-- Equipment is handed to a named person by the checkout crew, independently of events.
create table public.equipment_loans (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.equipment_assets(id),
  borrower_id uuid not null references public.profiles(id),
  issued_by uuid not null references public.profiles(id),
  issued_at timestamptz not null default now(),
  due_date date,
  checkout_condition text not null check(checkout_condition in ('Good','Needs service','Damaged')),
  checkout_notes text not null default '',
  created_at timestamptz not null default now()
);
create index equipment_loans_asset_idx on public.equipment_loans(asset_id, issued_at desc);
create index equipment_loans_borrower_idx on public.equipment_loans(borrower_id, issued_at desc);

create table public.equipment_loan_returns (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null unique references public.equipment_loans(id),
  return_condition text not null check(return_condition in ('Good','Needs service','Damaged')),
  notes text not null default '',
  received_by uuid not null references public.profiles(id),
  returned_at timestamptz not null default now()
);

alter table public.equipment_loans enable row level security;
alter table public.equipment_loan_returns enable row level security;
create policy equipment_loans_select_scoped on public.equipment_loans for select to authenticated
  using(public.is_staff() or borrower_id=auth.uid());
create policy equipment_loan_returns_select_scoped on public.equipment_loan_returns for select to authenticated
  using(public.is_staff() or exists(select 1 from public.equipment_loans l where l.id=loan_id and l.borrower_id=auth.uid()));
create policy profiles_select_checkout_crew on public.profiles for select to authenticated
  using(public.is_staff());
create policy profiles_select_loan_counterpart on public.profiles for select to authenticated
  using(exists(select 1 from public.equipment_loans l where l.borrower_id=auth.uid() and l.issued_by=profiles.id));
drop policy equipment_assets_select on public.equipment_assets;
create policy equipment_assets_select on public.equipment_assets for select to authenticated using(
  public.is_staff() or exists(select 1 from public.equipment_loans l where l.asset_id=id and l.borrower_id=auth.uid())
);

drop policy incidents_insert_assigned on public.incidents;
create policy incidents_insert_assigned on public.incidents for insert to authenticated with check(
  reported_by=auth.uid() and status='Open' and resolved_by is null and resolved_at is null and resolution_notes is null and assigned_to is null
  and (
    public.is_staff() or
    ((event_id is null or public.assigned_to_event(event_id)) and
      (asset_id is null or exists(
        select 1 from public.equipment_loans l
        where l.asset_id=incidents.asset_id and l.borrower_id=auth.uid()
          and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id)
      )))
  )
);

create trigger equipment_loans_audit after insert or update or delete on public.equipment_loans
  for each row execute function public.write_audit_log();
create trigger equipment_loan_returns_audit after insert or update or delete on public.equipment_loan_returns
  for each row execute function public.write_audit_log();

create or replace function public.issue_equipment_to_person(
  p_asset_id uuid, p_borrower_id uuid, p_due_date date default null, p_checkout_notes text default ''
) returns uuid language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_asset public.equipment_assets%rowtype;
  v_borrower public.profiles%rowtype;
  v_loan_id uuid;
begin
  if not public.is_staff() then raise exception 'Only the equipment checkout crew can hand out equipment' using errcode='42501'; end if;
  if p_due_date is not null and p_due_date < current_date then raise exception 'Due date must be today or later'; end if;
  if length(coalesce(p_checkout_notes,'')) > 1000 then raise exception 'Handoff notes are too long'; end if;
  select * into v_borrower from public.profiles where id=p_borrower_id and active;
  if not found or v_borrower.role='Event Organizer' then raise exception 'Choose an active media team member'; end if;
  select * into v_asset from public.equipment_assets where id=p_asset_id for update;
  if not found or v_asset.status<>'Available' or v_asset.condition<>'Good' then raise exception 'Equipment is not available to hand out'; end if;
  if exists(
    select 1 from public.equipment_loans l
    where l.asset_id=p_asset_id and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id)
  ) then raise exception 'Equipment already has an active borrower'; end if;

  insert into public.equipment_loans(asset_id,borrower_id,issued_by,due_date,checkout_condition,checkout_notes)
    values(p_asset_id,p_borrower_id,auth.uid(),p_due_date,v_asset.condition,coalesce(p_checkout_notes,'')) returning id into v_loan_id;
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
  if not public.is_staff() then raise exception 'Only the equipment checkout crew can record a return' using errcode='42501'; end if;
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

-- Retire event-based equipment actions. The old reservation tables remain only for existing records.
revoke execute on function public.reserve_equipment_asset(uuid,uuid,uuid) from public,anon,authenticated;
revoke execute on function public.checkout_equipment(uuid,uuid,text) from public,anon,authenticated;
revoke execute on function public.return_equipment(uuid,text,text) from public,anon,authenticated;
revoke execute on function public.issue_equipment_to_person(uuid,uuid,date,text) from public,anon;
revoke execute on function public.return_borrowed_equipment(uuid,text,text) from public,anon;
grant execute on function public.issue_equipment_to_person(uuid,uuid,date,text) to authenticated;
grant execute on function public.return_borrowed_equipment(uuid,text,text) to authenticated;
grant select on public.equipment_loans,public.equipment_loan_returns to authenticated;
