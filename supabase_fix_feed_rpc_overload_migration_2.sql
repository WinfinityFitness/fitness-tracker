-- Fix: supabase_admin_block_visibility_migration.sql re-created the
-- 3-argument get_visible_feed_posts overload (by re-declaring it in
-- place to add a block check) without realizing
-- supabase_fix_feed_rpc_overload_migration.sql had already dropped that
-- exact overload once before, for exactly this reason. Having both the
-- 3-arg and 4-arg versions again made every normal feed load (which
-- calls this RPC with exactly 3 arguments) ambiguous between them,
-- breaking the wellness Nexus feed the same way it broke before.
-- Dropping the 3-argument overload again leaves only the 4-argument
-- version (whose extra param already defaults to null) -- this is now
-- also fixed at the source in supabase_admin_block_visibility_migration.sql
-- itself, so re-running that file won't reintroduce this again.
drop function if exists get_visible_feed_posts(uuid, timestamptz, int);

notify pgrst, 'reload schema';
