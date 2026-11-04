-- Let active crew see the names and attendance responses on published events
-- without granting broader access to profile rows or private profile data.
create or replace function public.list_event_attendance_crew()
returns table (
  id uuid,
  full_name text,
  role text,
  job_title text
)
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select distinct p.id, p.full_name, p.role, p.job_title
  from public.profiles p
  where public.current_role() is not null
    and exists (
      select 1
      from public.role_assignments a
      join public.events e on e.id = a.event_id
      where a.user_id = p.id
        and e.status in ('Published', 'Completed')
    )
  order by p.full_name;
$$;

revoke all on function public.list_event_attendance_crew() from public, anon;
grant execute on function public.list_event_attendance_crew() to authenticated;
