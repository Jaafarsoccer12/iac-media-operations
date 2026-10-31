-- Track grouped stock as one inventory record with a count, while keeping
-- each person's handoff quantity in its own loan record.
alter table public.equipment_assets
  add column if not exists quantity integer not null default 1;
alter table public.equipment_loans
  add column if not exists quantity integer not null default 1;

do $$
begin
  if not exists(select 1 from pg_constraint where conname='equipment_assets_quantity_check') then
    alter table public.equipment_assets add constraint equipment_assets_quantity_check
      check(quantity between 1 and 10000);
  end if;
  if not exists(select 1 from pg_constraint where conname='equipment_loans_quantity_check') then
    alter table public.equipment_loans add constraint equipment_loans_quantity_check
      check(quantity between 1 and 10000);
  end if;
end;
$$;

grant update(quantity) on public.equipment_assets to authenticated;

create or replace function public.enforce_equipment_quantity_not_below_active_loans()
returns trigger
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
declare
  v_active_count integer;
  v_borrowed_quantity integer;
begin
  select count(distinct l.borrower_id)::integer, coalesce(sum(l.quantity),0)::integer
    into v_active_count, v_borrowed_quantity
  from public.equipment_loans l
  where l.asset_id=new.id
    and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id);

  if new.quantity < v_borrowed_quantity then
    raise exception 'Quantity cannot be lower than the units currently borrowed.' using errcode='23514';
  end if;

  if new.condition='Good' and new.status in ('Available','Checked out') then
    new.status := case when v_borrowed_quantity >= new.quantity then 'Checked out' else 'Available' end;
  end if;

  if v_active_count=1 then
    select l.borrower_id into new.current_custodian_id
    from public.equipment_loans l
    where l.asset_id=new.id
      and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id)
    limit 1;
  elsif v_active_count>1 then
    new.current_custodian_id := null;
  end if;

  return new;
end;
$$;

drop trigger if exists equipment_quantity_guard on public.equipment_assets;
create trigger equipment_quantity_guard
  before update of quantity,condition on public.equipment_assets
  for each row execute function public.enforce_equipment_quantity_not_below_active_loans();

drop function if exists public.issue_equipment_to_person(uuid,uuid,date,text,timestamptz);
create function public.issue_equipment_to_person(
  p_asset_id uuid,
  p_borrower_id uuid,
  p_due_date date default null,
  p_checkout_notes text default '',
  p_issued_at timestamptz default now(),
  p_quantity integer default 1
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
declare
  v_asset public.equipment_assets%rowtype;
  v_borrower public.profiles%rowtype;
  v_loan_id uuid;
  v_borrowed_quantity integer;
  v_active_count integer;
  v_active_custodian uuid;
begin
  if not public.is_staff() and not public.has_equipment_manager_role() then
    raise exception 'Only the equipment checkout crew can hand out equipment' using errcode='42501';
  end if;
  if p_due_date is not null and p_due_date < current_date then raise exception 'Due date must be today or later'; end if;
  if p_issued_at is null then raise exception 'Choose a handoff date'; end if;
  if p_quantity is null or p_quantity not between 1 and 10000 then raise exception 'Enter a valid handoff quantity'; end if;
  if length(coalesce(p_checkout_notes,'')) > 1000 then raise exception 'Handoff notes are too long'; end if;

  select * into v_borrower from public.profiles where id=p_borrower_id and active;
  if not found or v_borrower.role='Event Organizer' then raise exception 'Choose an active media team member'; end if;
  select * into v_asset from public.equipment_assets where id=p_asset_id for update;
  if not found or v_asset.condition<>'Good' or v_asset.status in ('Under maintenance','Damaged','Missing','Retired','Reserved') then
    raise exception 'Equipment is not available to hand out';
  end if;

  select count(distinct l.borrower_id)::integer, coalesce(sum(l.quantity),0)::integer
    into v_active_count, v_borrowed_quantity
  from public.equipment_loans l
  where l.asset_id=p_asset_id
    and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id);
  if p_quantity > v_asset.quantity-v_borrowed_quantity then
    raise exception 'Not enough units are available to hand out';
  end if;

  insert into public.equipment_loans(asset_id,borrower_id,issued_by,issued_at,due_date,quantity,checkout_condition,checkout_notes)
    values(p_asset_id,p_borrower_id,auth.uid(),p_issued_at,p_due_date,p_quantity,v_asset.condition,coalesce(p_checkout_notes,'')) returning id into v_loan_id;
  select count(distinct l.borrower_id)::integer, coalesce(sum(l.quantity),0)::integer
    into v_active_count, v_borrowed_quantity
  from public.equipment_loans l
  where l.asset_id=p_asset_id
    and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id);
  if v_active_count=1 then
    select l.borrower_id into v_active_custodian
    from public.equipment_loans l
    where l.asset_id=p_asset_id
      and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id)
    limit 1;
  end if;
  update public.equipment_assets
    set status=case when v_borrowed_quantity>=quantity then 'Checked out' else 'Available' end,
        current_custodian_id=v_active_custodian
    where id=p_asset_id;
  insert into public.notifications(user_id,title,body,href)
    values(p_borrower_id,'Equipment handed to you',p_quantity || ' × ' || v_asset.name || ' · recorded by the checkout crew','equipment');
  return v_loan_id;
end;
$$;

create or replace function public.return_borrowed_equipment(
  p_loan_id uuid, p_return_condition text, p_notes text default ''
) returns void
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
declare
  v_loan public.equipment_loans%rowtype;
  v_asset public.equipment_assets%rowtype;
  v_active_count integer;
  v_borrowed_quantity integer;
  v_active_custodian uuid;
begin
  if not public.is_staff() and not public.has_equipment_manager_role() then
    raise exception 'Only the equipment checkout crew can record a return' using errcode='42501';
  end if;
  if p_return_condition not in ('Good','Needs service','Damaged') then raise exception 'Select an inspected return condition'; end if;
  if length(coalesce(p_notes,'')) > 1000 then raise exception 'Inspection notes are too long'; end if;
  select * into v_loan from public.equipment_loans where id=p_loan_id for update;
  if not found or exists(select 1 from public.equipment_loan_returns r where r.loan_id=p_loan_id) then
    raise exception 'This item is not currently borrowed or was already returned';
  end if;
  select * into v_asset from public.equipment_assets where id=v_loan.asset_id for update;
  if not found then raise exception 'Equipment record not found'; end if;
  insert into public.equipment_loan_returns(loan_id,return_condition,notes,received_by)
    values(p_loan_id,p_return_condition,coalesce(p_notes,''),auth.uid());

  select count(distinct l.borrower_id)::integer, coalesce(sum(l.quantity),0)::integer
    into v_active_count, v_borrowed_quantity
  from public.equipment_loans l
  where l.asset_id=v_asset.id
    and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id);
  if v_active_count=1 then
    select l.borrower_id into v_active_custodian
    from public.equipment_loans l
    where l.asset_id=v_asset.id
      and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id)
    limit 1;
  end if;

  update public.equipment_assets
    set condition=p_return_condition,
        status=case when p_return_condition<>'Good' then 'Under maintenance'
                    when v_borrowed_quantity>=quantity then 'Checked out' else 'Available' end,
        current_custodian_id=v_active_custodian
    where id=v_asset.id;
  if p_return_condition<>'Good' then
    insert into public.maintenance_records(asset_id,opened_by,description,notes)
      values(v_asset.id,auth.uid(),'Issue found during equipment return',coalesce(p_notes,''));
  end if;
end;
$$;

revoke execute on function public.issue_equipment_to_person(uuid,uuid,date,text,timestamptz,integer) from public,anon;
grant execute on function public.issue_equipment_to_person(uuid,uuid,date,text,timestamptz,integer) to authenticated;
revoke execute on function public.return_borrowed_equipment(uuid,text,text) from public,anon;
grant execute on function public.return_borrowed_equipment(uuid,text,text) to authenticated;
