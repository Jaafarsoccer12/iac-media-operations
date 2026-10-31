-- Allow authorized equipment managers to remove unused inventory records.
-- Keep any asset linked to operational history so loans, checkouts, and
-- maintenance records remain valid. Incident rows are preserved by SET NULL.
create or replace function public.delete_equipment_asset(p_asset_id uuid) returns void
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
begin
  if not (public.is_manager() or public.has_equipment_manager_role()) then
    raise exception 'Only an administrator, director, or equipment manager can delete equipment' using errcode='42501';
  end if;

  perform 1 from public.equipment_assets where id=p_asset_id for update;
  if not found then
    raise exception 'Equipment record not found' using errcode='P0002';
  end if;

  if exists(select 1 from public.equipment_loans where asset_id=p_asset_id)
    or exists(select 1 from public.equipment_reservations where asset_id=p_asset_id)
    or exists(select 1 from public.equipment_checkouts where asset_id=p_asset_id)
    or exists(select 1 from public.maintenance_records where asset_id=p_asset_id) then
    raise exception 'This equipment has borrowing, checkout, reservation, or maintenance history and cannot be deleted.' using errcode='23503';
  end if;

  delete from public.equipment_assets where id=p_asset_id;
end;
$$;

revoke execute on function public.delete_equipment_asset(uuid) from public,anon;
grant execute on function public.delete_equipment_asset(uuid) to authenticated;
