-- Creates the one shared "Tavern" group chat room the Adventure Map's
-- Tavern tab now points at, replacing the earlier "World Chat is the same
-- public room as Nexus + a separate DM picker" design with a single named
-- room instead.
--
-- Access is gated client-side, not server-side: send_chat_message has no
-- membership check for a non-DM room (confirmed by reading its definition
-- in supabase_admin_block_visibility_migration.sql -- it only checks
-- chat_room_members/is_blocked for is_dm=true rooms), and chat_messages'
-- own SELECT policy is already anon-permissive same as every other room.
-- So no chat_room_members rows are created here at all -- the room is
-- simply only ever reachable through the Adventure Map's Tavern tab,
-- which is only visible while the game presence heartbeat (see
-- supabase_game_presence_migration.sql) is running.
--
-- Fixed id so the client can reference it directly (TAVERN_ROOM_ID in
-- app.js) without a lookup query. single_member_since is left null on
-- purpose -- cleanup_stale_solo_rooms() only deletes rooms where that's
-- NOT null, so this permanent room is never swept up by that job.

insert into chat_rooms (id, name, created_by_key, created_by_name, is_dm)
values (
  '11111111-1111-4111-8111-111111111111',
  'Tavern',
  '00000000-0000-0000-0000-000000000000',
  'System',
  false
)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
