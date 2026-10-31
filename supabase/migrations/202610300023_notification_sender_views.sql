alter table public.notifications
  add column if not exists sender_id uuid references public.profiles(id) on delete set null;

alter table public.notifications
  alter column sender_id set default auth.uid();

create index if not exists notifications_sender_created_idx
  on public.notifications(sender_id, created_at desc)
  where sender_id is not null;

create or replace function public.process_due_time_alarms()
returns integer
language plpgsql security definer set search_path = public, pg_temp set row_security = off as $$
declare
  v_alarm record;
  v_visible_count integer := 0;
begin
  if auth.uid() is null then raise exception 'Sign in to process due alarms' using errcode = '42501'; end if;
  for v_alarm in
    select id, user_id, created_by, description, fire_at
      from public.time_alarms
      where fire_at <= now() and triggered_at is null and cancelled_at is null and completed_at is null
        and (user_id = auth.uid() or public.is_manager())
      order by fire_at
      for update skip locked
  loop
    update public.time_alarms set triggered_at = now() where id = v_alarm.id;
    insert into public.notifications(user_id, sender_id, title, body, href)
      values (
        v_alarm.user_id,
        v_alarm.created_by,
        'Alarm: ' || v_alarm.description,
        'Your alarm is due · ' || to_char(v_alarm.fire_at at time zone 'America/New_York', 'Mon DD, YYYY HH12:MI AM') || ' center time · Mark the task complete to stop reminders.',
        'time-alarm:' || v_alarm.id::text
      );
    if v_alarm.user_id = auth.uid() or public.is_manager() then v_visible_count := v_visible_count + 1; end if;
  end loop;
  return v_visible_count;
end;
$$;

revoke execute on function public.process_due_time_alarms() from public, anon;
grant execute on function public.process_due_time_alarms() to authenticated;
