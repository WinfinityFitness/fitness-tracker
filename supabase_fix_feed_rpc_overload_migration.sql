-- Fix: supabase_profile_view_and_wall_migration.sql added a 4th parameter
-- (p_author_share_key) to get_visible_feed_posts via `create or replace`.
-- Postgres identifies functions by their argument TYPE list, so a
-- different arg count is a NEW overload, not a replacement — the
-- original 3-argument version never went away. That left two candidate
-- functions, and every normal feed load (which calls this RPC with
-- exactly 3 arguments — p_viewer_share_key, p_cutoff, p_limit) became
-- ambiguous between them, which is why the feed stopped loading.
-- Dropping the old 3-argument overload leaves only the 4-argument
-- version, whose new parameter already defaults to null.
drop function if exists get_visible_feed_posts(uuid, timestamptz, int);

notify pgrst, 'reload schema';
