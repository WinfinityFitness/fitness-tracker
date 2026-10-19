-- Patches supabase_web_sync_cross_device_migration.sql in place: that
-- migration's two RPCs returned each log/review/daily-review day as plain
-- {date, data}, so the client's only option on a conflict was "whichever
-- device's WHOLE snapshot is newer wins" -- overwriting every day,
-- including ones the other device never touched. If mobile edited today
-- and the PC edited yesterday around the same time, one of those two
-- edits was silently discarded instead of merging.
--
-- Fix is server-side only: add each row's own updated_at (already tracked
-- per-day in web_sync_logs/reviews/daily_reviews) to the returned element,
-- as 'updatedAt', so the client can merge day-by-day -- a day untouched by
-- the other device is left alone, a day with identical data on both sides
-- is a no-op, and only a day that's genuinely DIFFERENT on both sides and
-- was edited on both within seconds of each other needs a real conflict
-- decision instead of one side just losing silently.

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
      select jsonb_agg(jsonb_build_object('date', l.log_date, 'data', l.data, 'updatedAt', l.updated_at) order by l.log_date)
      from web_sync_logs l
      where l.share_key = acct.share_key and l.log_date >= (current_date - p_days)
    ), '[]'::jsonb),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object('date', r.entry_date, 'data', r.data, 'updatedAt', r.updated_at) order by r.entry_date)
      from web_sync_reviews r
      where r.share_key = acct.share_key and r.entry_date >= (current_date - p_days)
    ), '[]'::jsonb),
    'dailyReviews', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.entry_date, 'data', d.data, 'updatedAt', d.updated_at) order by d.entry_date)
      from web_sync_daily_reviews d
      where d.share_key = acct.share_key and d.entry_date >= (current_date - p_days)
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
grant execute on function web_sync_get_dashboard(text, text, int) to anon;

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
      select jsonb_agg(jsonb_build_object('date', l.log_date, 'data', l.data, 'updatedAt', l.updated_at) order by l.log_date)
      from web_sync_logs l
      where l.share_key = acct.share_key and l.log_date >= (current_date - p_days)
    ), '[]'::jsonb),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object('date', r.entry_date, 'data', r.data, 'updatedAt', r.updated_at) order by r.entry_date)
      from web_sync_reviews r
      where r.share_key = acct.share_key and r.entry_date >= (current_date - p_days)
    ), '[]'::jsonb),
    'dailyReviews', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.entry_date, 'data', d.data, 'updatedAt', d.updated_at) order by d.entry_date)
      from web_sync_daily_reviews d
      where d.share_key = acct.share_key and d.entry_date >= (current_date - p_days)
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
grant execute on function web_sync_get_snapshot_by_share_key(uuid, int) to anon;
