-- Coach white-label tenancy — Phase B rework. The owner clarified there is
-- no per-coach subdomain/website at all: everyone stays on the one shared
-- Winfinity app. "Rebrand" means a client sees their own coach's name/logo,
-- resolved by which coach they're ATTACHED to (coach_clients), not by which
-- URL they visited. get_coach_branding_by_slug (slug-keyed, public) is left
-- in place unused rather than dropped -- no reason to break a working
-- migration -- but nothing calls it client-side anymore as of this pass.
--
-- get_my_coach_features already returns brand fields, built for the
-- feature-flag lookup -- this just extends it to also return splash fields,
-- so client-side branding resolution can be a single call instead of two.

create or replace function get_my_coach_features(p_share_key uuid)
returns table (
  has_coach boolean, brand_name text, brand_logo_url text,
  brand_color_primary text, brand_color_accent text,
  splash_image_url text, splash_image_zoom numeric, splash_image_pos_x numeric, splash_image_pos_y numeric,
  feature_core_tracking boolean, feature_resistance_training boolean,
  feature_outdoor_activity boolean, feature_nutrition_logging boolean, feature_prep_meals boolean
)
language plpgsql
security definer
as $$
declare v_row record;
begin
  select c.brand_name, c.brand_logo_url, c.brand_color_primary, c.brand_color_accent,
    s.splash_image_url, s.splash_image_zoom, s.splash_image_pos_x, s.splash_image_pos_y,
    c.feature_core_tracking, c.feature_resistance_training,
    c.feature_outdoor_activity, c.feature_nutrition_logging, c.feature_prep_meals
  into v_row
  from coach_clients cc
  join coaches c on c.id = cc.coach_id
  left join coach_splash_settings s on s.coach_id = c.id
  where cc.share_key = p_share_key and cc.status = 'active' and c.active;

  if not found then
    return query select false, null::text, null::text, null::text, null::text,
      null::text, null::numeric, null::numeric, null::numeric,
      false, false, false, false, false;
  else
    return query select true, v_row.brand_name, v_row.brand_logo_url, v_row.brand_color_primary, v_row.brand_color_accent,
      v_row.splash_image_url, v_row.splash_image_zoom, v_row.splash_image_pos_x, v_row.splash_image_pos_y,
      v_row.feature_core_tracking, v_row.feature_resistance_training,
      v_row.feature_outdoor_activity, v_row.feature_nutrition_logging, v_row.feature_prep_meals;
  end if;
end;
$$;
grant execute on function get_my_coach_features(uuid) to anon;

notify pgrst, 'reload schema';
