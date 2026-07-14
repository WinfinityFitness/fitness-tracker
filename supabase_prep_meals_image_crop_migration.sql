-- Adds per-meal image framing (zoom + focal point) so an admin can zoom
-- and reposition how a remote image URL is displayed in the Food Preps
-- thumbnails/detail view — the app can't re-host a cropped copy of a
-- remote image, so the crop is stored as display parameters instead:
-- image_zoom (1 = fit, up to 3 = 3x) and image_pos_x/y (focal point as
-- 0-100 percentages, 50/50 = centered).

alter table prep_meals add column if not exists image_zoom numeric not null default 1;
alter table prep_meals add column if not exists image_pos_x numeric not null default 50;
alter table prep_meals add column if not exists image_pos_y numeric not null default 50;

drop function if exists admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text);

create or replace function admin_upsert_prep_meal(
  p_digital_id text, p_password text,
  p_id bigint, p_category text, p_name text, p_ingredients text, p_procedure text,
  p_cal_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric,
  p_fiber_per_100g numeric, p_sodium_per_100g numeric,
  p_active boolean, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  if p_id is null then
    insert into prep_meals (category, name, ingredients, procedure, cal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, sodium_per_100g, active, image_url, image_zoom, image_pos_x, image_pos_y, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_cal_per_100g, p_protein_per_100g, p_carbs_per_100g, p_fat_per_100g, p_fiber_per_100g, p_sodium_per_100g, p_active, nullif(p_image_url, ''),
            greatest(1, least(3, coalesce(p_image_zoom, 1))), greatest(0, least(100, coalesce(p_image_pos_x, 50))), greatest(0, least(100, coalesce(p_image_pos_y, 50))),
            'admin', null, null);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        cal_per_100g = p_cal_per_100g, protein_per_100g = p_protein_per_100g,
        carbs_per_100g = p_carbs_per_100g, fat_per_100g = p_fat_per_100g,
        fiber_per_100g = p_fiber_per_100g, sodium_per_100g = p_sodium_per_100g,
        active = p_active, image_url = nullif(p_image_url, ''),
        image_zoom = greatest(1, least(3, coalesce(p_image_zoom, 1))),
        image_pos_x = greatest(0, least(100, coalesce(p_image_pos_x, 50))),
        image_pos_y = greatest(0, least(100, coalesce(p_image_pos_y, 50)))
    where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, numeric, numeric) to anon;
