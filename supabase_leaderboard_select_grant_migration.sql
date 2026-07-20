-- The leaderboard table has an RLS policy allowing public reads ("Public
-- read access" ... using (true), from leaderboard_setup.sql), but an RLS
-- policy only takes effect AFTER the underlying Postgres role already has
-- table-level SELECT privilege -- it's not a substitute for the grant
-- itself. Somewhere along the way (most likely the broader security-
-- hardening pass earlier in this project's history) the anon role's
-- privilege on this specific table was missing/revoked, while every other
-- table the app reads directly (feed_posts, chat_messages, etc.) still had
-- theirs.
--
-- This silently broke every direct read of this table -- confirmed live:
-- a plain anon SELECT against leaderboard returns
-- "permission denied for table leaderboard" (Postgres 42501), while the
-- same request against feed_posts/chat_messages succeeds normally. Writes
-- (upsert_leaderboard_entry, set_leaderboard_avatar, etc.) kept working
-- throughout because those are SECURITY DEFINER functions, which run with
-- the function owner's privileges, not the caller's -- so the underlying
-- grant gap never affected them, only ever masking itself.
--
-- Practical effect: EVERY feature reading this table directly has been
-- silently returning empty/erroring the whole time, not just avatars --
-- wdsFetchAvatarsByShareKey (feed/chat/friends avatars everywhere on
-- wellness) and pullLeaderboard() (the Nexus/Leaderboard rankings tab in
-- FT and its wellness mirror) alike.

grant select on public.leaderboard to anon;

notify pgrst, 'reload schema';
