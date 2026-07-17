-- Friends system + per-post visibility (Public / Friends / Only Me) for
-- the desktop Profile Page. Same soft/best-effort trust model as the rest
-- of Nexus — this app has no real per-request authentication (no
-- auth.uid()), so visibility below is enforced by a SECURITY DEFINER RPC
-- doing the friend-check server-side, not by an RLS policy (RLS can't
-- tell "who's asking" without real auth) — same caveat already documented
-- for chat_rooms/chat_room_members: not a hard guarantee against a
-- determined anon-key holder querying feed_posts directly, just what the
-- app itself respects.

-- ---------------------------------------------------------------------
-- 1. A public-safe avatar column on leaderboard (already the "safe
--    public subset" table — public_id was added here for the same
--    reason). The FULL profile photo lives in web_sync_accounts.profile,
--    which is correctly private (zero anon policies) — this is a
--    separate, deliberately-public copy the user pushes here whenever
--    their Entity Identity photo changes, purely so Friends cards / feed
--    avatars have something to show for OTHER people, not just initials.
-- ---------------------------------------------------------------------
alter table leaderboard add column if not exists avatar_data_url text;

create or replace function set_leaderboard_avatar(p_share_key uuid, p_avatar_data_url text) returns void
language sql
security definer
as $$
  update leaderboard set avatar_data_url = p_avatar_data_url where share_key = p_share_key;
$$;
grant execute on function set_leaderboard_avatar(uuid, text) to anon;

-- ---------------------------------------------------------------------
-- 2. Friendships — request/accept/decline/remove, all through RPCs.
--    RLS enabled with zero anon policies (like web_sync_accounts): the
--    ONLY way to touch this table is through the functions below.
-- ---------------------------------------------------------------------
create table if not exists friendships (
  requester_share_key uuid not null,
  addressee_share_key uuid not null,
  status text not null default 'pending', -- 'pending' | 'accepted'
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (requester_share_key, addressee_share_key),
  constraint friendships_no_self check (requester_share_key <> addressee_share_key)
);
alter table friendships enable row level security;

create or replace function send_friend_request(p_share_key uuid, p_target_public_id text) returns void
language plpgsql
security definer
as $$
declare
  v_target_key uuid;
begin
  select share_key into v_target_key from leaderboard where public_id = p_target_public_id limit 1;
  if v_target_key is null then
    raise exception 'No user found with that Digital ID';
  end if;
  if v_target_key = p_share_key then
    raise exception 'You can''t add yourself as a friend';
  end if;
  -- Already friends, or a request already pending either direction: no-op
  -- rather than erroring, so a double-tap of "Add Friend" is harmless.
  if exists (
    select 1 from friendships
    where (requester_share_key = p_share_key and addressee_share_key = v_target_key)
       or (requester_share_key = v_target_key and addressee_share_key = p_share_key)
  ) then
    return;
  end if;
  insert into friendships (requester_share_key, addressee_share_key, status)
  values (p_share_key, v_target_key, 'pending');
end;
$$;
grant execute on function send_friend_request(uuid, text) to anon;

create or replace function respond_friend_request(p_share_key uuid, p_requester_share_key uuid, p_accept boolean) returns void
language plpgsql
security definer
as $$
begin
  if p_accept then
    update friendships set status = 'accepted', responded_at = now()
    where requester_share_key = p_requester_share_key and addressee_share_key = p_share_key and status = 'pending';
  else
    delete from friendships
    where requester_share_key = p_requester_share_key and addressee_share_key = p_share_key and status = 'pending';
  end if;
end;
$$;
grant execute on function respond_friend_request(uuid, uuid, boolean) to anon;

create or replace function remove_friend(p_share_key uuid, p_other_share_key uuid) returns void
language sql
security definer
as $$
  delete from friendships
  where (requester_share_key = p_share_key and addressee_share_key = p_other_share_key)
     or (requester_share_key = p_other_share_key and addressee_share_key = p_share_key);
$$;
grant execute on function remove_friend(uuid, uuid) to anon;

create or replace function list_friends(p_share_key uuid)
returns table (share_key uuid, code_name text, public_id text, avatar_data_url text)
language sql
security definer
as $$
  select l.share_key, l.code_name, l.public_id, l.avatar_data_url
  from friendships f
  join leaderboard l on l.share_key = (case when f.requester_share_key = p_share_key then f.addressee_share_key else f.requester_share_key end)
  where f.status = 'accepted' and (f.requester_share_key = p_share_key or f.addressee_share_key = p_share_key);
$$;
grant execute on function list_friends(uuid) to anon;

create or replace function list_pending_friend_requests(p_share_key uuid)
returns table (requester_share_key uuid, code_name text, public_id text, avatar_data_url text, created_at timestamptz)
language sql
security definer
as $$
  select l.share_key, l.code_name, l.public_id, l.avatar_data_url, f.created_at
  from friendships f
  join leaderboard l on l.share_key = f.requester_share_key
  where f.addressee_share_key = p_share_key and f.status = 'pending';
$$;
grant execute on function list_pending_friend_requests(uuid) to anon;

create or replace function are_friends(p_a uuid, p_b uuid) returns boolean
language sql
security definer
as $$
  select exists (
    select 1 from friendships
    where status = 'accepted'
      and ((requester_share_key = p_a and addressee_share_key = p_b)
        or (requester_share_key = p_b and addressee_share_key = p_a))
  );
$$;
grant execute on function are_friends(uuid, uuid) to anon;

-- ---------------------------------------------------------------------
-- 3. feed_posts visibility. The existing "Public read access" (select
--    using (true)) policy stays as-is — see the note at the top of this
--    file on why this is enforced by an RPC, not RLS. The app's own feed
--    fetch (fetchFeedPosts in app.js) switches from a direct table
--    select to calling get_visible_feed_posts below.
-- ---------------------------------------------------------------------
alter table feed_posts add column if not exists visibility text not null default 'public';

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
  order by fp.created_at desc
  limit p_limit;
$$;
grant execute on function get_visible_feed_posts(uuid, timestamptz, int) to anon;

create or replace function set_feed_post_visibility(p_post_id bigint, p_share_key uuid, p_visibility text) returns void
language plpgsql
security definer
as $$
begin
  if p_visibility not in ('public', 'friends', 'only_me') then
    raise exception 'Invalid visibility';
  end if;
  update feed_posts set visibility = p_visibility where id = p_post_id and share_key = p_share_key;
end;
$$;
grant execute on function set_feed_post_visibility(bigint, uuid, text) to anon;

notify pgrst, 'reload schema';
