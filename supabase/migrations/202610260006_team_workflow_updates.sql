alter table public.profiles add column if not exists access_roles text[] not null default '{}';
update public.profiles set access_roles=array[role] where cardinality(access_roles)=0;
alter table public.profiles drop constraint if exists profiles_access_roles_check;
alter table public.profiles add constraint profiles_access_roles_check check (
  cardinality(access_roles) between 1 and 6 and
  access_roles <@ array['Administrator','Media Director','Team Lead','Operator','Trainee','Event Organizer']::text[]
);

-- Restrict event category values to the three categories requested by the team.
update public.events set category='General' where category not in ('Happy','Sad','General');
alter table public.events drop constraint if exists events_category_check;
alter table public.events add constraint events_category_check check(category in ('Happy','Sad','General'));

-- Non-administrators can read only checklists assigned to their own profile.
drop policy if exists checklist_instances_select on public.checklist_instances;
create policy checklist_instances_select on public.checklist_instances for select to authenticated using (
  public.current_role()='Administrator' or
  exists(select 1 from public.role_assignments a where a.id=assignment_id and a.user_id=auth.uid())
);
drop policy if exists checklist_items_select on public.checklist_items;
create policy checklist_items_select on public.checklist_items for select to authenticated using (
  assigned_user_id=auth.uid() or public.current_role()='Administrator'
);

create or replace function public.complete_checklist_item(p_item_id uuid,p_status text,p_notes text default '') returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_instance uuid; v_required boolean; v_is_admin boolean;
begin
  if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.access_roles && array['Administrator','Media Director','Team Lead','Operator','Trainee']::text[]) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if p_status not in ('Outstanding','Complete','Needs attention') then raise exception 'Invalid check state'; end if;
  select ci.id,i.is_required into v_instance,v_required
    from public.checklist_items i join public.checklist_instances ci on ci.id=i.instance_id where i.id=p_item_id;
  if not found then raise exception 'Checklist item not found'; end if;
  select 'Administrator'=any(access_roles) into v_is_admin from public.profiles where id=auth.uid();
  if not v_is_admin and not exists(select 1 from public.checklist_items i where i.id=p_item_id and i.assigned_user_id=auth.uid()) then
    raise exception 'You can only update your assigned checklist' using errcode='42501';
  end if;
  if p_status='Needs attention' and v_required and length(trim(coalesce(p_notes,'')))<5 then raise exception 'Describe the failed required check'; end if;
  update public.checklist_items set status=p_status,
    notes=case when nullif(trim(p_notes),'') is not null then nullif(trim(p_notes),'') when p_status='Outstanding' then null else notes end,
    completed_at=case when p_status='Outstanding' then null else now() end,
    completed_by=case when p_status='Outstanding' then null else auth.uid() end where id=p_item_id;
  update public.checklist_instances ci set status=case
    when exists(select 1 from public.checklist_items i where i.instance_id=v_instance and i.is_required and i.status='Needs attention') then 'Needs attention'
    when not exists(select 1 from public.checklist_items i where i.instance_id=v_instance and i.is_required and i.status<>'Complete') then 'Ready'
    else 'In progress' end where ci.id=v_instance;
end; $$;

-- Only the administrator can edit equipment inventory details.
create policy equipment_assets_update_admin on public.equipment_assets for update to authenticated
  using(public.current_role()='Administrator') with check(public.current_role()='Administrator');
grant update(asset_code,name,category,storage_location,model,serial_number,condition,status,notes) on public.equipment_assets to authenticated;

-- Only the administrator can revise an incident, including a resolved or closed one.
drop policy if exists incidents_update_staff on public.incidents;
create policy incidents_update_admin on public.incidents for update to authenticated
  using(public.current_role()='Administrator') with check(public.current_role()='Administrator');
grant update(event_id,asset_id,category,severity,description,status,resolution_notes,resolved_by,resolved_at) on public.incidents to authenticated;

-- The handoff date supplied by the checkout crew is stored with the loan.
drop function if exists public.issue_equipment_to_person(uuid,uuid,date,text);
create function public.issue_equipment_to_person(
  p_asset_id uuid, p_borrower_id uuid, p_due_date date default null, p_checkout_notes text default '', p_issued_at timestamptz default now()
) returns uuid language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_asset public.equipment_assets%rowtype;
  v_borrower public.profiles%rowtype;
  v_loan_id uuid;
begin
  if not public.is_staff() then raise exception 'Only the equipment checkout crew can hand out equipment' using errcode='42501'; end if;
  if p_due_date is not null and p_due_date < current_date then raise exception 'Due date must be today or later'; end if;
  if p_issued_at is null then raise exception 'Choose a handoff date'; end if;
  if length(coalesce(p_checkout_notes,'')) > 1000 then raise exception 'Handoff notes are too long'; end if;
  select * into v_borrower from public.profiles where id=p_borrower_id and active;
  if not found or v_borrower.role='Event Organizer' then raise exception 'Choose an active media team member'; end if;
  select * into v_asset from public.equipment_assets where id=p_asset_id for update;
  if not found or v_asset.status<>'Available' or v_asset.condition<>'Good' then raise exception 'Equipment is not available to hand out'; end if;
  if exists(select 1 from public.equipment_loans l where l.asset_id=p_asset_id and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id)) then
    raise exception 'Equipment already has an active borrower';
  end if;
  insert into public.equipment_loans(asset_id,borrower_id,issued_by,issued_at,due_date,checkout_condition,checkout_notes)
    values(p_asset_id,p_borrower_id,auth.uid(),p_issued_at,p_due_date,v_asset.condition,coalesce(p_checkout_notes,'')) returning id into v_loan_id;
  update public.equipment_assets set status='Checked out',current_custodian_id=p_borrower_id where id=p_asset_id;
  insert into public.notifications(user_id,title,body,href)
    values(p_borrower_id,'Equipment handed to you',v_asset.name || ' · recorded by the checkout crew','equipment');
  return v_loan_id;
end; $$;
revoke execute on function public.issue_equipment_to_person(uuid,uuid,date,text,timestamptz) from public,anon;
grant execute on function public.issue_equipment_to_person(uuid,uuid,date,text,timestamptz) to authenticated;
