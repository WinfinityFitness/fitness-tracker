-- Web Dashboard Sync: lets a Digital ID opt in (Settings > Web Dashboard
-- Sync) to upload its full local history so wellness.winfinityfitness.com
-- can show a signed-in operator their own real data instead of the
-- placeholder numbers the desktop shell ships with by default.
--
-- Deliberately its own table group, independent of `leaderboard` (which
-- only ever holds a small public-opt-in subset) — anchored on share_key,
-- the same private/never-displayed UUID identity anchor every other
-- private table in this project uses, NOT public_id (public_id is just a
-- mutable display label — see admin_transfer_digital_id, which can already
-- repoint it independently of share_key, so it must never be a primary key
-- here).
--
-- Named web_sync_* rather than sync_* to stay unambiguous next to the
-- unrelated existing account_sync_log / media_sync_settings tables.
--
-- pin_hash is the ONE deliberate exception to this project's usual
-- plaintext-comparison convention (see admin passwords, share_key itself).
-- Everything else here is either an unguessable random secret or has no
-- real security model to begin with; a PIN is short and human-chosen and
-- likely reused elsewhere by the user, so it's actually worth hashing.
-- pgcrypto is already enabled elsewhere in this project (gen_random_uuid).

create extension if not exists pgcrypto;

create table if not exists web_sync_accounts (
  share_key uuid primary key,
  public_id text not null,
  pin_hash text,
  profile jsonb,
  theme text,
  skin text,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table web_sync_accounts enable row level security;
-- No policies at all — anon has zero direct table access either way;
-- every read/write goes through the SECURITY DEFINER functions below.

-- Partial (only when a PIN is actually set) so a device that never enables
-- web sync can't block someone else from later claiming that public_id on
-- the sync side, and so there's no race over an as-yet-unset public_id.
create unique index if not exists web_sync_accounts_public_id_idx
  on web_sync_accounts (public_id) where pin_hash is not null;

create table if not exists web_sync_logs (
  share_key uuid not null references web_sync_accounts(share_key) on delete cascade,
  log_date date not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (share_key, log_date)
);
alter table web_sync_logs enable row level security;

create table if not exists web_sync_reviews (
  share_key uuid not null references web_sync_accounts(share_key) on delete cascade,
  entry_date date not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (share_key, entry_date)
);
alter table web_sync_reviews enable row level security;

create table if not exists web_sync_daily_reviews (
  share_key uuid not null references web_sync_accounts(share_key) on delete cascade,
  entry_date date not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (share_key, entry_date)
);
alter table web_sync_daily_reviews enable row level security;

-- Called from Settings > Web Dashboard Sync when a user turns sync on (or
-- changes their PIN). Creates the account row on first call. Server-side
-- length check backs up the client-side one — never trust the client alone.
create or replace function web_sync_set_pin(p_share_key uuid, p_public_id text, p_pin text) returns void
language plpgsql
security definer
as $$
begin
  if p_pin is null or length(p_pin) < 6 then
    raise exception 'PIN must be at least 6 characters';
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
grant execute on function web_sync_set_pin(uuid, text, text) to anon;

-- Locks the desktop sign-in without deleting any history — re-enabling
-- (web_sync_set_pin again) picks the same synced data back up.
create or replace function web_sync_disable(p_share_key uuid) returns void
language sql
security definer
as $$
  update web_sync_accounts set pin_hash = null, updated_at = now() where share_key = p_share_key;
$$;
grant execute on function web_sync_disable(uuid) to anon;

-- Requires the account row to already exist (created by web_sync_set_pin)
-- — enforces "enable sync once" at the DB layer, not just the UI.
create or replace function web_sync_push_snapshot(p_share_key uuid, p_profile jsonb, p_theme text, p_skin text) returns void
language plpgsql
security definer
as $$
begin
  update web_sync_accounts
  set profile = p_profile, theme = p_theme, skin = p_skin, updated_at = now()
  where share_key = p_share_key;
  if not found then
    raise exception 'Web sync is not enabled for this account';
  end if;
end;
$$;
grant execute on function web_sync_push_snapshot(uuid, jsonb, text, text) to anon;

-- p_entries is a JSON array of {"date": "YYYY-MM-DD", "data": {...}} —
-- the app converts its date-keyed wft_logs object into this shape before
-- calling. One row per day, upserted, so a resync just overwrites in place.
create or replace function web_sync_push_logs(p_share_key uuid, p_entries jsonb) returns void
language plpgsql
security definer
as $$
begin
  if not exists (select 1 from web_sync_accounts where share_key = p_share_key) then
    raise exception 'Web sync is not enabled for this account';
  end if;
  insert into web_sync_logs (share_key, log_date, data, updated_at)
  select p_share_key, (elem->>'date')::date, elem->'data', now()
  from jsonb_array_elements(p_entries) as elem
  on conflict (share_key, log_date) do update
  set data = excluded.data, updated_at = now();
end;
$$;
grant execute on function web_sync_push_logs(uuid, jsonb) to anon;

create or replace function web_sync_push_reviews(p_share_key uuid, p_entries jsonb) returns void
language plpgsql
security definer
as $$
begin
  if not exists (select 1 from web_sync_accounts where share_key = p_share_key) then
    raise exception 'Web sync is not enabled for this account';
  end if;
  insert into web_sync_reviews (share_key, entry_date, data, updated_at)
  select p_share_key, (elem->>'date')::date, elem->'data', now()
  from jsonb_array_elements(p_entries) as elem
  on conflict (share_key, entry_date) do update
  set data = excluded.data, updated_at = now();
end;
$$;
grant execute on function web_sync_push_reviews(uuid, jsonb) to anon;

create or replace function web_sync_push_daily_reviews(p_share_key uuid, p_entries jsonb) returns void
language plpgsql
security definer
as $$
begin
  if not exists (select 1 from web_sync_accounts where share_key = p_share_key) then
    raise exception 'Web sync is not enabled for this account';
  end if;
  insert into web_sync_daily_reviews (share_key, entry_date, data, updated_at)
  select p_share_key, (elem->>'date')::date, elem->'data', now()
  from jsonb_array_elements(p_entries) as elem
  on conflict (share_key, entry_date) do update
  set data = excluded.data, updated_at = now();
end;
$$;
grant execute on function web_sync_push_daily_reviews(uuid, jsonb) to anon;

-- The desktop sign-in's only entry point — public_id is meant to be shared,
-- so the PIN is the actual gate here. Locks out for 15 minutes after 8 bad
-- attempts in a row (nothing else in this project rate-limits anything, and
-- this table holds meaningfully more sensitive data than anything else
-- anon-readable in this schema, so it gets the one exception).
create or replace function web_sync_get_dashboard(p_public_id text, p_pin text, p_days int default 90) returns jsonb
language plpgsql
security definer
as $$
declare
  acct web_sync_accounts%rowtype;
  result jsonb;
begin
  select * into acct from web_sync_accounts where public_id = p_public_id and pin_hash is not null;
  if not found then
    raise exception 'Not authorized';
  end if;

  if acct.locked_until is not null and acct.locked_until > now() then
    raise exception 'Too many attempts — try again later';
  end if;

  if acct.pin_hash <> crypt(p_pin, acct.pin_hash) then
    update web_sync_accounts
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 8 then now() + interval '15 minutes' else locked_until end
    where share_key = acct.share_key;
    raise exception 'Not authorized';
  end if;

  update web_sync_accounts set failed_attempts = 0, locked_until = null where share_key = acct.share_key;

  select jsonb_build_object(
    'profile', acct.profile,
    'theme', acct.theme,
    'skin', acct.skin,
    'logs', coalesce((
      select jsonb_agg(jsonb_build_object('date', l.log_date, 'data', l.data) order by l.log_date)
      from web_sync_logs l
      where l.share_key = acct.share_key and l.log_date >= (current_date - p_days)
    ), '[]'::jsonb),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object('date', r.entry_date, 'data', r.data) order by r.entry_date)
      from web_sync_reviews r
      where r.share_key = acct.share_key and r.entry_date >= (current_date - p_days)
    ), '[]'::jsonb),
    'dailyReviews', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.entry_date, 'data', d.data) order by d.entry_date)
      from web_sync_daily_reviews d
      where d.share_key = acct.share_key and d.entry_date >= (current_date - p_days)
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
grant execute on function web_sync_get_dashboard(text, text, int) to anon;

-- Addendum to supabase_delete_account_data_migration.sql: "Clear All Data"
-- (Keep Digital ID unchecked) must also purge any synced web-sync history,
-- or a full training/nutrition history is left stranded server-side with
-- no in-app way to remove it. Re-running the full function body, same
-- pattern this project already uses (e.g. supabase_prep_meals_fix_migration.sql
-- patching an earlier migration in place).
create or replace function delete_account_data(p_share_key uuid) returns void
language plpgsql
security definer
as $$
begin
  delete from leaderboard where share_key = p_share_key;
  delete from chat_room_members where share_key = p_share_key;
  delete from chat_messages where sender_share_key = p_share_key;
  delete from chat_message_reactions where share_key = p_share_key;
  delete from push_subscriptions where share_key = p_share_key;
  delete from reminder_settings where share_key = p_share_key;
  delete from assigned_targets where share_key = p_share_key;
  delete from account_sync_log where share_key = p_share_key;
  delete from web_sync_accounts where share_key = p_share_key;
end;
$$;
grant execute on function delete_account_data(uuid) to anon;
