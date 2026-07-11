-- Scheduled Web Push reminders for Winfinity Tracker (hydration + Start/End
-- Day Log nudges). Run this AFTER supabase_push_notifications_migration.sql
-- — it reuses that migration's Vault-stored service_role_key secret and the
-- same VAPID setup, just adds a second, schedule-driven push path instead
-- of the DM trigger's event-driven one.
--
-- Why a separate table: hydration/log reminders are time-of-day based, not
-- triggered by a database event like a new chat message — something has to
-- periodically ask "is it this user's reminder time yet?" That requires
-- knowing each user's chosen times AND their timezone (the server runs in
-- UTC; "7:00 AM" only means something once you know whose 7:00 AM it is).
--
-- ============================================================
-- MANUAL STEPS — do these in order:
-- ============================================================
--   1. Deploy the new Edge Function: supabase functions deploy check-reminders
--      (see supabase/functions/check-reminders/index.ts) — it reuses the
--      same VAPID_PRIVATE_KEY secret you already set, no new secret needed.
--   2. Run this file.
--   3. Schedule the periodic check (run by itself, in the SQL editor):
--        select cron.schedule(
--          'winfinity-check-reminders',
--          '*/10 * * * *',
--          $$
--          select net.http_post(
--            url := 'https://mzkjboplfalauivwcnni.supabase.co/functions/v1/check-reminders',
--            headers := jsonb_build_object(
--              'Content-Type', 'application/json',
--              'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
--            ),
--            body := '{}'::jsonb
--          );
--          $$
--        );
--      This runs the check every 10 minutes. To stop/change it later:
--        select cron.unschedule('winfinity-check-reminders');
-- ============================================================

create extension if not exists pg_cron;
-- pg_net was already enabled by supabase_push_notifications_migration.sql.

create table if not exists reminder_settings (
  share_key uuid primary key,
  timezone text not null default 'UTC',
  hydration_enabled boolean not null default false,
  wake_time text not null default '07:00',
  bed_time text not null default '22:00',
  meal_times text[] not null default array['07:00','12:00','19:00'],
  hourly_enabled boolean not null default true,
  log_reminders_enabled boolean not null default false,
  last_sent jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table reminder_settings enable row level security;
-- No anon select/insert/update/delete — all writes go through the RPC
-- below, all reads happen server-side in the Edge Function via the
-- service role key.

create or replace function upsert_reminder_settings(
  p_share_key uuid,
  p_timezone text,
  p_hydration_enabled boolean,
  p_wake_time text,
  p_bed_time text,
  p_meal_times text[],
  p_hourly_enabled boolean,
  p_log_reminders_enabled boolean
) returns void
language sql
security definer
as $$
  insert into reminder_settings (
    share_key, timezone, hydration_enabled, wake_time, bed_time,
    meal_times, hourly_enabled, log_reminders_enabled, updated_at
  )
  values (
    p_share_key, coalesce(p_timezone, 'UTC'), p_hydration_enabled, p_wake_time, p_bed_time,
    p_meal_times, p_hourly_enabled, p_log_reminders_enabled, now()
  )
  on conflict (share_key) do update set
    timezone = excluded.timezone,
    hydration_enabled = excluded.hydration_enabled,
    wake_time = excluded.wake_time,
    bed_time = excluded.bed_time,
    meal_times = excluded.meal_times,
    hourly_enabled = excluded.hourly_enabled,
    log_reminders_enabled = excluded.log_reminders_enabled,
    updated_at = now();
$$;
grant execute on function upsert_reminder_settings(uuid, text, boolean, text, text, text[], boolean, boolean) to anon;
