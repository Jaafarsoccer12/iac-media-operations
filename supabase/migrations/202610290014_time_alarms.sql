create table public.time_alarms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  fire_at timestamptz not null,
  description text not null check (length(trim(description)) between 1 and 180),
  triggered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);

create index time_alarms_pending_fire_at_idx
  on public.time_alarms(fire_at)
  where triggered_at is null and cancelled_at is null;

alter table public.time_alarms enable row level security;
grant select, insert on public.time_alarms to authenticated;

create policy time_alarms_select_own_or_manager on public.time_alarms
  for select to authenticated
  using (user_id = auth.uid() or public.is_manager());

create policy time_alarms_insert_own_or_manager on public.time_alarms
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (user_id = auth.uid() or public.is_manager())
    and exists (select 1 from public.profiles p where p.id = user_id and p.active)
  );

create or replace function public.cancel_time_alarm(p_alarm_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp set row_security = off as $$
declare
  v_changed boolean := false;
begin
  if auth.uid() is null then raise exception 'Sign in to cancel an alarm' using errcode = '42501'; end if;
  update public.time_alarms
    set cancelled_at = now()
    where id = p_alarm_id
      and triggered_at is null and cancelled_at is null
      and (user_id = auth.uid() or public.is_manager());
  v_changed := found;
  return v_changed;
end;
$$;

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
      where fire_at <= now() and triggered_at is null and cancelled_at is null
        and (user_id = auth.uid() or public.is_manager())
      order by fire_at
      for update skip locked
  loop
    update public.time_alarms set triggered_at = now() where id = v_alarm.id;
    insert into public.notifications(user_id, title, body, href)
      values (
        v_alarm.user_id,
        'Alarm: ' || v_alarm.description,
        'Your alarm is due · ' || to_char(v_alarm.fire_at at time zone 'America/New_York', 'Mon DD, YYYY HH12:MI AM') || ' center time',
        'time'
      );
    if v_alarm.user_id = auth.uid() or public.is_manager() then v_visible_count := v_visible_count + 1; end if;
  end loop;
  return v_visible_count;
end;
$$;

revoke execute on function public.cancel_time_alarm(uuid) from public, anon;
revoke execute on function public.process_due_time_alarms() from public, anon;
grant execute on function public.cancel_time_alarm(uuid) to authenticated;
grant execute on function public.process_due_time_alarms() to authenticated;
