-- Native push tokens (Firebase Cloud Messaging) for the Android app —
-- parallel to push_subscriptions (Web Push, browser/PWA installs). The
-- native Capacitor WebView doesn't implement the Web Push API at all
-- (no PushManager), so the native app registers an FCM token here instead;
-- the send-push Edge Function delivers to both tables' rows for a given
-- share_key, covering whichever platform that user is actually on.

create table if not exists fcm_tokens (
  token text primary key,
  share_key uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists fcm_tokens_share_key_idx on fcm_tokens (share_key);

alter table fcm_tokens enable row level security;
-- Same trust model as push_subscriptions — no anon select/insert/update/delete
-- policies, all writes go through the RPCs below, Edge Function reads via
-- the service role key (bypasses RLS entirely).

create or replace function upsert_fcm_token(p_share_key uuid, p_token text) returns void
language sql
security definer
as $$
  insert into fcm_tokens (token, share_key)
  values (p_token, p_share_key)
  on conflict (token) do update set share_key = excluded.share_key;
$$;
grant execute on function upsert_fcm_token(uuid, text) to anon;

create or replace function delete_fcm_token(p_token text) returns void
language sql
security definer
as $$
  delete from fcm_tokens where token = p_token;
$$;
grant execute on function delete_fcm_token(text) to anon;
