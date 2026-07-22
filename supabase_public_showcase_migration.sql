-- Public Progress Showcase — a fully anonymous, unauthenticated dashboard
-- (showcase.html) meant to be iframe-embedded on winfinityfitness.com's
-- marketing page. Shows real opted-in users AND 100 synthetic demo users as
-- bar charts (one bar per user per metric), with a click-to-reveal stat
-- card per user. Entirely new, isolated tables — zero changes to any real
-- user table, zero effect on real user data either way.
--
-- Two things deliberately NOT touched here, both confirmed with the user:
--  - The in-app Nexus Leaderboard opt-in is unrelated to this (it's forced
--    on unconditionally now, see initLeaderboard() in app.js) — this is a
--    SEPARATE, explicit opt-in, since "visible to other signed-in app
--    users" and "visible publicly with no login at all" are different
--    consent levels.
--  - `leaderboard` currently over-grants anon SELECT to admin-only columns
--    (admin_mode_override, ad_free_until) via a table-level grant from an
--    earlier migration. Left alone per the user's explicit choice — this
--    file's own RPC uses an explicit column allowlist regardless, so it
--    never touches those columns either way.
--
-- ============================================================
-- MANUAL STEPS after running this file:
-- ============================================================
--   1. Confirm the cron job registered:
--        select * from cron.job where jobname = 'winfinity-advance-showcase-day';
--   2. Embed on winfinityfitness.com via Elementor (HTML/embed widget):
--        <iframe src="https://winfinityfitness.github.io/fitness-tracker/showcase.html"
--                style="width:100%;border:0;min-height:640px;" loading="lazy"
--                title="Winfinity Progress Showcase"></iframe>
-- ============================================================

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------
-- 1. Real-user opt-in — its own locked-down table, not a column on the
--    already-wide-open `leaderboard` table (a boolean there would itself
--    be trivially readable by anyone holding the anon key, same issue as
--    the rest of that table — see header note above).
-- ---------------------------------------------------------------------
create table if not exists showcase_optins (
  share_key uuid primary key references leaderboard(share_key) on delete cascade,
  optin boolean not null default false,
  optin_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table showcase_optins enable row level security;
-- Deliberately zero anon policies/grants — only reachable through the RPCs
-- below, matching web_sync_accounts/reminder_settings's lockdown, not
-- leaderboard's own already-regretted "using (true)" pattern.

create or replace function set_showcase_optin(p_share_key uuid, p_optin boolean) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into showcase_optins (share_key, optin, optin_at, updated_at)
  values (p_share_key, p_optin, case when p_optin then now() else null end, now())
  on conflict (share_key) do update set
    optin = excluded.optin,
    optin_at = case when excluded.optin and not showcase_optins.optin then now() else showcase_optins.optin_at end,
    updated_at = now();
end;
$$;
grant execute on function set_showcase_optin(uuid, boolean) to anon;

-- ---------------------------------------------------------------------
-- 2. 100 synthetic demo users + a pre-generated 14-day metric snapshot
--    per user (only day_index 7-14 ever exist/are shown — see the cursor
--    design in section 3 for why). Generated ONCE below, not regenerated
--    daily — only which day is *revealed* advances daily.
-- ---------------------------------------------------------------------
create table if not exists showcase_demo_users (
  id serial primary key,
  code_name text not null,
  public_id text not null unique,
  avatar_data_url text,
  fitness_mode text
);

create table if not exists showcase_demo_daily_metrics (
  demo_user_id int not null references showcase_demo_users(id) on delete cascade,
  day_index int not null check (day_index between 7 and 14),
  weight_progress_pct numeric,
  weight_lost_kg numeric,
  steps integer,
  volume_lifted numeric,
  volume_unit text not null default 'kg',
  furthest_run_km numeric,
  fastest_run_pace_sec numeric,
  conscientious_score integer,
  avg_calories integer,
  avg_protein_g integer,
  logging_consistency_pct integer,
  primary key (demo_user_id, day_index)
);
alter table showcase_demo_users enable row level security;
alter table showcase_demo_daily_metrics enable row level security;
-- Zero anon policies/grants on either — only reachable through the merged
-- RPC in section 4.

-- One-time seed: 100 users, each with a random starting baseline plus a
-- small per-user trend slope carried across the 8 days (7..14) — not
-- independent random() per cell, so each user's week reads as a plausible
-- trend (gradually losing weight, steps drifting up/down, etc.) instead of
-- noise. Re-runnable safely (guarded by a row-count check).
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
  v_user_id int;
  v_names text[] := array['Aiko','Bram','Cass','Deo','Eli','Farah','Gio','Hana','Ivo','Jaz',
    'Kian','Luz','Milo','Nadia','Omar','Pia','Quin','Rafa','Sable','Toma',
    'Uma','Vito','Wren','Xael','Yara','Zeph','Aris','Beni','Cyra','Dax',
    'Enzo','Fira','Gael','Hollis','Ines','Jax','Kaia','Leon','Maren','Nero'];
begin
  if (select count(*) from showcase_demo_users) > 0 then
    return; -- already seeded, don't duplicate on re-run
  end if;

  for i in 1..100 loop
    v_public_id := 'WF-DEMO' || lpad(i::text, 3, '0');
    v_is_runner := random() < 0.65;

    v_start_steps := 4000 + random() * 9000;
    v_steps_drift := (random() - 0.4) * 300; -- slight upward bias day over day

    v_start_volume := 500 + random() * 6000;
    v_volume_trend := v_start_volume * (0.005 + random() * 0.02); -- +0.5-2.5%/day

    v_start_progress := -6 + random() * 10; -- -6% to +4% at day 7
    v_progress_trend := (random() - 0.3) * 0.6; -- trends toward loss slightly more often

    v_start_weight_lost := random() * 8;
    v_conscientious_base := 40 + random() * 55;
    v_calories_base := 1600 + random() * 1200;
    v_protein_base := 80 + random() * 140;
    v_furthest_run := case when v_is_runner then 2 + random() * 13 else null end;
    v_fastest_pace := case when v_is_runner then 240 + random() * 240 else null end;

    insert into showcase_demo_users (code_name, public_id, fitness_mode)
    values (
      v_names[1 + (i % array_length(v_names, 1))] || '-' || i,
      v_public_id,
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

-- ---------------------------------------------------------------------
-- 3. Single-row "visible day" cursor (same singleton pattern as
--    ad_settings) + the daily advance, pure SQL, no Edge Function needed
--    (this job only ever does one UPDATE, unlike check-reminders which
--    has to actually send Web Push messages).
-- ---------------------------------------------------------------------
create table if not exists showcase_state (
  id int primary key default 1,
  visible_day int not null default 7,
  last_advanced_on date,
  updated_at timestamptz not null default now(),
  constraint showcase_state_single_row check (id = 1)
);
insert into showcase_state (id, visible_day) values (1, 7) on conflict (id) do nothing;
alter table showcase_state enable row level security;
create policy "anon read showcase_state" on showcase_state for select using (true);

create or replace function advance_showcase_day() returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update showcase_state
  set visible_day = case when visible_day >= 14 then 7 else visible_day + 1 end,
      last_advanced_on = current_date,
      updated_at = now()
  where id = 1
    and last_advanced_on is distinct from current_date;
end;
$$;

select cron.schedule(
  'winfinity-advance-showcase-day',
  '0 0 * * *',
  $$select advance_showcase_day();$$
);

-- ---------------------------------------------------------------------
-- 4. The merged public RPC. Explicit column allowlist (same pattern as
--    get_visible_leaderboard) — admin-only leaderboard columns are
--    structurally never referenced. drop first, per this project's own
--    documented "returns table signature change creates an overload"
--    gotcha (see supabase_fix_feed_rpc_overload_migration*.sql).
-- ---------------------------------------------------------------------
drop function if exists get_public_showcase_data();

create or replace function get_public_showcase_data()
returns table (
  public_id text,
  code_name text,
  avatar_data_url text,
  fitness_mode text,
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
  select l.public_id, l.code_name, l.avatar_data_url, l.fitness_mode,
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

  select u.public_id, u.code_name, u.avatar_data_url, u.fitness_mode,
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
