-- Admin override: rename a user's Entity Designation (leaderboard display
-- name) by Digital ID from the admin drawer. Unlike
-- admin_set_fitness_mode (supabase_admin_fitness_mode_override_migration.sql),
-- code_name is a live server-side column with nothing device-local to
-- reconcile, so this writes it directly -- same "admin writes leaderboard
-- by public_id" pattern as admin_grant_ad_free/admin_revoke_ad_free
-- (supabase_ads_migration.sql), no pending-flag/pickup dance needed.
--
-- Caveat: if the target still has their own Bio "Name" set locally
-- (profile.name), effectiveLeaderboardName() in app.js prefers that over
-- code_name, so their own next leaderboard sync will silently overwrite
-- this back to their chosen name. This override is really only "sticky"
-- for accounts with no Bio Name set (running on the generated fallback
-- code name).
create or replace function admin_set_entity_designation(
  p_digital_id text, p_password text, p_target_public_id text, p_new_name text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  if p_new_name is null or trim(p_new_name) = '' then
    raise exception 'Entity Designation cannot be blank.';
  end if;
  if length(trim(p_new_name)) > 40 then
    raise exception 'Entity Designation must be 40 characters or fewer.';
  end if;
  update leaderboard set code_name = trim(p_new_name) where public_id = p_target_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
end;
$$;
grant execute on function admin_set_entity_designation(text, text, text, text) to anon;

notify pgrst, 'reload schema';
