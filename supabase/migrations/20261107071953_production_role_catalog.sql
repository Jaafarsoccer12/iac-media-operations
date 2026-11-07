-- Make production assignments administrator-manageable in operation_categories.
-- Existing role rows are preserved; missing default roles are added only once.
alter table public.operation_categories
  drop constraint if exists operation_categories_category_type_check;

alter table public.operation_categories
  add constraint operation_categories_category_type_check
  check (category_type = any (array['equipment','sops','incidents','checklists','events','production_roles']::text[]));

insert into public.operation_categories (category_type, category_name, sort_order)
values
  ('production_roles', 'Camera Operator', 0),
  ('production_roles', 'PTZ Camera Operator', 1),
  ('production_roles', 'Video Operator', 2),
  ('production_roles', 'Audio Operator', 3),
  ('production_roles', 'Equipment Manager', 4),
  ('production_roles', 'Photography', 5),
  ('production_roles', 'Video Switcher Operator', 6),
  ('production_roles', 'Videography', 7),
  ('production_roles', 'Director', 8)
on conflict (category_type, category_name) do nothing;
