-- Reopens prep-meal submissions to every user, with admin moderation:
-- a user's own submission saves to the database immediately and shows up
-- for THEM right away, but stays hidden from everyone else until an admin
-- approves it. Admins can approve (one tap in the manager list, or just by
-- editing+saving the meal) or delete anything inappropriate.

alter table prep_meals add column if not exists approved boolean not null default false;
-- Everything already in the catalog predates moderation — grandfather it
-- all as approved so nothing currently public disappears.
update prep_meals set approved = true;

-- Self-service RPCs (re-created after being dropped by the admin-only
-- migration). A user can only ever insert as themselves or edit/delete
-- rows whose author_share_key matches their own key; image fields are
-- deliberately NOT accepted here so an anonymous submission can never
-- inject an arbitrary image URL that shows up for everyone. Edits to an
-- already-approved meal reset it to pending so the admin re-reviews.
create or replace function user_upsert_prep_meal(
  p_share_key uuid, p_author_name text,
  p_id bigint, p_category text, p_name text, p_ingredients text, p_procedure text,
  p_cal_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric,
  p_fiber_per_100g numeric, p_sodium_per_100g numeric
) returns void
language plpgsql
security definer
as $$
begin
  if p_id is null then
    insert into prep_meals (category, name, ingredients, procedure, cal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, sodium_per_100g, active, approved, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_cal_per_100g, p_protein_per_100g, p_carbs_per_100g, p_fat_per_100g, p_fiber_per_100g, p_sodium_per_100g, true, false, 'user', p_share_key, p_author_name);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        cal_per_100g = p_cal_per_100g, protein_per_100g = p_protein_per_100g,
        carbs_per_100g = p_carbs_per_100g, fat_per_100g = p_fat_per_100g,
        fiber_per_100g = p_fiber_per_100g, sodium_per_100g = p_sodium_per_100g,
        author_name = p_author_name, approved = false
    where id = p_id and author_type = 'user' and author_share_key = p_share_key;
  end if;
end;
$$;
grant execute on function user_upsert_prep_meal(uuid, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric) to anon;

create or replace function user_delete_prep_meal(p_share_key uuid, p_id bigint) returns void
language plpgsql
security definer
as $$
begin
  delete from prep_meals where id = p_id and author_type = 'user' and author_share_key = p_share_key;
end;
$$;
grant execute on function user_delete_prep_meal(uuid, bigint) to anon;

-- One-tap approval from the admin manager list.
create or replace function admin_approve_prep_meal(p_digital_id text, p_password text, p_id bigint) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update prep_meals set approved = true where id = p_id;
end;
$$;
grant execute on function admin_approve_prep_meal(text, text, bigint) to anon;

-- Same signature as before (no client change needed) — but any meal an
-- admin saves is by definition reviewed, so it's marked approved.
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
            greatest(1, least(3, coalesce(p_image_zoom, 1))), greatest(0, least(100, coalesce(p_image_pos_x, 50))), greatest(0, least(100, coalesce(p_image_pos_y, 50))),
            'admin', null, null);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        cal_per_100g = p_cal_per_100g, protein_per_100g = p_protein_per_100g,
        carbs_per_100g = p_carbs_per_100g, fat_per_100g = p_fat_per_100g,
        fiber_per_100g = p_fiber_per_100g, sodium_per_100g = p_sodium_per_100g,
        active = p_active, approved = true, image_url = nullif(p_image_url, ''),
        image_zoom = greatest(1, least(3, coalesce(p_image_zoom, 1))),
        image_pos_x = greatest(0, least(100, coalesce(p_image_pos_x, 50))),
        image_pos_y = greatest(0, least(100, coalesce(p_image_pos_y, 50)))
    where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, numeric, numeric) to anon;
