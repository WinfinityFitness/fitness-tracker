-- Per-app push notification routing — separates FT, Wellness, and
-- Messenger's external (OS) notifications instead of every subscribed
-- surface getting a duplicate of everything.
--
-- push_subscriptions gains an `app` column ('ft' | 'wellness' | 'messenger')
-- set by the client at subscribe time (see subscribeToPush() in app.js,
-- keyed off location.hostname the same way sw.js already picks a
-- notification icon per origin). Existing rows predate this column and are
-- treated as 'ft' wherever a filter checks for it — FT is the only surface
-- that subscribed to push before Wellness/Messenger existed.
--
-- Two independent routing rules land on top of this:
--  1. Chat/DM messages: pushed to Messenger if the recipient has an active
--     Messenger subscription, else Wellness, else FT as a last resort so an
--     FT-only user isn't left with zero notification. Decided here in
--     notify_dm_push, which now passes an app_filter array to send-push.
--     The existing messenger_auto_redirect deep-link logic is untouched —
--     app_filter only controls WHICH devices get the OS notification at
--     all, not what tapping it opens.
--  2. FT's own scheduled reminders (hydration, Start/End Day Log, Progress
--     Photo, Take Measurements — all sent by check-reminders) stay FT-only
--     external pushes; see the matching check-reminders/index.ts update
--     (not part of this SQL file — deploy that function separately).
alter table push_subscriptions add column if not exists app text;

create or replace function upsert_push_subscription(
  p_share_key uuid, p_endpoint text, p_p256dh text, p_auth text, p_app text default null
) returns void
language sql
security definer
as $$
  insert into push_subscriptions (endpoint, share_key, p256dh, auth, app)
  values (p_endpoint, p_share_key, p_p256dh, p_auth, p_app)
  on conflict (endpoint) do update
    set share_key = excluded.share_key, p256dh = excluded.p256dh, auth = excluded.auth, app = excluded.app;
$$;
grant execute on function upsert_push_subscription(uuid, text, text, text, text) to anon;

-- Same body as supabase_messenger_auto_redirect_serverside_migration.sql's
-- notify_dm_push() plus the new app_filter computation.
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
  v_app_filter jsonb;
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

  -- Messenger if the recipient has it installed, else Wellness, else FT as
  -- a last-resort fallback so an FT-only user still gets notified at all.
  if exists (select 1 from push_subscriptions where share_key = v_recipient_key and app = 'messenger') then
    v_app_filter := '["messenger"]'::jsonb;
  elsif exists (select 1 from push_subscriptions where share_key = v_recipient_key and app = 'wellness') then
    v_app_filter := '["wellness"]'::jsonb;
  else
    v_app_filter := '["ft"]'::jsonb;
  end if;

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
             then 'https://messenger.winfinityfitness.com/' else null end,
      'app_filter', v_app_filter
    )
  );

  return new;
end;
$$;

notify pgrst, 'reload schema';
