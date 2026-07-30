-- Lets a NEW coach's Coach Portal login be the SAME credential as their
-- personal Nexus (Web Dashboard Sync) PIN, instead of a separate coach
-- password. Existing coaches (created before this migration) are
-- untouched and keep their own independent password -- this only applies
-- going forward, via the new admin_create_linked_coach path.
--
-- A "linked" coach is just a coaches row with share_key set, pointing at
-- the SAME share_key their personal fitness-tracker Digital ID already
-- uses in web_sync_accounts. Their "password" is then whatever PIN they
-- already set in Settings > Web Dashboard Sync on their phone -- one
-- secret, one place to set/change/forgot-reset it (web_sync_reset_pin,
-- supabase_web_sync_forgot_pin_migration.sql, already covers "forgot" for
-- this same PIN). An unlinked (legacy) coach has share_key = null and
-- keeps working exactly as before, checked against coaches.password_hash.

alter table coaches add column if not exists share_key uuid;
create unique index if not exists coaches_share_key_idx on coaches (share_key) where share_key is not null;
-- Linked coaches never get their own password_hash -- the column must
-- allow null now (it was `not null` from this table's original creation).
alter table coaches alter column password_hash drop not null;

-- Owner-only: provision a coach LINKED to an existing, already-web-sync-
-- enabled Digital ID, instead of typing a separate coach password. Fails
-- with a clear message if that person hasn't set up Web Dashboard Sync
-- (with a PIN) yet -- there's nothing to link to otherwise.
create or replace function admin_create_linked_coach(
  p_admin_digital_id text, p_admin_password text,
  p_coach_digital_id text, p_client_public_id text,
  p_brand_name text, p_slug text
) returns uuid
language plpgsql
security definer
as $$
declare v_id uuid; v_share_key uuid;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  if p_brand_name is null or trim(p_brand_name) = '' then
    raise exception 'Brand name cannot be blank.';
  end if;

  select share_key into v_share_key from web_sync_accounts
  where public_id = p_client_public_id and pin_hash is not null;
  if v_share_key is null then
    raise exception 'That Digital ID hasn''t enabled Web Dashboard Sync with a PIN yet -- have them turn it on in Settings > Web Dashboard Sync first, then try again.';
  end if;

  insert into coaches (digital_id, share_key, password_hash, brand_name, slug)
  values (p_coach_digital_id, v_share_key, null, trim(p_brand_name), lower(trim(p_slug)))
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function admin_create_linked_coach(text, text, text, text, text, text) to anon;

-- Branches on share_key: linked coaches authenticate against their own
-- web_sync_accounts PIN (same lockout counter as the desktop Nexus
-- sign-in, since it's genuinely the same credential); unlinked (legacy)
-- coaches keep the exact original behavior, byte-for-byte.
create or replace function verify_coach_login(p_digital_id text, p_password text) returns uuid
language plpgsql
security definer
as $$
declare c coaches%rowtype; wsa web_sync_accounts%rowtype;
begin
  select * into c from coaches where digital_id = p_digital_id;
  if not found or not c.active then
    raise exception 'Not authorized';
  end if;

  if c.share_key is not null then
    select * into wsa from web_sync_accounts where share_key = c.share_key;
    if not found or wsa.pin_hash is null then
      raise exception 'Not authorized';
    end if;
    if wsa.locked_until is not null and wsa.locked_until > now() then
      raise exception 'Too many attempts — try again later';
    end if;
    if wsa.pin_hash <> crypt(p_password, wsa.pin_hash) then
      update web_sync_accounts set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 8 then now() + interval '15 minutes' else locked_until end
      where share_key = c.share_key;
      raise exception 'Not authorized';
    end if;
    update web_sync_accounts set failed_attempts = 0, locked_until = null where share_key = c.share_key;
    return c.id;
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

-- A linked coach has no coach-side password to change -- their PIN lives
-- (and is changed/reset) in the mobile app, not here. Point them there
-- instead of silently no-op'ing or drifting a second copy of the secret.
create or replace function coach_change_password(p_coach_digital_id text, p_old_password text, p_new_password text) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid; v_share_key uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_old_password);
  select share_key into v_share_key from coaches where id = v_coach_id;
  if v_share_key is not null then
    raise exception 'Your Coach Portal password is the same as your Nexus Sync PIN — change it in the mobile app under Settings > Web Dashboard Sync instead.';
  end if;
  update coaches set password_hash = crypt(p_new_password, gen_salt('bf')), updated_at = now() where id = v_coach_id;
end;
$$;
grant execute on function coach_change_password(text, text, text) to anon;

-- Owner override, same branching: for a linked coach this resets their
-- actual Nexus PIN (web_sync_accounts), not a separate coach field --
-- there isn't one to reset.
create or replace function admin_reset_coach_password(
  p_admin_digital_id text, p_admin_password text,
  p_coach_id uuid, p_new_password text
) returns void
language plpgsql
security definer
as $$
declare v_share_key uuid;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  if p_new_password is null or length(p_new_password) < 6 then
    raise exception 'New password must be at least 6 characters.';
  end if;

  select share_key into v_share_key from coaches where id = p_coach_id;
  if not found then
    raise exception 'No coach found with that id';
  end if;

  if v_share_key is not null then
    update web_sync_accounts set
      pin_hash = crypt(p_new_password, gen_salt('bf')),
      failed_attempts = 0, locked_until = null, updated_at = now()
    where share_key = v_share_key;
  else
    update coaches set
      password_hash = crypt(p_new_password, gen_salt('bf')),
      failed_attempts = 0, locked_until = null, updated_at = now()
    where id = p_coach_id;
  end if;
end;
$$;
grant execute on function admin_reset_coach_password(text, text, uuid, text) to anon;

notify pgrst, 'reload schema';
