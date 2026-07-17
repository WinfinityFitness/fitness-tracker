-- View-other-operators'-profiles + per-operator wall-posting permissions.
-- Same soft/best-effort trust model as friends/visibility (see
-- supabase_friends_and_visibility_migration.sql): this app has no real
-- per-request authentication, so "who can post on my wall" and "what can
-- this viewer see" are enforced inside SECURITY DEFINER RPCs, not RLS.

-- ---------------------------------------------------------------------
-- 1. Public-safe profile lookup by share_key — powers "click a name to
--    view that operator's profile." Reads straight from web_sync_accounts
--    (fully private table, zero anon policies) but only ever returns the
--    same safe subset the Friends card already shows publicly (name,
--    avatar, Digital ID), plus their wall-posting permission (not
--    sensitive — knowing "only friends can post here" isn't a secret).
--    Never returns the private profile blob itself (age, weight, etc.).
-- ---------------------------------------------------------------------
alter table web_sync_accounts add column if not exists wall_post_permission text not null default 'friends';

create or replace function get_public_profile_by_share_key(p_share_key uuid)
returns table (public_id text, code_name text, avatar_data_url text, wall_post_permission text)
language sql
security definer
as $$
  select public_id,
         coalesce(profile->>'name', public_id) as code_name,
         profile->>'photoDataUrl' as avatar_data_url,
         wall_post_permission
  from web_sync_accounts
  where share_key = p_share_key;
$$;
grant execute on function get_public_profile_by_share_key(uuid) to anon;

-- ---------------------------------------------------------------------
-- 2. Wall posts — a post authored by one operator but placed on another
--    operator's profile (Facebook-style "posted on X's timeline").
--    wall_owner_share_key is null for a normal own-feed post; set for a
--    wall post. get_visible_feed_posts' author-filter is extended to
--    also match posts placed ON that author's wall by someone else, so a
--    profile page shows both "their own posts" and "what friends wrote
--    on their wall" — same idea as fetchFeedPostsByUser in app.js, which
--    now calls this RPC instead of a raw table select (that raw select
--    had no visibility check at all, so it's also a privacy fix: anyone
--    who knew a share_key could previously read their friends-only/
--    only-me posts).
-- ---------------------------------------------------------------------
alter table feed_posts add column if not exists wall_owner_share_key uuid;

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
  order by fp.created_at desc
  limit p_limit;
$$;
grant execute on function get_visible_feed_posts(uuid, timestamptz, int, uuid) to anon;

-- ---------------------------------------------------------------------
-- 3. Per-owner wall-posting permission + the check/insert RPCs that
--    enforce it server-side.
-- ---------------------------------------------------------------------
create or replace function set_wall_post_permission(p_share_key uuid, p_permission text) returns void
language plpgsql
security definer
as $$
begin
  if p_permission not in ('anyone', 'friends_of_friends', 'friends', 'only_me') then
    raise exception 'Invalid permission';
  end if;
  update web_sync_accounts set wall_post_permission = p_permission where share_key = p_share_key;
end;
$$;
grant execute on function set_wall_post_permission(uuid, text) to anon;

create or replace function are_friends_of_friends(p_a uuid, p_b uuid) returns boolean
language sql
security definer
as $$
  select exists (
    select 1
    from (
      select case when requester_share_key = p_a then addressee_share_key else requester_share_key end as friend_of_a
      from friendships
      where status = 'accepted' and (requester_share_key = p_a or addressee_share_key = p_a)
    ) fa
    join (
      select case when requester_share_key = p_b then addressee_share_key else requester_share_key end as friend_of_b
      from friendships
      where status = 'accepted' and (requester_share_key = p_b or addressee_share_key = p_b)
    ) fb on fa.friend_of_a = fb.friend_of_b
  );
$$;
grant execute on function are_friends_of_friends(uuid, uuid) to anon;

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

create or replace function create_wall_post(p_poster_share_key uuid, p_owner_share_key uuid, p_code_name text, p_message text, p_image_url text default null, p_link_preview jsonb default null) returns void
language plpgsql
security definer
as $$
begin
  if not can_post_on_wall(p_owner_share_key, p_poster_share_key) then
    raise exception 'This operator does not allow posts on their wall';
  end if;
  insert into feed_posts (share_key, code_name, message, image_url, link_preview, wall_owner_share_key)
  values (p_poster_share_key, p_code_name, p_message, p_image_url, p_link_preview, p_owner_share_key);
end;
$$;
grant execute on function create_wall_post(uuid, uuid, text, text, text, jsonb) to anon;

notify pgrst, 'reload schema';
