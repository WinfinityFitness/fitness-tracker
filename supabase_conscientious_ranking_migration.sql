-- Adds the "Conscientious" leaderboard ranking — a 0-100 score averaging
-- today's Habit Completion % (see computeHabitCompletion in app.js) and
-- today's Life Fuel % (water/calorie/protein adherence), rewarding people
-- who are consistently filling in their daily logs and hitting today's
-- targets. Mirrors the existing set_run_records() pattern (see
-- supabase_group_chat_migration_3.sql) so the main upsert_leaderboard_entry()
-- signature doesn't need to change — purely additive, doesn't touch any
-- existing column.

alter table leaderboard add column if not exists conscientious_score integer;

create or replace function set_conscientious_score(
  p_share_key uuid,
  p_score int
) returns void
language sql
security definer
as $$
  update leaderboard
  set conscientious_score = p_score
  where share_key = p_share_key;
$$;

grant execute on function set_conscientious_score(uuid, int) to anon;
