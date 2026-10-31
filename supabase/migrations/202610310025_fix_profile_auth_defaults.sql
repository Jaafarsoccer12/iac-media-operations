-- New auth users must receive values accepted by the current access-role constraints.
alter table public.profiles alter column role set default 'Videographer';
alter table public.profiles alter column access_roles set default array['Videographer']::text[];

create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.profiles(id,full_name,username,avatar_url,job_title,role,access_roles)
  values(
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'),''),split_part(coalesce(new.email,'team member'),'@',1)),
    nullif(lower(trim(new.raw_user_meta_data->>'username')),''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'avatar_url'),''),''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'job_title'),''),''),
    'Videographer',
    array['Videographer']::text[]
  ) on conflict(id) do nothing;
  return new;
end; $$;
