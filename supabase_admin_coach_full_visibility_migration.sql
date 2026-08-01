-- Owner/super-admin full visibility + control over every coach's data --
-- last login timestamp, their real client roster (with Monitor access),
-- and their branding/splash settings, all viewable and editable from the
-- Owner Card without needing to reset a coach's password and log in as
-- them. Every new function here is gated by the existing, unmodified
-- verify_admin_login (same as admin_set_coach_features/admin_set_coach_active
-- already are) -- a coach's own credentials can never reach any of this.
-- Writes reuse the existing log_coach_action() helper so admin-made
-- changes show up in the same Activity Log a coach's own actions do.

alter table coaches add column if not exists last_login_at timestamptz;

-- Same auth logic as before, now also stamping last_login_at on success --
-- this is what lets the owner see which coaches have actually logged in.
create or replace function verify_coach_login(p_digital_id text, p_password text) returns uuid
language plpgsql
security definer
as $$
declare c coaches%rowtype;
begin
  select * into c from coaches where digital_id = p_digital_id;
  if not found or not c.active then
    raise exception 'Not authorized';
  end if;
  if c.locked_until is not null and c.locked_until > now() then
    raise exception 'Too many attempts — try again later';
  end if;
  if c.password_hash <> crypt(p_password, c.password_hash) then
    update coaches set failed_attempts = failed_attempts + 1,
      locked_until = case when failed_attempts + 1 >= 8 then now() + interval '15 minutes' else locked_until end
    where id = c.id;
    raise exception 'Not authorized';
  end if;
  update coaches set failed_attempts = 0, locked_until = null, last_login_at = now() where id = c.id;
  return c.id;
end;
$$;
grant execute on function verify_coach_login(text, text) to anon;

-- Return columns changed (added last_login_at + branding fields) -- drop
-- first, same reason as every other signature-changing function here.
drop function if exists admin_list_coaches(text, text);
create or replace function admin_list_coaches(p_admin_digital_id text, p_admin_password text)
returns table (
  id uuid, digital_id text, brand_name text, slug text, active boolean,
  feature_core_tracking boolean, feature_resistance_training boolean,
  feature_outdoor_activity boolean, feature_nutrition_logging boolean, feature_prep_meals boolean,
  client_count bigint, created_at timestamptz, last_login_at timestamptz,
  brand_logo_url text, brand_color_primary text, brand_color_accent text
)
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  return query
    select c.id, c.digital_id, c.brand_name, c.slug, c.active,
      c.feature_core_tracking, c.feature_resistance_training,
      c.feature_outdoor_activity, c.feature_nutrition_logging, c.feature_prep_meals,
      (select count(*) from coach_clients cc where cc.coach_id = c.id and cc.status = 'active'),
      c.created_at, c.last_login_at,
      c.brand_logo_url, c.brand_color_primary, c.brand_color_accent
    from coaches c
    order by c.created_at desc;
end;
$$;
grant execute on function admin_list_coaches(text, text) to anon;

-- ---------------------------------------------------------------------
-- Client roster (view) -- same shape as the coach's own coach_list_clients,
-- just targeting p_coach_id directly under admin auth instead of resolving
-- the caller's own coach_id via their credentials.
-- ---------------------------------------------------------------------
create or replace function admin_get_coach_clients(p_admin_digital_id text, p_admin_password text, p_coach_id uuid)
returns table (share_key uuid, public_id text, client_nickname text, attached_at timestamptz)
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  return query
    select cc.share_key, cc.public_id, cc.client_nickname, cc.created_at
    from coach_clients cc
    where cc.coach_id = p_coach_id and cc.status = 'active'
    order by cc.created_at desc;
end;
$$;
grant execute on function admin_get_coach_clients(text, text, uuid) to anon;

create or replace function admin_set_client_nickname(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid, p_client_public_id text, p_nickname text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  update coach_clients set client_nickname = nullif(trim(p_nickname), '')
  where coach_id = p_coach_id and public_id = p_client_public_id and status = 'active';
  if not found then
    raise exception 'This user is not one of that coach''s attached clients.';
  end if;
  perform log_coach_action(p_coach_id, 'admin_rename_client', p_client_public_id, 'renamed by owner');
end;
$$;
grant execute on function admin_set_client_nickname(text, text, uuid, text, text) to anon;

create or replace function admin_assign_client_targets(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid, p_target_digital_id text,
  p_calorie_target int, p_step_goal int, p_workouts_per_week int,
  p_refeed_calories int, p_refeed_start date, p_refeed_end date
) returns void
language plpgsql
security definer
as $$
declare v_share_key uuid;
declare v_brand_name text;
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

  insert into assigned_targets (
    share_key, calorie_target, step_goal, workouts_per_week,
    refeed_calories, refeed_start, refeed_end, show_social_links, assigned_by_name, updated_at
  )
  values (
    v_share_key, p_calorie_target, p_step_goal, p_workouts_per_week,
    p_refeed_calories, p_refeed_start, p_refeed_end, true, v_brand_name, now()
  )
  on conflict (share_key) do update set
    calorie_target = excluded.calorie_target, step_goal = excluded.step_goal,
    workouts_per_week = excluded.workouts_per_week, refeed_calories = excluded.refeed_calories,
    refeed_start = excluded.refeed_start, refeed_end = excluded.refeed_end,
    assigned_by_name = excluded.assigned_by_name, updated_at = now();

  perform log_coach_action(p_coach_id, 'admin_assign_targets', p_target_digital_id, 'assigned by owner');
end;
$$;
grant execute on function admin_assign_client_targets(text, text, uuid, text, int, int, int, int, date, date) to anon;

create or replace function admin_remove_coach_client(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid, p_client_public_id text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  update coach_clients set status = 'removed'
    where coach_id = p_coach_id and public_id = p_client_public_id and status = 'active';
  if not found then
    raise exception 'No active client found with that Digital ID under this coach.';
  end if;
  perform log_coach_action(p_coach_id, 'admin_remove_client', p_client_public_id, 'removed by owner');
end;
$$;
grant execute on function admin_remove_coach_client(text, text, uuid, text) to anon;

-- Admin-gated Monitor read, scoped to make sure the given share_key really
-- is one of THIS coach's clients (not just any client anywhere) -- same
-- underlying data (web_sync_logs/assigned_targets) as coach_get_client_monitor.
create or replace function admin_get_client_monitor(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid, p_client_share_key uuid, p_days int default 60
) returns jsonb
language plpgsql
security definer
as $$
declare result jsonb;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  if not exists (
    select 1 from coach_clients
    where coach_id = p_coach_id and share_key = p_client_share_key and status = 'active'
  ) then
    raise exception 'This user is not one of that coach''s attached clients.';
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
grant execute on function admin_get_client_monitor(text, text, uuid, uuid, int) to anon;

-- ---------------------------------------------------------------------
-- Branding + splash (view + edit) -- admin-gated equivalents of
-- coach_update_branding / coach_set_splash_image, targeting p_coach_id
-- directly. Branding fields are already returned by admin_list_coaches
-- above; splash needs its own getter since it lives on a separate table.
-- ---------------------------------------------------------------------
create or replace function admin_get_coach_splash(p_admin_digital_id text, p_admin_password text, p_coach_id uuid)
returns table (splash_image_url text, splash_image_zoom numeric, splash_image_pos_x numeric, splash_image_pos_y numeric, splash_caption text)
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  return query
    select s.splash_image_url, s.splash_image_zoom, s.splash_image_pos_x, s.splash_image_pos_y, s.splash_caption
    from coach_splash_settings s
    where s.coach_id = p_coach_id;
end;
$$;
grant execute on function admin_get_coach_splash(text, text, uuid) to anon;

create or replace function admin_update_coach_branding(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid,
  p_brand_name text, p_brand_logo_url text, p_brand_color_primary text, p_brand_color_accent text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  if p_brand_name is null or trim(p_brand_name) = '' then
    raise exception 'Brand name cannot be blank.';
  end if;
  update coaches set
    brand_name = trim(p_brand_name),
    brand_logo_url = p_brand_logo_url,
    brand_color_primary = p_brand_color_primary,
    brand_color_accent = p_brand_color_accent,
    updated_at = now()
  where id = p_coach_id;
  if not found then
    raise exception 'No coach found with that id';
  end if;
  perform log_coach_action(p_coach_id, 'admin_update_branding', null, 'branding updated by owner');
end;
$$;
grant execute on function admin_update_coach_branding(text, text, uuid, text, text, text, text) to anon;

create or replace function admin_set_coach_splash(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric, p_splash_caption text default null
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  insert into coach_splash_settings (coach_id, splash_image_url, splash_image_zoom, splash_image_pos_x, splash_image_pos_y, splash_caption)
  values (
    p_coach_id, nullif(p_image_url, ''),
    greatest(1, least(3, coalesce(p_image_zoom, 1))),
    greatest(0, least(100, coalesce(p_image_pos_x, 50))),
    greatest(0, least(100, coalesce(p_image_pos_y, 50))),
    nullif(p_splash_caption, '')
  )
  on conflict (coach_id) do update set
    splash_image_url = excluded.splash_image_url,
    splash_image_zoom = excluded.splash_image_zoom,
    splash_image_pos_x = excluded.splash_image_pos_x,
    splash_image_pos_y = excluded.splash_image_pos_y,
    splash_caption = excluded.splash_caption,
    updated_at = now();
  perform log_coach_action(p_coach_id, 'admin_update_splash', null, 'splash updated by owner');
end;
$$;
grant execute on function admin_set_coach_splash(text, text, uuid, text, numeric, numeric, numeric, text) to anon;

notify pgrst, 'reload schema';
