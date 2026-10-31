-- Keep program phases fixed to the five stages used by the IAC checklist flow.
-- Existing labels are translated before unsupported legacy values are normalized.

update public.events
set current_program_phase = case current_program_phase
  when 'During lecture' then 'During recitation'
  when 'Special event' then 'After event'
  when 'Pre-event' then 'Pre-event'
  when 'Quran' then 'Quran'
  when 'During recitation' then 'During recitation'
  when 'Noha' then 'Noha'
  when 'After event' then 'After event'
  else 'Pre-event'
end;

update public.checklist_items
set program_phase = case program_phase
  when 'During lecture' then 'During recitation'
  when 'Special event' then 'After event'
  when 'Pre-event' then 'Pre-event'
  when 'Quran' then 'Quran'
  when 'During recitation' then 'During recitation'
  when 'Noha' then 'Noha'
  when 'After event' then 'After event'
  else 'Pre-event'
end;

update public.checklist_templates
set category = case category
  when 'During lecture' then 'During recitation'
  when 'Special event' then 'After event'
  when 'Pre-event' then 'Pre-event'
  when 'Quran' then 'Quran'
  when 'During recitation' then 'During recitation'
  when 'Noha' then 'Noha'
  when 'After event' then 'After event'
  else 'Pre-event'
end;

delete from public.operation_categories
where category_type = 'checklists'
  and category_name not in ('Pre-event', 'Quran', 'During recitation', 'Noha', 'After event');

insert into public.operation_categories(category_type, category_name, sort_order)
values
  ('checklists', 'Pre-event', 1),
  ('checklists', 'Quran', 2),
  ('checklists', 'During recitation', 3),
  ('checklists', 'Noha', 4),
  ('checklists', 'After event', 5)
on conflict (category_type, category_name) do update
set sort_order = excluded.sort_order;

alter table public.operation_categories
  drop constraint if exists operation_categories_fixed_checklist_phases;

alter table public.operation_categories
  add constraint operation_categories_fixed_checklist_phases check (
    category_type <> 'checklists'
    or category_name in ('Pre-event', 'Quran', 'During recitation', 'Noha', 'After event')
  );

create or replace function public.protect_fixed_checklist_phases()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.category_type = 'checklists' then
      raise exception 'The five checklist program phases cannot be deleted';
    end if;
    return old;
  end if;
  if old.category_type = 'checklists' then
    if new.category_type <> old.category_type or new.category_name <> old.category_name then
      raise exception 'The five checklist program phases cannot be renamed';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists protect_fixed_checklist_phases on public.operation_categories;
create trigger protect_fixed_checklist_phases
before update or delete on public.operation_categories
for each row execute function public.protect_fixed_checklist_phases();
