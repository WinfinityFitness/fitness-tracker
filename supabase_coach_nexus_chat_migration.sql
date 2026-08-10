-- Coach Portal chat, synced into the same Nexus chat system every regular
-- user already has (chat_rooms/chat_room_members/chat_messages) -- NOT a
-- separate parallel inbox. A client sees a coach's message as a completely
-- normal DM from "Coach [Brand Name]" in their own Chats/Nexus tab, and a
-- coach sees/sends it from the new Chat tab in Coach Portal. Both sides
-- read/write the exact same rows.
--
-- The blocker: coaches have no Nexus identity today. Only "linked" coaches
-- (see supabase_coach_linked_pin_migration.sql) happen to have a share_key,
-- because their coach account is tied to their OWN personal fitness-tracker
-- account. A plain Digital-ID-and-password-only coach has none at all, and
-- can't be a chat_room_members row without one. Fix: give EVERY coach a
-- dedicated chat_share_key of their own, auto-generated, used ONLY as their
-- messaging identity -- it's not a real leaderboard/showcase account (both
-- start_dm_by_share_key and send_chat_message are pure share_key/code_name
-- primitives with no leaderboard dependency at all, confirmed by reading
-- both functions -- so this never makes a coach show up in the public
-- leaderboard or showcase).

alter table coaches add column if not exists chat_share_key uuid unique default gen_random_uuid();
-- Backfill for coaches created before this column existed -- the column
-- default only applies to NEW rows, ALTER TABLE doesn't retroactively fill
-- existing ones.
update coaches set chat_share_key = gen_random_uuid() where chat_share_key is null;
alter table coaches alter column chat_share_key set not null;

-- Coach-side: opens (finding-or-creating, via the existing
-- start_dm_by_share_key) the DM thread with one of the coach's own active
-- clients, returning everything the UI needs to read/send from here on --
-- the room id, plus the coach's own chat identity so it can call the
-- already-anon-granted send_chat_message directly afterward (same as any
-- regular user does) without a second round trip.
create or replace function coach_open_client_chat(
  p_coach_digital_id text, p_coach_password text, p_client_public_id text
) returns table(room_id uuid, coach_chat_share_key uuid, coach_brand_name text)
language plpgsql
security definer
as $$
declare
  v_coach_id uuid;
  v_chat_key uuid;
  v_brand_name text;
  v_client_share_key uuid;
  v_client_code_name text;
  v_room_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);

  select share_key, code_name into v_client_share_key, v_client_code_name
    from leaderboard where public_id = p_client_public_id limit 1;
  if v_client_share_key is null then
    raise exception 'No user found with that Digital ID';
  end if;
  if not exists (select 1 from coach_clients where coach_id = v_coach_id and share_key = v_client_share_key and status = 'active') then
    raise exception 'This user is not one of your attached clients.';
  end if;

  select chat_share_key, brand_name into v_chat_key, v_brand_name from coaches where id = v_coach_id;

  v_room_id := start_dm_by_share_key(v_chat_key, v_brand_name, v_client_share_key, coalesce(v_client_code_name, p_client_public_id));

  return query select v_room_id, v_chat_key, v_brand_name;
end;
$$;
grant execute on function coach_open_client_chat(text, text, text) to anon;

-- Owner-side mirror -- opens the chat on behalf of one of a coach's
-- clients. Takes p_coach_id directly (the owner already has it from the
-- coach they're managing) rather than the coach's own password.
create or replace function admin_open_coach_client_chat(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid, p_client_public_id text
) returns table(room_id uuid, coach_chat_share_key uuid, coach_brand_name text)
language plpgsql
security definer
as $$
declare
  v_chat_key uuid;
  v_brand_name text;
  v_client_share_key uuid;
  v_client_code_name text;
  v_room_id uuid;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  select share_key, code_name into v_client_share_key, v_client_code_name
    from leaderboard where public_id = p_client_public_id limit 1;
  if v_client_share_key is null then
    raise exception 'No user found with that Digital ID';
  end if;
  if not exists (select 1 from coach_clients where coach_id = p_coach_id and share_key = v_client_share_key and status = 'active') then
    raise exception 'This user is not one of that coach''s attached clients.';
  end if;

  select chat_share_key, brand_name into v_chat_key, v_brand_name from coaches where id = p_coach_id;

  v_room_id := start_dm_by_share_key(v_chat_key, v_brand_name, v_client_share_key, coalesce(v_client_code_name, p_client_public_id));

  return query select v_room_id, v_chat_key, v_brand_name;
end;
$$;
grant execute on function admin_open_coach_client_chat(text, text, uuid, text) to anon;

-- Reading/sending from here on reuses what already exists and is already
-- anon-granted, same as any regular user's own chat -- chat_messages has
-- anon-permissive RLS (see supabase_group_chat_migration.sql's own
-- comment), so the Coach Portal just does
-- sb.from('chat_messages').select(...).eq('room_id', roomId) directly, and
-- sends via sb.rpc('send_chat_message', { p_room_id, p_sender_key: coach_chat_share_key,
-- p_code_name: coach_brand_name, p_message }). No new RPCs needed for
-- either -- that's the whole point of giving the coach a real share_key
-- instead of building a parallel messaging system.