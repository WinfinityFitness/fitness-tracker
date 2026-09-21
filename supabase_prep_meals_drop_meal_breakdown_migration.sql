-- Cleanup: the meal_breakdown jsonb column and its admin_set_meal_breakdown_image
-- RPC were introduced for the "Meal Breakdown popup" feature, now replaced
-- by splitting each meal into its own standalone Food Prep row (see
-- supabase_prep_meals_split_into_menu_items_migration.sql). Nothing in the
-- app references either anymore. Run this last, after that migration.

drop function if exists admin_set_meal_breakdown_image(text, text, bigint, int, text);
alter table prep_meals drop column if exists meal_breakdown;
