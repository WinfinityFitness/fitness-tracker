-- Web Push notifications for Winfinity Tracker.
-- Run this once in the Supabase SQL editor, AFTER the group chat migrations.
--
-- What this adds: a push_subscriptions table (keyed by share_key) and a
-- trigger that fires whenever a new DM message is inserted, calling an
-- Edge Function that pushes a real Android/browser notification to the
-- recipient — one that arrives even with the app fully closed and the
-- phone locked. The app's existing in-app Notification API only fires
-- while the app's own JS is actively running, which a locked/closed phone
-- can't guarantee — this is the real background-delivery path.
--
-- ============================================================
-- MANUAL STEPS — do these in order, this file alone isn't enough:
-- ============================================================
--   1. Deploy the Edge Function: from the project root,
--        supabase functions deploy send-push
--      (see supabase/functions/send-push/index.ts)
--   2. Set the VAPID private key as a function secret — this is the
--      PRIVATE half of the key pair Claude generated; never put it in
--      any file that gets committed:
--        supabase secrets set VAPID_PRIVATE_KEY=<paste the private key>
--   3. Store your Supabase SERVICE ROLE key in Vault (SQL editor, run by
--      itself, with your own real key — never commit this value anywhere):
--        select vault.create_secret('<paste your service_role key>', 'service_role_key');
--   4. Then run the rest of this file.
-- ============================================================

create extension if not exists pg_net;

create table if not exists push_subscriptions (
  endpoint text primary key,
  share_key uuid not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_share_key_idx on push_subscriptions (share_key);

alter table push_subscriptions enable row level security;
-- Deliberately no anon select/insert/update/delete policies — all writes
-- go through the RPCs below, and the Edge Function reads via the service
-- role key, which bypasses RLS entirely.

create or replace function upsert_push_subscription(
  p_share_key uuid, p_endpoint text, p_p256dh text, p_auth text
) returns void
language sql
security definer
as $$
  insert into push_subscriptions (endpoint, share_key, p256dh, auth)
  values (p_endpoint, p_share_key, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set share_key = excluded.share_key, p256dh = excluded.p256dh, auth = excluded.auth;
$$;
grant execute on function upsert_push_subscription(uuid, text, text, text) to anon;

create or replace function delete_push_subscription(p_endpoint text) returns void
language sql
security definer
as $$
  delete from push_subscriptions where endpoint = p_endpoint;
$$;
grant execute on function delete_push_subscription(text) to anon;

-- Fires once per new DM message. Looks up the other participant in the
-- room and asks the Edge Function to push to their subscribed devices.
-- Silently no-ops for group-room messages (push is DM-only for now) and
-- for anyone with no saved subscription.
create or replace function notify_dm_push() returns trigger
language plpgsql
security definer
as $$
declare
  v_is_dm boolean;
  v_sender_key uuid;
  v_recipient_key uuid;
  v_service_key text;
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

  perform net.http_post(
    url := 'https://mzkjboplfalauivwcnni.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object(
      'share_key', v_recipient_key,
      'title', 'New message from ' || new.code_name,
      'body', left(new.message, 120)
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_notify_dm_push on chat_messages;
create trigger trg_notify_dm_push
  after insert on chat_messages
  for each row execute function notify_dm_push();
