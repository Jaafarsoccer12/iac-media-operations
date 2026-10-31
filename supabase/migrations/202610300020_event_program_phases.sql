-- Track each event's live program phase and the phase attached to checklist items.
alter table public.events
  add column if not exists current_program_phase text not null default 'Pre-event';

alter table public.checklist_items
  add column if not exists program_phase text not null default 'Pre-event';

-- Keep older records valid when an organization has renamed or removed its first phase.
update public.events e
set current_program_phase = coalesce((
  select category_name from public.operation_categories
  where category_type='checklists' order by sort_order,category_name limit 1
),e.current_program_phase)
where not exists (
  select 1 from public.operation_categories
  where category_type='checklists' and category_name=e.current_program_phase
);

-- Preserve the phase already chosen on saved checklist templates for existing assignments.
update public.checklist_items item
set program_phase = coalesce((
  select category_name from public.operation_categories
  where category_type='checklists' and category_name=template.category limit 1
),ev.current_program_phase,'Pre-event')
from public.checklist_instances instance
join public.checklist_template_versions version on version.id = instance.template_version_id
join public.checklist_templates template on template.id = version.template_id
join public.events ev on ev.id = instance.event_id
where item.instance_id = instance.id;

create or replace function public.default_event_program_phase() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if not exists (
    select 1 from public.operation_categories
    where category_type='checklists' and category_name=new.current_program_phase
  ) then
    select category_name into new.current_program_phase
    from public.operation_categories where category_type='checklists'
    order by sort_order,category_name limit 1;
  end if;
  return new;
end; $$;

drop trigger if exists events_default_program_phase on public.events;
create trigger events_default_program_phase before insert on public.events
for each row execute function public.default_event_program_phase();

drop function if exists public.admin_update_checklist_item(uuid, text, boolean);
create function public.admin_update_checklist_item(
  p_item_id uuid,
  p_label text,
  p_is_required boolean,
  p_program_phase text
) returns void
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_instance uuid;
  v_user uuid;
  v_old_phase text;
  v_phase text;
begin
  if not public.can_manage_checklist_templates() then
    raise exception 'Only an administrator or director can manage checklist items' using errcode='42501';
  end if;
  if length(trim(coalesce(p_label,''))) not between 2 and 240 then
    raise exception 'Checklist item must be 2 to 240 characters';
  end if;
  select instance_id,assigned_user_id,program_phase into v_instance,v_user,v_old_phase
  from public.checklist_items where id=p_item_id for update;
  if not found then raise exception 'Checklist item not found'; end if;
  v_phase := coalesce(nullif(trim(p_program_phase),''),v_old_phase,'Pre-event');
  if v_phase is distinct from v_old_phase and not exists (
    select 1 from public.operation_categories where category_type='checklists' and category_name=v_phase
  ) then
    raise exception 'Choose a current program phase from the checklist categories';
  end if;
  update public.checklist_items
  set label=trim(p_label),is_required=coalesce(p_is_required,true),program_phase=v_phase
  where id=p_item_id;
  perform public.sync_checklist_instance_status(v_instance);
  if v_user is not null then
    insert into public.notifications(user_id,title,body,href)
    values(v_user,'Checklist item updated',trim(p_label)||' · '||v_phase,'checklists');
  end if;
  insert into public.audit_logs(actor_id,action,target_type,target_id)
    values(auth.uid(),'Edited checklist item','checklist_item',p_item_id);
end; $$;

create or replace function public.admin_quick_assign_checklist_template(p_template_id uuid,p_event_id uuid,p_user_id uuid,p_tasks jsonb) returns integer
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_template public.checklist_templates%rowtype;
  v_event public.events%rowtype;
  v_person public.profiles%rowtype;
  v_version uuid;
  v_instance uuid;
  v_task jsonb;
  v_step integer := 0;
  v_label text;
  v_phase text;
begin
  if not public.can_manage_checklist_templates() then raise exception 'Only an administrator or director can assign checklist templates' using errcode='42501'; end if;
  select * into v_template from public.checklist_templates where id=p_template_id;
  select * into v_event from public.events where id=p_event_id and status not in ('Completed','Cancelled');
  select * into v_person from public.profiles where id=p_user_id and active;
  if v_template.id is null or v_event.id is null or v_person.id is null then raise exception 'Choose a saved template, upcoming event, and active team member'; end if;
  select id into v_version from public.checklist_template_versions where template_id=p_template_id order by version desc limit 1;
  if v_version is null then raise exception 'This template has no saved task list'; end if;
  if jsonb_typeof(p_tasks)<>'array' or jsonb_array_length(p_tasks) not between 1 and 60 then raise exception 'A checklist needs between 1 and 60 tasks'; end if;
  v_phase := coalesce(
    (select category_name from public.operation_categories where category_type='checklists' and category_name=v_template.category limit 1),
    (select category_name from public.operation_categories where category_type='checklists' and category_name=v_event.current_program_phase limit 1),
    (select category_name from public.operation_categories where category_type='checklists' order by sort_order,category_name limit 1),
    'Pre-event'
  );
  insert into public.checklist_instances(event_id,assignment_id,template_version_id,title,role_name,created_by)
    values(p_event_id,null,v_version,v_template.title,coalesce(nullif(trim(v_person.job_title),''),v_person.role),auth.uid()) returning id into v_instance;
  for v_task in select value from jsonb_array_elements(p_tasks) as tasks(value) loop
    v_step := v_step + 1;
    v_label := trim(coalesce(v_task->>'label',''));
    if length(v_label) not between 2 and 240 then raise exception 'Each checklist task must be 2 to 240 characters'; end if;
    insert into public.checklist_items(instance_id,step_order,label,is_required,assigned_user_id,assigned_role,program_phase)
      values(v_instance,v_step,v_label,coalesce((v_task->>'required')::boolean,true),p_user_id,coalesce(nullif(trim(v_person.job_title),''),v_person.role),v_phase);
  end loop;
  insert into public.notifications(user_id,title,body,href)
    values(p_user_id,'Checklist assigned',v_event.title||' · '||v_template.title||' · '||v_step||' tasks','checklists');
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),'Assigned checklist template','checklist_instance',v_instance,jsonb_build_object('template_id',p_template_id,'event_id',p_event_id,'user_id',p_user_id,'program_phase',v_phase));
  return v_step;
end; $$;

create or replace function public.set_event_program_phase(p_event_id uuid,p_phase text) returns void
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_title text;
  v_previous text;
  v_user_id uuid;
begin
  if not public.is_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  if length(trim(coalesce(p_phase,''))) not between 2 and 80 then raise exception 'Choose a valid program phase'; end if;
  select title,current_program_phase into v_title,v_previous
  from public.events where id=p_event_id for update;
  if not found then raise exception 'Event not found'; end if;
  if not exists(select 1 from public.operation_categories where category_type='checklists' and category_name=trim(p_phase)) then
    raise exception 'Choose a current program phase from the checklist categories';
  end if;
  if coalesce(v_previous,'Pre-event') is distinct from trim(p_phase) then
    update public.events set current_program_phase=trim(p_phase),updated_at=now() where id=p_event_id;
    for v_user_id in select distinct user_id from public.role_assignments where event_id=p_event_id and user_id<>auth.uid() loop
      insert into public.notifications(user_id,title,body,href)
      values(v_user_id,'Program phase updated',v_title||' · '||trim(p_phase),'events');
    end loop;
    insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
      values(auth.uid(),'Changed program phase','event',p_event_id,jsonb_build_object('from',v_previous,'to',trim(p_phase)));
  end if;
end; $$;

revoke execute on function public.admin_update_checklist_item(uuid,text,boolean,text) from public,anon;
grant execute on function public.admin_update_checklist_item(uuid,text,boolean,text) to authenticated;
revoke execute on function public.admin_quick_assign_checklist_template(uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.admin_quick_assign_checklist_template(uuid,uuid,uuid,jsonb) to authenticated;
revoke execute on function public.set_event_program_phase(uuid,text) from public,anon;
grant execute on function public.set_event_program_phase(uuid,text) to authenticated;
