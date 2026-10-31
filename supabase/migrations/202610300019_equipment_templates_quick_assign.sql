-- Reusable equipment bundles and an atomic multi-item checkout workflow.
create table public.equipment_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index equipment_templates_name_lower_idx on public.equipment_templates (lower(name));
alter table public.equipment_templates enable row level security;
create policy equipment_templates_manager_select on public.equipment_templates for select to authenticated
  using (public.is_manager() or public.has_equipment_manager_role());
grant select on public.equipment_templates to authenticated;

create or replace function public.prevent_delete_equipment_template_asset()
returns trigger
language plpgsql
set search_path=public,pg_temp as $$
begin
  if exists (
    select 1 from public.equipment_templates t
    where t.items @> jsonb_build_array(jsonb_build_object('assetId',old.id::text))
  ) then
    raise exception 'Remove this equipment from its saved templates before deleting it.' using errcode='23503';
  end if;
  return old;
end;
$$;
create trigger equipment_template_asset_delete_guard
  before delete on public.equipment_assets
  for each row execute function public.prevent_delete_equipment_template_asset();

create or replace function public.save_equipment_template(
  p_template_id uuid,
  p_name text,
  p_items jsonb
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
declare
  v_id uuid;
  v_item jsonb;
  v_asset public.equipment_assets%rowtype;
  v_quantity integer;
begin
  if not public.is_manager() and not public.has_equipment_manager_role() then
    raise exception 'Only equipment managers, directors, or administrators can manage equipment templates' using errcode='42501';
  end if;
  if p_name is null or length(trim(p_name)) not between 2 and 120 then
    raise exception 'Enter an equipment template name between 2 and 120 characters';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Add between 1 and 100 equipment items to the template';
  end if;
  if (select count(distinct value->>'assetId') from jsonb_array_elements(p_items)) <> jsonb_array_length(p_items) then
    raise exception 'Add each equipment item only once';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    if coalesce(v_item->>'assetId','') = '' or coalesce(v_item->>'quantity','') !~ '^[1-9][0-9]*$' then
      raise exception 'Each equipment item needs a valid inventory item and quantity';
    end if;
    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity > 10000 then raise exception 'Equipment quantities must be 10000 or less'; end if;
    select * into v_asset from public.equipment_assets where id=(v_item->>'assetId')::uuid;
    if not found then raise exception 'Choose equipment that still exists in the inventory'; end if;
    if v_quantity > v_asset.quantity then
      raise exception '% only has % units in inventory', v_asset.name, v_asset.quantity;
    end if;
  end loop;

  if p_template_id is null then
    insert into public.equipment_templates(name,items,created_by)
      values(trim(p_name),p_items,auth.uid()) returning id into v_id;
  else
    update public.equipment_templates
      set name=trim(p_name), items=p_items, updated_at=now()
      where id=p_template_id returning id into v_id;
    if v_id is null then raise exception 'Equipment template not found' using errcode='P0002'; end if;
  end if;
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),case when p_template_id is null then 'Created equipment template' else 'Updated equipment template' end,'equipment_template',v_id,jsonb_build_object('name',trim(p_name),'item_count',jsonb_array_length(p_items)));
  return v_id;
end;
$$;

create or replace function public.delete_equipment_template(p_template_id uuid)
returns void
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
declare
  v_name text;
begin
  if not public.is_manager() and not public.has_equipment_manager_role() then
    raise exception 'Only equipment managers, directors, or administrators can manage equipment templates' using errcode='42501';
  end if;
  delete from public.equipment_templates where id=p_template_id returning name into v_name;
  if v_name is null then raise exception 'Equipment template not found' using errcode='P0002'; end if;
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),'Deleted equipment template','equipment_template',p_template_id,jsonb_build_object('name',v_name));
end;
$$;

create or replace function public.quick_assign_equipment_template(
  p_template_id uuid,
  p_borrower_id uuid,
  p_items jsonb,
  p_due_date date default null,
  p_checkout_notes text default '',
  p_issued_at timestamptz default now()
) returns integer
language plpgsql security definer
set search_path=public,pg_temp
set row_security=off as $$
declare
  v_template public.equipment_templates%rowtype;
  v_borrower public.profiles%rowtype;
  v_item jsonb;
  v_asset public.equipment_assets%rowtype;
  v_asset_id uuid;
  v_quantity integer;
  v_borrowed_quantity integer;
  v_active_count integer;
  v_active_custodian uuid;
  v_count integer := 0;
  v_summary text := '';
begin
  if not public.is_manager() and not public.has_equipment_manager_role() then
    raise exception 'Only equipment managers, directors, or administrators can assign equipment' using errcode='42501';
  end if;
  if p_due_date is not null and p_due_date < current_date then raise exception 'Due date must be today or later'; end if;
  if p_issued_at is null then raise exception 'Choose a handoff date'; end if;
  if length(coalesce(p_checkout_notes,'')) > 1000 then raise exception 'Handoff notes are too long'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Add between 1 and 100 equipment items';
  end if;
  if (select count(distinct value->>'assetId') from jsonb_array_elements(p_items)) <> jsonb_array_length(p_items) then
    raise exception 'Add each equipment item only once';
  end if;
  select * into v_template from public.equipment_templates where id=p_template_id;
  if not found then raise exception 'Equipment template not found' using errcode='P0002'; end if;
  select * into v_borrower from public.profiles where id=p_borrower_id and active;
  if not found then raise exception 'Choose an active media team member'; end if;

  -- Lock every requested inventory row in a consistent order before checking stock.
  for v_asset_id in
    select (value->>'assetId')::uuid from jsonb_array_elements(p_items) order by 1
  loop
    perform 1 from public.equipment_assets where id=v_asset_id for update;
    if not found then raise exception 'An item in this template is no longer in the inventory'; end if;
  end loop;

  -- Validate the complete bundle before inserting any loan rows.
  for v_item in select value from jsonb_array_elements(p_items) loop
    if coalesce(v_item->>'quantity','') !~ '^[1-9][0-9]*$' then raise exception 'Enter a valid quantity for every item'; end if;
    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity > 10000 then raise exception 'Equipment quantities must be 10000 or less'; end if;
    select * into v_asset from public.equipment_assets where id=(v_item->>'assetId')::uuid;
    if v_asset.condition <> 'Good' or v_asset.status not in ('Available','Checked out') then
      raise exception '% is not available to hand out. Check its condition or current loans', v_asset.name;
    end if;
    select coalesce(sum(l.quantity),0)::integer into v_borrowed_quantity
      from public.equipment_loans l
      where l.asset_id=v_asset.id and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id);
    if v_quantity > v_asset.quantity-v_borrowed_quantity then
      raise exception 'Not enough units of % are available to hand out', v_asset.name;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_asset_id := (v_item->>'assetId')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    select * into v_asset from public.equipment_assets where id=v_asset_id;
    insert into public.equipment_loans(asset_id,borrower_id,issued_by,issued_at,due_date,quantity,checkout_condition,checkout_notes)
      values(v_asset.id,p_borrower_id,auth.uid(),p_issued_at,p_due_date,v_quantity,v_asset.condition,coalesce(p_checkout_notes,''));
    select count(distinct l.borrower_id)::integer, coalesce(sum(l.quantity),0)::integer
      into v_active_count,v_borrowed_quantity
      from public.equipment_loans l
      where l.asset_id=v_asset.id and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id);
    v_active_custodian := null;
    if v_active_count=1 then
      select l.borrower_id into v_active_custodian from public.equipment_loans l
        where l.asset_id=v_asset.id and not exists(select 1 from public.equipment_loan_returns r where r.loan_id=l.id) limit 1;
    end if;
    update public.equipment_assets
      set status=case when v_borrowed_quantity>=quantity then 'Checked out' else 'Available' end,
          current_custodian_id=v_active_custodian
      where id=v_asset.id;
    v_count := v_count+1;
    v_summary := concat_ws(', ',nullif(v_summary,''),v_quantity || ' × ' || v_asset.name);
  end loop;

  insert into public.notifications(user_id,title,body,href)
    values(p_borrower_id,'Equipment handed to you',v_template.name || ' · ' || v_summary || ' · recorded by the checkout crew','equipment');
  insert into public.notifications(user_id,title,body,href)
    select p.id,'Equipment updated',v_template.name || ' was handed to ' || v_borrower.full_name || ' · ' || v_summary || '.','equipment'
    from public.profiles p
    where p.id not in (auth.uid(),p_borrower_id) and p.active
      and (p.role in ('Administrator','Director','Equipment Manager') or p.access_roles && array['Administrator','Director','Equipment Manager']::text[]);
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),'Assigned equipment template','equipment_template_assignment',p_template_id,jsonb_build_object('borrower_id',p_borrower_id,'loan_count',v_count,'items',p_items));
  return v_count;
end;
$$;

revoke execute on function public.save_equipment_template(uuid,text,jsonb) from public,anon;
grant execute on function public.save_equipment_template(uuid,text,jsonb) to authenticated;
revoke execute on function public.delete_equipment_template(uuid) from public,anon;
grant execute on function public.delete_equipment_template(uuid) to authenticated;
revoke execute on function public.quick_assign_equipment_template(uuid,uuid,jsonb,date,text,timestamptz) from public,anon;
grant execute on function public.quick_assign_equipment_template(uuid,uuid,jsonb,date,text,timestamptz) to authenticated;
