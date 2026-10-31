-- Username resolution and post-login account verification use a server-only
-- Supabase admin client. BYPASSRLS does not grant table SELECT privileges.
-- Keep anonymous access and the authenticated role's existing RLS unchanged.
grant select on table public.profiles to service_role;

-- These active-member policies previously queried profiles directly. Profile
-- visibility also queries assignments/events, causing an RLS recursion loop.
-- current_role() already reads the caller's active profile as SECURITY DEFINER;
-- role is NOT NULL, so this preserves the original active-member condition.
alter policy events_select_all_active_crew on public.events
  using (public.current_role() is not null);
alter policy assignments_select_event_roster on public.role_assignments
  using (public.current_role() is not null);
