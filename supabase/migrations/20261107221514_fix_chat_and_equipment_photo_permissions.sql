begin;

-- Reply targets must be the row referenced by the new message. Qualify the
-- outer column so PostgreSQL does not bind it to parent.reply_to_id.
drop policy if exists crew_chat_messages_insert_sender on public.crew_chat_messages;
create policy crew_chat_messages_insert_sender on public.crew_chat_messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.is_active_chat_member((select auth.uid()))
    and jsonb_typeof(attachments) = 'array'
    and not exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(attachments) = 'array' then attachments else '[]'::jsonb end) as attachment
      where coalesce(attachment->>'path', '') = ''
         or split_part(attachment->>'path', '/', 1) <> (select auth.uid())::text
         or split_part(attachment->>'path', '/', 2) <> 'chat'
    )
    and (
      (conversation_type = 'all' and recipient_id is null)
      or (conversation_type = 'direct' and recipient_id is not null
          and recipient_id <> (select auth.uid())
          and public.is_active_chat_member(recipient_id))
    )
    and (
      reply_to_id is null
      or exists (
        select 1
        from public.crew_chat_messages as parent
        where parent.id = public.crew_chat_messages.reply_to_id
          and parent.conversation_type = public.crew_chat_messages.conversation_type
          and (
            public.crew_chat_messages.conversation_type = 'all'
            or (parent.sender_id = public.crew_chat_messages.sender_id and parent.recipient_id = public.crew_chat_messages.recipient_id)
            or (parent.sender_id = public.crew_chat_messages.recipient_id and parent.recipient_id = public.crew_chat_messages.sender_id)
          )
      )
    )
  );

-- The live equipment table already carries this field; keep fresh installs in sync.
alter table public.equipment_assets add column if not exists image_path text;

-- Only Administrators and Equipment Managers may add inventory records.
drop policy if exists equipment_assets_insert on public.equipment_assets;
drop policy if exists equipment_assets_insert_manager on public.equipment_assets;
create policy equipment_assets_insert_admin_equipment_manager on public.equipment_assets
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and status = case
      when condition = any (array['Needs service', 'Damaged', 'Unknown']::text[]) then 'Under maintenance'
      else 'Available'
    end
    and exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.active
        and (p.role in ('Administrator', 'Equipment Manager')
          or p.access_roles && array['Administrator', 'Equipment Manager']::text[])
    )
  );

-- Directors can still manage loans and equipment records, but cannot change
-- photo paths. This also protects the field if a client calls PostgREST directly.
create or replace function public.guard_equipment_asset_image_path()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set row_security to 'off'
as $$
begin
  if new.image_path is distinct from old.image_path
     and coalesce(auth.role(), '') <> 'service_role'
     and not exists (
       select 1 from public.profiles p
       where p.id = (select auth.uid()) and p.active
         and (p.role in ('Administrator', 'Equipment Manager')
           or p.access_roles && array['Administrator', 'Equipment Manager']::text[])
     ) then
    raise exception 'Only an administrator or equipment manager can change equipment photos' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists equipment_asset_image_path_guard on public.equipment_assets;
create trigger equipment_asset_image_path_guard
  before update of image_path on public.equipment_assets
  for each row execute function public.guard_equipment_asset_image_path();

-- Keep delete permission aligned between the API and its SECURITY DEFINER RPC.
create or replace function public.delete_equipment_asset(p_asset_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set row_security to 'off'
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.active
      and (p.role in ('Administrator', 'Equipment Manager')
        or p.access_roles && array['Administrator', 'Equipment Manager']::text[])
  ) then
    raise exception 'Only an administrator or equipment manager can delete equipment' using errcode = '42501';
  end if;

  perform 1 from public.equipment_assets where id = p_asset_id for update;
  if not found then
    raise exception 'Equipment record not found' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.equipment_loans where asset_id = p_asset_id)
     or exists (select 1 from public.equipment_reservations where asset_id = p_asset_id)
     or exists (select 1 from public.equipment_checkouts where asset_id = p_asset_id)
     or exists (select 1 from public.maintenance_records where asset_id = p_asset_id) then
    raise exception 'This equipment has borrowing, checkout, reservation, or maintenance history and cannot be deleted.' using errcode = '23503';
  end if;

  delete from public.equipment_assets where id = p_asset_id;
end;
$$;

-- The crew-media bucket is private. Preserve chat/SOP paths while granting
-- asset photo upload/removal to the two inventory roles only.
drop policy if exists crew_media_insert on storage.objects;
create policy crew_media_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'crew-media'
    and public.current_role() is not null
    and split_part(name, '/', 1) = (select auth.uid())::text
    and (
      split_part(name, '/', 2) = 'chat'
      or (split_part(name, '/', 2) = 'assets' and exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid()) and p.active
          and (p.role in ('Administrator', 'Equipment Manager')
            or p.access_roles && array['Administrator', 'Equipment Manager']::text[])
      ))
      or (split_part(name, '/', 2) = 'sops' and public.is_manager())
    )
  );

drop policy if exists crew_media_delete on storage.objects;
create policy crew_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'crew-media'
    and (
      (split_part(name, '/', 2) = 'assets' and exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid()) and p.active
          and (p.role in ('Administrator', 'Equipment Manager')
            or p.access_roles && array['Administrator', 'Equipment Manager']::text[])
      ))
      or (split_part(name, '/', 2) = 'sops' and public.is_manager())
    )
  );

commit;
