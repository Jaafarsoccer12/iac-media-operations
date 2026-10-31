alter table public.time_alarms
  add column if not exists completed_at timestamptz;

create or replace function public.process_due_time_alarms()
returns integer
language plpgsql security definer set search_path = public, pg_temp set row_security = off as $$
declare
  v_alarm record;
  v_visible_count integer := 0;
begin
  if auth.uid() is null then raise exception 'Sign in to process due alarms' using errcode = '42501'; end if;
  for v_alarm in
    select id, user_id, description, fire_at
      from public.time_alarms
      where fire_at <= now() and triggered_at is null and cancelled_at is null and completed_at is null
        and (user_id = auth.uid() or public.is_manager())
      order by fire_at
      for update skip locked
  loop
    update public.time_alarms set triggered_at = now() where id = v_alarm.id;
    insert into public.notifications(user_id, title, body, href)
      values (
        v_alarm.user_id,
        'Alarm: ' || v_alarm.description,
        'Your alarm is due · ' || to_char(v_alarm.fire_at at time zone 'America/New_York', 'Mon DD, YYYY HH12:MI AM') || ' center time · Mark the task complete to stop reminders.',
        'time-alarm:' || v_alarm.id::text
      );
    if v_alarm.user_id = auth.uid() or public.is_manager() then v_visible_count := v_visible_count + 1; end if;
  end loop;
  return v_visible_count;
end;
$$;

create or replace function public.complete_time_alarm(p_alarm_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp set row_security = off as $$
declare
  v_changed boolean := false;
begin
  if auth.uid() is null then raise exception 'Sign in to complete an alarm' using errcode = '42501'; end if;
  update public.time_alarms
    set completed_at = now()
    where id = p_alarm_id
      and user_id = auth.uid()
      and triggered_at is not null
      and cancelled_at is null
      and completed_at is null;
  v_changed := found;
  if v_changed then
    update public.notifications
      set read_at = coalesce(read_at, now())
      where user_id = auth.uid()
        and href = 'time-alarm:' || p_alarm_id::text;
  end if;
  return v_changed;
end;
$$;

revoke execute on function public.process_due_time_alarms() from public, anon;
revoke execute on function public.complete_time_alarm(uuid) from public, anon;
grant execute on function public.process_due_time_alarms() to authenticated;
grant execute on function public.complete_time_alarm(uuid) to authenticated;
