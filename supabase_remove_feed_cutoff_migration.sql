-- ---------------------------------------------------------------------
-- Remove the 30-day age cutoff from get_visible_feed_posts.
--
-- The wellness dashboard's feed queries only posts newer than
-- p_cutoff (app.js computes "now - 30 days" and passes it every call).
-- During a quiet period with no new posts, every existing post ages
-- past that window and the feed silently returns empty -- looking
-- exactly like all posts were deleted, when they're untouched in the
-- table. This happened for real on 2026-09-07 (newest post was from
-- 2026-08-05, i.e. 33 days old).
--
-- Fix: keep the same 4-argument signature (app.js still computes and
-- sends p_cutoff every call -- no client change needed, no risk of
-- reintroducing the 3-arg/4-arg overload ambiguity from
-- supabase_fix_feed_rpc_overload_migration.sql) but stop filtering by
-- it. The feed now always shows the p_limit most recent posts,
-- regardless of age.
-- ---------------------------------------------------------------------
create or replace function get_visible_feed_posts(p_viewer_share_key uuid, p_cutoff timestamptz, p_limit int default 30, p_author_share_key uuid default null)
returns setof feed_posts
language sql
security definer
as $$
  select fp.* from feed_posts fp
  where fp.deleted = false
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
