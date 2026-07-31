-- Coach Dashboard: a showcase-style bar chart (same interaction as the
-- public Progress Showcase -- metric tabs, one bar per person, click for a
-- stat card) but scoped to a coach's own attached clients only, using
-- their real data. No opt-in gate and no synthetic demo rows needed here
-- (unlike get_public_showcase_data) -- a coach already has a legitimate
-- relationship with their own attached clients via coach_clients, and
-- this is never public/unauthenticated.
--
-- Pulls straight from `leaderboard`'s own pre-computed columns, same
-- source get_public_showcase_data uses for real (non-demo) rows --
-- every synced user already has these fields regardless of showcase
-- opt-in, since that opt-in only gates PUBLIC visibility, not whether
-- the columns exist.
-- Returned as a single JSONB object (brand_name + a rows array) rather
-- than a flat table, since this needs to hand back one coach-level field
-- (brand_name, for the dashboard header) alongside the per-client rows --
-- a plain RETURNS TABLE can't mix those without repeating brand_name on
-- every row.
create or replace function coach_get_showcase_data(p_coach_digital_id text, p_coach_password text)
returns jsonb
language plpgsql
security definer
as $$
declare v_coach_id uuid; v_brand_name text; result jsonb;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select brand_name into v_brand_name from coaches where id = v_coach_id;

  select jsonb_build_object(
    'brandName', v_brand_name,
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'publicId', l.public_id, 'codeName', l.code_name, 'avatarDataUrl', l.avatar_data_url,
        'fitnessMode', l.fitness_mode, 'weightProgressPct', l.weight_progress_pct, 'steps', l.steps,
        'volumeLifted', l.volume_lifted, 'volumeUnit', l.volume_unit, 'furthestRunKm', l.furthest_run_km,
        'fastestRunPaceSec', l.fastest_run_pace_sec, 'conscientiousScore', l.conscientious_score,
        'updatedAt', l.updated_at
      ))
      from coach_clients cc
      join leaderboard l on l.share_key = cc.share_key
      where cc.coach_id = v_coach_id and cc.status = 'active'
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
grant execute on function coach_get_showcase_data(text, text) to anon;

notify pgrst, 'reload schema';
