-- Separate a person's production position from their access role.
alter table public.profiles add column if not exists job_title text not null default '';
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists avatar_url text not null default '';
create unique index if not exists profiles_username_lower_unique on public.profiles(lower(username)) where username is not null and btrim(username) <> '';

create or replace function public.guard_profile_privileges() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active or new.qualification_status is distinct from old.qualification_status)
    and session_user not in ('postgres','supabase_admin','service_role')
    and current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    and public.current_role() is distinct from 'Administrator' then
    raise exception 'Only an administrator can change a role, account state, or qualification' using errcode='42501';
  end if;
  return new;
end; $$;

create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.profiles(id,full_name,username,avatar_url,job_title,role)
  values(
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'),''),split_part(coalesce(new.email,'team member'),'@',1)),
    nullif(lower(trim(new.raw_user_meta_data->>'username')),''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'avatar_url'),''),''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'job_title'),''),''),
    'Operator'
  ) on conflict(id) do nothing;
  return new;
end; $$;

revoke execute on function public.guard_profile_privileges(),public.handle_new_auth_user() from public,anon,authenticated;
