-- RLS helpers, audit trails, and transactional operational actions.
create or replace function public.current_role() returns text language sql stable security definer
set search_path=public,pg_temp set row_security=off as $$
  select p.role from public.profiles p where p.id=auth.uid() and p.active limit 1
$$;
create or replace function public.is_manager() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(public.current_role() in ('Administrator','Media Director'),false)
$$;
create or replace function public.is_staff() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(public.current_role() in ('Administrator','Media Director','Team Lead'),false)
$$;
create or replace function public.leads_event(p_event_id uuid) returns boolean language sql stable security definer
set search_path=public,pg_temp set row_security=off as $$
  select exists(select 1 from public.events e where e.id=p_event_id and e.event_lead_id=auth.uid())
    or exists(select 1 from public.role_assignments a where a.event_id=p_event_id and a.user_id=auth.uid() and a.role_name='Production Director')
$$;
create or replace function public.assigned_to_event(p_event_id uuid) returns boolean language sql stable security definer
set search_path=public,pg_temp set row_security=off as $$
  select exists(select 1 from public.role_assignments a where a.event_id=p_event_id and a.user_id=auth.uid())
$$;
create or replace function public.can_access_event(p_event_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.is_manager() or (public.current_role()='Team Lead' and (public.leads_event(p_event_id) or public.assigned_to_event(p_event_id))) or public.assigned_to_event(p_event_id)
$$;

create or replace function public.guard_profile_privileges() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active or new.qualification_status is distinct from old.qualification_status)
    and session_user not in ('postgres','supabase_admin','service_role')
    and public.current_role() is distinct from 'Administrator' then raise exception 'Only an administrator can change a role, account state, or qualification' using errcode='42501'; end if;
  return new;
end; $$;
create trigger profiles_protect_privileges before update on public.profiles for each row execute function public.guard_profile_privileges();

create or replace function public.write_audit_log() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
  if tg_op='DELETE' then v_id:=old.id; else v_id:=new.id; end if;
  insert into public.audit_logs(actor_id,action,target_type,target_id)
  values(auth.uid(),case when tg_op='INSERT' then 'Created ' else 'Changed ' end || replace(tg_table_name,'_',' '),tg_table_name,v_id);
  if tg_op='DELETE' then return old; else return new; end if;
end; $$;
create trigger events_audit after insert or update or delete on public.events for each row execute function public.write_audit_log();
create trigger assignments_audit after insert or update or delete on public.role_assignments for each row execute function public.write_audit_log();
create trigger assets_audit after insert or update or delete on public.equipment_assets for each row execute function public.write_audit_log();
create trigger reservations_audit after insert or update or delete on public.equipment_reservations for each row execute function public.write_audit_log();
create trigger checkouts_audit after insert or update or delete on public.equipment_checkouts for each row execute function public.write_audit_log();
create trigger returns_audit after insert or update or delete on public.equipment_returns for each row execute function public.write_audit_log();
create trigger incidents_audit after insert or update or delete on public.incidents for each row execute function public.write_audit_log();
create trigger sops_audit after insert or update or delete on public.sops for each row execute function public.write_audit_log();
create trigger sop_versions_audit after insert or update or delete on public.sop_versions for each row execute function public.write_audit_log();
create trigger content_audit after insert or update or delete on public.content_projects for each row execute function public.write_audit_log();

create or replace function public.record_incident_history() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    insert into public.incident_history(incident_id,actor_id,action,notes) values(new.id,auth.uid(),'Reported',new.description);
  elsif old.status is distinct from new.status or old.resolution_notes is distinct from new.resolution_notes then
    insert into public.incident_history(incident_id,actor_id,action,notes) values(new.id,auth.uid(),'Status updated to '||new.status,new.resolution_notes);
  end if;
  return new;
end; $$;
create trigger incidents_history after insert or update on public.incidents for each row execute function public.record_incident_history();

create or replace function public.notify_incident_leads() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare recipient uuid;
begin
  for recipient in select p.id from public.profiles p where p.active and p.id<>new.reported_by and (
    p.role in ('Administrator','Media Director') or (new.event_id is not null and (
      p.id=(select e.event_lead_id from public.events e where e.id=new.event_id) or
      exists(select 1 from public.role_assignments a where a.event_id=new.event_id and a.user_id=p.id and a.role_name='Production Director')))
  ) loop
    insert into public.notifications(user_id,title,body,href) values(recipient,'New incident reported',new.severity||' · '||new.category,'incidents');
  end loop;
  return new;
end; $$;
create trigger incidents_notify after insert on public.incidents for each row execute function public.notify_incident_leads();

create or replace function public.flag_incident_asset() returns trigger language plpgsql security definer
set search_path=public,pg_temp set row_security=off as $$
begin
  if new.asset_id is not null and new.severity in ('High','Critical') then
    update public.equipment_assets set status='Under maintenance' where id=new.asset_id;
  end if;
  return new;
end; $$;
create trigger incidents_flag_asset after insert on public.incidents for each row execute function public.flag_incident_asset();

create or replace function public.create_event_with_notes(
 p_title text,p_category text,p_event_date date,p_start_time time,p_end_time time,p_setup_time time,p_time_zone text,p_venue text,p_event_lead_id uuid,
 p_description text,p_livestream_required boolean,p_recording_required boolean,p_photography_required boolean,p_public_information text,p_private_notes text
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
  if not public.is_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  if p_end_time<=p_start_time then raise exception 'End time must be after start time'; end if;
  insert into public.events(title,category,event_date,start_time,end_time,setup_time,time_zone,venue,event_lead_id,description,livestream_required,recording_required,photography_required,public_information,created_by)
  values(trim(p_title),p_category,p_event_date,p_start_time,p_end_time,p_setup_time,p_time_zone,trim(p_venue),p_event_lead_id,p_description,p_livestream_required,p_recording_required,p_photography_required,p_public_information,auth.uid()) returning id into v_id;
  insert into public.event_private_notes(event_id,notes,updated_by) values(v_id,coalesce(p_private_notes,''),auth.uid());
  return v_id;
end; $$;

create or replace function public.update_event_with_notes(
 p_event_id uuid,p_title text,p_category text,p_event_date date,p_start_time time,p_end_time time,p_setup_time time,p_time_zone text,p_venue text,p_event_lead_id uuid,
 p_description text,p_livestream_required boolean,p_recording_required boolean,p_photography_required boolean,p_public_information text,p_private_notes text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare old_row public.events%rowtype; v_changed boolean;
begin
  if not public.is_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  if p_end_time<=p_start_time then raise exception 'Event time is invalid'; end if;
  select * into old_row from public.events where id=p_event_id for update;
  if not found then raise exception 'Event not found'; end if;
  v_changed:=old_row.event_date<>p_event_date or old_row.start_time<>p_start_time or old_row.end_time<>p_end_time or old_row.setup_time<>p_setup_time or old_row.time_zone<>p_time_zone or old_row.venue<>p_venue;
  if v_changed and exists(
    select 1 from public.role_assignments a join public.events other_event on other_event.id=a.event_id
    where a.event_id=p_event_id and exists(
      select 1 from public.role_assignments other_assignment join public.events other on other.id=other_assignment.event_id
      where other_assignment.user_id=a.user_id and other.id<>p_event_id and other.status not in ('Cancelled','Completed')
        and tstzrange((p_event_date+p_setup_time) at time zone p_time_zone,(p_event_date+p_end_time) at time zone p_time_zone,'[)') &&
            tstzrange((other.event_date+other_assignment.arrival_time) at time zone other.time_zone,(other.event_date+other.end_time) at time zone other.time_zone,'[)')
    )
  ) then raise exception 'Schedule change conflicts with a team assignment'; end if;
  update public.events set title=trim(p_title),category=p_category,event_date=p_event_date,start_time=p_start_time,end_time=p_end_time,setup_time=p_setup_time,time_zone=p_time_zone,
    venue=trim(p_venue),event_lead_id=p_event_lead_id,description=p_description,livestream_required=p_livestream_required,
    recording_required=p_recording_required,photography_required=p_photography_required,public_information=p_public_information where id=p_event_id;
  if v_changed then
    update public.equipment_reservations r set start_at=(p_event_date+p_setup_time) at time zone p_time_zone,end_at=(p_event_date+p_end_time) at time zone p_time_zone
      where r.event_id=p_event_id and r.status in ('Reserved','Checked out');
  end if;
  insert into public.event_private_notes(event_id,notes,updated_by) values(p_event_id,coalesce(p_private_notes,''),auth.uid())
  on conflict(event_id) do update set notes=excluded.notes,updated_by=excluded.updated_by,updated_at=now();
  if v_changed then insert into public.notifications(user_id,title,body,href)
    select a.user_id,'Event schedule updated',p_title||' · '||p_event_date::text||' · '||p_venue,'assignments' from public.role_assignments a where a.event_id=p_event_id;
  end if;
end; $$;

create or replace function public.publish_event_schedule(p_event_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_title text;
begin
  if not public.is_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  update public.events set status='Published' where id=p_event_id and status='Planning' returning title into v_title;
  if v_title is null then raise exception 'Planning event not found'; end if;
  insert into public.notifications(user_id,title,body,href) select a.user_id,'Schedule published',v_title||' · '||a.role_name,'assignments' from public.role_assignments a where a.event_id=p_event_id;
end; $$;

create or replace function public.create_event_assignment_with_checklist(
 p_event_id uuid,p_user_id uuid,p_role_name text,p_arrival_time time,p_instructions text,p_backup_user_id uuid default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_assignment uuid; v_checklist uuid; v_role uuid; v_date date; v_end time; v_zone text; v_start_at timestamptz; v_end_at timestamptz;
begin
  if not public.is_manager() and not (coalesce(public.current_role(),'')='Team Lead' and public.leads_event(p_event_id)) then raise exception 'Not authorized' using errcode='42501'; end if;
  select event_date,end_time,time_zone into v_date,v_end,v_zone from public.events where id=p_event_id and status<>'Cancelled';
  if not found or not exists(select 1 from public.profiles where id=p_user_id and active) then raise exception 'Event or active team member not found'; end if;
  v_start_at:=(v_date+p_arrival_time) at time zone v_zone; v_end_at:=(v_date+v_end) at time zone v_zone;
  if exists(select 1 from public.role_assignments a join public.events e on e.id=a.event_id where a.user_id=p_user_id and e.status not in ('Cancelled','Completed')
    and tstzrange(v_start_at,v_end_at,'[)') && tstzrange((e.event_date+a.arrival_time) at time zone e.time_zone,(e.event_date+e.end_time) at time zone e.time_zone,'[)')) then
    raise exception 'Assignment time conflict'; end if;
  select id into v_role from public.role_definitions where name=p_role_name and active limit 1;
  insert into public.role_assignments(event_id,user_id,role_definition_id,role_name,arrival_time,instructions,backup_user_id,assigned_by)
  values(p_event_id,p_user_id,v_role,p_role_name,p_arrival_time,coalesce(p_instructions,''),p_backup_user_id,auth.uid()) returning id into v_assignment;
  insert into public.checklist_instances(event_id,assignment_id,title,role_name,created_by) values(p_event_id,v_assignment,p_role_name||' checklist',p_role_name,auth.uid()) returning id into v_checklist;
  insert into public.checklist_items(instance_id,step_order,label,is_required,assigned_user_id,assigned_role)
    select v_checklist,step_order,label,is_required,p_user_id,p_role_name from public.role_checklist_templates where role_name=p_role_name and active order by step_order;
  if not found then insert into public.checklist_items(instance_id,step_order,label,is_required,assigned_user_id,assigned_role) values
    (v_checklist,1,'Review event instructions',true,p_user_id,p_role_name),(v_checklist,2,'Check assigned equipment and report faults',true,p_user_id,p_role_name),(v_checklist,3,'Confirm readiness with the event lead',true,p_user_id,p_role_name); end if;
  insert into public.notifications(user_id,title,body,href) values(p_user_id,'New event assignment',p_role_name||' · '||(select title from public.events where id=p_event_id),'assignments');
  return v_assignment;
end; $$;

insert into public.role_checklist_templates(role_name,step_order,label) values
('Production Director',1,'Confirm production plan with event lead'),('Production Director',2,'Verify crew assignments and arrival times'),('Production Director',3,'Complete readiness check before doors open'),
('Camera Operator',1,'Inspect camera, lens, tripod, and cables'),('Camera Operator',2,'Check framing, focus, and exposure'),('Camera Operator',3,'Confirm recording or tally status with director'),
('PTZ Camera Operator',1,'Confirm camera control and presets'),('PTZ Camera Operator',2,'Verify framing with production director'),('PTZ Camera Operator',3,'Check movement and communication path'),
('Video Switcher Operator',1,'Verify input names and signal presence'),('Video Switcher Operator',2,'Confirm program and preview outputs'),('Video Switcher Operator',3,'Run transition and audio-follow checks'),
('Livestream Operator',1,'Confirm approved destination and stream details'),('Livestream Operator',2,'Check stream health and program audio'),('Livestream Operator',3,'Confirm stream is live with event lead'),
('Audio Operator',1,'Inspect microphones and batteries'),('Audio Operator',2,'Verify routing and monitor levels'),('Audio Operator',3,'Complete line check before doors open'),
('Recording Operator',1,'Confirm media capacity and recording destination'),('Recording Operator',2,'Start a short test recording'),('Recording Operator',3,'Verify file playback and backup plan'),
('Lighting Operator',1,'Inspect fixtures and power connections'),('Lighting Operator',2,'Confirm approved lighting state'),('Lighting Operator',3,'Check safe cable routing'),
('Content Editor',1,'Confirm source files and event label'),('Content Editor',2,'Verify backup location before editing'),('Content Editor',3,'Add edit notes for reviewer'),
('Publishing Operator',1,'Confirm reviewer approval'),('Publishing Operator',2,'Check title, description, and captions'),('Publishing Operator',3,'Record the final publication link'),
('Equipment / Setup Operator',1,'Inspect assigned equipment condition'),('Equipment / Setup Operator',2,'Confirm asset IDs against checkout'),('Equipment / Setup Operator',3,'Report faults before deployment') on conflict do nothing;

create or replace function public.acknowledge_assignment(p_assignment_id uuid,p_response text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(public.current_role(),'') not in ('Operator','Trainee') or p_response not in ('Accepted','Declined') then raise exception 'Not authorized' using errcode='42501'; end if;
  update public.role_assignments set response_status=p_response,acknowledged_at=now() where id=p_assignment_id and user_id=auth.uid();
  if not found then raise exception 'Assignment not found or not yours'; end if;
end; $$;

create or replace function public.complete_checklist_item(p_item_id uuid,p_status text,p_notes text default '') returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_event uuid; v_instance uuid; v_required boolean;
begin
  if coalesce(public.current_role(),'') not in ('Administrator','Media Director','Team Lead','Operator','Trainee') then raise exception 'Not authorized' using errcode='42501'; end if;
  if p_status not in ('Outstanding','Complete','Needs attention') then raise exception 'Invalid check state'; end if;
  select ci.event_id,ci.id,i.is_required into v_event,v_instance,v_required from public.checklist_items i join public.checklist_instances ci on ci.id=i.instance_id where i.id=p_item_id;
  if not found then raise exception 'Checklist item not found'; end if;
  if not public.is_manager() and not (coalesce(public.current_role(),'')='Team Lead' and (public.leads_event(v_event) or public.assigned_to_event(v_event)))
    and not exists(select 1 from public.checklist_items i where i.id=p_item_id and i.assigned_user_id=auth.uid()) then raise exception 'Not authorized' using errcode='42501'; end if;
  if p_status='Needs attention' and v_required and length(trim(coalesce(p_notes,'')))<5 then raise exception 'Describe the failed required check'; end if;
  update public.checklist_items set status=p_status,notes=case when nullif(trim(p_notes),'') is not null then nullif(trim(p_notes),'') when p_status='Outstanding' then null else notes end,completed_at=case when p_status='Outstanding' then null else now() end,completed_by=case when p_status='Outstanding' then null else auth.uid() end where id=p_item_id;
  update public.checklist_instances ci set status=case
    when exists(select 1 from public.checklist_items i where i.instance_id=v_instance and i.is_required and i.status='Needs attention') then 'Needs attention'
    when not exists(select 1 from public.checklist_items i where i.instance_id=v_instance and i.is_required and i.status<>'Complete') then 'Ready' else 'In progress' end where ci.id=v_instance;
end; $$;

create or replace function public.reserve_equipment_asset(p_asset_id uuid,p_event_id uuid,p_custodian_id uuid) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; e public.events%rowtype; a public.equipment_assets%rowtype;
begin
  if not public.is_staff() or not public.can_access_event(p_event_id) then raise exception 'Not authorized for this event' using errcode='42501'; end if;
  select * into e from public.events where id=p_event_id and status not in ('Cancelled','Completed');
  if not found then raise exception 'Event not found'; end if;
  select * into a from public.equipment_assets where id=p_asset_id for update;
  if not found or a.status in ('Under maintenance','Damaged','Missing','Retired') then raise exception 'Asset is not available'; end if;
  insert into public.equipment_reservations(asset_id,event_id,start_at,end_at,status,custodian_id,reserved_by)
    values(p_asset_id,p_event_id,(e.event_date+e.setup_time) at time zone e.time_zone,(e.event_date+e.end_time) at time zone e.time_zone,'Reserved',p_custodian_id,auth.uid()) returning id into v_id;
  update public.equipment_assets set status='Reserved' where id=p_asset_id and status='Available'; return v_id;
exception when exclusion_violation then raise exception 'Asset is already reserved during this time' using errcode='23P01';
end; $$;

create or replace function public.checkout_equipment(p_reservation_id uuid,p_custodian_id uuid,p_condition text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.equipment_reservations%rowtype; a public.equipment_assets%rowtype;
begin
  if not public.is_staff() then raise exception 'Not authorized' using errcode='42501'; end if;
  select * into r from public.equipment_reservations where id=p_reservation_id for update;
  if not found or r.status<>'Reserved' or not public.can_access_event(r.event_id) then raise exception 'Reservation not active or not authorized'; end if;
  select * into a from public.equipment_assets where id=r.asset_id for update;
  if a.condition<>'Good' or p_condition<>'Good' then raise exception 'Resolve asset condition before checkout'; end if;
  insert into public.equipment_checkouts(reservation_id,asset_id,event_id,checked_out_by,custodian_id,checkout_condition) values(r.id,r.asset_id,r.event_id,auth.uid(),p_custodian_id,p_condition);
  update public.equipment_reservations set status='Checked out',custodian_id=p_custodian_id where id=r.id;
  update public.equipment_assets set status='Checked out',current_custodian_id=p_custodian_id where id=a.id;
end; $$;

create or replace function public.return_equipment(p_reservation_id uuid,p_condition text,p_notes text default '') returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.equipment_reservations%rowtype; c public.equipment_checkouts%rowtype;
begin
  if not public.is_staff() then raise exception 'Not authorized' using errcode='42501'; end if;
  select * into r from public.equipment_reservations where id=p_reservation_id for update;
  if not found or r.status<>'Checked out' or not public.can_access_event(r.event_id) then raise exception 'Checkout not active or not authorized'; end if;
  select * into c from public.equipment_checkouts where reservation_id=r.id for update;
  if not found or exists(select 1 from public.equipment_returns where checkout_id=c.id) then raise exception 'Return already recorded'; end if;
  if p_condition not in ('Good','Needs service','Damaged') then raise exception 'Select an inspected return condition'; end if;
  insert into public.equipment_returns(checkout_id,return_condition,notes,inspected_by) values(c.id,p_condition,coalesce(p_notes,''),auth.uid());
  update public.equipment_reservations set status='Returned' where id=r.id;
  update public.equipment_assets set condition=p_condition,status=case when p_condition<>'Good' then 'Under maintenance' when exists(select 1 from public.equipment_reservations future where future.asset_id=r.asset_id and future.id<>r.id and future.status='Reserved') then 'Reserved' else 'Available' end,current_custodian_id=null where id=r.asset_id;
  if p_condition<>'Good' then insert into public.maintenance_records(asset_id,opened_by,description,notes) values(r.asset_id,auth.uid(),'Issue found during equipment return',coalesce(p_notes,'')); end if;
end; $$;

create or replace function public.create_sop_draft(p_title text,p_category text,p_purpose text,p_steps text[]) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_sop uuid; v_version uuid; v_step text; i integer:=0;
begin
  if not public.is_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  if length(trim(p_title))<3 or length(trim(p_purpose))<10 then raise exception 'SOP title and purpose are required'; end if;
  insert into public.sops(title,category,author_id) values(trim(p_title),p_category,auth.uid()) returning id into v_sop;
  insert into public.sop_versions(sop_id,version,purpose,authored_by) values(v_sop,1,p_purpose,auth.uid()) returning id into v_version;
  foreach v_step in array coalesce(p_steps,'{}') loop i:=i+1; insert into public.sop_steps(sop_version_id,step_number,instruction) values(v_version,i,v_step); end loop;
  update public.sops set current_version_id=v_version where id=v_sop; return v_sop;
end; $$;
create or replace function public.publish_sop_version(p_sop_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_version uuid;
begin
  if not public.is_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  select current_version_id into v_version from public.sops where id=p_sop_id for update;
  if v_version is null then raise exception 'SOP version not found'; end if;
  update public.sop_versions set status='Published',reviewed_by=auth.uid(),reviewed_at=now() where id=v_version;
  update public.sops set status='Published' where id=p_sop_id;
end; $$;

create or replace function public.transition_content_stage(p_content_id uuid,p_stage text,p_backup_location text default '',p_verification_note text default '',p_storage_link text default '') returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.content_projects%rowtype; v_allowed boolean;
begin
  select * into c from public.content_projects where id=p_content_id for update;
  if not found then raise exception 'Content project not found'; end if;
  if not public.is_manager() and c.assigned_editor_id is distinct from auth.uid() and c.assigned_reviewer_id is distinct from auth.uid() then raise exception 'Not authorized' using errcode='42501'; end if;
  v_allowed:=(c.stage='Recording pending verification' and p_stage='Files transferred') or (c.stage='Files transferred' and p_stage='Backup verified')
    or (c.stage='Backup verified' and p_stage='Editing') or (c.stage='Editing' and p_stage='Awaiting review')
    or (c.stage='Awaiting review' and p_stage in ('Revisions requested','Approved')) or (c.stage='Revisions requested' and p_stage='Editing')
    or (c.stage='Approved' and p_stage='Scheduled') or (c.stage='Scheduled' and p_stage='Published') or (c.stage='Published' and p_stage='Archived');
  if not v_allowed then raise exception 'Invalid content workflow transition' using errcode='23514'; end if;
  if p_stage='Backup verified' and (length(trim(p_backup_location))<3 or length(trim(p_verification_note))<8) then raise exception 'Backup location and verification are required'; end if;
  if p_stage in ('Revisions requested','Approved') and not public.is_manager() and c.assigned_reviewer_id<>auth.uid() then raise exception 'Only the assigned reviewer can review content' using errcode='42501'; end if;
  if p_stage in ('Scheduled','Published','Archived') and not public.is_manager() then raise exception 'Only an authorized director can publish content' using errcode='42501'; end if;
  update public.content_projects set stage=p_stage,storage_link=coalesce(nullif(p_storage_link,''),storage_link),
    backup_location=case when p_stage='Backup verified' then p_backup_location else backup_location end,
    backup_verification_note=case when p_stage='Backup verified' then p_verification_note else backup_verification_note end,
    backup_verified_at=case when p_stage='Backup verified' then now() else backup_verified_at end where id=p_content_id;
  insert into public.content_workflow_history(content_project_id,from_stage,to_stage,actor_id,note) values(p_content_id,c.stage,p_stage,auth.uid(),nullif(p_verification_note,''));
end; $$;

