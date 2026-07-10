-- Remote coach-assigned targets migration for Winfinity Tracker.
-- Run this once in the Supabase SQL editor for the project (after
-- supabase_announcement_migration.sql — reuses its verify_admin_login
-- admin-credential check).
--
-- Lets the admin (same login used for the Nexus announcement) push a
-- calorie/step/workout/refeed assignment to a specific user by their
-- Digital ID. The target user's own device pulls it down (by their own
-- share_key, which only they know) when they tap Refresh on the "Assigned
-- Targets (Optional Override)" widget on the Fuel tab.

create table if not exists assigned_targets (
  share_key uuid primary key,
  calorie_target int,
  step_goal int,
  workouts_per_week int,
  refeed_calories int,
  refeed_start date,
  refeed_end date,
  assigned_by_name text,
  updated_at timestamptz not null default now()
);

alter table assigned_targets enable row level security;

drop policy if exists "anon read assigned_targets" on assigned_targets;
create policy "anon read assigned_targets" on assigned_targets for select using (true);
-- Deliberately no anon insert/update/delete policy — all writes go through
-- assign_targets() below, which enforces the admin check server-side,
-- same trust model as set_announcement() in the announcement migration.

create or replace function assign_targets(
  p_admin_digital_id text,
  p_admin_password text,
  p_target_digital_id text,
  p_calorie_target int,
  p_step_goal int,
  p_workouts_per_week int,
  p_refeed_calories int,
  p_refeed_start date,
  p_refeed_end date
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
    refeed_calories, refeed_start, refeed_end, assigned_by_name, updated_at
  )
  values (
    v_target_share_key, p_calorie_target, p_step_goal, p_workouts_per_week,
    p_refeed_calories, p_refeed_start, p_refeed_end, 'Coach', now()
  )
  on conflict (share_key) do update set
    calorie_target = excluded.calorie_target,
    step_goal = excluded.step_goal,
    workouts_per_week = excluded.workouts_per_week,
    refeed_calories = excluded.refeed_calories,
    refeed_start = excluded.refeed_start,
    refeed_end = excluded.refeed_end,
    updated_at = now();
end;
$$;

grant execute on function assign_targets(text, text, text, int, int, int, int, date, date) to anon;
