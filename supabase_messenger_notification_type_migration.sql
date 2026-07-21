-- Tags DM push notifications with a "type": "chat" field so sw.js's
-- notificationclick handler can tell a chat message apart from a
-- hydration/Start-Day-Log/End-Day-Log reminder (check-reminders' own
-- pushes never set this, so they're unaffected) -- see the Messenger
-- auto-redirect toggle (wdsMessengerTogglePopup in index.html /
-- WDS_MESSENGER_AUTO_KEY in app.js). Byte-for-byte identical to
-- notify_dm_push() in supabase_push_notifications_migration.sql except
-- for the one added 'type' key in the request body.
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
      'body', left(new.message, 120),
      'type', 'chat'
    )
  );

  return new;
end;
$$;
