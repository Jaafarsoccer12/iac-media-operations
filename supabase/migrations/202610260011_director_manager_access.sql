-- Give Directors manager-level operational access while reserving Administrator accounts.
create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path=public,pg_temp set row_security=off as $$
  select exists (
    select 1 from public.profiles p
    where p.id=auth.uid() and p.active
      and (p.role in ('Administrator','Director') or p.access_roles && array['Administrator','Director']::text[])
  )
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path=public,pg_temp set row_security=off as $$
  select exists (
    select 1 from public.profiles p
    where p.id=auth.uid() and p.active
      and (p.role in ('Administrator','Director') or p.access_roles && array['Administrator','Director']::text[])
  )
$$;

grant execute on function public.is_manager() to authenticated;
grant execute on function public.is_staff() to authenticated;

-- Directors can see manager-level reports and audit history.
drop policy if exists audit_admin_select on public.audit_logs;
create policy audit_admin_select on public.audit_logs for select to authenticated using(public.is_manager());
drop policy if exists events_delete_admin on public.events;
create policy events_delete_admin on public.events for delete to authenticated using(public.is_manager());

-- Directors need the same team-wide checklist and inventory visibility as administrators.
drop policy if exists checklist_instances_select on public.checklist_instances;
create policy checklist_instances_select on public.checklist_instances for select to authenticated using(
  public.is_manager() or
  exists(select 1 from public.role_assignments a where a.id=assignment_id and a.user_id=auth.uid())
);
drop policy if exists checklist_items_select on public.checklist_items;
create policy checklist_items_select on public.checklist_items for select to authenticated using(
  assigned_user_id=auth.uid() or public.is_manager()
);
drop policy if exists equipment_assets_update_admin on public.equipment_assets;
create policy equipment_assets_update_manager on public.equipment_assets for update to authenticated
  using(public.is_manager()) with check(public.is_manager());

-- Let Directors manage non-administrator accounts through the connected app.
drop policy if exists profiles_update_director_non_admin on public.profiles;
create policy profiles_update_director_non_admin on public.profiles for update to authenticated
  using(
    public.is_manager() and public.current_role()<>'Administrator'
    and role<>'Administrator' and not ('Administrator'=any(access_roles))
  )
  with check(
    public.is_manager() and public.current_role()<>'Administrator'
    and role<>'Administrator' and not ('Administrator'=any(access_roles))
  );

create or replace function public.guard_profile_privileges() returns trigger
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_actor_is_admin boolean;
  v_actor_is_director boolean;
  v_target_is_admin boolean;
  v_next_is_admin boolean;
begin
  select coalesce(p.role='Administrator' or 'Administrator'=any(p.access_roles),false),
         coalesce(p.role='Director' or 'Director'=any(p.access_roles),false)
    into v_actor_is_admin,v_actor_is_director
    from public.profiles p where p.id=auth.uid() and p.active;
  v_actor_is_admin := coalesce(v_actor_is_admin,false);
  v_actor_is_director := coalesce(v_actor_is_director,false);
  v_target_is_admin := coalesce(old.role='Administrator' or 'Administrator'=any(old.access_roles),false);
  v_next_is_admin := coalesce(new.role='Administrator' or 'Administrator'=any(new.access_roles),false);

  if (new.role is distinct from old.role or new.access_roles is distinct from old.access_roles
      or new.active is distinct from old.active or new.qualification_status is distinct from old.qualification_status)
    and session_user not in ('postgres','supabase_admin','service_role')
    and current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    and not v_actor_is_admin
    and not (v_actor_is_director and not v_target_is_admin and not v_next_is_admin) then
    raise exception 'Only an administrator can change an administrator account or grant administrator access' using errcode='42501';
  end if;
  return new;
end; $$;

revoke execute on function public.guard_profile_privileges() from public,anon,authenticated;

-- Existing incident editors can revise any non-administrator incident record.
drop policy if exists incidents_update_manager_full on public.incidents;
create policy incidents_update_manager_full on public.incidents for update to authenticated
  using(public.is_manager()) with check(public.is_manager());
