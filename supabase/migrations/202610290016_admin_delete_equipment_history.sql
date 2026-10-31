-- Let administrators remove one returned handoff record or all returned
-- handoff history for an asset. Active loans remain protected.
create or replace function public.admin_delete_equipment_history(
  p_asset_id uuid,
  p_loan_id uuid default null
) returns integer
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
declare
  v_deleted integer;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id=auth.uid() and p.active
      and (p.role='Administrator' or 'Administrator'=any(p.access_roles))
  ) then
    raise exception 'Only an administrator can delete equipment history' using errcode='42501';
  end if;

  if p_loan_id is not null then
    -- Match the return workflow's loan-then-asset lock order.
    perform 1 from public.equipment_loans
      where id=p_loan_id and asset_id=p_asset_id for update;
    if not found then
      raise exception 'Equipment history record not found' using errcode='P0002';
    end if;

    perform 1 from public.equipment_assets where id=p_asset_id for update;
    if not found then
      raise exception 'Equipment record not found' using errcode='P0002';
    end if;

    if not exists(select 1 from public.equipment_loan_returns where loan_id=p_loan_id) then
      raise exception 'Return this equipment before deleting its handoff history' using errcode='23503';
    end if;

    delete from public.equipment_loan_returns where loan_id=p_loan_id;
    delete from public.equipment_loans where id=p_loan_id and asset_id=p_asset_id;
    get diagnostics v_deleted = row_count;
    return v_deleted;
  end if;

  -- Lock loan rows before the asset, as the return workflow locks a loan first.
  perform 1 from public.equipment_loans
    where asset_id=p_asset_id order by id for update;
  perform 1 from public.equipment_assets where id=p_asset_id for update;
  if not found then
    raise exception 'Equipment record not found' using errcode='P0002';
  end if;

  if exists(
    select 1 from public.equipment_loans l
    where l.asset_id=p_asset_id
      and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id)
  ) then
    raise exception 'Return all borrowed equipment before deleting its full history' using errcode='23503';
  end if;

  delete from public.equipment_loan_returns r
    using public.equipment_loans l
    where r.loan_id=l.id and l.asset_id=p_asset_id;
  delete from public.equipment_loans where asset_id=p_asset_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.admin_delete_equipment_history(uuid,uuid) from public,anon;
grant execute on function public.admin_delete_equipment_history(uuid,uuid) to authenticated;
