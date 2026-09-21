-- Splits "Easy Cook" out of the "No-Cook" tab into its own category (they
-- were combined into one tab originally, now the user wants them separate
-- Food Preps tabs). Also adds admin_set_meal_breakdown_image, letting an
-- admin attach a thumbnail to an individual Meal A/B/C... entry inside a
-- plan's meal_breakdown jsonb array (same "paste a URL" convention as
-- every other admin image field in this app -- there's no real file
-- upload anywhere in Food Preps, just a URL text field).
--
-- Run this AFTER supabase_prep_meals_no_cook_category_migration.sql and
-- supabase_lazylifter_meal_breakdown_migration.sql. Safe to re-run.

alter table prep_meals drop constraint if exists prep_meals_category_check;
alter table prep_meals add constraint prep_meals_category_check check (category in ('breakfast', 'full_meal', 'snack', 'no_cook', 'easy_cook'));

update prep_meals
set category = 'easy_cook'
where name like 'Easy Cook %';

create or replace function admin_set_meal_breakdown_image(
  p_digital_id text, p_password text, p_id bigint, p_meal_index int, p_image_url text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update prep_meals
  set meal_breakdown = jsonb_set(meal_breakdown, array[p_meal_index::text, 'image_url'], to_jsonb(nullif(p_image_url, '')))
  where id = p_id;
end;
$$;
grant execute on function admin_set_meal_breakdown_image(text, text, bigint, int, text) to anon;
