-- Real (organic) users get their own actual country shown on the Public
-- Progress Showcase, instead of always coming through as null. Only ever
-- set from a manually-searched weather location (which has a real geocoded
-- country) -- GPS auto-detect never populates this, so a user who's never
-- searched a location just stays null (existing frontend behavior: grouped
-- under "All locations", not excluded). Fabricated demo users are a
-- completely separate table (showcase_demo_users) and are never touched by
-- this -- only they get force-assigned to the Philippines, per the earlier
-- migrations.

alter table leaderboard add column if not exists country text;

create or replace function set_leaderboard_country(p_share_key uuid, p_country text) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update leaderboard set country = p_country where share_key = p_share_key;
end;
$$;
grant execute on function set_leaderboard_country(uuid, text) to anon;

-- Re-declare the showcase RPC with the real users' actual country instead
-- of a hardcoded null -- drop first, same documented overload gotcha as
-- every other change to this function's return signature.
drop function if exists get_public_showcase_data();

create or replace function get_public_showcase_data()
returns table (
  public_id text,
  code_name text,
  avatar_data_url text,
  fitness_mode text,
  location text,
  weight_progress_pct numeric,
  weight_lost_kg numeric,
  steps integer,
  volume_lifted numeric,
  volume_unit text,
  furthest_run_km numeric,
  fastest_run_pace_sec numeric,
  conscientious_score integer,
  avg_calories integer,
  avg_protein_g integer,
  logging_consistency_pct integer,
  updated_at timestamptz,
  is_demo boolean
)
language sql
security definer
set search_path = public
as $$
  select l.public_id, l.code_name, l.avatar_data_url, l.fitness_mode, l.country as location,
         l.weight_progress_pct, null::numeric as weight_lost_kg, l.steps,
         l.volume_lifted, l.volume_unit,
         l.furthest_run_km, l.fastest_run_pace_sec, l.conscientious_score,
         null::int as avg_calories, null::int as avg_protein_g, null::int as logging_consistency_pct,
         l.updated_at, false as is_demo
  from leaderboard l
  where l.public_id is not null
    and l.updated_at >= now() - interval '7 days'

  union all

  select u.public_id, u.code_name, u.avatar_data_url, u.fitness_mode, u.location,
         m.weight_progress_pct, m.weight_lost_kg, m.steps,
         m.volume_lifted, m.volume_unit,
         m.furthest_run_km, m.fastest_run_pace_sec, m.conscientious_score,
         m.avg_calories, m.avg_protein_g, m.logging_consistency_pct,
         now() as updated_at, true as is_demo
  from showcase_demo_users u
  join showcase_demo_daily_metrics m on m.demo_user_id = u.id
  where m.day_index = (select visible_day from showcase_state where id = 1);
$$;
grant execute on function get_public_showcase_data() to anon;

notify pgrst, 'reload schema';
