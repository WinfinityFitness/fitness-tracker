-- Coach white-label tenancy — coach quality-of-life + accountability round:
-- 1. coach_assign_targets -- lets a coach set calorie/step/workout/refeed
--    targets for their OWN attached clients (reuses the existing
--    assigned_targets table/shape from the owner-only assign_targets RPC,
--    just coach-scoped and checked against coach_clients). This is the
--    actual coaching function, more central than most of what was
--    originally left owner-only -- worth it being self-service.
-- 2. coach_change_password -- self-service, needs the CURRENT password
--    (re-verifies via verify_coach_login, same re-auth-every-call pattern
--    as everywhere else in this app).
-- 3. coach_action_log -- accountability trail now that multiple coaches
--    can modify shared data. log_coach_action() is an internal helper
--    (not itself granted to anon), called from coach_attach_client/
--    coach_remove_client/coach_assign_targets. admin_get_coach_activity_log
--    is the owner-only read side.

create table if not exists coach_action_log (
  id bigint generated always as identity primary key,
  coach_id uuid not null references coaches(id) on delete cascade,
  action text not null,
  target_public_id text,
  details text,
  created_at timestamptz not null default now()
);
alter table coach_action_log enable row level security;
-- zero anon policies -- written only via log_coach_action() (called
-- internally by other SECURITY DEFINER functions, itself not granted to
-- anon), read only via admin_get_coach_activity_log() below.

create or replace function log_coach_action(p_coach_id uuid, p_action text, p_target_public_id text, p_details text) returns void
language sql
security definer
as $$
  insert into coach_action_log (coach_id, action, target_public_id, details)
  values (p_coach_id, p_action, p_target_public_id, p_details);
$$;
-- Deliberately NOT granted to anon -- internal helper only, called from
-- other SECURITY DEFINER function bodies (which run with the privileges
-- of their definer, so they can call this without a separate grant).

create or replace function admin_get_coach_activity_log(p_admin_digital_id text, p_admin_password text, p_coach_id uuid)
returns table (action text, target_public_id text, details text, created_at timestamptz)
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  return query
    select l.action, l.target_public_id, l.details, l.created_at
    from coach_action_log l
    where l.coach_id = p_coach_id
    order by l.created_at desc
    limit 200;
end;
$$;
grant execute on function admin_get_coach_activity_log(text, text, uuid) to anon;

create or replace function coach_change_password(p_coach_digital_id text, p_old_password text, p_new_password text) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_old_password);
  if p_new_password is null or length(p_new_password) < 6 then
    raise exception 'New password must be at least 6 characters.';
  end if;
  update coaches set password_hash = crypt(p_new_password, gen_salt('bf')), updated_at = now() where id = v_coach_id;
end;
$$;
grant execute on function coach_change_password(text, text, text) to anon;

create or replace function coach_assign_targets(
  p_coach_digital_id text, p_coach_password text, p_target_digital_id text,
  p_calorie_target int, p_step_goal int, p_workouts_per_week int,
  p_refeed_calories int, p_refeed_start date, p_refeed_end date
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
  select brand_name into v_brand_name from coaches where id = v_coach_id;

  insert into assigned_targets (
    share_key, calorie_target, step_goal, workouts_per_week,
    refeed_calories, refeed_start, refeed_end, show_social_links, assigned_by_name, updated_at
  )
  values (
    v_share_key, p_calorie_target, p_step_goal, p_workouts_per_week,
    p_refeed_calories, p_refeed_start, p_refeed_end, true, v_brand_name, now()
  )
  on conflict (share_key) do update set
    calorie_target = excluded.calorie_target,
    step_goal = excluded.step_goal,
    workouts_per_week = excluded.workouts_per_week,
    refeed_calories = excluded.refeed_calories,
    refeed_start = excluded.refeed_start,
    refeed_end = excluded.refeed_end,
    assigned_by_name = excluded.assigned_by_name,
    updated_at = now();

  perform log_coach_action(v_coach_id, 'assign_targets', p_target_digital_id,
    'calories=' || coalesce(p_calorie_target::text, '-') || ' steps=' || coalesce(p_step_goal::text, '-') || ' workouts/wk=' || coalesce(p_workouts_per_week::text, '-'));
end;
$$;
grant execute on function coach_assign_targets(text, text, text, int, int, int, int, date, date) to anon;

-- coach_attach_client / coach_remove_client, now with audit logging added
-- (everything else identical to the version shipped with Phase D/the
-- account-lock migration -- room provisioning, locked-account rejection,
-- etc. all unchanged).
create or replace function coach_attach_client(
  p_coach_digital_id text, p_coach_password text, p_client_public_id text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_share_key uuid;
declare v_code_name text;
declare v_locked boolean;
declare v_existing_coach uuid;
declare v_room_id uuid;
declare v_brand_name text;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select share_key, code_name, locked into v_share_key, v_code_name, v_locked from leaderboard where public_id = p_client_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
  if coalesce(v_locked, false) then
    raise exception 'This account is locked and cannot be attached to a coach.';
  end if;
  select coach_id into v_existing_coach from coach_clients
    where share_key = v_share_key and status = 'active';
  if found and v_existing_coach <> v_coach_id then
    raise exception 'This client is already attached to a different coach';
  end if;
  insert into coach_clients (coach_id, share_key, public_id, attached_via)
  values (v_coach_id, v_share_key, p_client_public_id, 'manual')
  on conflict (coach_id, share_key) do update
    set status = 'active', public_id = excluded.public_id;

  select id into v_room_id from chat_rooms where owner_coach_id = v_coach_id limit 1;
  if v_room_id is null then
    select brand_name into v_brand_name from coaches where id = v_coach_id;
    insert into chat_rooms (name, created_by_key, created_by_name, owner_coach_id)
    values (v_brand_name || ' Group', v_share_key, v_code_name, v_coach_id)
    returning id into v_room_id;
    insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
    values (v_room_id, v_share_key, v_code_name, 'joined', v_share_key);
  else
    insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
    values (v_room_id, v_share_key, v_code_name, 'joined', v_share_key)
    on conflict (room_id, share_key) do update set status = 'joined';
  end if;

  perform log_coach_action(v_coach_id, 'attach_client', p_client_public_id, null);
end;
$$;
grant execute on function coach_attach_client(text, text, text) to anon;

create or replace function coach_remove_client(
  p_coach_digital_id text, p_coach_password text, p_client_public_id text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_share_key uuid;
declare v_room_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select share_key into v_share_key from leaderboard where public_id = p_client_public_id;

  update coach_clients set status = 'removed'
    where coach_id = v_coach_id and public_id = p_client_public_id and status = 'active';
  if not found then
    raise exception 'No active client found with that Digital ID under your roster';
  end if;

  if v_share_key is not null then
    select id into v_room_id from chat_rooms where owner_coach_id = v_coach_id limit 1;
    if v_room_id is not null then
      delete from chat_room_members where room_id = v_room_id and share_key = v_share_key;
    end if;
  end if;

  perform log_coach_action(v_coach_id, 'remove_client', p_client_public_id, null);
end;
$$;
grant execute on function coach_remove_client(text, text, text) to anon;

notify pgrst, 'reload schema';
