-- Widens the image-framing zoom range from 1x-3x to 0.3x-3x (zoom OUT now
-- allowed, not just zoom in) for both the prep meal image crop and the
-- admin-editable app boot logo. Same signatures as before — only the
-- clamp bounds inside each function change, no client-side RPC-call
-- changes needed beyond what's already shipped.

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
    insert into prep_meals (category, name, ingredients, procedure, cal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, sodium_per_100g, active, approved, image_url, image_zoom, image_pos_x, image_pos_y, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_cal_per_100g, p_protein_per_100g, p_carbs_per_100g, p_fat_per_100g, p_fiber_per_100g, p_sodium_per_100g, p_active, true, nullif(p_image_url, ''),
            greatest(0.3, least(3, coalesce(p_image_zoom, 1))), greatest(0, least(100, coalesce(p_image_pos_x, 50))), greatest(0, least(100, coalesce(p_image_pos_y, 50))),
            'admin', null, null);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        cal_per_100g = p_cal_per_100g, protein_per_100g = p_protein_per_100g,
        carbs_per_100g = p_carbs_per_100g, fat_per_100g = p_fat_per_100g,
        fiber_per_100g = p_fiber_per_100g, sodium_per_100g = p_sodium_per_100g,
        active = p_active, approved = true, image_url = nullif(p_image_url, ''),
        image_zoom = greatest(0.3, least(3, coalesce(p_image_zoom, 1))),
        image_pos_x = greatest(0, least(100, coalesce(p_image_pos_x, 50))),
        image_pos_y = greatest(0, least(100, coalesce(p_image_pos_y, 50)))
    where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, numeric, numeric) to anon;

create or replace function admin_set_splash_image(
  p_digital_id text, p_password text, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update app_splash_settings
  set splash_image_url = nullif(p_image_url, ''),
      splash_image_zoom = greatest(0.3, least(3, coalesce(p_image_zoom, 1))),
      splash_image_pos_x = greatest(0, least(100, coalesce(p_image_pos_x, 50))),
      splash_image_pos_y = greatest(0, least(100, coalesce(p_image_pos_y, 50))),
      updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_splash_image(text, text, text, numeric, numeric, numeric) to anon;
