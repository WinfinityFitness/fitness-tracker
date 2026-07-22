-- Fixes the Messenger auto-redirect toggle actually persisting. The
-- original supabase_messenger_auto_redirect_serverside_migration.sql was
-- apparently never run against this database (confirmed directly: the
-- column and function didn't exist), which is the real reason the toggle
-- "always reverted on refresh" — every save silently failed against a
-- column/function that didn't exist, so the server legitimately had no
-- value, and the client correctly-but-uselessly synced that back as off.
--
-- This is a trimmed version of that file: same column + RPC + dashboard-
-- sync additions, but deliberately WITHOUT re-running that file's own
-- notify_dm_push() redefinition, which used this column to decide between
-- Messenger/Wellness/FT — that routing was intentionally replaced by the
-- Messenger-only version in supabase_notification_types_migration.sql.
-- Running the original file now would silently revert that fix. This
-- column is purely cosmetic going forward — nothing reads it for routing
-- anymore, it only makes the toggle's own on/off state persist correctly.
alter table web_sync_accounts add column if not exists messenger_auto_redirect boolean not null default false;

create or replace function set_messenger_auto_redirect(p_share_key uuid, p_enabled boolean) returns void
language sql
security definer
as $$
  update web_sync_accounts set messenger_auto_redirect = p_enabled where share_key = p_share_key;
$$;
grant execute on function set_messenger_auto_redirect(uuid, boolean) to anon;

-- Surfaces the preference to the client on sign-in, so the toggle shows
-- its real current state instead of a stale/never-set localStorage value.
-- Byte-for-byte identical to web_sync_get_dashboard in
-- supabase_web_sync_migration.sql except for the one added key.
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
    'shareKey', acct.share_key,
    'profile', acct.profile,
    'theme', acct.theme,
    'skin', acct.skin,
    'messengerAutoRedirect', acct.messenger_auto_redirect,
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

notify pgrst, 'reload schema';
