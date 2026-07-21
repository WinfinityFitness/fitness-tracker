-- Isolated fix: app.js's enableWebSync() has been calling web_sync_set_pin
-- with 4 named params (p_share_key, p_public_id, p_pin, p_old_pin) for a
-- while now, but the live database still only has the original 3-param
-- version (supabase_web_sync_migration.sql) -- PostgREST can't find a
-- matching function for an unrecognized named param, so every "Set PIN"
-- tap in Settings > Web Dashboard Sync has been failing.
--
-- The correct 4-param version already exists, written, inside
-- supabase_security_hardening_migration_2.sql -- but that file ALSO
-- resets the admin login password to a hardcoded value and rewrites
-- verify_admin_login, and it's not yet confirmed whether that file was
-- already run before (with a possibly different password than what's
-- currently sitting in it) or never run at all. Rather than risk
-- silently changing/reverting the working admin password as a side
-- effect of fixing this PIN bug, this is that same web_sync_set_pin
-- function in isolation -- byte-for-byte identical to the version in
-- migration_2, nothing else. Safe to run now regardless of whatever
-- state migration_2 is in; run migration_2 separately (or not) once the
-- admin password situation there is sorted out.
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
