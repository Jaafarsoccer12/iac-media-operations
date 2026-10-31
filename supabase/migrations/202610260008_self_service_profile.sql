create or replace function public.update_own_profile(p_username text,p_avatar_url text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_username text := lower(trim(coalesce(p_username,'')));
  v_avatar_url text := coalesce(p_avatar_url,'');
  v_previous_username text;
begin
  if v_user_id is null then raise exception 'Sign in to update your profile' using errcode='42501'; end if;
  if v_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then raise exception 'Usernames must be 3 to 32 characters and use letters, numbers, dots, dashes, or underscores'; end if;
  if length(v_avatar_url)>400000 or (v_avatar_url<>'' and v_avatar_url !~ '^(https?://[^[:space:]]+|data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2})$') then
    raise exception 'Choose a JPEG photo or use a secure image link';
  end if;
  select username into v_previous_username from public.profiles where id=v_user_id and active;
  if not found then raise exception 'Active profile not found' using errcode='42501'; end if;
  update public.profiles set username=v_username,avatar_url=v_avatar_url where id=v_user_id;
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(v_user_id,'Updated own profile','profile',v_user_id,jsonb_build_object('username_changed',v_previous_username is distinct from v_username));
end; $$;

revoke execute on function public.update_own_profile(text,text) from public,anon;
grant execute on function public.update_own_profile(text,text) to authenticated;
