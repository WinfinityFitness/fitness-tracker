-- Coach Portal: "Monitor" a client -- recent activity, targets-vs-actual,
-- weight trend, streak, and last-active status. Previously coach-portal.html
-- only ever showed relationship/admin data (attach/detach, targets,
-- branding) -- coaches had no way to see a client's real logged data at all.
--
-- Deliberately returns RAW log entries (not pre-aggregated compliance %s or
-- streak counts) -- the actual comparison/streak/trend logic lives in
-- app.js already (getEffectiveCalorieTarget, renderTrainingStats,
-- isBeginnerDayComplete, computeTrendSeries) and reimplementing it a
-- second time in SQL risks silently drifting from the client-facing
-- definitions a coach is trying to match. coach-portal.html's JS
-- reimplements those same definitions against this raw data instead
-- (see the file's own comments at the call site for exactly which
-- app.js function each piece mirrors).
--
-- p_days defaults to 60 (not 30) specifically so a coach-side streak
-- reimplementation has enough trailing history to count an actual streak
-- correctly -- isBeginnerDayComplete's streak can run well past 30 days
-- for a consistent client, and a too-short window would silently
-- undercount it.
create or replace function coach_get_client_monitor(
  p_coach_digital_id text, p_coach_password text, p_client_share_key uuid, p_days int default 60
) returns jsonb
language plpgsql
security definer
as $$
declare v_coach_id uuid; result jsonb;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  if not exists (
    select 1 from coach_clients
    where coach_id = v_coach_id and share_key = p_client_share_key and status = 'active'
  ) then
    raise exception 'This user is not one of your attached clients.';
  end if;

  select jsonb_build_object(
    'lastSyncedAt', (select updated_at from web_sync_accounts where share_key = p_client_share_key),
    'targets', (
      select jsonb_build_object(
        'calorieTarget', calorie_target, 'stepGoal', step_goal, 'workoutsPerWeek', workouts_per_week,
        'refeedCalories', refeed_calories, 'refeedStart', refeed_start, 'refeedEnd', refeed_end,
        'assignedByName', assigned_by_name
      )
      from assigned_targets where share_key = p_client_share_key
    ),
    'logs', coalesce((
      select jsonb_agg(jsonb_build_object('date', l.log_date, 'data', l.data) order by l.log_date)
      from web_sync_logs l
      where l.share_key = p_client_share_key and l.log_date >= (current_date - p_days)
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
grant execute on function coach_get_client_monitor(text, text, uuid, int) to anon;
