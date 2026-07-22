-- Adds a "location" flavor to the Progress Showcase for international
-- variety (winfinityfitness.com marketing goal: showcase should read as a
-- global community). Demo users get a random country from a diverse list,
-- assigned once and kept stable. Real opted-in users don't have a tracked
-- public location today, so they come through as null (the frontend
-- groups those under "All locations" — no location-based exclusion).

alter table showcase_demo_users add column if not exists location text;

do $$
declare
  r record;
  v_countries text[] := array['Philippines','United States','Japan','Brazil','Germany',
    'India','Australia','Canada','South Korea','United Kingdom','Mexico','Nigeria',
    'Sweden','Italy','South Africa','Indonesia','France','Vietnam','Spain','Kenya'];
begin
  for r in select id from showcase_demo_users where location is null loop
    update showcase_demo_users
    set location = v_countries[1 + floor(random() * array_length(v_countries, 1))::int]
    where id = r.id;
  end loop;
end;
$$;

-- Re-declare the RPC with the new location column added to both sides of
-- the union (null for real users, the assigned country for demo users).
-- drop first -- returns table signature change creates an overload
-- otherwise (same documented gotcha as the original migration).
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
  select l.public_id, l.code_name, l.avatar_data_url, l.fitness_mode, null::text as location,
         l.weight_progress_pct, null::numeric as weight_lost_kg, l.steps,
         l.volume_lifted, l.volume_unit,
         l.furthest_run_km, l.fastest_run_pace_sec, l.conscientious_score,
         null::int as avg_calories, null::int as avg_protein_g, null::int as logging_consistency_pct,
         l.updated_at, false as is_demo
  from leaderboard l
  join showcase_optins so on so.share_key = l.share_key
  where so.optin = true
    and l.public_id is not null
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
