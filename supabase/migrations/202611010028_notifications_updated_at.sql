-- The core schema installs the shared set_updated_at trigger on notifications.
-- Add its expected column so marking alarm notifications read can complete.
alter table public.notifications
  add column if not exists updated_at timestamptz not null default now();
