-- Admin override: set a user's Fitness Mode by Digital ID from the admin
-- drawer. Delivered as a pending flag on their public leaderboard row
-- (same "admin writes leaderboard by public_id" pattern as
-- admin_grant_ad_free/admin_revoke_ad_free in supabase_ads_migration.sql)
-- since fitness mode itself lives purely in each device's own local
-- profile (offline-first) -- there's nothing server-side to update
-- directly. The TARGET's own device picks the pending override up on its
-- next periodic leaderboard sync (see pushLeaderboardEntry in app.js),
-- applies it locally exactly like a normal promotion/demotion (resets
-- modeProgress too), then clears the flag via
-- clear_leaderboard_mode_override so it only ever applies once. Normal
-- daily demotion/promotion rules resume immediately afterward -- this is
-- a one-time forced-set, not a lock.
alter table leaderboard add column if not exists admin_mode_override text;

create or replace function admin_set_fitness_mode(
  p_digital_id text, p_password text, p_target_public_id text, p_mode text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  if p_mode not in ('beginner', 'warrior', 'spartan', 'demigod') then
    raise exception 'Invalid fitness mode.';
  end if;
  update leaderboard set admin_mode_override = p_mode where public_id = p_target_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
end;
$$;
grant execute on function admin_set_fitness_mode(text, text, text, text) to anon;

-- Self-service (no admin auth) -- a user's own device calls this on
-- itself, right after applying a pending override locally, so it's not
-- re-applied on every subsequent sync.
create or replace function clear_leaderboard_mode_override(p_share_key uuid) returns void
language sql
security definer
as $$
  update leaderboard set admin_mode_override = null where share_key = p_share_key;
$$;
grant execute on function clear_leaderboard_mode_override(uuid) to anon;

notify pgrst, 'reload schema';
