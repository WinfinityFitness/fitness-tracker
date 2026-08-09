-- Coach Portal push notifications: a coach gets pushed a real OS
-- notification when one of their clients finishes a workout ("Completed"
-- on the Training tab), even with the Coach Portal/Dashboard fully closed.
--
-- Mirrors supabase_push_notifications_migration.sql /
-- supabase_fcm_tokens_migration.sql's client-facing tables exactly, just
-- keyed by coach_id instead of share_key -- coaches aren't necessarily
-- tied to a fitness-tracker share_key at all (only "linked" coaches are,
-- see supabase_coach_linked_pin_migration.sql). Delivered through the
-- SAME send-push Edge Function as every other push in this app -- see
-- that function's updated coach_id branch, deployed alongside this file.
--
-- ============================================================
-- MANUAL STEPS -- do these in order, this file alone isn't enough:
--   1. Redeploy the send-push Edge Function with the updated code (adds
--      the coach_id branch) -- see supabase/functions/send-push/index.ts.
--      No new secrets needed -- this reuses the same VAPID_PRIVATE_KEY /
--      FCM_SERVICE_ACCOUNT_JSON / service_role_key Vault secret already
--      configured for supabase_push_notifications_migration.sql.
--   2. Then run the rest of this file.
-- ============================================================

create table if not exists coach_push_subscriptions (
  endpoint text primary key,
  coach_id uuid not null references coaches(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists coach_push_subscriptions_coach_id_idx on coach_push_subscriptions (coach_id);

create table if not exists coach_fcm_tokens (
  token text primary key,
  coach_id uuid not null references coaches(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists coach_fcm_tokens_coach_id_idx on coach_fcm_tokens (coach_id);

alter table coach_push_subscriptions enable row level security;
alter table coach_fcm_tokens enable row level security;
-- Same trust model as the client-facing tables -- no anon select/insert/
-- update/delete policies, all writes go through the RPCs below (which
-- re-verify the coach's own login), the Edge Function reads via the
-- service role key (bypasses RLS entirely).

create or replace function coach_upsert_push_subscription(
  p_coach_digital_id text, p_coach_password text, p_endpoint text, p_p256dh text, p_auth text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  insert into coach_push_subscriptions (endpoint, coach_id, p256dh, auth)
  values (p_endpoint, v_coach_id, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set coach_id = excluded.coach_id, p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;
grant execute on function coach_upsert_push_subscription(text, text, text, text, text) to anon;

create or replace function coach_delete_push_subscription(
  p_coach_digital_id text, p_coach_password text, p_endpoint text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  delete from coach_push_subscriptions where endpoint = p_endpoint and coach_id = v_coach_id;
end;
$$;
grant execute on function coach_delete_push_subscription(text, text, text) to anon;

create or replace function coach_upsert_fcm_token(
  p_coach_digital_id text, p_coach_password text, p_token text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  insert into coach_fcm_tokens (token, coach_id)
  values (p_token, v_coach_id)
  on conflict (token) do update set coach_id = excluded.coach_id;
end;
$$;
grant execute on function coach_upsert_fcm_token(text, text, text) to anon;

create or replace function coach_delete_fcm_token(
  p_coach_digital_id text, p_coach_password text, p_token text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  delete from coach_fcm_tokens where token = p_token and coach_id = v_coach_id;
end;
$$;
grant execute on function coach_delete_fcm_token(text, text, text) to anon;

-- Called by the CLIENT (app.js) right after a successful "Completed" sync
-- -- share_key-authenticated like the rest of the client-facing sync RPCs
-- (a share_key is itself a private, unguessable credential; no password
-- involved on this side). Notifies every coach this client is actively
-- attached to -- almost always exactly one, but not enforced as such.
create or replace function notify_coach_of_client_workout(p_share_key uuid) returns void
language plpgsql
security definer
as $$
declare
  v_code_name text;
  v_service_key text;
  r record;
begin
  select code_name into v_code_name from leaderboard where share_key = p_share_key limit 1;

  select decrypted_secret into v_service_key from vault.decrypted_secrets
    where name = 'service_role_key' limit 1;
  if v_service_key is null then
    return; -- Vault secret not set up yet -- skip rather than error.
  end if;

  for r in select coach_id from coach_clients where share_key = p_share_key and status = 'active' loop
    perform net.http_post(
      url := 'https://mzkjboplfalauivwcnni.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key
      ),
      body := jsonb_build_object(
        'coach_id', r.coach_id,
        'title', coalesce(v_code_name, 'Your client') || ' just finished a workout!',
        'body', 'Open Coach Portal to see their Training Calendar.',
        'url', 'https://winfinityfitness.com/coach-portal'
      )
    );
  end loop;
end;
$$;
grant execute on function notify_coach_of_client_workout(uuid) to anon;