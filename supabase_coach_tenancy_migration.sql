-- Coach white-label tenancy — Phase A (data model + coach auth + manual
-- feature toggles). See the approved plan for full context and rationale;
-- summary: coaches "rebrand" the app for their own paying clients, get a
-- SCOPED admin view (their own client roster + their own branding), while
-- the owner's existing verify_admin_login/admin_credentials stay completely
-- untouched -- a coach's reach must be structurally incapable of becoming
-- global, so this is a wholly separate credential type (verify_coach_login
-- returns uuid, not void, so it can never be interchanged with
-- verify_admin_login at a call site by mistake).
--
-- Feature access is exactly 5 boolean flags per coach (Core Tracking,
-- Resistance Training, Outdoor Activity Tracker, Nutrition logging, Prep
-- Meals Database) -- owner-controlled only (tied to billing, verified
-- out-of-band same as the existing admin_grant_ad_free donation flow), a
-- coach can never grant these to themselves. Branding (name/logo/colors) is
-- coach-controlled, separate from feature flags.
--
-- Client attach is fully manual: a coach (or the owner) attaches a client
-- by their existing Digital ID (leaderboard.public_id) from the coach's own
-- panel -- no invite code, no client-side self-service step. One coach per
-- client, enforced by a unique index on coach_clients.share_key.

create table if not exists coaches (
  id uuid primary key default gen_random_uuid(),
  digital_id text unique not null,
  password_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  brand_name text not null,
  brand_logo_url text,
  brand_color_primary text,
  brand_color_accent text,
  slug text unique not null,
  active boolean not null default true,
  feature_core_tracking boolean not null default false,
  feature_resistance_training boolean not null default false,
  feature_outdoor_activity boolean not null default false,
  feature_nutrition_logging boolean not null default false,
  feature_prep_meals boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coaches_slug_format check (slug ~ '^[a-z0-9-]{2,40}$')
);
alter table coaches enable row level security;
-- zero anon policies, deliberately -- matches admin_credentials/
-- web_sync_accounts/assessment_requests' lockdown convention. Every read
-- and write goes through the SECURITY DEFINER RPCs below.

create table if not exists coach_clients (
  coach_id uuid not null references coaches(id) on delete cascade,
  share_key uuid not null,
  public_id text,
  status text not null default 'active' check (status in ('active', 'removed')),
  attached_via text not null default 'manual',
  created_at timestamptz not null default now(),
  primary key (coach_id, share_key)
);
alter table coach_clients enable row level security;
-- one coach per client, and only while active -- a removed row doesn't
-- free up the share_key for a different coach; re-attaching just flips
-- status back to 'active' under the same coach (see coach_attach_client).
create unique index if not exists coach_clients_share_key_active_idx
  on coach_clients (share_key) where status = 'active';

-- ---------------------------------------------------------------------
-- Coach auth -- structurally separate from verify_admin_login on purpose.
-- ---------------------------------------------------------------------

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
  update coaches set failed_attempts = 0, locked_until = null where id = c.id;
  return c.id;
end;
$$;
grant execute on function verify_coach_login(text, text) to anon;

-- ---------------------------------------------------------------------
-- Owner-only: provision coaches, set their paid feature flags.
-- Gated by the existing, UNMODIFIED verify_admin_login -- only the real
-- owner can ever reach these, never a coach's own credential.
-- ---------------------------------------------------------------------

create or replace function admin_create_coach(
  p_admin_digital_id text, p_admin_password text,
  p_coach_digital_id text, p_coach_password text,
  p_brand_name text, p_slug text
) returns uuid
language plpgsql
security definer
as $$
declare v_id uuid;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  if p_brand_name is null or trim(p_brand_name) = '' then
    raise exception 'Brand name cannot be blank.';
  end if;
  insert into coaches (digital_id, password_hash, brand_name, slug)
  values (p_coach_digital_id, crypt(p_coach_password, gen_salt('bf')), trim(p_brand_name), lower(trim(p_slug)))
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function admin_create_coach(text, text, text, text, text, text) to anon;

create or replace function admin_set_coach_features(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid,
  p_core_tracking boolean, p_resistance_training boolean,
  p_outdoor_activity boolean, p_nutrition_logging boolean, p_prep_meals boolean
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  update coaches set
    feature_core_tracking = p_core_tracking,
    feature_resistance_training = p_resistance_training,
    feature_outdoor_activity = p_outdoor_activity,
    feature_nutrition_logging = p_nutrition_logging,
    feature_prep_meals = p_prep_meals,
    updated_at = now()
  where id = p_coach_id;
  if not found then
    raise exception 'No coach found with that id';
  end if;
end;
$$;
grant execute on function admin_set_coach_features(text, text, uuid, boolean, boolean, boolean, boolean, boolean) to anon;

create or replace function admin_set_coach_active(
  p_admin_digital_id text, p_admin_password text, p_coach_id uuid, p_active boolean
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  update coaches set active = p_active, updated_at = now() where id = p_coach_id;
  if not found then
    raise exception 'No coach found with that id';
  end if;
end;
$$;
grant execute on function admin_set_coach_active(text, text, uuid, boolean) to anon;

create or replace function admin_list_coaches(p_admin_digital_id text, p_admin_password text)
returns table (
  id uuid, digital_id text, brand_name text, slug text, active boolean,
  feature_core_tracking boolean, feature_resistance_training boolean,
  feature_outdoor_activity boolean, feature_nutrition_logging boolean, feature_prep_meals boolean,
  client_count bigint, created_at timestamptz
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
      c.created_at
    from coaches c
    order by c.created_at desc;
end;
$$;
grant execute on function admin_list_coaches(text, text) to anon;

-- ---------------------------------------------------------------------
-- Coach-scoped: every function starts by resolving the caller's own
-- coach_id via verify_coach_login, then filters everything by it. This is
-- the real enforced scoping the codebase didn't have before -- not just an
-- audit column like assessment_requests.requested_by_admin.
-- ---------------------------------------------------------------------

create or replace function coach_update_branding(
  p_coach_digital_id text, p_coach_password text,
  p_brand_name text, p_brand_logo_url text, p_brand_color_primary text, p_brand_color_accent text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  if p_brand_name is null or trim(p_brand_name) = '' then
    raise exception 'Brand name cannot be blank.';
  end if;
  update coaches set
    brand_name = trim(p_brand_name),
    brand_logo_url = p_brand_logo_url,
    brand_color_primary = p_brand_color_primary,
    brand_color_accent = p_brand_color_accent,
    updated_at = now()
  where id = v_coach_id;
end;
$$;
grant execute on function coach_update_branding(text, text, text, text, text, text) to anon;

create or replace function coach_get_feature_flags(p_coach_digital_id text, p_coach_password text)
returns table (
  feature_core_tracking boolean, feature_resistance_training boolean,
  feature_outdoor_activity boolean, feature_nutrition_logging boolean, feature_prep_meals boolean
)
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  return query
    select c.feature_core_tracking, c.feature_resistance_training,
      c.feature_outdoor_activity, c.feature_nutrition_logging, c.feature_prep_meals
    from coaches c where c.id = v_coach_id;
end;
$$;
grant execute on function coach_get_feature_flags(text, text) to anon;

create or replace function coach_attach_client(
  p_coach_digital_id text, p_coach_password text, p_client_public_id text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_share_key uuid;
declare v_existing_coach uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select share_key into v_share_key from leaderboard where public_id = p_client_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
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
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  update coach_clients set status = 'removed'
    where coach_id = v_coach_id and public_id = p_client_public_id and status = 'active';
  if not found then
    raise exception 'No active client found with that Digital ID under your roster';
  end if;
end;
$$;
grant execute on function coach_remove_client(text, text, text) to anon;

create or replace function coach_list_clients(p_coach_digital_id text, p_coach_password text)
returns table (share_key uuid, public_id text, attached_at timestamptz)
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  return query
    select cc.share_key, cc.public_id, cc.created_at
    from coach_clients cc
    where cc.coach_id = v_coach_id and cc.status = 'active'
    order by cc.created_at desc;
end;
$$;
grant execute on function coach_list_clients(text, text) to anon;

-- ---------------------------------------------------------------------
-- Client self-service (own share_key, no coach credentials -- matches the
-- rest of the app's "share_key is the trust anchor" convention).
-- ---------------------------------------------------------------------

create or replace function get_my_coach_features(p_share_key uuid)
returns table (
  has_coach boolean, brand_name text, brand_logo_url text,
  brand_color_primary text, brand_color_accent text,
  feature_core_tracking boolean, feature_resistance_training boolean,
  feature_outdoor_activity boolean, feature_nutrition_logging boolean, feature_prep_meals boolean
)
language plpgsql
security definer
as $$
declare v_row record;
begin
  -- deliberately uses SELECT INTO (reliable, well-documented FOUND
  -- semantics) rather than checking FOUND after a RETURN QUERY, which is
  -- not a dependable pattern in plpgsql.
  select c.brand_name, c.brand_logo_url, c.brand_color_primary, c.brand_color_accent,
    c.feature_core_tracking, c.feature_resistance_training,
    c.feature_outdoor_activity, c.feature_nutrition_logging, c.feature_prep_meals
  into v_row
  from coach_clients cc
  join coaches c on c.id = cc.coach_id
  where cc.share_key = p_share_key and cc.status = 'active' and c.active;

  if not found then
    return query select false, null::text, null::text, null::text, null::text,
      false, false, false, false, false;
  else
    return query select true, v_row.brand_name, v_row.brand_logo_url, v_row.brand_color_primary, v_row.brand_color_accent,
      v_row.feature_core_tracking, v_row.feature_resistance_training,
      v_row.feature_outdoor_activity, v_row.feature_nutrition_logging, v_row.feature_prep_meals;
  end if;
end;
$$;
grant execute on function get_my_coach_features(uuid) to anon;

-- Phase C enforcement helper (function shipped now so it exists ahead of
-- being threaded into the training/nutrition/outdoor/prep-meals RPCs in a
-- follow-up migration -- not called from anywhere yet).
create or replace function assert_feature_enabled(p_share_key uuid, p_feature text) returns void
language plpgsql
security definer
as $$
declare v_enabled boolean;
begin
  select case p_feature
    when 'core_tracking' then c.feature_core_tracking
    when 'resistance_training' then c.feature_resistance_training
    when 'outdoor_activity' then c.feature_outdoor_activity
    when 'nutrition_logging' then c.feature_nutrition_logging
    when 'prep_meals' then c.feature_prep_meals
    else null
  end into v_enabled
  from coach_clients cc
  join coaches c on c.id = cc.coach_id
  where cc.share_key = p_share_key and cc.status = 'active' and c.active;

  if v_enabled is null or not v_enabled then
    raise exception 'This feature is not enabled for your account.';
  end if;
end;
$$;
grant execute on function assert_feature_enabled(uuid, text) to anon;

notify pgrst, 'reload schema';
