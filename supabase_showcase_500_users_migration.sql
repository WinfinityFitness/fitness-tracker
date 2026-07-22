-- Expands the Progress Showcase demo dataset from 100 to 500 users. Wipes
-- and regenerates the existing synthetic set (no real value in preserving
-- it — it's fabricated data) rather than only appending 400 more, so every
-- user (old and new) goes through the exact same generation pass including
-- a random location assignment (previously a separate backfill migration).
-- Zero effect on real users either way — this only ever touches
-- showcase_demo_users/showcase_demo_daily_metrics.

truncate table showcase_demo_daily_metrics;
truncate table showcase_demo_users restart identity cascade;

do $$
declare
  i int;
  d int;
  v_public_id text;
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
  v_location text;
  v_user_id int;
  v_names text[] := array['Aiko','Bram','Cass','Deo','Eli','Farah','Gio','Hana','Ivo','Jaz',
    'Kian','Luz','Milo','Nadia','Omar','Pia','Quin','Rafa','Sable','Toma',
    'Uma','Vito','Wren','Xael','Yara','Zeph','Aris','Beni','Cyra','Dax',
    'Enzo','Fira','Gael','Hollis','Ines','Jax','Kaia','Leon','Maren','Nero'];
  v_countries text[] := array['Philippines','United States','Japan','Brazil','Germany',
    'India','Australia','Canada','South Korea','United Kingdom','Mexico','Nigeria',
    'Sweden','Italy','South Africa','Indonesia','France','Vietnam','Spain','Kenya'];
begin
  for i in 1..500 loop
    v_public_id := 'WF-DEMO' || lpad(i::text, 3, '0');
    v_is_runner := random() < 0.65;
    v_location := v_countries[1 + floor(random() * array_length(v_countries, 1))::int];

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

    insert into showcase_demo_users (code_name, public_id, fitness_mode, location)
    values (
      v_names[1 + (i % array_length(v_names, 1))] || '-' || i,
      v_public_id,
      (array['beginner','warrior','spartan','demigod'])[1 + floor(random() * 4)::int],
      v_location
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

notify pgrst, 'reload schema';
