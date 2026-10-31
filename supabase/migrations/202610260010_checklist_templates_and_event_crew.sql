-- Reuse the existing versioned checklist template tables and event role assignments.
-- Run this migration before using the feature with a connected Supabase project.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles drop constraint if exists profiles_access_roles_check;

update public.profiles
set role = case
  when role in ('Administrator','Director','Videographer','Video Switcher Operator','PTZ Camera Operator','Audio Operator','Equipment Manager','Video Operator','Photography') then role
  when role in ('Media Director','Team Lead') then 'Director'
  when role in ('Operator','Trainee','Event Organizer') and job_title in ('Director','Videographer','Video Switcher Operator','PTZ Camera Operator','Audio Operator','Video Operator','Photography') then job_title
  when role = 'Equipment Manager' then 'Equipment Manager'
  else 'Videographer'
end;

update public.profiles p
set access_roles = coalesce((
  select array_agg(distinct case
    when value in ('Administrator','Director','Videographer','Video Switcher Operator','PTZ Camera Operator','Audio Operator','Equipment Manager','Video Operator','Photography') then value
    when value in ('Media Director','Team Lead') then 'Director'
    when value in ('Operator','Trainee','Event Organizer') and p.job_title in ('Director','Videographer','Video Switcher Operator','PTZ Camera Operator','Audio Operator','Video Operator','Photography') then p.job_title
    else 'Videographer'
  end)
  from unnest(coalesce(p.access_roles, array[]::text[])) as role_values(value)
), array[p.role]);

alter table public.profiles add constraint profiles_role_check check (
  role in ('Administrator','Director','Videographer','Video Switcher Operator','PTZ Camera Operator','Audio Operator','Equipment Manager','Video Operator','Photography')
);
alter table public.profiles add constraint profiles_access_roles_check check (
  cardinality(access_roles) between 1 and 9 and
  access_roles <@ array['Administrator','Director','Videographer','Video Switcher Operator','PTZ Camera Operator','Audio Operator','Equipment Manager','Video Operator','Photography']::text[]
);

create or replace function public.can_manage_checklist_templates() returns boolean
language sql stable security definer set search_path=public,pg_temp set row_security=off as $$
  select exists (
    select 1 from public.profiles p
    where p.id=auth.uid() and p.active
      and (p.role in ('Administrator','Director') or p.access_roles && array['Administrator','Director']::text[])
  )
$$;

create or replace function public.can_manage_event_crew() returns boolean
language sql stable security definer set search_path=public,pg_temp set row_security=off as $$
  select exists (
    select 1 from public.profiles p
    where p.id=auth.uid() and p.active
      and (p.role in ('Administrator','Director') or p.access_roles && array['Administrator','Director']::text[])
  )
$$;

grant execute on function public.can_manage_checklist_templates() to authenticated;
grant execute on function public.can_manage_event_crew() to authenticated;

-- Upcoming and planning events are visible to every active crew account.
create policy events_select_all_active_crew on public.events for select to authenticated
  using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.active));
create policy profiles_select_event_directors on public.profiles for select to authenticated
  using (public.can_manage_event_crew());
create policy assignments_select_event_roster on public.role_assignments for select to authenticated
  using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.active));

-- Managers can maintain private templates; regular members cannot browse template drafts.
drop policy if exists checklist_templates_select on public.checklist_templates;
drop policy if exists checklist_templates_write on public.checklist_templates;
drop policy if exists checklist_versions_select on public.checklist_template_versions;
drop policy if exists checklist_versions_write on public.checklist_template_versions;
drop policy if exists checklist_template_items_select on public.checklist_template_items;
drop policy if exists checklist_template_items_write on public.checklist_template_items;
create policy checklist_templates_select on public.checklist_templates for select to authenticated
  using (public.can_manage_checklist_templates());
create policy checklist_templates_write on public.checklist_templates for all to authenticated
  using (public.can_manage_checklist_templates()) with check (public.can_manage_checklist_templates());
create policy checklist_versions_select on public.checklist_template_versions for select to authenticated
  using (public.can_manage_checklist_templates());
create policy checklist_versions_write on public.checklist_template_versions for all to authenticated
  using (public.can_manage_checklist_templates()) with check (public.can_manage_checklist_templates());
create policy checklist_template_items_select on public.checklist_template_items for select to authenticated
  using (public.can_manage_checklist_templates());
create policy checklist_template_items_write on public.checklist_template_items for all to authenticated
  using (public.can_manage_checklist_templates()) with check (public.can_manage_checklist_templates());

-- No invented arrival time is stored for events whose setup time is not known.
alter table public.role_assignments alter column arrival_time drop not null;

-- Existing events start with the full active crew selected. The app can change this roster per event.
insert into public.role_assignments(event_id,user_id,role_name,arrival_time,instructions,response_status,assigned_by)
select e.id,p.id,coalesce(nullif(trim(p.job_title),''),p.role),e.setup_time,'','Pending',e.created_by
from public.events e cross join public.profiles p
where p.active and not exists (
  select 1 from public.role_assignments a where a.event_id=e.id and a.user_id=p.id
)
on conflict (event_id,user_id,role_name) do nothing;

create or replace function public.sync_event_crew(p_event_id uuid,p_user_ids uuid[] default null) returns void
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_selected uuid[] := p_user_ids;
  v_person record;
  v_role text;
  v_existing uuid;
  v_user uuid;
  v_title text;
  v_date date;
begin
  if not public.can_manage_event_crew() then raise exception 'Only an administrator or director can change event crew' using errcode='42501'; end if;
  select title,event_date into v_title,v_date from public.events where id=p_event_id;
  if not found then raise exception 'Event not found'; end if;
  if v_selected is null then select coalesce(array_agg(id order by full_name),array[]::uuid[]) into v_selected from public.profiles where active; end if;
  if exists(select 1 from unnest(v_selected) requested(id) left join public.profiles p on p.id=requested.id and p.active where p.id is null) then
    raise exception 'Choose active team members for this event';
  end if;
  for v_person in select id,full_name,role,job_title from public.profiles where active and id=any(v_selected) loop
    v_role := coalesce(nullif(trim(v_person.job_title),''),v_person.role);
    delete from public.role_assignments where event_id=p_event_id and user_id=v_person.id and role_name is distinct from v_role;
    select id into v_existing from public.role_assignments where event_id=p_event_id and user_id=v_person.id and role_name=v_role limit 1;
    if v_existing is null then
      insert into public.role_assignments(event_id,user_id,role_name,arrival_time,instructions,response_status,assigned_by)
        select p_event_id,v_person.id,v_role,e.setup_time,'','Pending',auth.uid() from public.events e where e.id=p_event_id;
      insert into public.notifications(user_id,title,body,href)
        values(v_person.id,'New event assignment',v_title||' · '||v_date::text,'events');
    end if;
  end loop;
  for v_user in select distinct user_id from public.role_assignments where event_id=p_event_id and not (user_id=any(v_selected)) loop
    insert into public.notifications(user_id,title,body,href) values(v_user,'Event crew updated','You are no longer assigned to '||v_title||'.','events');
  end loop;
  delete from public.role_assignments where event_id=p_event_id and not (user_id=any(v_selected));
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),'Updated event crew','event',p_event_id,jsonb_build_object('assigned_user_ids',v_selected));
end; $$;

create or replace function public.admin_create_checklist_template(p_name text,p_tasks jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_template uuid;
  v_version uuid;
  v_task jsonb;
  v_step integer := 0;
  v_label text;
begin
  if not public.can_manage_checklist_templates() then raise exception 'Only an administrator or director can manage checklist templates' using errcode='42501'; end if;
  if length(trim(coalesce(p_name,''))) not between 2 and 120 then raise exception 'Template name must be 2 to 120 characters'; end if;
  if jsonb_typeof(p_tasks)<>'array' or jsonb_array_length(p_tasks) not between 1 and 60 then raise exception 'A template needs between 1 and 60 tasks'; end if;
  insert into public.checklist_templates(title,category,applies_to_role,published,created_by) values(trim(p_name),'Operations',null,false,auth.uid()) returning id into v_template;
  insert into public.checklist_template_versions(template_id,version,change_note,created_by) values(v_template,1,'Initial template',auth.uid()) returning id into v_version;
  for v_task in select value from jsonb_array_elements(p_tasks) as tasks(value) loop
    v_step := v_step + 1; v_label := trim(coalesce(v_task->>'label',''));
    if length(v_label) not between 2 and 240 then raise exception 'Each checklist task must be 2 to 240 characters'; end if;
    insert into public.checklist_template_items(version_id,step_order,label,is_required) values(v_version,v_step,v_label,coalesce((v_task->>'required')::boolean,true));
  end loop;
  insert into public.audit_logs(actor_id,action,target_type,target_id) values(auth.uid(),'Created checklist template','checklist_template',v_template);
  return v_template;
end; $$;

create or replace function public.admin_update_checklist_template(p_template_id uuid,p_name text,p_tasks jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_template public.checklist_templates%rowtype;
  v_version uuid;
  v_next integer;
  v_task jsonb;
  v_step integer := 0;
  v_label text;
begin
  if not public.can_manage_checklist_templates() then raise exception 'Only an administrator or director can manage checklist templates' using errcode='42501'; end if;
  if length(trim(coalesce(p_name,''))) not between 2 and 120 then raise exception 'Template name must be 2 to 120 characters'; end if;
  if jsonb_typeof(p_tasks)<>'array' or jsonb_array_length(p_tasks) not between 1 and 60 then raise exception 'A template needs between 1 and 60 tasks'; end if;
  select * into v_template from public.checklist_templates where id=p_template_id for update;
  if not found then raise exception 'Checklist template not found'; end if;
  select coalesce(max(version),0)+1 into v_next from public.checklist_template_versions where template_id=p_template_id;
  update public.checklist_templates set title=trim(p_name),updated_at=now() where id=p_template_id;
  insert into public.checklist_template_versions(template_id,version,change_note,created_by) values(p_template_id,v_next,'Updated template',auth.uid()) returning id into v_version;
  for v_task in select value from jsonb_array_elements(p_tasks) as tasks(value) loop
    v_step := v_step + 1; v_label := trim(coalesce(v_task->>'label',''));
    if length(v_label) not between 2 and 240 then raise exception 'Each checklist task must be 2 to 240 characters'; end if;
    insert into public.checklist_template_items(version_id,step_order,label,is_required) values(v_version,v_step,v_label,coalesce((v_task->>'required')::boolean,true));
  end loop;
  insert into public.audit_logs(actor_id,action,target_type,target_id) values(auth.uid(),'Updated checklist template','checklist_template',p_template_id);
end; $$;

create or replace function public.admin_duplicate_checklist_template(p_template_id uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_source public.checklist_templates%rowtype;
  v_source_version uuid;
  v_new_template uuid;
  v_new_version uuid;
begin
  if not public.can_manage_checklist_templates() then raise exception 'Only an administrator or director can manage checklist templates' using errcode='42501'; end if;
  select * into v_source from public.checklist_templates where id=p_template_id;
  if not found then raise exception 'Checklist template not found'; end if;
  select id into v_source_version from public.checklist_template_versions where template_id=p_template_id order by version desc limit 1;
  if v_source_version is null then raise exception 'This template has no saved task list'; end if;
  insert into public.checklist_templates(title,category,applies_to_role,published,created_by) values('Copy of '||v_source.title,v_source.category,v_source.applies_to_role,false,auth.uid()) returning id into v_new_template;
  insert into public.checklist_template_versions(template_id,version,change_note,created_by) values(v_new_template,1,'Copied template',auth.uid()) returning id into v_new_version;
  insert into public.checklist_template_items(version_id,step_order,label,instructions,is_required,assigned_role)
    select v_new_version,step_order,label,instructions,is_required,assigned_role from public.checklist_template_items where version_id=v_source_version order by step_order;
  insert into public.audit_logs(actor_id,action,target_type,target_id) values(auth.uid(),'Duplicated checklist template','checklist_template',v_new_template);
  return v_new_template;
end; $$;

create or replace function public.admin_delete_checklist_template(p_template_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
begin
  if not public.can_manage_checklist_templates() then raise exception 'Only an administrator or director can manage checklist templates' using errcode='42501'; end if;
  delete from public.checklist_templates where id=p_template_id;
  if not found then raise exception 'Checklist template not found'; end if;
  insert into public.audit_logs(actor_id,action,target_type,target_id) values(auth.uid(),'Deleted checklist template','checklist_template',p_template_id);
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
begin
  if not public.can_manage_checklist_templates() then raise exception 'Only an administrator or director can assign checklist templates' using errcode='42501'; end if;
  select * into v_template from public.checklist_templates where id=p_template_id;
  select * into v_event from public.events where id=p_event_id and status not in ('Completed','Cancelled');
  select * into v_person from public.profiles where id=p_user_id and active;
  if v_template.id is null or v_event.id is null or v_person.id is null then raise exception 'Choose a saved template, upcoming event, and active team member'; end if;
  select id into v_version from public.checklist_template_versions where template_id=p_template_id order by version desc limit 1;
  if v_version is null then raise exception 'This template has no saved task list'; end if;
  if jsonb_typeof(p_tasks)<>'array' or jsonb_array_length(p_tasks) not between 1 and 60 then raise exception 'A checklist needs between 1 and 60 tasks'; end if;
  insert into public.checklist_instances(event_id,assignment_id,template_version_id,title,role_name,created_by)
    values(p_event_id,null,v_version,v_template.title,coalesce(nullif(trim(v_person.job_title),''),v_person.role),auth.uid()) returning id into v_instance;
  for v_task in select value from jsonb_array_elements(p_tasks) as tasks(value) loop
    v_step := v_step + 1; v_label := trim(coalesce(v_task->>'label',''));
    if length(v_label) not between 2 and 240 then raise exception 'Each checklist task must be 2 to 240 characters'; end if;
    insert into public.checklist_items(instance_id,step_order,label,is_required,assigned_user_id,assigned_role)
      values(v_instance,v_step,v_label,coalesce((v_task->>'required')::boolean,true),p_user_id,coalesce(nullif(trim(v_person.job_title),''),v_person.role));
  end loop;
  insert into public.notifications(user_id,title,body,href)
    values(p_user_id,'Checklist assigned',v_event.title||' · '||v_template.title||' · '||v_step||' tasks','checklists');
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),'Assigned checklist template','checklist_instance',v_instance,jsonb_build_object('template_id',p_template_id,'event_id',p_event_id,'user_id',p_user_id));
  return v_step;
end; $$;

revoke execute on function public.sync_event_crew(uuid,uuid[]) from public,anon;
revoke execute on function public.admin_create_checklist_template(text,jsonb) from public,anon;
revoke execute on function public.admin_update_checklist_template(uuid,text,jsonb) from public,anon;
revoke execute on function public.admin_duplicate_checklist_template(uuid) from public,anon;
revoke execute on function public.admin_delete_checklist_template(uuid) from public,anon;
revoke execute on function public.admin_quick_assign_checklist_template(uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.sync_event_crew(uuid,uuid[]) to authenticated;
grant execute on function public.admin_create_checklist_template(text,jsonb) to authenticated;
grant execute on function public.admin_update_checklist_template(uuid,text,jsonb) to authenticated;
grant execute on function public.admin_duplicate_checklist_template(uuid) to authenticated;
grant execute on function public.admin_delete_checklist_template(uuid) to authenticated;
grant execute on function public.admin_quick_assign_checklist_template(uuid,uuid,uuid,jsonb) to authenticated;
