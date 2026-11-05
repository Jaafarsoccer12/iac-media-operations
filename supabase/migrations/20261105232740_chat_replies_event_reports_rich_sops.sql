begin;

-- Chat replies remain confined to the same existing conversation. Attachment
-- paths must belong to the sender; Storage RLS controls who can download them.
alter table public.crew_chat_messages
  add column if not exists reply_to_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.crew_chat_messages'::regclass
      and conname = 'crew_chat_messages_reply_to_id_fkey'
  ) then
    alter table public.crew_chat_messages
      add constraint crew_chat_messages_reply_to_id_fkey
      foreign key (reply_to_id) references public.crew_chat_messages(id) on delete set null;
  end if;
end $$;

drop policy if exists crew_chat_messages_insert_sender on public.crew_chat_messages;
create policy crew_chat_messages_insert_sender on public.crew_chat_messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.is_active_chat_member((select auth.uid()))
    and jsonb_typeof(attachments) = 'array'
    and not exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(attachments) = 'array' then attachments else '[]'::jsonb end) as attachment
      where coalesce(attachment->>'path', '') = ''
         or split_part(attachment->>'path', '/', 1) <> (select auth.uid())::text
         or split_part(attachment->>'path', '/', 2) <> 'chat'
    )
    and (
      (conversation_type = 'all' and recipient_id is null)
      or (conversation_type = 'direct' and recipient_id is not null
          and recipient_id <> (select auth.uid())
          and public.is_active_chat_member(recipient_id))
    )
    and (
      reply_to_id is null
      or exists (
        select 1 from public.crew_chat_messages parent
        where parent.id = reply_to_id
          and parent.conversation_type = public.crew_chat_messages.conversation_type
          and (
            public.crew_chat_messages.conversation_type = 'all'
            or (parent.sender_id = public.crew_chat_messages.sender_id and parent.recipient_id = public.crew_chat_messages.recipient_id)
            or (parent.sender_id = public.crew_chat_messages.recipient_id and parent.recipient_id = public.crew_chat_messages.sender_id)
          )
      )
    )
  );

-- Messages are immutable; read receipts live in their own table. Do not add an
-- update policy that could let a sender redirect an existing direct message.
drop policy if exists crew_chat_messages_update_sender on public.crew_chat_messages;

-- Event timing and a restricted, actor-attributed activity timeline.
alter table public.events
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz;

create table if not exists public.event_activity (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (length(trim(action)) between 1 and 80),
  summary text not null check (length(trim(summary)) between 1 and 500),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists event_activity_event_time_idx
  on public.event_activity(event_id, occurred_at, id);
alter table public.event_activity enable row level security;
revoke all on public.event_activity from public, anon, authenticated;
grant select on public.event_activity to authenticated;
drop policy if exists event_activity_manager_select on public.event_activity;
create policy event_activity_manager_select on public.event_activity
  for select to authenticated using (public.is_manager());

-- Trigger writer is private, reads the authenticated user from the request JWT,
-- and only records activity while a program is running.
create or replace function public.capture_event_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_event_id uuid;
  v_actor_id uuid := auth.uid();
  v_action text;
  v_summary text;
  v_started timestamptz;
  v_ended timestamptz;
  v_name text;
  v_asset text;
begin
  if tg_table_name = 'checklist_items' then
    if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
    select ci.event_id into v_event_id from public.checklist_instances ci where ci.id = coalesce(new.instance_id, old.instance_id);
    v_actor_id := coalesce(v_actor_id, new.completed_by, new.verified_by);
    v_action := 'checklist';
    v_summary := case when new.status = 'Complete' then 'Completed checklist task: ' else 'Updated checklist task: ' end || left(new.label, 360);
  elsif tg_table_name = 'incidents' then
    if tg_op = 'UPDATE' and old.status is not distinct from new.status
       and old.description is not distinct from new.description
       and old.resolution_notes is not distinct from new.resolution_notes
       and old.immediate_action is not distinct from new.immediate_action
       and old.photos is not distinct from new.photos
       and old.category is not distinct from new.category
       and old.severity is not distinct from new.severity
       and old.event_id is not distinct from new.event_id
       and old.asset_id is not distinct from new.asset_id then return new; end if;
    v_event_id := new.event_id;
    if v_event_id is null then
      select id into v_event_id from public.events
        where started_at is not null and ended_at is null and status = 'Published'
        order by started_at desc limit 1;
    end if;
    v_actor_id := coalesce(v_actor_id, new.resolved_by, new.reported_by);
    v_action := case when tg_op = 'INSERT' then 'incident' else 'incident update' end;
    v_summary := case when tg_op = 'INSERT' then 'Incident reported: ' else 'Incident changed: ' end || left(new.category || ' · ' || new.severity || ' · ' || new.status, 340);
  elsif tg_table_name = 'role_assignments' then
    if tg_op = 'DELETE' then v_event_id := old.event_id; else v_event_id := new.event_id; end if;
    if tg_op = 'UPDATE' and old.response_status is distinct from new.response_status then
      v_actor_id := coalesce(v_actor_id, new.user_id);
      v_action := 'attendance';
      v_summary := case new.response_status when 'Accepted' then 'Confirmed attendance' when 'Declined' then 'Declined attendance' else 'Updated attendance' end;
    elsif tg_op = 'DELETE' then
      v_action := 'crew assignment';
      select full_name into v_name from public.profiles where id = old.user_id;
      v_actor_id := coalesce(v_actor_id, old.assigned_by);
      v_summary := 'Crew assignment removed: ' || coalesce(v_name, 'Team member') || ' · ' || old.role_name;
    else
      if tg_op = 'UPDATE' and old.user_id is not distinct from new.user_id and old.role_name is not distinct from new.role_name then return new; end if;
      v_action := 'crew assignment';
      select full_name into v_name from public.profiles where id = new.user_id;
      v_actor_id := coalesce(v_actor_id, new.assigned_by);
      v_summary := case when tg_op = 'INSERT' then 'Crew assigned: ' else 'Crew assignment changed: ' end || coalesce(v_name, 'Team member') || ' · ' || new.role_name;
    end if;
  elsif tg_table_name = 'equipment_checkouts' then
    v_event_id := new.event_id;
    v_actor_id := coalesce(v_actor_id, new.checked_out_by);
    select name into v_asset from public.equipment_assets where id = new.asset_id;
    v_action := 'equipment checkout';
    v_summary := 'Equipment checked out: ' || coalesce(v_asset, 'Equipment item');
  elsif tg_table_name = 'equipment_returns' then
    select c.event_id, a.name into v_event_id, v_asset
      from public.equipment_checkouts c join public.equipment_assets a on a.id = c.asset_id
      where c.id = new.checkout_id;
    v_actor_id := coalesce(v_actor_id, new.inspected_by);
    v_action := 'equipment return';
    v_summary := 'Equipment returned: ' || coalesce(v_asset, 'Equipment item');
  elsif tg_table_name = 'equipment_loans' then
    select e.id into v_event_id from public.events e
      where e.started_at is not null and e.ended_at is null and e.status = 'Published'
      order by e.started_at desc limit 1;
    v_actor_id := coalesce(v_actor_id, new.issued_by);
    select name into v_asset from public.equipment_assets where id = new.asset_id;
    v_action := 'equipment checkout';
    v_summary := 'Equipment checked out: ' || coalesce(v_asset, 'Equipment item') || ' · quantity ' || new.quantity;
  elsif tg_table_name = 'equipment_loan_returns' then
    select e.id, a.name into v_event_id, v_asset
      from public.equipment_loans l
      join public.equipment_assets a on a.id = l.asset_id
      cross join lateral (select id from public.events where started_at is not null and ended_at is null and status = 'Published' order by started_at desc limit 1) e
      where l.id = new.loan_id;
    v_actor_id := coalesce(v_actor_id, new.received_by);
    v_action := 'equipment return';
    v_summary := 'Equipment returned: ' || coalesce(v_asset, 'Equipment item');
  else
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if v_event_id is null or v_actor_id is null then if tg_op = 'DELETE' then return old; else return new; end if; end if;
  select started_at, ended_at into v_started, v_ended from public.events where id = v_event_id;
  if v_started is null or v_ended is not null then if tg_op = 'DELETE' then return old; else return new; end if; end if;
  if not exists (select 1 from public.profiles p where p.id = v_actor_id and p.active) then if tg_op = 'DELETE' then return old; else return new; end if; end if;
  insert into public.event_activity(event_id, actor_id, action, summary)
    values (v_event_id, v_actor_id, v_action, left(v_summary, 500));
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.capture_event_activity() from public, anon, authenticated;

drop trigger if exists event_activity_checklist on public.checklist_items;
create trigger event_activity_checklist after insert or update on public.checklist_items
  for each row execute function public.capture_event_activity();
drop trigger if exists event_activity_incidents on public.incidents;
create trigger event_activity_incidents after insert or update on public.incidents
  for each row execute function public.capture_event_activity();
drop trigger if exists event_activity_assignments on public.role_assignments;
create trigger event_activity_assignments after insert or update or delete on public.role_assignments
  for each row execute function public.capture_event_activity();
drop trigger if exists event_activity_equipment_checkouts on public.equipment_checkouts;
create trigger event_activity_equipment_checkouts after insert on public.equipment_checkouts
  for each row execute function public.capture_event_activity();
drop trigger if exists event_activity_equipment_returns on public.equipment_returns;
create trigger event_activity_equipment_returns after insert on public.equipment_returns
  for each row execute function public.capture_event_activity();
drop trigger if exists event_activity_equipment_loans on public.equipment_loans;
create trigger event_activity_equipment_loans after insert on public.equipment_loans
  for each row execute function public.capture_event_activity();
drop trigger if exists event_activity_equipment_loan_returns on public.equipment_loan_returns;
create trigger event_activity_equipment_loan_returns after insert on public.equipment_loan_returns
  for each row execute function public.capture_event_activity();

create or replace function public.start_event_program(p_event_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare v_event public.events%rowtype; v_started timestamptz := now();
begin
  if auth.uid() is null or not public.is_manager() then raise exception 'Only an administrator or director can start a program' using errcode = '42501'; end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found or v_event.status <> 'Published' then raise exception 'Only a published program can be started' using errcode = '22023'; end if;
  if v_event.started_at is not null then raise exception 'This program has already started' using errcode = '23505'; end if;
  update public.events set started_at = v_started, ended_at = null where id = p_event_id;
  insert into public.event_activity(event_id, actor_id, action, summary, occurred_at)
    values (p_event_id, auth.uid(), 'program started', 'Program started', v_started);
  insert into public.notifications(user_id, sender_id, title, body, href)
    select distinct a.user_id, auth.uid(), 'Program started', v_event.title || ' has started.', 'events'
    from public.role_assignments a join public.profiles p on p.id = a.user_id and p.active
    where a.event_id = p_event_id and a.user_id <> auth.uid();
  return v_started;
end;
$$;

create or replace function public.end_event_program(p_event_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare v_event public.events%rowtype; v_ended timestamptz := now();
begin
  if auth.uid() is null or not public.is_manager() then raise exception 'Only an administrator or director can end a program' using errcode = '42501'; end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found or v_event.status <> 'Published' or v_event.started_at is null then raise exception 'Only a running program can be ended' using errcode = '22023'; end if;
  if v_event.ended_at is not null then raise exception 'This program has already ended' using errcode = '23505'; end if;
  update public.events set ended_at = v_ended, status = 'Completed' where id = p_event_id;
  insert into public.event_activity(event_id, actor_id, action, summary, occurred_at)
    values (p_event_id, auth.uid(), 'program ended', 'Program ended', v_ended);
  insert into public.notifications(user_id, sender_id, title, body, href)
    select distinct a.user_id, auth.uid(), 'Program ended', v_event.title || ' has ended.', 'events'
    from public.role_assignments a join public.profiles p on p.id = a.user_id and p.active
    where a.event_id = p_event_id and a.user_id <> auth.uid();
  return v_ended;
end;
$$;
revoke all on function public.start_event_program(uuid) from public, anon;
revoke all on function public.end_event_program(uuid) from public, anon;
grant execute on function public.start_event_program(uuid) to authenticated;
grant execute on function public.end_event_program(uuid) to authenticated;

create or replace function public.admin_clear_active_time_alarms()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare v_ids uuid[]; v_count integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.active
      and ('Administrator' = any(p.access_roles) or p.role = 'Administrator')
  ) then raise exception 'Only an active administrator can clear team alarms' using errcode = '42501'; end if;
  with cancelled as (
    update public.time_alarms set cancelled_at = now()
      where cancelled_at is null and completed_at is null
      returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from cancelled;
  v_count := coalesce(array_length(v_ids, 1), 0);
  if coalesce(array_length(v_ids, 1), 0) > 0 then
      update public.notifications set read_at = coalesce(read_at, now())
       where href in (select 'time-alarm:' || alarm_id::text from unnest(v_ids) as ids(alarm_id));
  end if;
  return v_count;
end;
$$;
revoke all on function public.admin_clear_active_time_alarms() from public, anon;
grant execute on function public.admin_clear_active_time_alarms() to authenticated;

-- Role changes use the signed-in database session, so they remain available
-- even when Supabase Auth admin/service credentials are temporarily offline.
create or replace function public.admin_update_profile_roles(p_member_id uuid, p_access_roles text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare v_actor public.profiles%rowtype; v_target public.profiles%rowtype; v_is_admin boolean; v_next_role text; v_admin_count integer; v_unique_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to edit team roles' using errcode = '42501'; end if;
  select * into v_actor from public.profiles where id = auth.uid() and active;
  if not found then raise exception 'Active team account required' using errcode = '42501'; end if;
  v_is_admin := v_actor.role = 'Administrator' or 'Administrator' = any(v_actor.access_roles);
  if not v_is_admin and not (v_actor.role = 'Director' or 'Director' = any(v_actor.access_roles)) then raise exception 'Only an administrator or director can edit roles' using errcode = '42501'; end if;
  select * into v_target from public.profiles where id = p_member_id for update;
  if not found then raise exception 'Team member not found' using errcode = 'P0002'; end if;
  if p_access_roles is null or cardinality(p_access_roles) < 1 or cardinality(p_access_roles) > 10 then
    raise exception 'Choose valid, unique app access roles' using errcode = '22023';
  end if;
  select count(distinct role_name) into v_unique_count from unnest(p_access_roles) as roles(role_name);
  if v_unique_count <> cardinality(p_access_roles)
     or array_position(p_access_roles, null) is not null
     or exists (select 1 from unnest(p_access_roles) as roles(role_name) where roles.role_name not in ('Administrator','Director','Videographer','Video Switcher Operator','Camera Operator','PTZ Camera Operator','Audio Operator','Equipment Manager','Video Operator','Photography'))
  then raise exception 'Choose valid, unique app access roles' using errcode = '22023'; end if;
  if not v_is_admin and (
    v_target.role = 'Administrator' or 'Administrator' = any(v_target.access_roles)
    or 'Administrator' = any(p_access_roles)
  ) then raise exception 'Only an administrator can edit administrator access' using errcode = '42501'; end if;
  v_next_role := case
    when 'Administrator' = any(p_access_roles) then 'Administrator'
    when 'Director' = any(p_access_roles) then 'Director'
    when 'Equipment Manager' = any(p_access_roles) then 'Equipment Manager'
    when 'Videographer' = any(p_access_roles) then 'Videographer'
    when 'Video Switcher Operator' = any(p_access_roles) then 'Video Switcher Operator'
    when 'Camera Operator' = any(p_access_roles) then 'Camera Operator'
    when 'PTZ Camera Operator' = any(p_access_roles) then 'PTZ Camera Operator'
    when 'Audio Operator' = any(p_access_roles) then 'Audio Operator'
    when 'Video Operator' = any(p_access_roles) then 'Video Operator'
    else 'Photography' end;
  if v_target.active and (v_target.role = 'Administrator' or 'Administrator' = any(v_target.access_roles))
     and not ('Administrator' = any(p_access_roles)) then
    select count(*) into v_admin_count from public.profiles p where p.active and (p.role = 'Administrator' or 'Administrator' = any(p.access_roles));
    if v_admin_count <= 1 then raise exception 'Keep at least one active administrator' using errcode = '23514'; end if;
  end if;
  update public.profiles set access_roles = p_access_roles, role = v_next_role, updated_at = now() where id = p_member_id;
  insert into public.audit_logs(actor_id, action, target_type, target_id, metadata)
    values (auth.uid(), 'Updated team app access roles', 'profile', p_member_id, jsonb_build_object('access_roles', p_access_roles, 'role', v_next_role));
end;
$$;
revoke all on function public.admin_update_profile_roles(uuid, text[]) from public, anon;
grant execute on function public.admin_update_profile_roles(uuid, text[]) to authenticated;

alter table public.sop_versions
  add column if not exists rich_content jsonb not null default '[]'::jsonb;

create or replace function public.save_rich_sop_draft(
  p_sop_id uuid, p_title text, p_category text, p_purpose text, p_content jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare v_sop_id uuid := p_sop_id; v_version_id uuid; v_version integer; v_block jsonb; v_kind text; v_text text; v_path text; v_order integer := 0; v_photos text[]; v_font_size integer;
begin
  if auth.uid() is null or not public.is_manager() then raise exception 'Only an administrator or director can edit SOPs' using errcode = '42501'; end if;
  if length(trim(coalesce(p_title,''))) < 3 or length(trim(coalesce(p_category,''))) < 1
     or jsonb_typeof(p_content) <> 'array' or jsonb_array_length(p_content) > 200
  then raise exception 'Enter an SOP title, category, and valid procedure content' using errcode = '22023'; end if;
  if v_sop_id is not null and not exists(select 1 from public.sops where id=v_sop_id) then raise exception 'SOP not found' using errcode = 'P0002'; end if;
  if v_sop_id is null then
    insert into public.sops(title,category,author_id,status) values(trim(p_title),trim(p_category),auth.uid(),'Draft') returning id into v_sop_id;
  end if;
  select coalesce(max(version),0)+1 into v_version from public.sop_versions where sop_id=v_sop_id;
  insert into public.sop_versions(sop_id,version,purpose,authored_by,rich_content,status)
    values(v_sop_id,v_version,left(trim(coalesce(p_purpose,'')),2000),auth.uid(),p_content,'Draft') returning id into v_version_id;
  for v_block in select value from jsonb_array_elements(p_content) loop
    v_kind := v_block->>'kind';
    if v_kind in ('title','heading','subheading','body') then
      v_text := trim(coalesce(v_block->>'text',''));
      v_font_size := 16;
      if v_block ? 'fontSize' then
        if coalesce(v_block->>'fontSize','') !~ '^[0-9]{1,2}$' then raise exception 'SOP font size must be between 10 and 48 points' using errcode='22023'; end if;
        v_font_size := (v_block->>'fontSize')::integer;
        if v_font_size not between 10 and 48 then raise exception 'SOP font size must be between 10 and 48 points' using errcode='22023'; end if;
      end if;
      if length(v_text) > 4000 then raise exception 'An SOP text block is too long' using errcode='22023'; end if;
      if v_text <> '' then
        v_order := v_order + 1;
        insert into public.sop_steps(sop_version_id,step_number,instruction)
          values(v_version_id,v_order,left(v_text,1000));
      end if;
    elsif v_kind = 'image' then
      v_path := v_block->>'path';
      if v_path is null or split_part(v_path,'/',1) = '' or split_part(v_path,'/',2) <> 'sops'
         or length(coalesce(v_block->>'alt','')) > 240 then raise exception 'SOP image path is invalid' using errcode='22023'; end if;
      if not exists(select 1 from storage.objects o where o.bucket_id='crew-media' and o.name=v_path and (split_part(v_path,'/',1)=auth.uid()::text or exists(select 1 from public.sops s where s.id=v_sop_id and v_path=any(s.photos))))
      then raise exception 'SOP images must belong to this editor or already be part of this SOP' using errcode='42501'; end if;
    else
      raise exception 'SOP content contains an unsupported block' using errcode='22023';
    end if;
  end loop;
  if not exists(select 1 from jsonb_array_elements(p_content) b where b->>'kind' in ('title','heading','subheading','body') and length(trim(coalesce(b->>'text',''))) > 0) then
    raise exception 'Add at least one text instruction' using errcode='22023';
  end if;
  select coalesce(array_agg(distinct b->>'path'),'{}'::text[]) into v_photos
    from jsonb_array_elements(p_content) b where b->>'kind'='image';
  update public.sops set title=trim(p_title),category=trim(p_category),status='Draft',current_version_id=v_version_id,photos=v_photos,updated_at=now()
    where id=v_sop_id;
  return v_sop_id;
end;
$$;
revoke all on function public.save_rich_sop_draft(uuid,text,text,text,jsonb) from public, anon;
grant execute on function public.save_rich_sop_draft(uuid,text,text,text,jsonb) to authenticated;

create or replace function public.delete_sop(p_sop_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
begin
  if auth.uid() is null or not public.is_manager() then raise exception 'Only an administrator or director can delete SOPs' using errcode = '42501'; end if;
  delete from public.sops where id = p_sop_id;
  if not found then raise exception 'SOP not found' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.delete_sop(uuid) from public, anon;
grant execute on function public.delete_sop(uuid) to authenticated;

commit;
