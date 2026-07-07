-- Follow-up migration: adds Furthest Run / Fastest Run leaderboard columns.
-- Run this in the Supabase SQL editor. Does NOT touch upsert_leaderboard_entry
-- or any existing column — purely additive, same pattern as set_public_id.

alter table leaderboard add column if not exists furthest_run_km numeric;
alter table leaderboard add column if not exists fastest_run_pace_sec numeric;

create or replace function set_run_records(
  p_share_key uuid,
  p_furthest_run_km numeric,
  p_fastest_run_pace_sec numeric
) returns void
language sql
security definer
as $$
  update leaderboard
  set furthest_run_km = p_furthest_run_km,
      fastest_run_pace_sec = p_fastest_run_pace_sec
  where share_key = p_share_key;
$$;

grant execute on function set_run_records(uuid, numeric, numeric) to anon;
