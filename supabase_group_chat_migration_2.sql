-- Follow-up migration: run AFTER supabase_group_chat_migration.sql.
-- Adds: creator-only group delete, and 1:1 direct messages (DMs) reusing the
-- same chat_rooms/chat_room_members/chat_messages tables.

-- Lets the room creator delete a group (and, via FK cascade, its members and
-- messages). Anyone else calling this is a no-op — checked server-side so a
-- tampered client request can't delete someone else's group.
create or replace function delete_chat_room(p_room_id uuid, p_requester_key uuid) returns void
language plpgsql
security definer
as $$
begin
  delete from chat_rooms where id = p_room_id and created_by_key = p_requester_key;
end;
$$;

grant execute on function delete_chat_room(uuid, uuid) to anon;

-- Direct messages: a "room" with exactly two members, both auto-joined (no
-- invite/accept step, unlike groups).
alter table chat_rooms add column if not exists is_dm boolean not null default false;

-- Starts (or resumes, if one already exists) a DM with someone by their
-- current display name. Same non-unique-name caveat as group invites by
-- Digital ID — this one intentionally matches by name since it's triggered
-- by tapping a name in the chat, not typing an ID.
create or replace function start_dm_by_name(
  p_my_key uuid,
  p_my_name text,
  p_other_name text
) returns uuid
language plpgsql
security definer
as $$
declare
  v_other_key uuid;
  v_room_id uuid;
begin
  select share_key into v_other_key from leaderboard where code_name = p_other_name limit 1;
  if v_other_key is null or v_other_key = p_my_key then
    return null;
  end if;

  select cr.id into v_room_id
  from chat_rooms cr
  where cr.is_dm = true
    and exists (select 1 from chat_room_members m1 where m1.room_id = cr.id and m1.share_key = p_my_key)
    and exists (select 1 from chat_room_members m2 where m2.room_id = cr.id and m2.share_key = v_other_key)
  limit 1;

  if v_room_id is not null then
    return v_room_id;
  end if;

  insert into chat_rooms (name, created_by_key, created_by_name, is_dm)
  values (p_other_name, p_my_key, p_my_name, true)
  returning id into v_room_id;

  insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key) values
    (v_room_id, p_my_key, p_my_name, 'joined', p_my_key),
    (v_room_id, v_other_key, p_other_name, 'joined', p_my_key);

  return v_room_id;
end;
$$;

grant execute on function start_dm_by_name(uuid, text, text) to anon;
