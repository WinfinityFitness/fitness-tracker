-- Adds the weekly "Progress Photo & Measurements" reminder (Sundays only,
-- at wake-up time) to the existing reminder_settings table/RPC created by
-- supabase_reminder_push_migration.sql. Run this AFTER that migration.
--
-- No Edge Function redeploy needed for THIS file, but check-reminders/
-- index.ts has been updated to read the new column and send two Sunday
-- notifications (Progress Photo + Take Measurements) — redeploy that
-- function with the updated code before this reminder will actually fire.

alter table reminder_settings add column if not exists progress_photo_enabled boolean not null default false;

-- The new version below adds a 9th parameter, which Postgres treats as a
-- distinct overload rather than a replacement — drop the old 8-arg one
-- first so there's no stale duplicate left behind.
drop function if exists upsert_reminder_settings(uuid, text, boolean, text, text, text[], boolean, boolean);

create or replace function upsert_reminder_settings(
  p_share_key uuid,
  p_timezone text,
  p_hydration_enabled boolean,
  p_wake_time text,
  p_bed_time text,
  p_meal_times text[],
  p_hourly_enabled boolean,
  p_log_reminders_enabled boolean,
  p_progress_photo_enabled boolean
) returns void
language sql
security definer
as $$
  insert into reminder_settings (
    share_key, timezone, hydration_enabled, wake_time, bed_time,
    meal_times, hourly_enabled, log_reminders_enabled, progress_photo_enabled, updated_at
  )
  values (
    p_share_key, coalesce(p_timezone, 'UTC'), p_hydration_enabled, p_wake_time, p_bed_time,
    p_meal_times, p_hourly_enabled, p_log_reminders_enabled, p_progress_photo_enabled, now()
  )
  on conflict (share_key) do update set
    timezone = excluded.timezone,
    hydration_enabled = excluded.hydration_enabled,
    wake_time = excluded.wake_time,
    bed_time = excluded.bed_time,
    meal_times = excluded.meal_times,
    hourly_enabled = excluded.hourly_enabled,
    log_reminders_enabled = excluded.log_reminders_enabled,
    progress_photo_enabled = excluded.progress_photo_enabled,
    updated_at = now();
$$;
grant execute on function upsert_reminder_settings(uuid, text, boolean, text, text, text[], boolean, boolean, boolean) to anon;
