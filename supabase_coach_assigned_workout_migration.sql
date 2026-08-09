-- Coach Portal: assign a weekly workout program (named exercises with
-- sets/reps/weight) to a specific client by Digital ID, same pull model
-- as supabase_assigned_targets_migration.sql's calorie/step assignment --
-- one row per client, upserted on every new assignment, read by the
-- client's own device via its own share_key (never pushed).
--
-- The client applies it by turning `exercises` into a session template
-- (see app.js's getSessionTemplates()/saveSessionTemplates(), the same
-- storage the "Load Session" dropdown on the Training tab already reads
-- from) -- riding along on the existing "Refresh" pull in the Assigned
-- Targets widget (refreshCoachAssignmentFromServer()) rather than adding
-- a second refresh button, since a coach typically sends both together.
--
-- exercises shape (jsonb array), matches session-template exercises
-- exactly so no reshaping is needed client-side:
--   [{ "name": "Bench Press", "sets": [{ "reps": 8, "weightKg": 60 }, ...] }, ...]

create table if not exists assigned_workouts (
  share_key uuid primary key,
  program_name text,
  exercises jsonb not null,
  assigned_by_name text,
  updated_at timestamptz not null default now()
);

alter table assigned_workouts enable row level security;

drop policy if exists "anon read assigned_workouts" on assigned_workouts;
create policy "anon read assigned_workouts" on assigned_workouts for select using (true);
-- Deliberately no anon insert/update/delete policy -- all writes go
-- through coach_assign_workout()/admin_assign_client_workout() below,
-- which enforce coach-owns-this-client server-side, same trust model as
-- coach_assign_targets()/admin_assign_client_targets().

-- Coach-side: assign to one of THEIR OWN attached clients.
create or replace function coach_assign_workout(
  p_coach_digital_id text, p_coach_password text, p_target_digital_id text,
  p_program_name text, p_exercises jsonb
) returns void
language plpgsql
security definer
as $$
declare
  v_coach_id uuid;
  v_share_key uuid;
  v_brand_name text;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select share_key into v_share_key from leaderboard where public_id = p_target_digital_id limit 1;
  if v_share_key is null then
    raise exception 'No user found with that Digital ID';
  end if;
  if not exists (select 1 from coach_clients where coach_id = v_coach_id and share_key = v_share_key and status = 'active') then
    raise exception 'This user is not one of your attached clients.';
  end if;
  select brand_name into v_brand_name from coaches where id = v_coach_id;

  insert into assigned_workouts (share_key, program_name, exercises, assigned_by_name, updated_at)
  values (v_share_key, p_program_name, p_exercises, v_brand_name, now())
  on conflict (share_key) do update set
    program_name = excluded.program_name,
    exercises = excluded.exercises,
    assigned_by_name = excluded.assigned_by_name,
    updated_at = now();

  perform log_coach_action(v_coach_id, 'coach_assign_workout', p_target_digital_id,
    'assigned "' || coalesce(p_program_name, 'Workout') || '" (' || jsonb_array_length(p_exercises) || ' exercise(s))');
end;
$$;
grant execute on function coach_assign_workout(text, text, text, text, jsonb) to anon;

-- Owner-side mirror: assign on behalf of one of a coach's clients (same
-- shape as admin_assign_client_targets).
create or replace function admin_assign_client_workout(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid, p_target_digital_id text,
  p_program_name text, p_exercises jsonb
) returns void
language plpgsql
security definer
as $$
declare
  v_share_key uuid;
  v_brand_name text;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  select share_key into v_share_key from leaderboard where public_id = p_target_digital_id limit 1;
  if v_share_key is null then
    raise exception 'No user found with that Digital ID';
  end if;
  if not exists (select 1 from coach_clients where coach_id = p_coach_id and share_key = v_share_key and status = 'active') then
    raise exception 'This user is not one of that coach''s attached clients.';
  end if;
  select brand_name into v_brand_name from coaches where id = p_coach_id;

  insert into assigned_workouts (share_key, program_name, exercises, assigned_by_name, updated_at)
  values (v_share_key, p_program_name, p_exercises, v_brand_name, now())
  on conflict (share_key) do update set
    program_name = excluded.program_name,
    exercises = excluded.exercises,
    assigned_by_name = excluded.assigned_by_name,
    updated_at = now();

  perform log_coach_action(p_coach_id, 'admin_assign_workout', p_target_digital_id,
    'assigned by owner: "' || coalesce(p_program_name, 'Workout') || '" (' || jsonb_array_length(p_exercises) || ' exercise(s))');
end;
$$;
grant execute on function admin_assign_client_workout(text, text, uuid, text, text, jsonb) to anon;