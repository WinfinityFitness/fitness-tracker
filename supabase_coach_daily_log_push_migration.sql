-- Lets a coach directly overwrite a client's CURRENT DAY food diary --
-- bypassing the client having to manually log anything themselves. Rides
-- the exact same pull mechanism as coach_assign_targets/assigned_targets
-- (supabase_assigned_targets_migration.sql, supabase_coach_extras_migration.sql):
-- one row per share_key, upserted on every push, picked up by the client's
-- EXISTING "Assigned Targets (Optional Override)" Refresh button on the
-- Fuel tab (refreshCoachAssignmentFromServer in app.js) -- no new button,
-- no new permission to grant, same trust model.
--
-- Deliberately destructive on the client side: applying a push REPLACES
-- that day's meals entirely (see applyPushedDailyLog in app.js), it does
-- not merge with whatever the client already logged. That's the point --
-- "bypass" means the coach's numbers win, not "add on top of".

create table if not exists assigned_daily_log (
  share_key uuid primary key,
  log_date date not null,
  calories int,
  protein int,
  carbs int,
  fat int,
  note text,
  assigned_by_name text,
  updated_at timestamptz not null default now()
);

alter table assigned_daily_log enable row level security;

drop policy if exists "anon read assigned_daily_log" on assigned_daily_log;
create policy "anon read assigned_daily_log" on assigned_daily_log for select using (true);
-- Deliberately no anon insert/update/delete policy -- all writes go through
-- coach_push_daily_log() below, which enforces coach+client-ownership
-- server-side, same trust model as coach_assign_targets.

create or replace function coach_push_daily_log(
  p_coach_digital_id text, p_coach_password text, p_target_digital_id text,
  p_log_date date, p_calories int, p_protein int, p_carbs int, p_fat int,
  p_note text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_share_key uuid;
declare v_brand_name text;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select share_key into v_share_key from leaderboard where public_id = p_target_digital_id limit 1;
  if v_share_key is null then
    raise exception 'No user found with that Digital ID';
  end if;
  if not exists (select 1 from coach_clients where coach_id = v_coach_id and share_key = v_share_key and status = 'active') then
    raise exception 'This user is not one of your attached clients.';
  end if;
  if p_log_date is null then
    raise exception 'A log date is required.';
  end if;
  select brand_name into v_brand_name from coaches where id = v_coach_id;

  insert into assigned_daily_log (
    share_key, log_date, calories, protein, carbs, fat, note, assigned_by_name, updated_at
  )
  values (
    v_share_key, p_log_date, p_calories, p_protein, p_carbs, p_fat, p_note, v_brand_name, now()
  )
  on conflict (share_key) do update set
    log_date = excluded.log_date,
    calories = excluded.calories,
    protein = excluded.protein,
    carbs = excluded.carbs,
    fat = excluded.fat,
    note = excluded.note,
    assigned_by_name = excluded.assigned_by_name,
    updated_at = now();

  perform log_coach_action(v_coach_id, 'push_daily_log', p_target_digital_id,
    'date=' || p_log_date::text || ' calories=' || coalesce(p_calories::text, '-') ||
    ' protein=' || coalesce(p_protein::text, '-') || ' carbs=' || coalesce(p_carbs::text, '-') ||
    ' fat=' || coalesce(p_fat::text, '-'));
end;
$$;
grant execute on function coach_push_daily_log(text, text, text, date, int, int, int, int, text) to anon;

notify pgrst, 'reload schema';
