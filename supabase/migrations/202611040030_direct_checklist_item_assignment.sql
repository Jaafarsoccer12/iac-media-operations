create or replace function public.admin_assign_checklist_item(
  p_event_id uuid,
  p_user_id uuid,
  p_label text,
  p_is_required boolean default true,
  p_program_phase text default null
) returns uuid
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_event public.events%rowtype;
  v_person public.profiles%rowtype;
  v_instance uuid;
  v_step integer;
  v_item uuid;
  v_phase text;
  v_role text;
begin
  if not public.can_manage_checklist_templates() then
    raise exception 'Only an administrator or director can assign checklist items' using errcode='42501';
  end if;
  if length(trim(coalesce(p_label,''))) not between 2 and 240 then
    raise exception 'Checklist item must be 2 to 240 characters';
  end if;

  select * into v_event from public.events
  where id=p_event_id and status not in ('Completed','Cancelled');
  if not found then raise exception 'Choose an upcoming or active event'; end if;

  select * into v_person from public.profiles where id=p_user_id and active;
  if not found then raise exception 'Choose an active team member'; end if;

  v_phase := nullif(trim(coalesce(p_program_phase,'')), '');
  if v_phase is null then
    select category_name into v_phase from public.operation_categories
    where category_type='checklists' and category_name=v_event.current_program_phase
    limit 1;
    if v_phase is null then
      select category_name into v_phase from public.operation_categories
      where category_type='checklists' order by sort_order,category_name limit 1;
    end if;
  elsif not exists (
    select 1 from public.operation_categories
    where category_type='checklists' and category_name=v_phase
  ) then
    raise exception 'Choose a current program phase from the checklist categories';
  end if;
  v_phase := coalesce(v_phase,'Pre-event');
  v_role := coalesce(nullif(trim(v_person.job_title),''),v_person.role);

  select instance.id into v_instance
  from public.checklist_instances instance
  where instance.event_id=p_event_id
    and instance.assignment_id is null
    and instance.template_version_id is null
    and instance.role_name=v_role
    and exists (
      select 1 from public.checklist_items item
      where item.instance_id=instance.id and item.assigned_user_id=p_user_id
    )
    and not exists (
      select 1 from public.checklist_items item
      where item.instance_id=instance.id and item.assigned_user_id is distinct from p_user_id
    )
  order by instance.created_at desc
  limit 1
  for update of instance;

  if v_instance is null then
    insert into public.checklist_instances(event_id,assignment_id,template_version_id,title,role_name,created_by)
    values(p_event_id,null,null,v_person.full_name||' checklist',v_role,auth.uid())
    returning id into v_instance;
  end if;

  select coalesce(max(step_order),0)+1 into v_step
  from public.checklist_items where instance_id=v_instance;
  insert into public.checklist_items(instance_id,step_order,label,is_required,assigned_user_id,assigned_role,program_phase)
  values(v_instance,v_step,trim(p_label),coalesce(p_is_required,true),p_user_id,v_role,v_phase)
  returning id into v_item;

  perform public.sync_checklist_instance_status(v_instance);
  insert into public.notifications(user_id,title,body,href)
  values(p_user_id,'New checklist item',v_event.title||' · '||trim(p_label),'checklists');
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
  values(auth.uid(),'Added checklist item','checklist_item',v_item,
    jsonb_build_object('event_id',p_event_id,'user_id',p_user_id,'program_phase',v_phase));
  return v_item;
end; $$;

revoke execute on function public.admin_assign_checklist_item(uuid,uuid,text,boolean,text) from public,anon;
grant execute on function public.admin_assign_checklist_item(uuid,uuid,text,boolean,text) to authenticated;
