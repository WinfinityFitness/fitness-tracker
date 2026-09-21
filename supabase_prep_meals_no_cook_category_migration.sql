-- Adds a 4th Food Preps category, "No-Cook", for the 48 Lazy Lifter
-- day-plans imported by supabase_lazylifter_prep_meals_import.sql (Easy
-- Cook + No-Cook Bulking + No-Cook Cutting all live in this one tab,
-- separate from Breakfast/Full Meal/Snacks). Also adds the meal_breakdown
-- column those rows use to back the per-meal (Meal A/B/C...) popup.
--
-- Run this BEFORE supabase_lazylifter_meal_breakdown_migration.sql (which
-- fills meal_breakdown in). Safe to re-run.

alter table prep_meals drop constraint if exists prep_meals_category_check;
alter table prep_meals add constraint prep_meals_category_check check (category in ('breakfast', 'full_meal', 'snack', 'no_cook'));

alter table prep_meals add column if not exists meal_breakdown jsonb;

-- Move the 48 already-imported day-plans out of "full_meal" into the new
-- "No-Cook" tab. Matched by name prefix, same convention their names were
-- given in the import migration ("Easy Cook — ...", "No-Cook Bulking —
-- ...", "No-Cook Cutting — ...").
update prep_meals
set category = 'no_cook'
where name like 'Easy Cook %' or name like 'No-Cook %';
