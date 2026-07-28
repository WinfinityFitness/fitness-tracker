-- Coach white-label tenancy — Phase C: feature-gating enforcement, on the
-- revised (free, coach-controlled) business model. Two real changes here:
--
-- 1. coach_set_own_features -- a coach toggles their OWN 5 flags directly
--    (verify_coach_login-scoped), no longer owner-gated-after-payment.
--    admin_set_coach_features (Phase A, owner-only) stays untouched and
--    callable too -- not removed, just no longer the only path.
--
-- 2. get_prep_meals -- the ONE flag with real server-hosted content behind
--    it (prep_meals is an admin-curated table, unlike the other 4 flags
--    which gate purely local on-device data with no per-entry Supabase
--    write to intercept -- confirmed by reading the app's actual write
--    path, updateLogFields() -> localStorage only). Replaces the direct
--    `sb.from('prep_meals').select(...)` read (one call site in app.js)
--    with a gated RPC: attached clients whose coach has feature_prep_meals
--    off get an empty list, not the raw table. A client with no coach at
--    all still sees prep_meals (this feature isn't behind a coach wall for
--    people who were never handed one), matching the existing default-open
--    posture of this app for anyone not opted into coaching.

create or replace function coach_set_own_features(
  p_coach_digital_id text, p_coach_password text,
  p_core_tracking boolean, p_resistance_training boolean,
  p_outdoor_activity boolean, p_nutrition_logging boolean, p_prep_meals boolean
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  update coaches set
    feature_core_tracking = p_core_tracking,
    feature_resistance_training = p_resistance_training,
    feature_outdoor_activity = p_outdoor_activity,
    feature_nutrition_logging = p_nutrition_logging,
    feature_prep_meals = p_prep_meals,
    updated_at = now()
  where id = v_coach_id;
end;
$$;
grant execute on function coach_set_own_features(text, text, boolean, boolean, boolean, boolean, boolean) to anon;

create or replace function get_prep_meals(p_share_key uuid)
returns setof prep_meals
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_enabled boolean;
begin
  select cc.coach_id into v_coach_id from coach_clients cc where cc.share_key = p_share_key and cc.status = 'active';
  if v_coach_id is not null then
    select feature_prep_meals into v_enabled from coaches where id = v_coach_id;
    if not coalesce(v_enabled, false) then
      return; -- attached to a coach who has this off -- empty result, not an error
    end if;
  end if;
  -- no coach at all, or coach has it on: full unrestricted list, same as
  -- the direct table read this replaces.
  return query select * from prep_meals order by created_at asc;
end;
$$;
grant execute on function get_prep_meals(uuid) to anon;

notify pgrst, 'reload schema';
