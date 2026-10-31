-- Ordered categories, manager checklist cleanup, team read receipts and settings PIN support.
alter table public.operation_categories add column if not exists sort_order integer not null default 0;
with ordered as (
  select category_type, category_name,
    row_number() over (partition by category_type order by case category_name
      when 'Pre-event' then 1 when 'Quran' then 2 when 'During lecture' then 3
      when 'Noha' then 4 when 'After event' then 5 when 'Special event' then 6 else 100 end, category_name) - 1 as position
  from public.operation_categories
)
update public.operation_categories c set sort_order=ordered.position
from ordered where c.category_type=ordered.category_type and c.category_name=ordered.category_name;

create or replace function public.reorder_operation_categories(p_category_type text, p_categories text[])
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare existing_count integer; supplied_count integer;
begin
  if not public.is_manager() and not public.has_equipment_manager_role() then raise exception 'Category access denied'; end if;
  select count(*) into existing_count from public.operation_categories where category_type=p_category_type;
  select count(distinct category_name) into supplied_count from unnest(p_categories) as items(category_name);
  if existing_count <> supplied_count or exists (
    select 1 from public.operation_categories c where c.category_type=p_category_type and not (c.category_name=any(p_categories))
  ) then raise exception 'Category list changed; reload and try again'; end if;
  update public.operation_categories c set sort_order=ordered.position
  from (select category_name, ordinality-1 as position from unnest(p_categories) with ordinality as items(category_name,ordinality)) ordered
  where c.category_type=p_category_type and c.category_name=ordered.category_name;
end $$;
grant execute on function public.reorder_operation_categories(text,text[]) to authenticated;

alter table public.checklist_items add column if not exists cleared_from_checklist boolean not null default false;
alter table public.checklist_items add column if not exists service_history_hidden boolean not null default false;
grant update(cleared_from_checklist) on public.checklist_items to authenticated;
drop policy if exists checklist_items_update_manager on public.checklist_items;
create policy checklist_items_update_manager on public.checklist_items for update to authenticated using(public.is_manager()) with check(public.is_manager());
create or replace function public.admin_clear_completed_checklists() returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare changed_count integer;
begin
  if not public.is_manager() then raise exception 'Manager access required'; end if;
  update public.checklist_items set cleared_from_checklist=true, updated_at=now()
    where status='Complete' and not cleared_from_checklist;
  get diagnostics changed_count=row_count;
  insert into public.audit_logs(actor_id,action,target_type,metadata)
    values(auth.uid(),'Cleared completed checklist items from active view','checklist',jsonb_build_object('count',changed_count));
  return changed_count;
end $$;
grant execute on function public.admin_clear_completed_checklists() to authenticated;

create or replace function public.admin_reset_member_service_history(p_user_id uuid) returns integer
language plpgsql security definer set search_path=public,pg_temp set row_security=off as $$
declare changed_count integer;
begin
  if not public.is_manager() then raise exception 'Manager access required'; end if;
  update public.role_assignments a set service_history_hidden=true
    from public.events e
    where a.event_id=e.id and a.user_id=p_user_id and not a.service_history_hidden
      and e.status <> 'Cancelled' and (e.status='Completed' or e.event_date < current_date);
  get diagnostics changed_count=row_count;
  update public.checklist_items set service_history_hidden=true, updated_at=now()
    where assigned_user_id=p_user_id and status='Complete' and not service_history_hidden;
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),'Reset team member service history view','profile',p_user_id,jsonb_build_object('event_assignments_hidden',changed_count));
  return changed_count;
end $$;
grant execute on function public.admin_reset_member_service_history(uuid) to authenticated;

alter table public.role_assignments add column if not exists service_history_hidden boolean not null default false;
grant update(service_history_hidden) on public.role_assignments to authenticated;
drop policy if exists assignments_update_manager on public.role_assignments;
create policy assignments_update_manager on public.role_assignments for update to authenticated using(public.is_manager()) with check(public.is_manager());

-- Reporters can attach completion photos and use short notes; managers keep full edit access.
grant insert(photos) on public.incidents to authenticated;
grant update(event_id,asset_id,category,severity,description,immediate_action,photos,status,resolution_notes,resolved_by,resolved_at) on public.incidents to authenticated;
drop policy if exists incidents_update_staff on public.incidents;
create policy incidents_update_staff on public.incidents for update to authenticated using(
  public.is_manager() or reported_by=auth.uid()
) with check(
  public.is_manager() or (reported_by=auth.uid() and status='Resolved' and resolved_by=auth.uid()
    and resolved_at is not null and length(trim(coalesce(resolution_notes,'')))>=1)
);

drop policy if exists notifications_select_manager on public.notifications;
create policy notifications_select_manager on public.notifications for select to authenticated using(public.is_manager());

create table if not exists public.settings_pin_security (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  pin_salt text not null,
  pin_hash text not null,
  failed_attempts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.settings_pin_security enable row level security;
drop policy if exists settings_pin_security_manager on public.settings_pin_security;
create policy settings_pin_security_manager on public.settings_pin_security for all to authenticated
  using(user_id=auth.uid() and public.is_manager())
  with check(user_id=auth.uid() and public.is_manager());
grant select,insert,update on public.settings_pin_security to authenticated;
