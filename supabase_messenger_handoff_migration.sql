-- Messenger handoff: lets wellness.winfinityfitness.com silently sign a
-- visitor into the separate messenger.winfinityfitness.com app (mobile-only
-- Messenger-style surface) without re-entering their Digital ID + PIN.
-- Different subdomain = different origin = no shared localStorage, so a
-- short-lived, single-use opaque token is handed across in the URL instead
-- of the PIN itself.
--
-- Mirrors web_sync_get_dashboard's own auth check (same pin_hash/lockout
-- logic) but returns only the chat-relevant slice of the account, not the
-- full 90-day fitness history — messenger has no reason to fetch that.

create table if not exists web_handoff_tokens (
  token uuid primary key default gen_random_uuid(),
  share_key uuid not null references web_sync_accounts(share_key) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 minutes')
);
alter table web_handoff_tokens enable row level security;
-- No policies — anon has zero direct table access, same as web_sync_accounts;
-- every read/write goes through the SECURITY DEFINER functions below.

-- Opportunistic cleanup of anything that expired unused, same pattern as
-- cleanup_stale_solo_rooms elsewhere in this project — cheap enough to run
-- on every mint rather than needing a cron job.
create or replace function create_web_handoff_token(p_public_id text, p_pin text) returns uuid
language plpgsql
security definer
as $$
declare
  acct web_sync_accounts%rowtype;
  new_token uuid;
begin
  delete from web_handoff_tokens where expires_at < now();

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

  insert into web_handoff_tokens (share_key) values (acct.share_key) returning token into new_token;
  return new_token;
end;
$$;
grant execute on function create_web_handoff_token(text, text) to anon;

-- One-time use: the row is deleted the instant it's redeemed, so a token
-- intercepted from browser history/referrer is worthless after first use,
-- and the 2-minute expiry bounds the window even if it's never redeemed.
create or replace function redeem_web_handoff_token(p_token uuid) returns jsonb
language plpgsql
security definer
as $$
declare
  tok web_handoff_tokens%rowtype;
  acct web_sync_accounts%rowtype;
  result jsonb;
begin
  delete from web_handoff_tokens where token = p_token and expires_at >= now() returning * into tok;
  if not found then
    raise exception 'Link expired — go back and try again.';
  end if;

  select * into acct from web_sync_accounts where share_key = tok.share_key;
  if not found then
    raise exception 'Not authorized';
  end if;

  select jsonb_build_object(
    'shareKey', acct.share_key,
    'publicId', acct.public_id,
    'profile', acct.profile,
    'theme', acct.theme,
    'skin', acct.skin
  ) into result;

  return result;
end;
$$;
grant execute on function redeem_web_handoff_token(uuid) to anon;

-- Lightweight re-entry for a returning messenger visit (PWA reopened later,
-- no fresh handoff token in the URL) — validates only that share_key still
-- exists, no PIN re-check. Consistent with this project's existing
-- security posture (see web_sync_migration's own notes on share_key being
-- an unguessable-but-not-secret identity anchor, not a credential) and
-- with how the mobile app's own remembered-session already works.
create or replace function get_chat_identity_by_share_key(p_share_key uuid) returns jsonb
language plpgsql
security definer
as $$
declare
  acct web_sync_accounts%rowtype;
  result jsonb;
begin
  select * into acct from web_sync_accounts where share_key = p_share_key;
  if not found then
    raise exception 'Not authorized';
  end if;

  select jsonb_build_object(
    'shareKey', acct.share_key,
    'publicId', acct.public_id,
    'profile', acct.profile,
    'theme', acct.theme,
    'skin', acct.skin
  ) into result;

  return result;
end;
$$;
grant execute on function get_chat_identity_by_share_key(uuid) to anon;
