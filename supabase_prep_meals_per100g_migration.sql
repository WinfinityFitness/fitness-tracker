-- Follow-up to supabase_prep_meals_migration.sql: switches prep_meals from
-- "whole-dish amount scaled off a 2000 kcal reference" to true per-100g
-- serving math (same convention as the Add Food AI estimate flow). Admin/
-- users now enter calories & macros PER 100 GRAMS; the Food Preps browser
-- (Warrior+ gated, opened from the Media Synchronizer's Browse button)
-- computes the serving size for whatever calorie target the viewer picks:
-- grams = target_kcal / cal_per_100g * 100, macros scale with grams.
--
-- Run this AFTER supabase_prep_meals_migration.sql has already been applied.

alter table prep_meals drop column if exists ref_grams;
alter table prep_meals drop column if exists ref_calories;
alter table prep_meals drop column if exists ref_protein;
alter table prep_meals drop column if exists ref_carbs;
alter table prep_meals drop column if exists ref_fat;
alter table prep_meals add column if not exists cal_per_100g numeric not null default 0;
alter table prep_meals add column if not exists protein_per_100g numeric not null default 0;
alter table prep_meals add column if not exists carbs_per_100g numeric not null default 0;
alter table prep_meals add column if not exists fat_per_100g numeric not null default 0;

-- Postgres overloads functions by exact argument signature, so changing the
-- parameter list doesn't replace the old one in place — drop it explicitly
-- first or both versions would exist side by side.
drop function if exists admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, boolean, text);
drop function if exists user_upsert_prep_meal(uuid, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric);

create or replace function admin_upsert_prep_meal(
  p_digital_id text, p_password text,
  p_id bigint, p_category text, p_name text, p_ingredients text, p_procedure text,
  p_cal_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric,
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
    insert into prep_meals (category, name, ingredients, procedure, cal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, active, image_url, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_cal_per_100g, p_protein_per_100g, p_carbs_per_100g, p_fat_per_100g, p_active, nullif(p_image_url, ''), 'admin', null, null);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        cal_per_100g = p_cal_per_100g, protein_per_100g = p_protein_per_100g,
        carbs_per_100g = p_carbs_per_100g, fat_per_100g = p_fat_per_100g,
        active = p_active, image_url = nullif(p_image_url, '')
    where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, boolean, text) to anon;

create or replace function user_upsert_prep_meal(
  p_share_key uuid, p_author_name text,
  p_id bigint, p_category text, p_name text, p_ingredients text, p_procedure text,
  p_cal_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric
) returns void
language plpgsql
security definer
as $$
begin
  if p_id is null then
    insert into prep_meals (category, name, ingredients, procedure, cal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, active, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_cal_per_100g, p_protein_per_100g, p_carbs_per_100g, p_fat_per_100g, true, 'user', p_share_key, p_author_name);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        cal_per_100g = p_cal_per_100g, protein_per_100g = p_protein_per_100g,
        carbs_per_100g = p_carbs_per_100g, fat_per_100g = p_fat_per_100g,
        author_name = p_author_name
    where id = p_id and author_type = 'user' and author_share_key = p_share_key;
  end if;
end;
$$;
grant execute on function user_upsert_prep_meal(uuid, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric) to anon;
