-- Adds fiber/sodium per-100g to prep_meals, alongside the existing
-- cal/protein/carbs/fat per-100g columns, so the Food Preps detail panel
-- can show a fuller nutrition-facts-style breakdown (matching the Add
-- Food AI estimate flow, which already tracks fiber/sodium per 100g).

alter table prep_meals add column if not exists fiber_per_100g numeric not null default 0;
alter table prep_meals add column if not exists sodium_per_100g numeric not null default 0;

drop function if exists admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, boolean, text);

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
