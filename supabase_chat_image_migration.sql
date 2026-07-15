-- Adds photo-attachment support to chat_messages (Public Chat + group
-- chat/DMs all share this one table, so this covers every room type).
-- Same permissive-for-anon trust model as the rest of the chat schema
-- (chat_messages/chat_rooms/chat_room_members) — no real auth, client-
-- generated share_key is trusted, matching leaderboard_setup.sql /
-- supabase_group_chat_migration.sql.

alter table chat_messages add column if not exists image_url text;

-- The original insert policy (leaderboard_setup.sql) required a non-empty
-- message (1-280 chars), which never allowed an image-only post. Replace it
-- with one that allows an empty message as long as an image is attached.
drop policy if exists "Public insert with basic length limits" on public.chat_messages;

create policy "Public insert with basic length limits"
  on public.chat_messages for insert
  with check (
    char_length(message) between 0 and 280
    and char_length(code_name) between 1 and 40
    and (char_length(message) > 0 or image_url is not null)
  );

-- ---------------------------------------------------------------------
-- Storage bucket for chat image attachments
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', true)
on conflict (id) do nothing;

drop policy if exists "chat images are publicly readable" on storage.objects;
create policy "chat images are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'chat-images');

drop policy if exists "anyone can upload a chat image" on storage.objects;
create policy "anyone can upload a chat image"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'chat-images');
