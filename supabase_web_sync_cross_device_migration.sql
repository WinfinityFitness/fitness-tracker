-- Cross-device last-edit-wins sync: lets a Digital ID opened in a browser
-- on a SECOND device (not just the phone that originally created it) link
-- itself to that same account and stay in sync both ways, instead of only
-- ever being able to push one-way (mobile -> web_sync_accounts) like the
-- original supabase_web_sync_migration.sql.
--
-- Two pieces:
--   1. lastEditedAt added to web_sync_get_dashboard's result -- the
--      greatest updated_at across the account row and its logs/reviews/
--      daily_reviews, so a client can tell whether the copy it's about to
--      show is older than what some OTHER device has since pushed.
--   2. web_sync_get_snapshot_by_share_key -- same shape, but keyed by the
--      share_key a device already holds (no PIN prompt), for a device
--      that's already linked to silently check-and-pull on every boot.
--      share_key is the same bearer-secret trust tier pushWebSyncSnapshot
--      already writes with, so letting it also read back is not a new
--      exposure (see web_sync_get_dashboard's own comment on this).

create or replace function web_sync_get_dashboard(p_public_id text, p_pin text, p_days int default 90) returns jsonb
language plpgsql
security definer
as $$
declare
  acct web_sync_accounts%rowtype;
  result jsonb;
  last_edited timestamptz;
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

  select greatest(
    acct.updated_at,
    coalesce((select max(updated_at) from web_sync_logs where share_key = acct.share_key), acct.updated_at),
    coalesce((select max(updated_at) from web_sync_reviews where share_key = acct.share_key), acct.updated_at),
    coalesce((select max(updated_at) from web_sync_daily_reviews where share_key = acct.share_key), acct.updated_at)
  ) into last_edited;

  select jsonb_build_object(
    'shareKey', acct.share_key,
    'profile', acct.profile,
    'theme', acct.theme,
    'skin', acct.skin,
    'lastEditedAt', last_edited,
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

-- No PIN here -- a device that already holds share_key (because it either
-- created this account or was linked once via web_sync_get_dashboard above)
-- uses this on every boot to silently check whether some OTHER device has
-- since pushed newer data, without re-prompting for the PIN each time.
-- Works even for an account that has never enabled web sync (pin_hash null)
-- so the device that originally minted the share_key can still read its
-- own data back; web_sync_push_logs/etc already allow writes in that state.
create or replace function web_sync_get_snapshot_by_share_key(p_share_key uuid, p_days int default 90) returns jsonb
language plpgsql
security definer
as $$
declare
  acct web_sync_accounts%rowtype;
  result jsonb;
  last_edited timestamptz;
begin
  select * into acct from web_sync_accounts where share_key = p_share_key;
  if not found then
    raise exception 'Not found';
  end if;

  select greatest(
    acct.updated_at,
    coalesce((select max(updated_at) from web_sync_logs where share_key = acct.share_key), acct.updated_at),
    coalesce((select max(updated_at) from web_sync_reviews where share_key = acct.share_key), acct.updated_at),
    coalesce((select max(updated_at) from web_sync_daily_reviews where share_key = acct.share_key), acct.updated_at)
  ) into last_edited;

  select jsonb_build_object(
    'shareKey', acct.share_key,
    'profile', acct.profile,
    'theme', acct.theme,
    'skin', acct.skin,
    'lastEditedAt', last_edited,
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
grant execute on function web_sync_get_snapshot_by_share_key(uuid, int) to anon;
