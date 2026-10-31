-- Add an equipment-only access role and grant it to Ameen's existing account.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (
  role in ('Administrator','Media Director','Team Lead','Equipment Manager','Operator','Trainee','Event Organizer')
);

alter table public.profiles drop constraint if exists profiles_access_roles_check;
alter table public.profiles add constraint profiles_access_roles_check check (
  cardinality(access_roles) between 1 and 7 and
  access_roles <@ array['Administrator','Media Director','Team Lead','Equipment Manager','Operator','Trainee','Event Organizer']::text[]
);

update public.profiles
set role='Equipment Manager', access_roles=array['Operator','Equipment Manager']
where lower(username)='ameen.hassan';

-- Equipment managers may see the team roster so they can record named handoffs.
drop policy if exists profiles_select_checkout_crew on public.profiles;
create policy profiles_select_checkout_crew on public.profiles for select to authenticated
  using(public.is_staff() or public.current_role()='Equipment Manager');

drop policy if exists equipment_assets_select on public.equipment_assets;
create policy equipment_assets_select on public.equipment_assets for select to authenticated using(
  public.is_staff() or public.current_role()='Equipment Manager' or
  exists(select 1 from public.equipment_loans l where l.asset_id=id and l.borrower_id=auth.uid())
);
create policy equipment_assets_insert_manager on public.equipment_assets for insert to authenticated with check(
  public.current_role()='Equipment Manager' and created_by=auth.uid() and
  status=case when condition in ('Needs service','Damaged','Unknown') then 'Under maintenance' else 'Available' end
);

drop policy if exists equipment_loans_select_scoped on public.equipment_loans;
create policy equipment_loans_select_scoped on public.equipment_loans for select to authenticated
  using(public.is_staff() or public.current_role()='Equipment Manager' or borrower_id=auth.uid());
drop policy if exists equipment_loan_returns_select_scoped on public.equipment_loan_returns;
create policy equipment_loan_returns_select_scoped on public.equipment_loan_returns for select to authenticated
  using(public.is_staff() or public.current_role()='Equipment Manager' or exists(
    select 1 from public.equipment_loans l where l.id=loan_id and l.borrower_id=auth.uid()
  ));

-- Equipment managers can issue handoffs and receive returns. Inventory edits remain admin-only.
create or replace function public.issue_equipment_to_person(
  p_asset_id uuid, p_borrower_id uuid, p_due_date date default null, p_checkout_notes text default '', p_issued_at timestamptz default now()
) returns uuid language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_asset public.equipment_assets%rowtype;
  v_borrower public.profiles%rowtype;
  v_loan_id uuid;
begin
  if not public.is_staff() and public.current_role()<>'Equipment Manager' then
    raise exception 'Only the equipment checkout crew can hand out equipment' using errcode='42501';
  end if;
  if p_due_date is not null and p_due_date < current_date then raise exception 'Due date must be today or later'; end if;
  if p_issued_at is null then raise exception 'Choose a handoff date'; end if;
  if length(coalesce(p_checkout_notes,'')) > 1000 then raise exception 'Handoff notes are too long'; end if;
  select * into v_borrower from public.profiles where id=p_borrower_id and active;
  if not found or v_borrower.role='Event Organizer' then raise exception 'Choose an active media team member'; end if;
  select * into v_asset from public.equipment_assets where id=p_asset_id for update;
  if not found or v_asset.status<>'Available' or v_asset.condition<>'Good' then raise exception 'Equipment is not available to hand out'; end if;
  if exists(select 1 from public.equipment_loans l where l.asset_id=p_asset_id and not exists(
    select 1 from public.equipment_loan_returns r where r.loan_id=l.id
  )) then raise exception 'Equipment already has an active borrower'; end if;
  insert into public.equipment_loans(asset_id,borrower_id,issued_by,issued_at,due_date,checkout_condition,checkout_notes)
    values(p_asset_id,p_borrower_id,auth.uid(),p_issued_at,p_due_date,v_asset.condition,coalesce(p_checkout_notes,'')) returning id into v_loan_id;
  update public.equipment_assets set status='Checked out',current_custodian_id=p_borrower_id where id=p_asset_id;
  insert into public.notifications(user_id,title,body,href)
    values(p_borrower_id,'Equipment handed to you',v_asset.name || ' · recorded by the checkout crew','equipment');
  return v_loan_id;
end; $$;

create or replace function public.return_borrowed_equipment(
  p_loan_id uuid, p_return_condition text, p_notes text default ''
) returns void language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_loan public.equipment_loans%rowtype;
  v_asset public.equipment_assets%rowtype;
begin
  if not public.is_staff() and public.current_role()<>'Equipment Manager' then
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
  update public.equipment_assets set condition=p_return_condition,
    status=case when p_return_condition='Good' then 'Available' else 'Under maintenance' end,
    current_custodian_id=null where id=v_asset.id;
  if p_return_condition<>'Good' then
    insert into public.maintenance_records(asset_id,opened_by,description,notes)
      values(v_asset.id,auth.uid(),'Issue found during equipment return',coalesce(p_notes,''));
  end if;
end; $$;

revoke execute on function public.issue_equipment_to_person(uuid,uuid,date,text,timestamptz) from public,anon;
grant execute on function public.issue_equipment_to_person(uuid,uuid,date,text,timestamptz) to authenticated;
revoke execute on function public.return_borrowed_equipment(uuid,text,text) from public,anon;
grant execute on function public.return_borrowed_equipment(uuid,text,text) to authenticated;
