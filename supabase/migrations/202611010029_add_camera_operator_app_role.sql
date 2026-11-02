-- Add Camera Operator as a distinct app-access role alongside PTZ Camera Operator.
-- This only widens accepted role values; it does not modify existing profiles.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (
  role in ('Administrator','Director','Videographer','Video Switcher Operator','Camera Operator','PTZ Camera Operator','Audio Operator','Equipment Manager','Video Operator','Photography')
);

alter table public.profiles drop constraint if exists profiles_access_roles_check;
alter table public.profiles add constraint profiles_access_roles_check check (
  cardinality(access_roles) between 1 and 10 and
  access_roles <@ array['Administrator','Director','Videographer','Video Switcher Operator','Camera Operator','PTZ Camera Operator','Audio Operator','Equipment Manager','Video Operator','Photography']::text[]
);
