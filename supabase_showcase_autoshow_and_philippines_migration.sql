-- 1. Public Progress Showcase no longer requires an explicit opt-in --
--    every real user with a public_id shows up automatically (still only
--    Digital ID + code name + stats, never anything more identifying, and
--    still a 7-day activity window so stale/abandoned profiles don't
--    linger). The showcase_optins table/RPC are left in place (harmless,
--    just unused) rather than dropped, in case opt-in-only is ever wanted
--    again -- only the WHERE clause changes.
--    drop first -- returns table signature is unchanged here, but keeping
--    this project's own documented habit of dropping before recreating
--    (see supabase_fix_feed_rpc_overload_migration*.sql).
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

-- 2. Demo users whose Digital ID doesn't literally contain "DEMO" (i.e.
--    the ones using the realistic-looking WF-XXXXXX format rather than the
--    obviously-fake WF-DEMO### one) all get reassigned to the Philippines,
--    replacing whatever random country they'd been given.
update showcase_demo_users
set location = 'Philippines'
where public_id not like 'WF-DEMO%';

notify pgrst, 'reload schema';
