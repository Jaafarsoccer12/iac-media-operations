-- Planning events may not have a confirmed program schedule yet. Published
-- events remain protected by the publication checks below.
alter table public.events alter column start_time drop not null;
alter table public.events alter column end_time drop not null;
alter table public.events alter column setup_time drop not null;

create or replace function public.create_event_with_notes(
 p_title text,p_category text,p_event_date date,p_start_time time,p_end_time time,p_setup_time time,p_time_zone text,p_venue text,p_event_lead_id uuid,
 p_description text,p_livestream_required boolean,p_recording_required boolean,p_photography_required boolean,p_public_information text,p_private_notes text
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
  if not public.is_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  if (p_start_time is null) <> (p_end_time is null) then raise exception 'Enter both an event start time and end time, or leave both for later'; end if;
  if p_start_time is not null and p_end_time <= p_start_time then raise exception 'End time must be after start time'; end if;
  insert into public.events(title,category,event_date,start_time,end_time,setup_time,time_zone,venue,event_lead_id,description,livestream_required,recording_required,photography_required,public_information,created_by)
  values(trim(p_title),p_category,p_event_date,p_start_time,p_end_time,p_setup_time,p_time_zone,trim(p_venue),p_event_lead_id,p_description,p_livestream_required,p_recording_required,p_photography_required,p_public_information,auth.uid()) returning id into v_id;
  insert into public.event_private_notes(event_id,notes,updated_by) values(v_id,coalesce(p_private_notes,''),auth.uid());
  return v_id;
end; $$;

create or replace function public.update_event_with_notes(
 p_event_id uuid,p_title text,p_category text,p_event_date date,p_start_time time,p_end_time time,p_setup_time time,p_time_zone text,p_venue text,p_event_lead_id uuid,
 p_description text,p_livestream_required boolean,p_recording_required boolean,p_photography_required boolean,p_public_information text,p_private_notes text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare old_row public.events%rowtype; v_changed boolean; v_schedule_complete boolean;
begin
  if not public.is_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  if (p_start_time is null) <> (p_end_time is null) then raise exception 'Enter both an event start time and end time, or leave both for later'; end if;
  if p_start_time is not null and p_end_time <= p_start_time then raise exception 'End time must be after start time'; end if;
  select * into old_row from public.events where id=p_event_id for update;
  if not found then raise exception 'Event not found'; end if;
  v_schedule_complete := p_start_time is not null and p_end_time is not null and p_setup_time is not null and trim(p_venue) <> '' and trim(p_venue) <> 'To be confirmed';
  if old_row.status='Published' and not v_schedule_complete then raise exception 'Add the event times and venue before keeping the schedule published'; end if;
  v_changed:=old_row.event_date is distinct from p_event_date or old_row.start_time is distinct from p_start_time or old_row.end_time is distinct from p_end_time or old_row.setup_time is distinct from p_setup_time or old_row.time_zone is distinct from p_time_zone or old_row.venue is distinct from p_venue;
  if v_changed and v_schedule_complete and exists(
    select 1 from public.role_assignments a
    where a.event_id=p_event_id and exists(
      select 1 from public.role_assignments other_assignment join public.events other on other.id=other_assignment.event_id
      where other_assignment.user_id=a.user_id and other.id<>p_event_id and other.status not in ('Cancelled','Completed')
        and other_assignment.arrival_time is not null and other.end_time is not null
        and tstzrange((p_event_date+p_setup_time) at time zone p_time_zone,(p_event_date+p_end_time) at time zone p_time_zone,'[)') &&
            tstzrange((other.event_date+other_assignment.arrival_time) at time zone other.time_zone,(other.event_date+other.end_time) at time zone other.time_zone,'[)')
    )
  ) then raise exception 'Schedule change conflicts with a team assignment'; end if;
  update public.events set title=trim(p_title),category=p_category,event_date=p_event_date,start_time=p_start_time,end_time=p_end_time,setup_time=p_setup_time,time_zone=p_time_zone,
    venue=trim(p_venue),event_lead_id=p_event_lead_id,description=p_description,livestream_required=p_livestream_required,
    recording_required=p_recording_required,photography_required=p_photography_required,public_information=p_public_information where id=p_event_id;
  if v_changed and v_schedule_complete then
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
  update public.events set status='Published'
    where id=p_event_id and status='Planning' and start_time is not null and end_time is not null and setup_time is not null
      and trim(venue)<>'' and trim(venue)<>'To be confirmed'
    returning title into v_title;
  if v_title is null then raise exception 'Add the event times and venue before publishing the schedule'; end if;
  insert into public.notifications(user_id,title,body,href) select a.user_id,'Schedule published',v_title||' · '||a.role_name,'assignments' from public.role_assignments a where a.event_id=p_event_id;
end; $$;
