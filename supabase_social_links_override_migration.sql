-- Adds a discreet per-user Facebook/Instagram footer-link override to the
-- existing assigned_targets/assign_targets() coach-assignment channel. Run
-- this AFTER supabase_assigned_targets_migration.sql.
--
-- show_social_links is nullable: null means "no override, use the default
-- (visible)". An admin sets it true/false via the Assign Targets overlay's
-- new "Footer Social Links" dropdown; the target user's own device picks it
-- up the moment they tap Refresh on Assigned Targets — applied immediately,
-- independent of whether they save the visible calorie/step targets
-- afterward (see refreshCoachAssignmentFromServer in app.js).

alter table assigned_targets add column if not exists show_social_links boolean;

-- The new version below adds a 10th parameter, which Postgres treats as a
-- distinct overload rather than a replacement — drop the old 9-arg one
-- first so there's no stale duplicate left behind.
drop function if exists assign_targets(text, text, text, int, int, int, int, date, date);

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
  if not verify_admin_login(p_admin_digital_id, p_admin_password) then
    raise exception 'Not authorized';
  end if;

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
    -- Leaving the dropdown at "No change" (null) on a later assignment
    -- keeps whatever override was set before, instead of clearing it —
    -- an unrelated calorie/step update shouldn't silently reset this.
    show_social_links = coalesce(excluded.show_social_links, assigned_targets.show_social_links),
    updated_at = now();
end;
$$;

grant execute on function assign_targets(text, text, text, int, int, int, int, date, date, boolean) to anon;
