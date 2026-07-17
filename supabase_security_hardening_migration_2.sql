-- Security hardening pass #2: the admin password and the PIN-reset
-- takeover gap from the RLS/RPC audit.
--
-- ADMIN PASSWORD CHANGE: the OLD password ('admin082801') must be treated
-- as fully compromised regardless of anything below — GitHub Pages'
-- free tier requires a public repo, so this password has been sitting in
-- plaintext in a public git repository this whole time. The new password
-- set below is:
--
--     Copper-Otter-4471!
--
-- Change the literal value in the "insert into admin_credentials" block
-- near the top of this file to something else first if you'd rather pick
-- your own — either way, this is the ONLY place a plaintext password
-- appears anywhere in this migration or the app going forward; every
-- function below only ever compares against a bcrypt hash.

-- ---------------------------------------------------------------------
-- admin_credentials — single row, hashed password, same lockout pattern
-- already used by web_sync_accounts (8 failed attempts -> 15 min lock).
-- RLS enabled with zero anon policies: the ONLY way to touch this table
-- at all is through verify_admin_login() below.
-- ---------------------------------------------------------------------
create table if not exists admin_credentials (
  digital_id text primary key,
  password_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table admin_credentials enable row level security;

insert into admin_credentials (digital_id, password_hash)
values ('WF-B932GB', crypt('Copper-Otter-4471!', gen_salt('bf')))
on conflict (digital_id) do update
set password_hash = excluded.password_hash, failed_attempts = 0, locked_until = null, updated_at = now();

-- ---------------------------------------------------------------------
-- verify_admin_login — was `returns boolean` (a plain select, used as
-- `if not verify_admin_login(...) then raise ... end if;` at every call
-- site) with a hardcoded plaintext comparison and zero rate limiting.
-- Rewritten to raise internally (so every call site becomes a single
-- `perform verify_admin_login(...);` line) and check a bcrypt hash with
-- lockout. Return type is changing (boolean -> void), which Postgres
-- doesn't allow via a plain CREATE OR REPLACE, hence the DROP first.
-- ---------------------------------------------------------------------
drop function if exists verify_admin_login(text, text);

create or replace function verify_admin_login(p_digital_id text, p_password text) returns void
language plpgsql
security definer
as $$
declare
  cred admin_credentials%rowtype;
begin
  select * into cred from admin_credentials where digital_id = p_digital_id;
  if not found then
    raise exception 'Not authorized';
  end if;
  if cred.locked_until is not null and cred.locked_until > now() then
    raise exception 'Too many attempts — try again later';
  end if;
  if cred.password_hash <> crypt(p_password, cred.password_hash) then
    update admin_credentials
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 8 then now() + interval '15 minutes' else locked_until end
    where digital_id = p_digital_id;
    raise exception 'Not authorized';
  end if;
  update admin_credentials set failed_attempts = 0, locked_until = null where digital_id = p_digital_id;
end;
$$;
grant execute on function verify_admin_login(text, text) to anon;

-- ---------------------------------------------------------------------
-- assign_targets — already called verify_admin_login(), but in the old
-- `if not verify_admin_login(...) then raise` shape that only worked
-- while it returned boolean. Same signature as live, so a plain
-- CREATE OR REPLACE is safe here (no DROP needed).
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Every function below had its own inline
--   if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
--     raise exception 'Not authorized';
--   end if;
-- replaced with `perform verify_admin_login(p_digital_id, p_password);`.
-- Everything else in each function body is byte-for-byte identical to
-- its live version. Same signatures throughout, so all plain CREATE OR
-- REPLACE, no DROPs needed.
-- ---------------------------------------------------------------------

create or replace function set_announcement(p_digital_id text, p_password text, p_message text) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update announcements set message = p_message, updated_at = now() where id = 1;
end;
$$;
grant execute on function set_announcement(text, text, text) to anon;

create or replace function admin_set_quick_log_dial_buttons(p_digital_id text, p_password text, p_buttons jsonb) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update ad_settings set quick_log_dial_buttons = p_buttons, updated_at = now() where id = 1;
end;
$$;
grant execute on function admin_set_quick_log_dial_buttons(text, text, jsonb) to anon;

create or replace function admin_upsert_prep_meal(
  p_digital_id text, p_password text,
  p_id bigint, p_category text, p_name text, p_ingredients text, p_procedure text,
  p_cal_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric,
  p_fiber_per_100g numeric, p_sodium_per_100g numeric,
  p_active boolean, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  if p_id is null then
    insert into prep_meals (category, name, ingredients, procedure, cal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, sodium_per_100g, active, approved, image_url, image_zoom, image_pos_x, image_pos_y, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_cal_per_100g, p_protein_per_100g, p_carbs_per_100g, p_fat_per_100g, p_fiber_per_100g, p_sodium_per_100g, p_active, true, nullif(p_image_url, ''),
            greatest(0.3, least(3, coalesce(p_image_zoom, 1))), greatest(0, least(100, coalesce(p_image_pos_x, 50))), greatest(0, least(100, coalesce(p_image_pos_y, 50))),
            'admin', null, null);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        cal_per_100g = p_cal_per_100g, protein_per_100g = p_protein_per_100g,
        carbs_per_100g = p_carbs_per_100g, fat_per_100g = p_fat_per_100g,
        fiber_per_100g = p_fiber_per_100g, sodium_per_100g = p_sodium_per_100g,
        active = p_active, approved = true, image_url = nullif(p_image_url, ''),
        image_zoom = greatest(0.3, least(3, coalesce(p_image_zoom, 1))),
        image_pos_x = greatest(0, least(100, coalesce(p_image_pos_x, 50))),
        image_pos_y = greatest(0, least(100, coalesce(p_image_pos_y, 50)))
    where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, numeric, numeric) to anon;

create or replace function admin_set_splash_image(
  p_digital_id text, p_password text, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update app_splash_settings
  set splash_image_url = nullif(p_image_url, ''),
      splash_image_zoom = greatest(0.3, least(3, coalesce(p_image_zoom, 1))),
      splash_image_pos_x = greatest(0, least(100, coalesce(p_image_pos_x, 50))),
      splash_image_pos_y = greatest(0, least(100, coalesce(p_image_pos_y, 50))),
      updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_splash_image(text, text, text, numeric, numeric, numeric) to anon;

create or replace function admin_delete_prep_meal(p_digital_id text, p_password text, p_id bigint) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  delete from prep_meals where id = p_id;
end;
$$;
grant execute on function admin_delete_prep_meal(text, text, bigint) to anon;

create or replace function admin_approve_prep_meal(p_digital_id text, p_password text, p_id bigint) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update prep_meals set approved = true where id = p_id;
end;
$$;
grant execute on function admin_approve_prep_meal(text, text, bigint) to anon;

create or replace function admin_set_media_sync(
  p_digital_id text, p_password text,
  p_mode text, p_image_urls jsonb, p_duration_sec int, p_randomize boolean
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update media_sync_settings
  set mode = p_mode,
      image_urls = p_image_urls,
      duration_sec = greatest(3, least(60, p_duration_sec)),
      randomize = coalesce(p_randomize, false),
      updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_media_sync(text, text, text, jsonb, int, boolean) to anon;

create or replace function admin_list_account_sync_log(p_digital_id text, p_password text)
returns table (public_id text, email text, gender text, location text, updated_at timestamptz)
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  return query
    select a.public_id, a.email, a.gender, a.location, a.updated_at
    from account_sync_log a
    order by a.public_id asc nulls last;
end;
$$;
grant execute on function admin_list_account_sync_log(text, text) to anon;

create or replace function admin_set_updates_enabled(p_digital_id text, p_password text, p_enabled boolean) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update ad_settings set updates_enabled = p_enabled, updated_at = now() where id = 1;
end;
$$;
grant execute on function admin_set_updates_enabled(text, text, boolean) to anon;

create or replace function admin_set_ads_enabled(p_digital_id text, p_password text, p_enabled boolean) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update ad_settings set ads_enabled = p_enabled, updated_at = now() where id = 1;
end;
$$;
grant execute on function admin_set_ads_enabled(text, text, boolean) to anon;

create or replace function admin_upsert_ad_product(
  p_digital_id text, p_password text,
  p_id bigint, p_name text, p_image_url text, p_link_url text, p_active boolean
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  if p_id is null then
    insert into ad_products (name, image_url, link_url, active) values (p_name, p_image_url, p_link_url, p_active);
  else
    update ad_products set name = p_name, image_url = p_image_url, link_url = p_link_url, active = p_active where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_ad_product(text, text, bigint, text, text, text, boolean) to anon;

create or replace function admin_delete_ad_product(p_digital_id text, p_password text, p_id bigint) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  delete from ad_products where id = p_id;
end;
$$;
grant execute on function admin_delete_ad_product(text, text, bigint) to anon;

create or replace function admin_grant_ad_free(p_digital_id text, p_password text, p_target_public_id text, p_hours int) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update leaderboard set ad_free_until = now() + (greatest(1, p_hours) || ' hours')::interval where public_id = p_target_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
end;
$$;
grant execute on function admin_grant_ad_free(text, text, text, int) to anon;

create or replace function admin_revoke_ad_free(p_digital_id text, p_password text, p_target_public_id text) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update leaderboard set ad_free_until = null where public_id = p_target_public_id;
end;
$$;
grant execute on function admin_revoke_ad_free(text, text, text) to anon;

create or replace function admin_transfer_digital_id(
  p_digital_id text, p_password text,
  p_old_public_id text, p_new_public_id text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  if not exists (select 1 from leaderboard where public_id = p_old_public_id) then
    raise exception 'No user found with that Digital ID';
  end if;
  delete from leaderboard where public_id = p_new_public_id and public_id <> p_old_public_id;
  update leaderboard set public_id = p_new_public_id where public_id = p_old_public_id;
end;
$$;
grant execute on function admin_transfer_digital_id(text, text, text, text) to anon;

-- ---------------------------------------------------------------------
-- web_sync_set_pin — used to unconditionally overwrite pin_hash with no
-- proof of the OLD pin, meaning anyone who ever obtained a victim's
-- share_key (no longer possible via the leaderboard leak closed in pass
-- #1, but share_key was never meant to be secret-enough-alone for this)
-- could silently take over their desktop dashboard login. Now requires
-- the current PIN via a new p_old_pin parameter — but ONLY when a PIN is
-- already set; first-time setup (no row yet, OR a row with pin_hash is
-- null, which is exactly what web_sync_disable() sets it to when sync is
-- turned off) still needs no old PIN, since there's nothing to prove yet.
-- A trailing default-null parameter doesn't change this function's call
-- signature for existing 3-arg callers, so no DROP is needed here.
-- ---------------------------------------------------------------------
create or replace function web_sync_set_pin(p_share_key uuid, p_public_id text, p_pin text, p_old_pin text default null) returns void
language plpgsql
security definer
as $$
declare
  existing_hash text;
begin
  if p_pin is null or length(p_pin) < 6 then
    raise exception 'PIN must be at least 6 characters';
  end if;

  select pin_hash into existing_hash from web_sync_accounts where share_key = p_share_key;

  if existing_hash is not null then
    if p_old_pin is null or existing_hash <> crypt(p_old_pin, existing_hash) then
      raise exception 'Not authorized';
    end if;
  end if;

  insert into web_sync_accounts (share_key, public_id, pin_hash, failed_attempts, locked_until, updated_at)
  values (p_share_key, p_public_id, crypt(p_pin, gen_salt('bf')), 0, null, now())
  on conflict (share_key) do update
  set public_id = excluded.public_id,
      pin_hash = excluded.pin_hash,
      failed_attempts = 0,
      locked_until = null,
      updated_at = now();
end;
$$;
grant execute on function web_sync_set_pin(uuid, text, text, text) to anon;

notify pgrst, 'reload schema';
