-- Two fixes for the profile page's Add Friend / Message buttons.

-- ---------------------------------------------------------------------
-- 1. start_dm_by_share_key -- start_dm_by_name (supabase_group_chat_migration_2.sql)
--    matches the other person by `code_name = p_other_name`, a plain
--    display-name lookup. Two people can share a name, and any mismatch
--    (stale name, case, whitespace) makes it silently `return null` --
--    which is exactly why the Message button "doesn't even budge": the
--    RPC succeeds with no error, just no data, so wdsStartDM's
--    `if (error || !data) return;` bails out with nothing visible.
--    The profile page already knows the target's real share_key
--    (wdsViewedProfile.shareKey) -- this lets the client use that
--    directly instead of the fragile name match. start_dm_by_name stays
--    in place for the one caller that only ever has a name (a Global
--    Chat sender with no synced account at all).
-- ---------------------------------------------------------------------
create or replace function start_dm_by_share_key(
  p_my_key uuid,
  p_my_name text,
  p_other_key uuid,
  p_other_name text
) returns uuid
language plpgsql
security definer
as $$
declare
  v_room_id uuid;
begin
  if p_other_key is null or p_other_key = p_my_key then
    return null;
  end if;

  select cr.id into v_room_id
  from chat_rooms cr
  where cr.is_dm = true
    and exists (select 1 from chat_room_members m1 where m1.room_id = cr.id and m1.share_key = p_my_key)
    and exists (select 1 from chat_room_members m2 where m2.room_id = cr.id and m2.share_key = p_other_key)
  limit 1;

  if v_room_id is not null then
    return v_room_id;
  end if;

  insert into chat_rooms (name, created_by_key, created_by_name, is_dm)
  values (p_other_name, p_my_key, p_my_name, true)
  returning id into v_room_id;

  insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key) values
    (v_room_id, p_my_key, p_my_name, 'joined', p_my_key),
    (v_room_id, p_other_key, p_other_name, 'joined', p_my_key);

  return v_room_id;
end;
$$;
grant execute on function start_dm_by_share_key(uuid, text, uuid, text) to anon;

-- ---------------------------------------------------------------------
-- 2. get_friend_request_status -- lets the client tell "no relationship"
--    apart from "request already pending" apart from "already friends",
--    for the specific pair of (me, this profile I'm viewing). Without
--    this, refreshWdsFriendsList only ever checked for an ACCEPTED
--    friendship and unconditionally reset the button to "+ Add Friend"
--    otherwise -- which fired again shortly after a successful send,
--    stomping the "Request Sent" label right back to "+ Add Friend" and
--    making it look like nothing happened.
-- ---------------------------------------------------------------------
create or replace function get_friend_request_status(p_share_key uuid, p_target_share_key uuid)
returns table (status text, requester_share_key uuid)
language sql
security definer
as $$
  select status, requester_share_key from friendships
  where (requester_share_key = p_share_key and addressee_share_key = p_target_share_key)
     or (requester_share_key = p_target_share_key and addressee_share_key = p_share_key)
  limit 1;
$$;
grant execute on function get_friend_request_status(uuid, uuid) to anon;

notify pgrst, 'reload schema';
