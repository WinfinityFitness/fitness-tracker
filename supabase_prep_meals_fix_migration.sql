-- Consolidated fix-it migration: supabase_prep_meals_per100g_migration.sql
-- never actually got run (only supabase_prep_meals_sodium_fiber_migration.sql
-- did), so the table was left with the old ref_grams/ref_calories/ref_protein/
-- ref_carbs/ref_fat columns while admin_upsert_prep_meal already expected the
-- new cal_per_100g/protein_per_100g/carbs_per_100g/fat_per_100g/fiber_per_100g/
-- sodium_per_100g ones — hence "column cal_per_100g does not exist" on save.
--
-- This migration is safe to run regardless of which prior migrations did or
-- didn't apply: it adds every per-100g column if missing, drops the old
-- ref_* columns if still present, drops every historical admin_upsert_prep_meal
-- signature this project has ever shipped (so nothing stale survives as a
-- duplicate overload), and recreates the one correct, current version.

alter table prep_meals add column if not exists cal_per_100g numeric not null default 0;
alter table prep_meals add column if not exists protein_per_100g numeric not null default 0;
alter table prep_meals add column if not exists carbs_per_100g numeric not null default 0;
alter table prep_meals add column if not exists fat_per_100g numeric not null default 0;
alter table prep_meals add column if not exists fiber_per_100g numeric not null default 0;
alter table prep_meals add column if not exists sodium_per_100g numeric not null default 0;

alter table prep_meals drop column if exists ref_grams;
alter table prep_meals drop column if exists ref_calories;
alter table prep_meals drop column if exists ref_protein;
alter table prep_meals drop column if exists ref_carbs;
alter table prep_meals drop column if exists ref_fat;

-- Every signature admin_upsert_prep_meal has ever had in this project,
-- dropped defensively (IF EXISTS) regardless of which ones actually made
-- it into this database, so no stale overload can linger.
drop function if exists admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, boolean, text);
drop function if exists admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, boolean, text);
drop function if exists admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text);

create or replace function admin_upsert_prep_meal(
  p_digital_id text, p_password text,
  p_id bigint, p_category text, p_name text, p_ingredients text, p_procedure text,
  p_cal_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric,
  p_fiber_per_100g numeric, p_sodium_per_100g numeric,
  p_active boolean, p_image_url text
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  if p_id is null then
    insert into prep_meals (category, name, ingredients, procedure, cal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, sodium_per_100g, active, image_url, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_cal_per_100g, p_protein_per_100g, p_carbs_per_100g, p_fat_per_100g, p_fiber_per_100g, p_sodium_per_100g, p_active, nullif(p_image_url, ''), 'admin', null, null);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        cal_per_100g = p_cal_per_100g, protein_per_100g = p_protein_per_100g,
        carbs_per_100g = p_carbs_per_100g, fat_per_100g = p_fat_per_100g,
        fiber_per_100g = p_fiber_per_100g, sodium_per_100g = p_sodium_per_100g,
        active = p_active, image_url = nullif(p_image_url, '')
    where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text) to anon;

-- Same story for user_upsert_prep_meal — it was supposed to be dropped
-- entirely by supabase_prep_meals_admin_only_migration.sql once prep meal
-- editing became admin-only, but drop it defensively here too in case
-- that migration was also skipped, so no anon-writable ref_grams-based
-- version is left reachable.
drop function if exists user_upsert_prep_meal(uuid, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric);
drop function if exists user_upsert_prep_meal(uuid, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric);
drop function if exists user_delete_prep_meal(uuid, bigint);
