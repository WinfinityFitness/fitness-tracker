-- Follow-up migration: run AFTER supabase_group_chat_migration.sql,
-- supabase_group_chat_migration_2.sql and supabase_group_chat_migration_3.sql.
-- Adds: creator-only member kick for a group chat.

-- Lets the room creator remove another member from a group. Anyone else
-- calling this is rejected server-side, so a tampered client request can't
-- kick someone from a group they didn't create. Only applies to groups
-- (is_dm rooms have exactly two fixed members and aren't kickable).
create or replace function kick_chat_room_member(
  p_room_id uuid,
  p_requester_key uuid,
  p_target_share_key uuid
) returns void
language plpgsql
security definer
as $$
declare
  v_creator uuid;
  v_is_dm boolean;
begin
  select created_by_key, is_dm into v_creator, v_is_dm from chat_rooms where id = p_room_id;
  if v_creator is null or v_creator <> p_requester_key then
    raise exception 'Not authorized';
  end if;
  if v_is_dm then
    raise exception 'Cannot kick from a direct message';
  end if;
  if p_target_share_key = p_requester_key then
    raise exception 'Use Delete group instead of kicking yourself';
  end if;
  delete from chat_room_members where room_id = p_room_id and share_key = p_target_share_key;
end;
$$;

grant execute on function kick_chat_room_member(uuid, uuid, uuid) to anon;
