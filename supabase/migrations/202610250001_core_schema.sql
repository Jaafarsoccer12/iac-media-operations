-- Normalized IAC Media Operations schema. No demo records are inserted here.
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  role text not null default 'Operator' check (role in ('Administrator','Media Director','Team Lead','Operator','Trainee','Event Organizer')),
  qualification_status text not null default 'Not started' check (qualification_status in ('Not started','In training','Awaiting assessment','Approved','Suspended','Needs renewal')),
  active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.role_definitions (
  id uuid primary key default gen_random_uuid(), name text not null unique, description text not null default '',
  default_requirements text[] not null default '{}', active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
insert into public.role_definitions(name, description) values
('Production Director','Oversees the event, confirms readiness, coordinates operators, and manages escalation.'),
('Camera Operator','Operates an assigned camera and follows verified framing instructions.'),
('PTZ Camera Operator','Controls assigned PTZ cameras and confirms presets with the director.'),
('Video Switcher Operator','Verifies inputs and operates the video switcher.'),
('Livestream Operator','Configures the approved stream destination and monitors stream health.'),
('Audio Operator','Checks microphones, routing, gain, and audio monitoring.'),
('Recording Operator','Verifies recording status, capacity, file integrity, and backup.'),
('Lighting Operator','Checks the approved lighting setup and safe cable routing.'),
('Content Editor','Organizes footage, edits assigned material, and submits it for review.'),
('Publishing Operator','Prepares approved content and records the publication link.'),
('Equipment / Setup Operator','Prepares equipment, handles checkout and return, and reports faults.')
on conflict (name) do nothing;

create table public.events (
  id uuid primary key default gen_random_uuid(), title text not null check(length(trim(title)) between 3 and 120),
  category text not null, description text not null default '', event_date date not null,
  start_time time not null, end_time time not null, setup_time time not null, time_zone text not null default 'UTC',
  venue text not null, event_lead_id uuid references public.profiles(id) on delete set null,
  livestream_required boolean not null default false, recording_required boolean not null default false,
  photography_required boolean not null default false, public_information text not null default '',
  status text not null default 'Planning' check(status in ('Planning','Published','Completed','Cancelled')),
  created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), check(end_time > start_time)
);
create index events_date_status_idx on public.events(event_date, status);
create index events_lead_date_idx on public.events(event_lead_id, event_date);
create table public.event_private_notes (
  event_id uuid primary key references public.events(id) on delete cascade, notes text not null default '',
  updated_by uuid not null references public.profiles(id), updated_at timestamptz not null default now()
);

create table public.event_templates (
  id uuid primary key default gen_random_uuid(), name text not null, category text not null,
  description text not null default '', active boolean not null default true,
  created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.event_template_roles (
  id uuid primary key default gen_random_uuid(), template_id uuid not null references public.event_templates(id) on delete cascade,
  role_definition_id uuid not null references public.role_definitions(id), arrival_offset_minutes integer not null default 90,
  instructions text not null default '', unique(template_id, role_definition_id)
);

create table public.equipment_categories (
  id uuid primary key default gen_random_uuid(), name text not null unique, active boolean not null default true, created_at timestamptz not null default now()
);
insert into public.equipment_categories(name) values
('Cameras'),('PTZ cameras'),('Lenses'),('Tripods'),('Video switchers'),('Audio mixers'),('Microphones'),('Wireless microphone systems'),('Speakers'),('Monitors and televisions'),('Capture devices'),('HDMI and SDI equipment'),('Ethernet and networking'),('Lighting'),('Computers and storage'),('Batteries and chargers'),('Memory cards'),('Cables and adapters'),('Other accessories') on conflict do nothing;
create table public.equipment_assets (
  id uuid primary key default gen_random_uuid(), asset_code text not null unique check(length(trim(asset_code)) between 3 and 40),
  name text not null check(length(trim(name)) between 2 and 120), category text not null references public.equipment_categories(name),
  manufacturer text, model text, serial_number text, barcode_value text unique, storage_location text not null default '',
  condition text not null default 'Good' check(condition in ('Good','Needs service','Damaged','Unknown')),
  status text not null default 'Available' check(status in ('Available','Reserved','Checked out','Under maintenance','Damaged','Missing','Retired')),
  purchase_date date, purchase_value numeric(12,2) check(purchase_value is null or purchase_value >= 0),
  current_custodian_id uuid references public.profiles(id) on delete set null, notes text not null default '',
  created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index equipment_status_category_idx on public.equipment_assets(status, category);

create table public.role_assignments (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id), role_definition_id uuid references public.role_definitions(id) on delete set null,
  role_name text not null, arrival_time time not null, instructions text not null default '', backup_user_id uuid references public.profiles(id) on delete set null,
  response_status text not null default 'Pending' check(response_status in ('Pending','Accepted','Declined')), response_note text,
  acknowledged_at timestamptz, assigned_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(event_id,user_id,role_name)
);
create index role_assignments_user_event_idx on public.role_assignments(user_id,event_id);
create table public.operator_qualifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  role_definition_id uuid not null references public.role_definitions(id), status text not null default 'Not started'
    check(status in ('Not started','In training','Awaiting assessment','Approved','Suspended','Needs renewal')),
  approved_by uuid references public.profiles(id), reason text, approved_at timestamptz, review_due_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(user_id,role_definition_id)
);
create index qualifications_user_status_idx on public.operator_qualifications(user_id,status);
create table public.training_resources (
  id uuid primary key default gen_random_uuid(), title text not null, description text not null default '', sop_id uuid,
  resource_url text, skill_level text not null default 'Introductory', published boolean not null default false,
  created_by uuid references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.training_records (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  training_resource_id uuid not null references public.training_resources(id), status text not null default 'Not started'
    check(status in ('Not started','In progress','Awaiting sign-off','Complete')), completed_at timestamptz,
  signed_off_by uuid references public.profiles(id), supervisor_note text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), unique(user_id,training_resource_id)
);

create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(), title text not null, category text not null, applies_to_role text,
  published boolean not null default false, created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.checklist_template_versions (
  id uuid primary key default gen_random_uuid(), template_id uuid not null references public.checklist_templates(id) on delete cascade,
  version integer not null check(version > 0), change_note text not null default '', created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(), unique(template_id,version)
);
create table public.checklist_template_items (
  id uuid primary key default gen_random_uuid(), version_id uuid not null references public.checklist_template_versions(id) on delete cascade,
  step_order integer not null, label text not null, instructions text not null default '', is_required boolean not null default true,
  assigned_role text, unique(version_id,step_order)
);
create table public.role_checklist_templates (
  id uuid primary key default gen_random_uuid(), role_name text not null, step_order integer not null,
  label text not null, is_required boolean not null default true, active boolean not null default true, unique(role_name,step_order)
);
create table public.checklist_instances (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade,
  assignment_id uuid unique references public.role_assignments(id) on delete set null,
  template_version_id uuid references public.checklist_template_versions(id) on delete set null,
  title text not null, role_name text, status text not null default 'In progress' check(status in ('Not started','In progress','Needs attention','Ready','Completed')),
  created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index checklist_instances_event_idx on public.checklist_instances(event_id);
create table public.checklist_items (
  id uuid primary key default gen_random_uuid(), instance_id uuid not null references public.checklist_instances(id) on delete cascade,
  template_item_id uuid references public.checklist_template_items(id) on delete set null, step_order integer not null,
  label text not null, instructions text not null default '', is_required boolean not null default true,
  assigned_user_id uuid references public.profiles(id) on delete set null, assigned_role text,
  status text not null default 'Outstanding' check(status in ('Outstanding','Complete','Needs attention')),
  completed_at timestamptz, completed_by uuid references public.profiles(id), notes text,
  verified_at timestamptz, verified_by uuid references public.profiles(id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), unique(instance_id,step_order)
);
create index checklist_items_user_status_idx on public.checklist_items(assigned_user_id,status);

create table public.equipment_reservations (
  id uuid primary key default gen_random_uuid(), asset_id uuid not null references public.equipment_assets(id),
  event_id uuid not null references public.events(id) on delete cascade, start_at timestamptz not null, end_at timestamptz not null,
  status text not null default 'Reserved' check(status in ('Reserved','Checked out','Returned','Cancelled','Issue')),
  custodian_id uuid not null references public.profiles(id), reserved_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), check(end_at > start_at),
  exclude using gist(asset_id with =, tstzrange(start_at,end_at,'[)') with &&) where(status in ('Reserved','Checked out'))
);
create index reservations_event_idx on public.equipment_reservations(event_id,start_at);
create table public.equipment_checkouts (
  id uuid primary key default gen_random_uuid(), reservation_id uuid not null unique references public.equipment_reservations(id),
  asset_id uuid not null references public.equipment_assets(id), event_id uuid not null references public.events(id),
  checked_out_by uuid not null references public.profiles(id), custodian_id uuid not null references public.profiles(id),
  checkout_condition text not null check(checkout_condition in ('Good','Needs service','Damaged','Unknown')),
  checked_out_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.equipment_returns (
  id uuid primary key default gen_random_uuid(), checkout_id uuid not null unique references public.equipment_checkouts(id),
  return_condition text not null check(return_condition in ('Good','Needs service','Damaged','Unknown')),
  notes text not null default '', inspected_by uuid not null references public.profiles(id), returned_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.maintenance_records (
  id uuid primary key default gen_random_uuid(), asset_id uuid not null references public.equipment_assets(id), incident_id uuid,
  opened_by uuid not null references public.profiles(id), description text not null,
  status text not null default 'Open' check(status in ('Open','In progress','Completed','Cancelled')), due_at timestamptz,
  completed_at timestamptz, notes text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.sops (
  id uuid primary key default gen_random_uuid(), title text not null, category text not null,
  status text not null default 'Draft' check(status in ('Draft','Published','Archived')),
  author_id uuid not null references public.profiles(id), reviewer_id uuid references public.profiles(id), current_version_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.sop_versions (
  id uuid primary key default gen_random_uuid(), sop_id uuid not null references public.sops(id) on delete cascade,
  version integer not null check(version > 0), purpose text not null, skill_level text not null default 'Introductory',
  equipment_covered text[] not null default '{}', troubleshooting text not null default '', safety_warnings text not null default '',
  status text not null default 'Draft' check(status in ('Draft','In review','Published','Archived')),
  authored_by uuid not null references public.profiles(id), reviewed_by uuid references public.profiles(id), reviewed_at timestamptz,
  created_at timestamptz not null default now(), unique(sop_id,version)
);
alter table public.sops add constraint sops_current_version_fk foreign key(current_version_id) references public.sop_versions(id) on delete set null;
create table public.sop_steps (
  id uuid primary key default gen_random_uuid(), sop_version_id uuid not null references public.sop_versions(id) on delete cascade,
  step_number integer not null, instruction text not null, warning text, media_url text, unique(sop_version_id,step_number)
);
alter table public.training_resources add constraint training_resources_sop_fk foreign key(sop_id) references public.sops(id) on delete set null;
create index sops_status_category_idx on public.sops(status,category);

create table public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null, body text not null, href text not null default 'dashboard', read_at timestamptz, created_at timestamptz not null default now()
);
create index notifications_user_unread_idx on public.notifications(user_id,created_at desc) where read_at is null;
create table public.announcements (
  id uuid primary key default gen_random_uuid(), event_id uuid references public.events(id) on delete cascade,
  title text not null, body text not null, published boolean not null default false, published_at timestamptz,
  created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.incidents (
  id uuid primary key default gen_random_uuid(), event_id uuid references public.events(id) on delete set null,
  asset_id uuid references public.equipment_assets(id) on delete set null, reported_by uuid not null references public.profiles(id),
  category text not null, severity text not null check(severity in ('Low','Medium','High','Critical')), description text not null,
  immediate_action text not null default '', assigned_to uuid references public.profiles(id) on delete set null,
  status text not null default 'Open' check(status in ('Open','Acknowledged','In progress','Resolved','Closed')),
  resolution_notes text, resolved_by uuid references public.profiles(id), resolved_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index incidents_status_severity_idx on public.incidents(status,severity,created_at desc);
create table public.incident_history (
  id uuid primary key default gen_random_uuid(), incident_id uuid not null references public.incidents(id) on delete cascade,
  actor_id uuid references public.profiles(id), action text not null, notes text, created_at timestamptz not null default now()
);

create table public.content_projects (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade,
  source_recording text, title text not null, content_type text not null,
  assigned_editor_id uuid references public.profiles(id), assigned_reviewer_id uuid references public.profiles(id),
  priority text not null default 'Normal' check(priority in ('Low','Normal','High','Urgent')), due_date date,
  stage text not null default 'Recording pending verification' check(stage in ('Recording pending verification','Files transferred','Backup verified','Editing','Awaiting review','Revisions requested','Approved','Scheduled','Published','Archived')),
  storage_link text, backup_location text, backup_verification_note text, backup_verified_at timestamptz,
  thumbnail_status text not null default 'Pending', caption_status text not null default 'Pending',
  publication_platform text, publication_url text, notes text not null default '',
  created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index content_event_stage_due_idx on public.content_projects(event_id,stage,due_date);
create table public.content_workflow_history (
  id uuid primary key default gen_random_uuid(), content_project_id uuid not null references public.content_projects(id) on delete cascade,
  from_stage text, to_stage text not null, actor_id uuid references public.profiles(id), note text, created_at timestamptz not null default now()
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), actor_id uuid references public.profiles(id) on delete set null,
  action text not null, target_type text not null, target_id uuid, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs(created_at desc);

do $$
declare t text;
begin
  foreach t in array array['profiles','role_definitions','events','event_templates','equipment_assets','role_assignments','operator_qualifications','training_resources','training_records','checklist_templates','checklist_instances','checklist_items','equipment_reservations','maintenance_records','sops','notifications','announcements','incidents','content_projects'] loop
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles(id,full_name,role)
  values(new.id,coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'),''),split_part(coalesce(new.email,'team member'),'@',1)),'Operator')
  on conflict(id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_auth_user();
