-- Prep Meal add/edit/delete is now admin-only (view/browse stays open to
-- everyone via the Warrior-tier-gated Food Preps overlay). Drops the
-- self-service RPCs entirely rather than just hiding their UI entry
-- points, so the "admin only" restriction holds even against someone
-- calling the REST API directly — matches admin_upsert_prep_meal/
-- admin_delete_prep_meal already being the only write path the client
-- uses. Any meals a user previously self-submitted are left as-is (still
-- visible, still labeled "By <name>") — only the ability to add new ones
-- or edit/delete existing ones as a non-admin is removed.

drop function if exists user_upsert_prep_meal(uuid, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric);
drop function if exists user_delete_prep_meal(uuid, bigint);
