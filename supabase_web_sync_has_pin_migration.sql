-- Fixes "Could not set PIN — try again" / server-side "Not authorized" when
-- Web Dashboard Sync is set up for the first time on a SECOND device for an
-- account that already has a PIN from another device.
--
-- initWebSyncSettings() in app.js decided whether to show the "current PIN"
-- field purely from this device's own wft_web_sync_enabled flag in
-- localStorage. That's a per-device flag, not the real account state: a
-- device that never locally enabled sync shows the field as hidden even
-- when the account's real share_key already has a pin_hash set from
-- another device. web_sync_set_pin then correctly rejects the new-PIN
-- attempt (no old PIN was sent to prove it), and the only field that could
-- have supplied one was never shown. New device, already-linked account
-- (e.g. via the cross-device "sign in with Digital ID" link) is exactly
-- the case that was broken.
--
-- This RPC lets the client ask the real account state directly, keyed by
-- share_key (same bearer-secret trust tier as every other share_key-keyed
-- call in this project) -- just a boolean, no hash or anything else
-- leaked.
create or replace function web_sync_has_pin(p_share_key uuid) returns boolean
language sql
security definer
as $$
  select exists(
    select 1 from web_sync_accounts where share_key = p_share_key and pin_hash is not null
  );
$$;
grant execute on function web_sync_has_pin(uuid) to anon;
