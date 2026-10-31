-- Incident evidence, assigned SOPs, reusable category lists, and published event attendance responses.
alter table public.incidents
  add column if not exists photos jsonb not null default '[]'::jsonb;

alter table public.sops
  add column if not exists assigned_user_ids uuid[] not null default '{}'::uuid[],
  add column if not exists available_to_all boolean not null default true;

create or replace function public.has_equipment_manager_role() returns boolean
language sql stable security definer set search_path=public,pg_temp set row_security=off as $$
  select exists (
    select 1 from public.profiles p where p.id=auth.uid() and p.active
      and (p.role='Equipment Manager' or 'Equipment Manager'=any(p.access_roles))
  )
$$;

grant execute on function public.has_equipment_manager_role() to authenticated;

create table if not exists public.operation_categories (
  category_type text not null check(category_type in ('equipment','sops','incidents','checklists','events')),
  category_name text not null check(length(trim(category_name)) between 2 and 80),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key(category_type, category_name)
);
alter table public.operation_categories enable row level security;
drop policy if exists operation_categories_read on public.operation_categories;
create policy operation_categories_read on public.operation_categories for select to authenticated using(true);
drop policy if exists operation_categories_write on public.operation_categories;
create policy operation_categories_write on public.operation_categories for all to authenticated
  using(public.is_manager() or public.has_equipment_manager_role())
  with check(public.is_manager() or public.has_equipment_manager_role());

insert into public.operation_categories(category_type,category_name) values
  ('equipment','Camera'),('equipment','Audio'),('equipment','Wiring'),('equipment','Video'),('equipment','Lighting'),('equipment','Other'),
  ('sops','Production'),('sops','Audio'),('sops','Video'),('sops','Livestream & recording'),('sops','Equipment'),('sops','Operations'),('sops','Safety'),
  ('incidents','Equipment damage'),('incidents','Audio issue'),('incidents','Video issue'),('incidents','Stream interruption'),('incidents','Recording issue'),('incidents','Network'),('incidents','Other'),
  ('checklists','Pre-event'),('checklists','Quran'),('checklists','During lecture'),('checklists','Noha'),('checklists','After event'),('checklists','Special event'),
  ('events','Happy'),('events','Sad'),('events','General')
on conflict do nothing;

-- Preserve private incident reports: managers can inspect every report, members only their own.
drop policy if exists incidents_select_scoped on public.incidents;
create policy incidents_select_scoped on public.incidents for select to authenticated using(
  public.is_manager() or reported_by=auth.uid()
);
drop policy if exists incidents_insert_equipment_manager on public.incidents;
create policy incidents_insert_equipment_manager on public.incidents for insert to authenticated with check(
  public.has_equipment_manager_role() and reported_by=auth.uid() and status='Open' and asset_id is not null
);
drop policy if exists incidents_update_staff on public.incidents;
create policy incidents_update_staff on public.incidents for update to authenticated using(
  public.is_manager() or reported_by=auth.uid()
) with check(
  public.is_manager() or (reported_by=auth.uid() and status='Resolved' and resolved_by=auth.uid()
    and resolved_at is not null and length(trim(coalesce(resolution_notes,'')))>=5)
);

-- Equipment managers can browse and update the whole equipment register even when they also have another role.
drop policy if exists equipment_assets_select on public.equipment_assets;
create policy equipment_assets_select on public.equipment_assets for select to authenticated using(
  public.is_staff() or public.has_equipment_manager_role() or exists(
    select 1 from public.equipment_loans l where l.asset_id=id and l.borrower_id=auth.uid()
  )
);
drop policy if exists equipment_assets_update_manager on public.equipment_assets;
create policy equipment_assets_update_manager on public.equipment_assets for update to authenticated
  using(public.is_manager() or public.has_equipment_manager_role())
  with check(public.is_manager() or public.has_equipment_manager_role());
drop policy if exists equipment_assets_insert_manager on public.equipment_assets;
create policy equipment_assets_insert_manager on public.equipment_assets for insert to authenticated with check(
  (public.is_manager() or public.has_equipment_manager_role()) and created_by=auth.uid()
);
drop policy if exists profiles_select_checkout_crew on public.profiles;
create policy profiles_select_checkout_crew on public.profiles for select to authenticated
  using(public.is_staff() or public.has_equipment_manager_role());
drop policy if exists equipment_loans_select_scoped on public.equipment_loans;
create policy equipment_loans_select_scoped on public.equipment_loans for select to authenticated
  using(public.is_staff() or public.has_equipment_manager_role() or borrower_id=auth.uid());

create or replace function public.respond_to_event_assignment(p_assignment_id uuid,p_response text) returns boolean
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare
  v_event_title text;
begin
  if p_response not in ('Accepted','Declined') then raise exception 'Choose Accepted or Declined'; end if;
  update public.role_assignments a set response_status=p_response
    from public.events e
    where a.id=p_assignment_id and a.user_id=auth.uid() and a.event_id=e.id and e.status='Published'
    returning e.title into v_event_title;
  if not found then return false; end if;
  insert into public.notifications(user_id,title,body,href)
    select p.id,'Event attendance response',
      coalesce((select full_name from public.profiles where id=auth.uid()),'A team member')||' · '||v_event_title||' · '||p_response,'events'
    from public.profiles p where p.active and p.id<>auth.uid()
      and (p.role in ('Administrator','Director') or p.access_roles && array['Administrator','Director']::text[]);
  return true;
end; $$;
revoke execute on function public.respond_to_event_assignment(uuid,text) from public,anon;
grant execute on function public.respond_to_event_assignment(uuid,text) to authenticated;
-- Favor the operational role for equipment-only checks when a profile has multiple access roles.
create or replace function public.current_role() returns text language sql stable security definer
set search_path=public,pg_temp set row_security=off as $$
  select case
    when p.role='Administrator' or 'Administrator'=any(p.access_roles) then 'Administrator'
    when p.role='Director' or 'Director'=any(p.access_roles) then 'Director'
    when p.role='Equipment Manager' or 'Equipment Manager'=any(p.access_roles) then 'Equipment Manager'
    else p.role
  end
  from public.profiles p where p.id=auth.uid() and p.active limit 1
$$;

grant select, insert, delete on public.operation_categories to authenticated;
