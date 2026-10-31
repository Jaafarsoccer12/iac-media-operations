-- Allow authenticated administrators to permanently delete an incident.
-- The existing incident delete trigger records the deletion in the audit log.
create or replace function public.admin_delete_incident(p_incident_id uuid)
returns void
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id=auth.uid() and p.active
      and (p.role='Administrator' or 'Administrator'=any(p.access_roles))
  ) then
    raise exception 'Only an administrator can delete incidents' using errcode='42501';
  end if;

  perform 1 from public.incidents where id=p_incident_id for update;
  if not found then
    raise exception 'Incident not found' using errcode='P0002';
  end if;

  delete from public.incidents where id=p_incident_id;
end;
$$;

revoke execute on function public.admin_delete_incident(uuid) from public,anon;
grant execute on function public.admin_delete_incident(uuid) to authenticated;
