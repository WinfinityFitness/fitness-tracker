-- Makes the Showcase's "Daily Steps" and "Calories Consumed" values for
-- demo users reflect a trailing 7-day average (today + the previous 6
-- revealed days) instead of a single day's point value -- steadier,
-- more realistic-looking numbers, and matches how a real "daily average"
-- stat is usually computed. Early in the demo cycle (before 7 days have
-- been revealed yet) this naturally averages over however many days
-- exist so far rather than needing fake padding.
--
-- Real opted-in users are untouched -- leaderboard only ever stores one
-- current aggregate value (no daily history table), so there's nothing
-- to average there; they keep showing whatever value the app itself
-- already computed and synced.
--
-- Rewrites get_public_showcase_data() from `language sql` to
-- `language plpgsql` (needed for the visible_day lookup + windowed
-- average) -- drop first, per this project's own documented "returns
-- table signature change creates an overload" gotcha.
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
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visible_day int;
  v_window_start int;
begin
  select visible_day into v_visible_day from showcase_state where id = 1;
  v_window_start := greatest(7, coalesce(v_visible_day, 7) - 6);

  return query
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
         m.weight_progress_pct, m.weight_lost_kg,
         round(avgw.avg_steps)::int as steps,
         m.volume_lifted, m.volume_unit,
         m.furthest_run_km, m.fastest_run_pace_sec, m.conscientious_score,
         round(avgw.avg_cal)::int as avg_calories,
         m.avg_protein_g, m.logging_consistency_pct,
         now() as updated_at, true as is_demo
  from showcase_demo_users u
  join showcase_demo_daily_metrics m on m.demo_user_id = u.id and m.day_index = v_visible_day
  join lateral (
    select avg(m2.steps) as avg_steps, avg(m2.avg_calories) as avg_cal
    from showcase_demo_daily_metrics m2
    where m2.demo_user_id = u.id and m2.day_index between v_window_start and v_visible_day
  ) avgw on true;
end;
$$;
grant execute on function get_public_showcase_data() to anon;

notify pgrst, 'reload schema';
