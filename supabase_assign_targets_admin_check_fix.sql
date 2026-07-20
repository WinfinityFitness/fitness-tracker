-- Fixes "Assign Targets" (Failed to assign) — assign_targets() was
-- reverted back to the OLD `if not verify_admin_login(...) then raise`
-- shape by supabase_social_links_override_migration.sql, which copy-
-- pasted the pre-hardening function body when it added the
-- p_show_social_links parameter, undoing the fix
-- supabase_security_hardening_migration_2.sql had already made.
-- verify_admin_login is void-returning now (raises its own exception on
-- failure) rather than returning a boolean, so `if not verify_admin_login(...)`
-- no longer does anything meaningful -- same bug class as the original
-- Post Announcement failure, just reintroduced here later. Same 10-arg
-- signature as what's currently live, so a plain CREATE OR REPLACE is
-- safe -- no DROP needed.

create or replace function assign_targets(
  p_admin_digital_id text,
  p_admin_password text,
  p_target_digital_id text,
  p_calorie_target int,
  p_step_goal int,
  p_workouts_per_week int,
  p_refeed_calories int,
  p_refeed_start date,
  p_refeed_end date,
  p_show_social_links boolean
) returns void
language plpgsql
security definer
as $$
declare
  v_target_share_key uuid;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  select share_key into v_target_share_key from leaderboard where public_id = p_target_digital_id limit 1;
  if v_target_share_key is null then
    raise exception 'No user found with that Digital ID';
  end if;

  insert into assigned_targets (
    share_key, calorie_target, step_goal, workouts_per_week,
    refeed_calories, refeed_start, refeed_end, show_social_links, assigned_by_name, updated_at
  )
  values (
    v_target_share_key, p_calorie_target, p_step_goal, p_workouts_per_week,
    p_refeed_calories, p_refeed_start, p_refeed_end, p_show_social_links, 'Coach', now()
  )
  on conflict (share_key) do update set
    calorie_target = excluded.calorie_target,
    step_goal = excluded.step_goal,
    workouts_per_week = excluded.workouts_per_week,
    refeed_calories = excluded.refeed_calories,
    refeed_start = excluded.refeed_start,
    refeed_end = excluded.refeed_end,
    show_social_links = coalesce(excluded.show_social_links, assigned_targets.show_social_links),
    updated_at = now();
end;
$$;
grant execute on function assign_targets(text, text, text, int, int, int, int, date, date, boolean) to anon;

notify pgrst, 'reload schema';
