-- Correction: the Messenger auto-redirect toggle (wdsMessengerTogglePopup
-- in index.html) was originally mirrored into IndexedDB so sw.js's
-- notificationclick handler could read it (a Service Worker has no
-- localStorage access) -- but IndexedDB is origin-scoped, and a chat push
-- notification can land on ANY of an account's subscribed devices/origins
-- (push_subscriptions is keyed by share_key only, no origin column), most
-- commonly the mobile FT app itself, whose origin never wrote that
-- IndexedDB entry in the first place. Confirmed live: a chat notification
-- delivered to FT ignored the toggle entirely and opened FT, not
-- Messenger, because FT's own service worker had nothing to read.
--
-- Fix: store the preference on the account itself (web_sync_accounts,
-- keyed by share_key -- the same identity anchor push_subscriptions
-- already uses) instead of per-device storage, and have notify_dm_push()
-- decide the redirect URL server-side, at send time, before the
-- notification ever reaches any device. sw.js goes back to just reading
-- notification.data.url directly -- no IndexedDB involved on the client
-- side at all anymore.
alter table web_sync_accounts add column if not exists messenger_auto_redirect boolean not null default false;

create or replace function set_messenger_auto_redirect(p_share_key uuid, p_enabled boolean) returns void
language sql
security definer
as $$
  update web_sync_accounts set messenger_auto_redirect = p_enabled where share_key = p_share_key;
$$;
grant execute on function set_messenger_auto_redirect(uuid, boolean) to anon;

-- Same body as supabase_messenger_notification_type_migration.sql's
-- notify_dm_push() except the url key is now set here, server-side,
-- instead of relying on the client to figure it out later.
create or replace function notify_dm_push() returns trigger
language plpgsql
security definer
as $$
declare
  v_is_dm boolean;
  v_sender_key uuid;
  v_recipient_key uuid;
  v_service_key text;
  v_redirect_messenger boolean;
begin
  if new.room_id is null then
    return new;
  end if;

  select is_dm into v_is_dm from chat_rooms where id = new.room_id;
  if not coalesce(v_is_dm, false) then
    return new;
  end if;

  select share_key into v_sender_key from chat_room_members
    where room_id = new.room_id and code_name = new.code_name limit 1;

  select share_key into v_recipient_key from chat_room_members
    where room_id = new.room_id and share_key is distinct from v_sender_key limit 1;

  if v_recipient_key is null then
    return new;
  end if;

  select decrypted_secret into v_service_key from vault.decrypted_secrets
    where name = 'service_role_key' limit 1;
  if v_service_key is null then
    -- Vault secret not set up yet (see step 3 above) — skip rather than error,
    -- so message sending itself never breaks because of this.
    return new;
  end if;

  select messenger_auto_redirect into v_redirect_messenger
    from web_sync_accounts where share_key = v_recipient_key;

  perform net.http_post(
    url := 'https://mzkjboplfalauivwcnni.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object(
      'share_key', v_recipient_key,
      'title', 'New message from ' || new.code_name,
      'body', left(new.message, 120),
      'type', 'chat',
      'url', case when coalesce(v_redirect_messenger, false)
             then 'https://messenger.winfinityfitness.com/' else null end
    )
  );

  return new;
end;
$$;

-- Also surfaces the preference to the client on sign-in, so a second
-- device/browser shows the toggle's real current state instead of
-- whatever (possibly stale, possibly never-set) value happens to be in
-- ITS OWN localStorage. Byte-for-byte identical to web_sync_get_dashboard
-- in supabase_web_sync_migration.sql except for the one added key.
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
