-- coach_get_showcase_data already returns brandName (used by both
-- coach-portal.html's Chat/Status tabs and coach-dashboard.html's own
-- heading) -- adds brandLogoUrl alongside it so the Coach Portal's new
-- sticky header (see applyCoachHeaderBranding() in coach-portal.html) can
-- show the coach's own saved logo, not just their name. Everything else
-- in the function is unchanged.
create or replace function coach_get_showcase_data(p_coach_digital_id text, p_coach_password text)
returns jsonb
language plpgsql
security definer
as $$
declare v_coach_id uuid; v_brand_name text; v_brand_logo_url text; result jsonb;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select brand_name, brand_logo_url into v_brand_name, v_brand_logo_url from coaches where id = v_coach_id;

  select jsonb_build_object(
    'brandName', v_brand_name,
    'brandLogoUrl', v_brand_logo_url,
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