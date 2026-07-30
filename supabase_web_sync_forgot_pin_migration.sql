-- "Forgot PIN" recovery for Web Dashboard Sync (Nexus), initiated from
-- inside the mobile app itself -- not the desktop dashboard.
--
-- web_sync_set_pin requires the OLD pin to change an existing one
-- (supabase_web_sync_set_pin_old_pin_fix_migration.sql), which is correct
-- for the desktop/Nexus side (a typed PIN is the only proof of identity
-- there) but leaves someone who's forgotten their PIN with no way back in
-- at all -- even though they're sitting right there in the mobile app,
-- which already trusts share_key alone for every other write in this
-- table (web_sync_push_snapshot, web_sync_push_logs, web_sync_disable --
-- none of them ask for the PIN). share_key is this project's actual
-- bearer-secret identity anchor (see supabase_web_sync_migration.sql's own
-- comment on it); requiring the old PIN *in addition* to it for this one
-- function was never a meaningfully higher bar, just an inconsistent one.
--
-- This function is that same trust model applied to PIN resets: proof of
-- being the legitimate device (share_key) is enough, exactly like it
-- already is everywhere else on this table.
create or replace function web_sync_reset_pin(p_share_key uuid, p_new_pin text) returns void
language plpgsql
security definer
as $$
begin
  if p_new_pin is null or length(p_new_pin) < 6 then
    raise exception 'PIN must be at least 6 characters';
  end if;
  if not exists (select 1 from web_sync_accounts where share_key = p_share_key) then
    raise exception 'Web sync has never been enabled on this device — use Set PIN instead.';
  end if;
  update web_sync_accounts
  set pin_hash = crypt(p_new_pin, gen_salt('bf')),
      failed_attempts = 0,
      locked_until = null,
      updated_at = now()
  where share_key = p_share_key;
end;
$$;
grant execute on function web_sync_reset_pin(uuid, text) to anon;
