-- Admin-initiated, one-directional user blocking: "hide p_hide_public_id
-- FROM p_from_public_id" (the reverse direction is untouched unless
-- admin_block_visibility is called again with the IDs swapped). Same
-- soft/best-effort trust model as friends/visibility and profile/wall
-- (see supabase_friends_and_visibility_migration.sql and
-- supabase_profile_view_and_wall_migration.sql) -- this app has no real
-- per-request authentication, so this is enforced inside SECURITY
-- DEFINER RPCs the app itself calls, not a hard guarantee against a
-- determined anon-key holder querying tables directly.
--
-- Scope: Leaderboard, profile view, Nexus feed/wall, and DM room
-- creation + DM message sending. NOT covered: group chat rooms (more
-- than 2 members -- hiding one member's messages from just one other
-- member isn't well-defined the same way) and the public Nexus Com/
-- Global Chat room (room_id is null there, not a real chat_rooms row --
-- see the Nexus Com merge notes in app.js). Blocking a pair still lets
-- both read that shared public room same as anyone else.

-- ---------------------------------------------------------------------
-- 1. blocked_pairs -- RLS enabled, zero anon policies (same lockdown as
--    friendships): the only way to read or write this table is through
--    the functions below.
-- ---------------------------------------------------------------------
create table if not exists blocked_pairs (
  blocker_share_key uuid not null,
  blocked_share_key uuid not null,
  created_at timestamptz not null default now(),
  primary key (blocker_share_key, blocked_share_key),
  constraint blocked_pairs_no_self check (blocker_share_key <> blocked_share_key)
);
alter table blocked_pairs enable row level security;

create or replace function is_blocked(p_blocker uuid, p_blocked uuid) returns boolean
language sql
security definer
as $$
  select exists (
    select 1 from blocked_pairs
    where blocker_share_key = p_blocker and blocked_share_key = p_blocked
  );
$$;
grant execute on function is_blocked(uuid, uuid) to anon;

-- ---------------------------------------------------------------------
-- 2. Admin RPCs -- Digital ID in, resolved to share_key the same way
--    send_friend_request does (select share_key from leaderboard where
--    public_id = ...).
-- ---------------------------------------------------------------------
create or replace function admin_block_visibility(
  p_digital_id text, p_password text, p_hide_public_id text, p_from_public_id text
) returns void
language plpgsql
security definer
as $$
declare
  v_hide_key uuid;
  v_from_key uuid;
begin
  perform verify_admin_login(p_digital_id, p_password);
  select share_key into v_hide_key from leaderboard where public_id = p_hide_public_id limit 1;
  select share_key into v_from_key from leaderboard where public_id = p_from_public_id limit 1;
  if v_hide_key is null or v_from_key is null then
    raise exception 'One of those Digital IDs wasn''t found';
  end if;
  if v_hide_key = v_from_key then
    raise exception 'Can''t block a user from themselves';
  end if;
  insert into blocked_pairs (blocker_share_key, blocked_share_key)
  values (v_from_key, v_hide_key)
  on conflict (blocker_share_key, blocked_share_key) do nothing;
end;
$$;
grant execute on function admin_block_visibility(text, text, text, text) to anon;

create or replace function admin_unblock_visibility(
  p_digital_id text, p_password text, p_hide_public_id text, p_from_public_id text
) returns void
language plpgsql
security definer
as $$
declare
  v_hide_key uuid;
  v_from_key uuid;
begin
  perform verify_admin_login(p_digital_id, p_password);
  select share_key into v_hide_key from leaderboard where public_id = p_hide_public_id limit 1;
  select share_key into v_from_key from leaderboard where public_id = p_from_public_id limit 1;
  if v_hide_key is null or v_from_key is null then
    raise exception 'One of those Digital IDs wasn''t found';
  end if;
  delete from blocked_pairs where blocker_share_key = v_from_key and blocked_share_key = v_hide_key;
end;
$$;
grant execute on function admin_unblock_visibility(text, text, text, text) to anon;

-- ---------------------------------------------------------------------
-- 3. Leaderboard -- pullLeaderboard() in app.js switches from a raw
--    table select to this RPC. Column list mirrors the original select
--    exactly (share_key deliberately excluded from what's returned to
--    the client -- it also authorizes deleting one's own leaderboard
--    entry, same reasoning already documented in
--    supabase_group_chat_migration.sql for why public_id exists at all).
--    %TYPE references so this can't drift from the real column types.
-- ---------------------------------------------------------------------
create or replace function get_visible_leaderboard(p_viewer_share_key uuid)
returns table (
  code_name leaderboard.code_name%TYPE,
  public_id leaderboard.public_id%TYPE,
  weight leaderboard.weight%TYPE,
  weight_unit leaderboard.weight_unit%TYPE,
  weight_progress leaderboard.weight_progress%TYPE,
  weight_progress_pct leaderboard.weight_progress_pct%TYPE,
  steps leaderboard.steps%TYPE,
  volume_lifted leaderboard.volume_lifted%TYPE,
  volume_unit leaderboard.volume_unit%TYPE,
  furthest_run_km leaderboard.furthest_run_km%TYPE,
  fastest_run_pace_sec leaderboard.fastest_run_pace_sec%TYPE,
  conscientious_score leaderboard.conscientious_score%TYPE,
  fitness_mode leaderboard.fitness_mode%TYPE,
  updated_at leaderboard.updated_at%TYPE
)
language sql
security definer
as $$
  select l.code_name, l.public_id, l.weight, l.weight_unit, l.weight_progress,
         l.weight_progress_pct, l.steps, l.volume_lifted, l.volume_unit,
         l.furthest_run_km, l.fastest_run_pace_sec, l.conscientious_score,
         l.fitness_mode, l.updated_at
  from leaderboard l
  where p_viewer_share_key is null or not is_blocked(p_viewer_share_key, l.share_key)
  order by l.updated_at desc;
$$;
grant execute on function get_visible_leaderboard(uuid) to anon;

-- ---------------------------------------------------------------------
-- 4. Profile view -- get_public_profile_by_share_key gains an optional
--    viewer param. Dropped and recreated (not just "or replace") because
--    adding a parameter creates a distinct overload rather than actually
--    replacing the 1-arg version -- see supabase_fix_feed_rpc_overload_
--    migration.sql for the exact ambiguity this project hit before with
--    get_visible_feed_posts; dropping the old signature avoids repeating
--    it here, and guarantees the unfiltered 1-arg version can't still be
--    called by anything that hasn't picked up the new app.js yet.
-- ---------------------------------------------------------------------
drop function if exists get_public_profile_by_share_key(uuid);

create or replace function get_public_profile_by_share_key(p_share_key uuid, p_viewer_share_key uuid default null)
returns table (public_id text, code_name text, avatar_data_url text, wall_post_permission text)
language sql
security definer
as $$
  select public_id,
         coalesce(profile->>'name', public_id) as code_name,
         profile->>'photoDataUrl' as avatar_data_url,
         wall_post_permission
  from web_sync_accounts
  where share_key = p_share_key
    and (p_viewer_share_key is null or not is_blocked(p_viewer_share_key, p_share_key));
$$;
grant execute on function get_public_profile_by_share_key(uuid, uuid) to anon;

-- ---------------------------------------------------------------------
-- 5. Feed/wall -- both existing get_visible_feed_posts overloads
--    (3-arg from supabase_friends_and_visibility_migration.sql, 4-arg
--    from supabase_profile_view_and_wall_migration.sql) gain a block
--    check; arg lists are unchanged so these are genuine in-place
--    replacements, not new overloads. can_post_on_wall also gains a
--    block check, ahead of its existing permission logic.
-- ---------------------------------------------------------------------
create or replace function get_visible_feed_posts(p_viewer_share_key uuid, p_cutoff timestamptz, p_limit int default 30)
returns setof feed_posts
language sql
security definer
as $$
  select fp.* from feed_posts fp
  where fp.deleted = false
    and fp.created_at >= p_cutoff
    and (
      fp.visibility = 'public'
      or fp.share_key = p_viewer_share_key
      or (fp.visibility = 'friends' and are_friends(fp.share_key, p_viewer_share_key))
    )
    and not is_blocked(p_viewer_share_key, fp.share_key)
  order by fp.created_at desc
  limit p_limit;
$$;
grant execute on function get_visible_feed_posts(uuid, timestamptz, int) to anon;

create or replace function get_visible_feed_posts(p_viewer_share_key uuid, p_cutoff timestamptz, p_limit int default 30, p_author_share_key uuid default null)
returns setof feed_posts
language sql
security definer
as $$
  select fp.* from feed_posts fp
  where fp.deleted = false
    and fp.created_at >= p_cutoff
    and (
      p_author_share_key is null
      or fp.share_key = p_author_share_key
      or fp.wall_owner_share_key = p_author_share_key
    )
    and (
      fp.visibility = 'public'
      or fp.share_key = p_viewer_share_key
      or (fp.visibility = 'friends' and are_friends(fp.share_key, p_viewer_share_key))
    )
    and not is_blocked(p_viewer_share_key, fp.share_key)
  order by fp.created_at desc
  limit p_limit;
$$;
grant execute on function get_visible_feed_posts(uuid, timestamptz, int, uuid) to anon;

create or replace function can_post_on_wall(p_owner_share_key uuid, p_poster_share_key uuid) returns boolean
language plpgsql
security definer
as $$
declare
  v_permission text;
begin
  if p_owner_share_key = p_poster_share_key then
    return true;
  end if;
  if is_blocked(p_owner_share_key, p_poster_share_key) then
    return false;
  end if;
  select wall_post_permission into v_permission from web_sync_accounts where share_key = p_owner_share_key;
  v_permission := coalesce(v_permission, 'friends');
  if v_permission = 'anyone' then return true; end if;
  if v_permission = 'only_me' then return false; end if;
  if v_permission = 'friends' then return are_friends(p_owner_share_key, p_poster_share_key); end if;
  if v_permission = 'friends_of_friends' then
    return are_friends(p_owner_share_key, p_poster_share_key) or are_friends_of_friends(p_owner_share_key, p_poster_share_key);
  end if;
  return false;
end;
$$;
grant execute on function can_post_on_wall(uuid, uuid) to anon;

-- ---------------------------------------------------------------------
-- 6. DM room creation -- both start_dm_by_share_key and start_dm_by_name
--    now return null on a blocked pair instead of creating/finding a
--    room, matching their existing "returns null on failure" contract
--    (wdsStartDM/startDM in app.js already treat a null/falsy result as
--    a silent failure, no app.js change needed for these two).
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
  if is_blocked(p_other_key, p_my_key) or is_blocked(p_my_key, p_other_key) then
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

create or replace function start_dm_by_name(
  p_my_key uuid,
  p_my_name text,
  p_other_name text
) returns uuid
language plpgsql
security definer
as $$
declare
  v_room_id uuid;
  v_other_key uuid;
begin
  select share_key into v_other_key from leaderboard where code_name = p_other_name limit 1;
  if v_other_key is null or v_other_key = p_my_key then
    return null;
  end if;
  if is_blocked(v_other_key, p_my_key) or is_blocked(p_my_key, v_other_key) then
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

-- ---------------------------------------------------------------------
-- 7. DM message sending -- previously a raw client-side insert with only
--    a length-check RLS policy (chat_image_migration's "Public insert
--    with basic length limits"), no room-membership or block check at
--    all, since RLS can't see "who's the other member of this specific
--    room" the way a SECURITY DEFINER function can. postChatMessage in
--    app.js switches to this RPC instead -- only DM rooms (chat_rooms.
--    is_dm = true) are block-checked; group rooms and the public
--    Global Chat room (room_id is null, not a real chat_rooms row) pass
--    through unchanged, per the scope note at the top of this file.
--    Blocks in EITHER direction between the two DM participants stop
--    the send, not just the direction the admin specified -- a private
--    1:1 thread only has two people in it, so "X hidden from Y" and "Y
--    hidden from X" both mean this conversation shouldn't continue.
-- ---------------------------------------------------------------------
create or replace function send_chat_message(
  p_room_id uuid, p_sender_key uuid, p_code_name text, p_message text, p_image_url text default null
) returns void
language plpgsql
security definer
as $$
declare
  v_is_dm boolean;
  v_other_key uuid;
  v_message text := coalesce(p_message, '');
begin
  if char_length(v_message) > 280 then
    raise exception 'Message too long.';
  end if;
  if char_length(coalesce(p_code_name, '')) not between 1 and 40 then
    raise exception 'Invalid code name.';
  end if;
  if char_length(v_message) = 0 and p_image_url is null then
    raise exception 'Empty message.';
  end if;

  if p_room_id is not null then
    select is_dm into v_is_dm from chat_rooms where id = p_room_id;
    if v_is_dm then
      select share_key into v_other_key from chat_room_members
        where room_id = p_room_id and share_key is distinct from p_sender_key limit 1;
      if v_other_key is not null and (is_blocked(v_other_key, p_sender_key) or is_blocked(p_sender_key, v_other_key)) then
        raise exception 'Message blocked.';
      end if;
    end if;
  end if;

  insert into chat_messages (code_name, message, image_url, room_id, sender_share_key)
  values (p_code_name, v_message, p_image_url, p_room_id, p_sender_key);
end;
$$;
grant execute on function send_chat_message(uuid, uuid, text, text, text) to anon;

notify pgrst, 'reload schema';
