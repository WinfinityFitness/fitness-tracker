-- Lets a coach set their own motto/brand text for the splash-screen caption
-- (the line under the logo, index.html's #splashScreen .splash-caption --
-- defaults to the bundled "Masarap talaga kumain..." line), instead of only
-- being able to swap the splash image. Mirrors exactly how splash_image_url
-- already flows through this same table/functions.

alter table coach_splash_settings add column if not exists splash_caption text;

create or replace function coach_set_splash_image(
  p_coach_digital_id text, p_coach_password text, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric,
  p_splash_caption text default null
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  insert into coach_splash_settings (coach_id, splash_image_url, splash_image_zoom, splash_image_pos_x, splash_image_pos_y, splash_caption)
  values (
    v_coach_id, nullif(p_image_url, ''),
    greatest(1, least(3, coalesce(p_image_zoom, 1))),
    greatest(0, least(100, coalesce(p_image_pos_x, 50))),
    greatest(0, least(100, coalesce(p_image_pos_y, 50))),
    nullif(p_splash_caption, '')
  )
  on conflict (coach_id) do update set
    splash_image_url = excluded.splash_image_url,
    splash_image_zoom = excluded.splash_image_zoom,
    splash_image_pos_x = excluded.splash_image_pos_x,
    splash_image_pos_y = excluded.splash_image_pos_y,
    splash_caption = excluded.splash_caption,
    updated_at = now();
end;
$$;
grant execute on function coach_set_splash_image(text, text, text, numeric, numeric, numeric, text) to anon;

-- The function the shared app actually calls client-side (see app.js's
-- fetchCoachBranding -- get_coach_branding_by_slug below is legacy/unused
-- per supabase_coach_branding_migration_2.sql's own comment, kept updated
-- anyway for consistency since it's a cheap, harmless change).
create or replace function get_my_coach_features(p_share_key uuid)
returns table (
  has_coach boolean, brand_name text, brand_logo_url text,
  brand_color_primary text, brand_color_accent text,
  splash_image_url text, splash_image_zoom numeric, splash_image_pos_x numeric, splash_image_pos_y numeric,
  splash_caption text,
  feature_core_tracking boolean, feature_resistance_training boolean,
  feature_outdoor_activity boolean, feature_nutrition_logging boolean, feature_prep_meals boolean
)
language plpgsql
security definer
as $$
declare v_row record;
begin
  select c.brand_name, c.brand_logo_url, c.brand_color_primary, c.brand_color_accent,
    s.splash_image_url, s.splash_image_zoom, s.splash_image_pos_x, s.splash_image_pos_y, s.splash_caption,
    c.feature_core_tracking, c.feature_resistance_training,
    c.feature_outdoor_activity, c.feature_nutrition_logging, c.feature_prep_meals
  into v_row
  from coach_clients cc
  join coaches c on c.id = cc.coach_id
  left join coach_splash_settings s on s.coach_id = c.id
  where cc.share_key = p_share_key and cc.status = 'active' and c.active;

  if not found then
    return query select false, null::text, null::text, null::text, null::text,
      null::text, null::numeric, null::numeric, null::numeric, null::text,
      false, false, false, false, false;
  else
    return query select true, v_row.brand_name, v_row.brand_logo_url, v_row.brand_color_primary, v_row.brand_color_accent,
      v_row.splash_image_url, v_row.splash_image_zoom, v_row.splash_image_pos_x, v_row.splash_image_pos_y, v_row.splash_caption,
      v_row.feature_core_tracking, v_row.feature_resistance_training,
      v_row.feature_outdoor_activity, v_row.feature_nutrition_logging, v_row.feature_prep_meals;
  end if;
end;
$$;
grant execute on function get_my_coach_features(uuid) to anon;

create or replace function get_coach_branding_by_slug(p_slug text)
returns table (
  brand_name text, brand_logo_url text, brand_color_primary text, brand_color_accent text,
  splash_image_url text, splash_image_zoom numeric, splash_image_pos_x numeric, splash_image_pos_y numeric,
  splash_caption text
)
language plpgsql
security definer
as $$
begin
  return query
    select c.brand_name, c.brand_logo_url, c.brand_color_primary, c.brand_color_accent,
      s.splash_image_url, s.splash_image_zoom, s.splash_image_pos_x, s.splash_image_pos_y, s.splash_caption
    from coaches c
    left join coach_splash_settings s on s.coach_id = c.id
    where c.slug = lower(trim(p_slug)) and c.active;
end;
$$;
grant execute on function get_coach_branding_by_slug(text) to anon;

notify pgrst, 'reload schema';
