create table public.crew_chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_type text not null check (conversation_type in ('all', 'direct')),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid references public.profiles(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint crew_chat_conversation_participants check (
    (conversation_type = 'all' and recipient_id is null)
    or (conversation_type = 'direct' and recipient_id is not null and recipient_id <> sender_id)
  )
);

create index crew_chat_all_recent_idx
  on public.crew_chat_messages(created_at desc)
  where conversation_type = 'all';
create index crew_chat_direct_sender_recent_idx
  on public.crew_chat_messages(sender_id, recipient_id, created_at desc)
  where conversation_type = 'direct';
create index crew_chat_direct_recipient_recent_idx
  on public.crew_chat_messages(recipient_id, sender_id, created_at desc)
  where conversation_type = 'direct';

alter table public.crew_chat_messages enable row level security;
grant select, insert on public.crew_chat_messages to authenticated;

create or replace function public.is_active_chat_member(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
set row_security = off as $$
  select exists (select 1 from public.profiles p where p.id = p_user_id and p.active);
$$;

create or replace function public.list_crew_chat_members()
returns table(id uuid, full_name text, avatar_url text, role text, job_title text)
language sql stable security definer
set search_path = public, pg_temp
set row_security = off as $$
  select p.id, p.full_name, p.avatar_url, p.role::text, p.job_title
    from public.profiles p
    where public.is_active_chat_member(auth.uid())
      and p.active
      and p.id <> auth.uid()
    order by p.full_name;
$$;

revoke all on function public.is_active_chat_member(uuid) from public, anon;
revoke all on function public.list_crew_chat_members() from public, anon;
grant execute on function public.is_active_chat_member(uuid) to authenticated;
grant execute on function public.list_crew_chat_members() to authenticated;

create policy crew_chat_messages_select_participants on public.crew_chat_messages
  for select to authenticated
  using (
    public.is_active_chat_member(auth.uid())
    and (conversation_type = 'all' or sender_id = auth.uid() or recipient_id = auth.uid())
  );

create policy crew_chat_messages_insert_sender on public.crew_chat_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_active_chat_member(auth.uid())
    and (
      (conversation_type = 'all' and recipient_id is null)
      or (conversation_type = 'direct' and recipient_id is not null and recipient_id <> auth.uid() and public.is_active_chat_member(recipient_id))
    )
  );
