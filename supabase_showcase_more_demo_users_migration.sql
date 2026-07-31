-- 1. Re-format existing demo users' Digital IDs from the obviously-sequential
--    WF-DEMO001..WF-DEMO100 to the same random-looking format real Digital
--    IDs use (WF- + 6 random uppercase alphanumeric chars, matching the
--    placeholder shown in index.html's own web-sync gate: "e.g. WF-7741ZQ").
--    Still clearly separated from real users at the data level (its own
--    table, is_demo:true, never joined against `leaderboard`) -- this only
--    changes the cosmetic format so they don't read as obviously-placeholder
--    at a glance. Deliberately does NOT reuse any real user's actual Digital
--    ID: generated fresh and checked for collisions against both tables.
create or replace function _showcase_gen_unique_public_id() returns text
language plpgsql
as $$
declare v_id text; v_exists boolean;
begin
  loop
    v_id := 'WF-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    select exists(
      select 1 from leaderboard where public_id = v_id
      union all
      select 1 from showcase_demo_users where public_id = v_id
    ) into v_exists;
    exit when not v_exists;
  end loop;
  return v_id;
end;
$$;

update showcase_demo_users set public_id = _showcase_gen_unique_public_id();

-- 2. Add 6 more demo users (100 -> 106), same generation approach as the
--    original seed in supabase_public_showcase_migration.sql: a random
--    baseline + a per-user trend slope carried across day_index 7-14, so
--    each reads as a plausible trend rather than independent daily noise.
do $$
declare
  i int;
  d int;
  v_is_runner boolean;
  v_start_steps numeric;
  v_steps_drift numeric;
  v_start_volume numeric;
  v_volume_trend numeric;
  v_start_progress numeric;
  v_progress_trend numeric;
  v_start_weight_lost numeric;
  v_conscientious_base numeric;
  v_calories_base numeric;
  v_protein_base numeric;
  v_furthest_run numeric;
  v_fastest_pace numeric;
  v_user_id int;
  v_names text[] := array['Nadia','Omar','Pia','Quin','Rafa','Sable'];
begin
  for i in 1..6 loop
    v_is_runner := random() < 0.65;
    v_start_steps := 4000 + random() * 9000;
    v_steps_drift := (random() - 0.4) * 300;
    v_start_volume := 500 + random() * 6000;
    v_volume_trend := v_start_volume * (0.005 + random() * 0.02);
    v_start_progress := -6 + random() * 10;
    v_progress_trend := (random() - 0.3) * 0.6;
    v_start_weight_lost := random() * 8;
    v_conscientious_base := 40 + random() * 55;
    v_calories_base := 1600 + random() * 1200;
    v_protein_base := 80 + random() * 140;
    v_furthest_run := case when v_is_runner then 2 + random() * 13 else null end;
    v_fastest_pace := case when v_is_runner then 240 + random() * 240 else null end;

    insert into showcase_demo_users (code_name, public_id, fitness_mode)
    values (
      v_names[i] || '-' || (100 + i),
      _showcase_gen_unique_public_id(),
      (array['beginner','warrior','spartan','demigod'])[1 + floor(random() * 4)::int]
    )
    returning id into v_user_id;

    for d in 7..14 loop
      insert into showcase_demo_daily_metrics (
        demo_user_id, day_index, weight_progress_pct, weight_lost_kg, steps,
        volume_lifted, volume_unit, furthest_run_km, fastest_run_pace_sec,
        conscientious_score, avg_calories, avg_protein_g, logging_consistency_pct
      ) values (
        v_user_id, d,
        round((v_start_progress + v_progress_trend * (d - 7))::numeric, 1),
        round((v_start_weight_lost + v_progress_trend * (d - 7) * -0.8)::numeric, 1),
        greatest(1000, round(v_start_steps + v_steps_drift * (d - 7) + (random() - 0.5) * 800)::int),
        round((v_start_volume + v_volume_trend * (d - 7))::numeric, 0),
        'kg',
        v_furthest_run,
        v_fastest_pace,
        least(100, greatest(0, round(v_conscientious_base + (random() - 0.5) * 8)::int)),
        round(v_calories_base + (random() - 0.5) * 300)::int,
        round(v_protein_base + (random() - 0.5) * 30)::int,
        least(100, greatest(30, round(v_conscientious_base + (random() - 0.5) * 15)::int))
      );
    end loop;
  end loop;
end;
$$;

drop function _showcase_gen_unique_public_id();

notify pgrst, 'reload schema';
