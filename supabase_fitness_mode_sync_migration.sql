-- Syncs each user's current Fitness Journey Mode (beginner/warrior/spartan/
-- demigod) to the leaderboard so their rank badge (helmet icon) can show
-- next to their name for everyone else too, not just themselves locally.
-- Mirrors the existing set_run_records()/set_conscientious_score() pattern
-- — purely additive, doesn't touch upsert_leaderboard_entry()'s signature.

alter table leaderboard add column if not exists fitness_mode text;

create or replace function set_fitness_mode(
  p_share_key uuid,
  p_mode text
) returns void
language sql
security definer
as $$
  update leaderboard
  set fitness_mode = p_mode
  where share_key = p_share_key;
$$;

grant execute on function set_fitness_mode(uuid, text) to anon;
