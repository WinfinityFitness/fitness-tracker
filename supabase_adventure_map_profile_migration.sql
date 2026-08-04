-- Exposes a read-only Adventure Map (Trailmap) summary on
-- get_public_profile_by_share_key -- same function the Profile page
-- already calls for both your own profile and a friend's, gated by the
-- same is_blocked() check already in place (no new visibility tier;
-- trailmap progress is treated the same as the rank/level info already
-- shown elsewhere, not as private as calorie/training logs). Pulled
-- straight out of the same profile JSONB blob that already round-trips
-- through web_sync for the whole app.gamification object -- no new sync
-- path needed.
drop function if exists get_public_profile_by_share_key(uuid, uuid);
create or replace function get_public_profile_by_share_key(p_share_key uuid, p_viewer_share_key uuid default null)
returns table (
  public_id text, code_name text, avatar_data_url text, wall_post_permission text,
  fitness_mode text, trailmap_leg_index int, trailmap_defeated_bosses jsonb
)
language sql
security definer
as $$
  select public_id,
         coalesce(profile->>'name', public_id) as code_name,
         profile->>'photoDataUrl' as avatar_data_url,
         wall_post_permission,
         profile->>'fitnessMode' as fitness_mode,
         coalesce((profile->'gamification'->'trailmap'->>'legIndex')::int, 0) as trailmap_leg_index,
         coalesce(profile->'gamification'->'trailmap'->'defeatedMainBosses', '[]'::jsonb) as trailmap_defeated_bosses
  from web_sync_accounts
  where share_key = p_share_key
    and (p_viewer_share_key is null or not is_blocked(p_viewer_share_key, p_share_key));
$$;
grant execute on function get_public_profile_by_share_key(uuid, uuid) to anon;

notify pgrst, 'reload schema';
