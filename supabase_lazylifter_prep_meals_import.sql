-- Imports all 48 distinct day-plans from the three Lazy Lifter meal-plan
-- PDFs (Easy Cook: 12, No-Cook Bulking: 18, No-Cook Cutting: 18 -- the
-- "Bonus Meal Plans" PDF is a straight duplicate of Easy Cook's numbers and
-- is skipped) into prep_meals, one row per whole day's plan (category =
-- 'full_meal').
--
-- IMPORTANT — how the numbers were built:
--   cal_per_100g / protein_per_100g / carbs_per_100g / fat_per_100g are
--   back-computed as (that plan's own stated MEAL PLAN TOTAL) / (estimated
--   total grams) * 100. The calorie/protein/carb/fat TOTALS themselves are
--   copied verbatim from each PDF's own "MEAL PLAN TOTAL" row -- nothing
--   there was altered or re-derived.
--   The one number that IS an estimate is total grams for the day, since
--   the PDFs give servings like "1/2 cup", "2 pcs", "1 order" rather than
--   grams. That was filled in using standard reference weights (Quaker
--   oats 40g=150kcal, ~180g per cup cooked rice, 1 egg=50g, a drained
--   Century tuna can=100g, etc.), and plain black coffee/water is treated
--   as 0g (it's not really part of "the dish"). Fiber/sodium aren't in the
--   source PDFs, so both are set to 0 -- edit any row afterward in the
--   admin Food Preps manager if you want to fill those in.
--
-- Run this in the Supabase SQL editor after all prep_meals migrations
-- (through supabase_prep_meals_user_submissions_migration.sql) are applied.

-- ============================== EASY COOK ==============================

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 1200 kcal (Plan 1)',
  'Meal A: Rolled Oats (Quaker) 1/2 cup, Low Fat Milk 1/2 cup, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Chicken Breast 80g, Baguio Beans 1/2 cup, Baby Potatoes 1/2 cup, Dari Cream Butter 1/2 tbsp, Rice 1/2 cup. Meal C: Black Forest Bread (Gardenia) 2 slices, Peanut Butter (Lady''s Choice) 1 tbsp, Whey Protein 1 scoop. Meal D: Century Tuna Chunks in Oil 1/2 can, Cabbage 1 cup, Rice 1/2 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  152.4, 13.08, 16.62, 3.66, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 1200 kcal (Plan 2)',
  'Meal A: Pandesal 1 pc, Egg (scrambled) 1 pc, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Pinoy Tapa 100g, Broccoli 100g, Garlic 2 cloves, Rice 1/2 cup. Meal C: Wheat Bread (Gardenia) 2 slices, Century Tuna Flakes in Oil 1 serving, Low Fat Mayo (Best Foods) 1 tbsp, Tomatoes 1 small, Lettuce 1 pc. Meal D: Rotisserie Chicken (Chooks-To-Go) 1 quarter, Mixed Veggies (Corn & Carrots) 1/2 cup, Rice 1/2 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  132.6, 12.00, 14.11, 4.95, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 1200 kcal (Plan 3)',
  'Meal A: Corned Beef (Purefoods) 80g, Rice 1/2 cup, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Chicken Breast 100g, Kangkong 100g, Tomatoes 1 small, Rice 1/2 cup. Meal C: Wheat Bread (Gardenia) 2 slices, Egg (scrambled) 1 pc, Low Fat Mayo 1 tbsp, Tomatoes 1 small, Lettuce 1 pc. Meal D: Rotisserie Chicken (Chooks-To-Go) 1 leg quarter, Broccoli (steamed) 1 cup, Rice 1/2 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  111.8, 11.31, 10.21, 3.44, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 1600 kcal (Plan 1)',
  'Meal A: Rolled Oats (Quaker) 1/2 cup, Low Fat Milk 1/2 cup, Saging na Saba 1 medium, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Chicken Breast 100g, Baguio Beans 1 cup, Baby Potatoes 1/2 cup, Dari Cream Butter 1/2 tbsp, Rice 1/2 cup. Meal C: Black Forest Bread 2 slices, Peanut Butter 1 tbsp, Banana 1/2 medium, Whey Protein 1 scoop. Meal D: Century Tuna Chunks in Oil 1/2 can, Cabbage 1 cup, Cheese (Eden) 2 servings, Rice 1/2 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  156.1, 11.65, 16.95, 4.30, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 1600 kcal (Plan 2)',
  'Meal A: Pandesal 1 pc, Egg (scrambled) 1 pc, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Pinoy Tapa 100g, Broccoli 100g, Garlic 2 cloves, Rice 1/2 cup. Meal C: Wheat Bread 2 slices, Century Tuna Flakes in Oil 1 can, Low Fat Mayo 1 tbsp, Tomatoes 1 small, Lettuce 1 pc, Cheese (Eden) 1 serving, Whey Protein 1 scoop. Meal D: Rotisserie Chicken 1 quarter, Mixed Veggies 1 cup, Dari Cream Butter 1/2 tbsp, Rice 1/2 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  146.9, 12.26, 12.85, 5.44, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 1600 kcal (Plan 3)',
  'Meal A: Corned Beef 100g, Eggs 1 pc, Rice 1/2 cup, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Chicken Breast 100g, Kangkong 100g, Tofu 1 pc, Tomatoes 1 small, Rice 1/2 cup. Meal C: Wheat Bread 2 slices, Egg (scrambled) 1 pc, Low Fat Mayo 1 tbsp, Tomatoes 1 small, Lettuce 1 pc, Cheese (Eden) 1 serving, Whey Protein 1 scoop. Meal D: Rotisserie Chicken 1 leg quarter, Broccoli (steamed) 1 cup, Rice 1/2 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  124.1, 12.48, 9.39, 4.23, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 2000 kcal (Plan 1)',
  'Meal A: Rolled Oats 1/2 cup, Low Fat Milk 1/2 cup, Saging na Saba 2 pcs, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Chicken Breast 200g, Baguio Beans 1 cup, Baby Potatoes 1/2 cup, Dari Cream Butter 1/2 tbsp, Rice 1/2 cup. Meal C: Black Forest Bread 2 slices, Peanut Butter 2 tbsp, Banana 1 medium, Whey Protein 1 scoop. Meal D: Century Tuna Chunks in Oil 1/2 can, Cabbage 1 cup, Cheese (Eden) 2 servings, Rice 1/2 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  160.5, 12.28, 16.74, 4.39, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 2000 kcal (Plan 2)',
  'Meal A: Pandesal 3 pcs, Egg (scrambled) 2 pcs, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Pinoy Tapa 100g, Broccoli 100g, Garlic 2 cloves, Rice 1/2 cup. Meal C: Wheat Bread 2 slices, Tuna Flakes in Oil (Mega) 1 can, Low Fat Mayo 1 tbsp, Tomatoes 1 small, Lettuce 1 pc, Cheese (Eden) 1 serving, Whey Protein 1 scoop. Meal D: Rotisserie Chicken 1 breast quarter, Mixed Veggies 1 cup, Dari Cream Butter 1/2 tbsp, Rice 1/2 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  159.0, 11.94, 15.15, 5.79, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 2000 kcal (Plan 3)',
  'Meal A: Corned Beef 100g, Potato (diced) 1/2 cup, Egg (sunny side up) 1 pc, Rice 1/2 cup, Black Coffee w/ Sugar 1 cup. Meal B: Chicken Breast 100g, Kangkong 100g, Tofu 1 pc, Tomatoes 1 small, Rice 1 cup. Meal C: Wheat Bread 2 slices, Egg 1 pc, Low Fat Mayo 1 tbsp, Tomatoes 1 small, Lettuce 1 pc, Cheese (Eden) 1 serving, Whey Protein 1 scoop. Meal D: Rotisserie Chicken 1 breast quarter, Broccoli 1 cup, Dari Cream Butter 1/2 tbsp, Rice 1 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  126.2, 10.68, 11.33, 4.05, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 2400 kcal (Plan 1)',
  'Meal A: Rolled Oats 1/2 cup, Low Fat Milk 1/2 cup, Saging na Saba 2 pcs, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Chicken Breast 100g, Baguio Beans 1 cup, Baby Potatoes 1 cup, Dari Cream Butter 1/2 tbsp, Rice 1 cup. Meal C: Black Forest Bread 2 slices, Peanut Butter 2 tbsp, Banana 1 medium, Whey Protein 1 scoop. Meal D: Whey Protein 1 scoop, Porky Pops (Oishi) 1 serving. Meal E: Century Tuna Chunks in Oil 1 can, Cabbage 2 cups, Cheese (Eden) 2 servings, Rice 2 servings.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  153.3, 12.14, 17.16, 3.85, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 2400 kcal (Plan 2)',
  'Meal A: Pandesal 3 pcs, Egg (scrambled) 2 pcs, Sugar 1 tsp, Black Coffee 1 cup. Meal B: Pinoy Tapa 100g, Broccoli 100g, Garlic 2 cloves, Rice 1 cup. Meal C: Wheat Bread 2 slices, Tuna Flakes in Oil 1 can, Low Fat Mayo 1 tbsp, Tomatoes 1 small, Lettuce 1 pc, Cheese (Eden) 1 serving, Whey Protein 1 scoop. Meal D: Whey Protein 1 scoop, Porky Pops (Oishi) 1 serving. Meal E: Rotisserie Chicken 1 breast quarter, Mixed Veggies 1 cup, Dari Cream Butter 1/2 tbsp, Rice 1 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  164.6, 13.25, 16.08, 5.31, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'Easy Cook — 2400 kcal (Plan 3)',
  'Meal A: Corned Beef 100g, Potato (diced) 1/2 cup, Egg (sunny side up) 1 pc, Rice 1 cup, Black Coffee w/ Sugar 1 cup. Meal B: Chicken Breast 100g, Kangkong 100g, Tofu 1 pc, Tomatoes 1 small, Rice 1 cup. Meal C: Wheat Bread 2 slices, Egg 1 pc, Low Fat Mayo 1 tbsp, Tomatoes 1 small, Lettuce 1 pc, Cheese (Eden) 1 serving, Whey Protein 1 scoop. Meal D: Whey Protein 1 scoop, Porky Pops (Oishi) 1 serving. Meal E: Rotisserie Chicken 1 breast quarter, Broccoli 1 cup, Dari Cream Butter 1/2 tbsp, Rice 1 cup.',
  'Lazy Lifter Easy Cook combo — prepare each meal as listed across the day.',
  136.2, 12.39, 11.95, 4.09, 0, 0, true, null, 1, 50, 50);

-- ========================= NO-COOK (BULKING) ============================

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 1800 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 2 whole, Pandesal 2 pcs, Tomato 1 small. Meal B: Mang Inasal PM2 1 order + 1 rice refill. Meal C: Ice Cream (any) 100g, Oishi Prawn Crackers 60g bag.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  197.6, 15.54, 22.17, 5.20, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 1800 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 2 whole, Canned Tuna in Oil (Century) 1 can, Pandesal 1 pc. Meal B: Chicken (white meat, Chooks-To-Go) 1 breast, White Rice 340g, Cucumber 1 cup slices. Meal C: Whey (any) 1 scoop. Meal D: Chicken (dark meat, Chooks-To-Go) 1 drum/thigh/wing, White Rice 340g, Tomato 1 small.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  128.2, 10.89, 15.01, 2.74, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 1800 kcal (Plan 3)',
  'Meal A: Eggs (boiled) 2 whole, Banana 1 small (100g), Quick Oats (Quaker) 2x70g. Meal B: Subway Roasted Chicken Sub 6" Wheat, Whey (any) 1 scoop. Meal C: Eggs (1 whole/1 white), Canned Sardines (Young''s Town) 1 can, White Rice 170g. Meal D: Canned Tuna (Gold Seas) 1 can, White Rice 170g, SkyFlakes Crackers 1 packet (3 each).',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  157.8, 12.90, 18.58, 3.54, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2100 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 3 whole, Pandesal 2 pcs, Banana 1 small (100g). Meal B: Canned Tuna in Water (Century) 2 cans, Tomato 1 small, Cucumber 1 cup slices. Meal C: Whey 1/2 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 1 order (without skin) + 1 rice refill. Meal E (Snack): Ensaymada (Goldilocks) 1 pc, Banana 1 small (100g).',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  139.9, 10.44, 17.60, 3.08, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2100 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 2 whole, Wheat Bread (Gardenia) 2 slices, Banana 2 small (200g). Meal B: Mang Inasal PM2 1 order (without skin) + 1 rice refill. Meal C: Whey 1 scoop, Peanut Butter (Lily''s) 2 tbsp (40g). Meal D: Canned Tuna (Gold Seas) 1 can, Tomato 1 small, Cucumber 1 cup slices. Meal E (Snack): Koko Crunch Cereal 1 serving, Stik-O Wafer Rolls 6 sticks.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  157.3, 11.85, 20.02, 3.31, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2100 kcal (Plan 3)',
  'Meal A: Canned Tuna in Water 1 can, White Rice 170g, Tomato 1 small. Meal B: Chicken (dark meat) 2 pcs, Tomato 1 small, Canned Tuna 1 can, White Rice 170g. Meal C: Banana 2 small (200g), Quick Oats 2x70g, Peanut Butter (Lily''s) 2 tbsp. Meal D: Chicken (white meat) 1 breast, Tomato 1 small. Meal E: SkyFlakes Crackers 1 packet (3 each).',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  150.6, 11.33, 18.98, 3.26, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2400 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 2 whole, White Rice 170g, Banana 1 small (100g). Meal B: Canned Tuna in Oil (Century) 1 can, Tomato 1 small, White Rice 170g. Meal C: Whey 1 scoop, Peanut Butter (Lily''s) 2 tbsp. Meal D: Mang Inasal PM2 1 order (without skin) + 2 rice refills. Meal E: SkyFlakes Crackers 1 packet (3 each).',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  156.3, 10.43, 21.19, 3.31, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2400 kcal (Plan 2)',
  'Meal A: Canned Tuna in Oil 1 can, Pandesal 1 pc, Banana 1 small (100g). Meal B: Chicken (white meat) 1 breast, White Rice 170g. Meal C: Whey 1.5 scoops, Peanut Butter (Lily''s) 2 tbsp, Banana 1 small (100g). Meal D: Chicken (dark meat) 2 pcs, White Rice 170g, Banana 1 small (100g). Meal E: Nestle Low Fat Milk 500ml, Koko Crunch Cereal 1 serving.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  144.3, 9.61, 19.55, 3.08, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2400 kcal (Plan 3)',
  'Meal A: Canned Tuna in Oil 1 can, Pandesal 1 pc, Banana 1 small (100g). Meal B: Subway Roasted Chicken Sub 6" Wheat. Meal C: Whey 1 scoop, Banana 1 small (100g), Peanut Butter 1 tbsp (20g). Meal D: Mang Inasal PM2 1 order (without skin) + 2 rice refills. Meal E: SkyFlakes Crackers 1 packet, Oishi Prawn Crackers 60g bag.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  172.2, 11.59, 22.75, 3.87, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2700 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 3 whole, White Rice 170g, Banana 1 small (100g). Meal B: Canned Tuna in Oil 2 cans, Tomato 1 small, White Rice 170g. Meal C: Whey 1/4 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 1 order + 1 rice refill. Meal E: Ice Cream (Selecta) 100g, Stik-O Wafer Rolls 9 sticks.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  166.6, 10.14, 22.91, 3.82, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2700 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 2 whole, Wheat Bread 2 slices, Banana 1 small (100g). Meal B: Chicken (dark meat) 2 pcs, Cucumber 1/2 cup, White Rice 170g, Banana 1 small (100g). Meal C: Whey 1.5 scoops, Banana 1 small (100g). Meal D: Chicken (white meat) 1 breast, Tomato 1 small, White Rice 170g. Meal E: Ice Cream (Selecta) 200g, SkyFlakes Crackers 3 packets, Oishi Prawn Crackers 60g bag.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  170.0, 10.25, 23.63, 3.83, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 2700 kcal (Plan 3)',
  'Meal A: Canned Tuna in Oil 1 can, White Rice 170g. Meal B: Subway Roasted Chicken Sub 6" Wheat, Banana 2 small (200g). Meal C: Canned Tuna in Oil 1 can, White Rice 170g. Meal D: Mang Inasal PM2 1 order + 2 rice refills. Meal E: Stik-O Wafer Rolls 6 sticks, Siopao Pork Asado 1 pc.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  152.8, 9.49, 21.06, 3.40, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 3000 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 2 whole, Quick Oats 2x70g, Banana 2 small (200g). Meal B: Canned Tuna in Oil 1 can, White Rice 170g, Tomato 1 small. Meal C: Canned Tuna in Oil 1 can, White Rice 170g, Tomato 1 small. Meal D: Mang Inasal PM2 1 order (without skin) + 2 rice refills. Meal E: Siopao Pork Asado 1 pc, Ensaymada 1 pc, SkyFlakes Crackers 1 packet.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  152.6, 8.74, 21.59, 3.48, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 3000 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 2 whole, Whey 1/2 scoop, Pandesal 2 pcs, Banana 1 small (100g). Meal B: Chicken (dark meat) 2 pcs, Cucumber 1/2 cup, White Rice 170g, Banana 1 small (100g). Meal C: Whey 1 scoop, Peanut Butter 2 tbsp, Banana 1 small (100g). Meal D: Chicken (white meat) 1 breast, Tomato 1 small, White Rice 170g. Meal E: Ice Cream (Selecta) 100g, Koko Crunch Cereal 2 servings, Lucky Me Pancit Canton 1 packet.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  199.1, 11.15, 28.03, 4.72, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 3000 kcal (Plan 3)',
  'Meal A: Canned Tuna in Oil 1 can, Banana 1 small (100g), Pandesal 2 pcs. Meal B: Subway Roasted Chicken Sub 6" Wheat, Banana 1 small (100g). Meal C: Whey 1.5 scoops, Banana 1 small (100g). Meal D: Mang Inasal PM2 1 order + 2 rice refills. Meal E: Pandesal 2 pcs, SkyFlakes Crackers 2 packets, Ensaymada 1 pc.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  183.9, 10.63, 25.95, 4.18, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 3300 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 4 whole, White Rice 170g, Banana 2 small (200g). Meal B: Canned Tuna in Oil 2 cans, Lucky Me Pancit Canton 1 packet, White Rice 170g. Meal C: Whey 1/4 scoop, Banana 2 small (200g), Quick Oats 2x70g. Meal D: Mang Inasal PM2 1 order + 2 rice refills. Meal E: Koko Crunch Cereal 2 servings, Stik-O Wafer Rolls 6 sticks.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  159.0, 8.67, 23.34, 3.44, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 3300 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 3 whole, Wheat Bread 2 slices, Banana 2 small (200g). Meal B: Chicken (dark meat) 2 pcs, Cucumber 1/2 cup, White Rice 170g, Banana 1 small (100g). Meal C: Whey 1 scoop, Peanut Butter 2 tbsp, Banana 1 small (100g). Meal D: Chicken (white meat) 1 breast, Tomato 1 small, White Rice 170g. Meal E: Nestle Low Fat Milk 2x500ml, Koko Crunch Cereal 2 servings, Stik-O Wafer Rolls 12 sticks.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  128.2, 7.03, 18.86, 2.73, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Bulking — 3300 kcal (Plan 3)',
  'Meal A: Canned Tuna in Oil 1 can, Pandesal 2 pcs, Banana 2 small (200g). Meal B: Subway Roasted Chicken Sub 12" Wheat, Banana 1 small (100g). Meal C: Canned Tuna in Oil 1 can, Pandesal 2 pcs, Banana 1 small (100g). Meal D: Mang Inasal PM2 1 order + 2 rice refills. Meal E: Stik-O Wafer Rolls 6 sticks, SkyFlakes Crackers 2 packets, Koko Crunch Cereal 1 serving.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  167.8, 9.22, 24.27, 3.76, 0, 0, true, null, 1, 50, 50);

-- ========================= NO-COOK (CUTTING) =============================

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1000 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 2 whole, Canned Sardines (Young''s Town) 1 can. Meal B: Canned Tuna in Water (Century) 2 cans, Tomato 1 small. Meal C: Whey 1.5 scoops. Meal D: Black Forest Bread (Gardenia) 2 slices, Eggs (1 whole/2 white).',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  139.2, 21.49, 5.51, 3.46, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1000 kcal (Plan 2)',
  'Meal A: Egg Whites (boiled) 5 pcs, Canned Tuna in Water 1 can, Pandesal 1 pc. Meal B: Chicken (white meat, Chooks-To-Go) 1 breast, Tomato 1 small, Cucumber 1 cup slices. Meal C: Whey 1.5 scoops. Meal D: Chicken (dark meat) 2 pcs, Tomato 1 small, Cucumber 1 cup slices.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  101.7, 15.72, 4.70, 2.22, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1000 kcal (Plan 3)',
  'Meal A: Canned Tuna in Water 1 can, Canned Sardines 1 can, Cucumber 1 cup slices. Meal B: Subway Roasted Chicken Sub 6" Wheat, Whey 1 scoop. Meal C: Eggs (1 whole/1 white), Canned Sardines 1 can, Cucumber 1 cup slices. Meal D: Canned Tuna (Gold Seas) 1 can.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  109.6, 16.49, 5.42, 2.44, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1300 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 2 whole. Meal B: Canned Tuna in Water 2 cans, Tomato 1 small, Cucumber 1 cup slices. Meal C: Whey 1 heaping scoop. Meal D: Mang Inasal PM2 (Single Rice) 1 order. Meal E: Siopao Pork Asado 1 pc.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  132.4, 16.76, 9.69, 2.96, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1300 kcal (Plan 2)',
  'Meal A: Eggs (1 whole/1 white), Canned Tuna in Oil 1 can. Meal B: Mang Inasal PM2 (Single Rice) 1 order. Meal C: Whey 1 scoop. Meal D: Canned Tuna (Gold Seas) 1 can, Tomato 1 small, Cucumber 1 cup slices. Meal E (Snack): Koko Crunch Cereal 1 serving (30g), Stik-O Wafer Rolls 4 sticks.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  138.2, 17.52, 10.62, 2.85, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1300 kcal (Plan 3)',
  'Meal A: Canned Tuna in Water 1 can, Cucumber 1 cup slices, Tomato 1 small. Meal B: Chicken (dark meat) 2 pcs, Tomato 1 small, Canned Tuna in Water 1 can, White Rice 170g. Meal C: Whey 1 heaping scoop. Meal D: Chicken (white meat) 1 breast, Tomato 1 small. Meal E (Snack): SkyFlakes Crackers 2 packets.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  117.8, 14.73, 8.65, 2.70, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1600 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 2 whole, White Rice 170g. Meal B: Canned Tuna in Oil 2 cans, Tomato 1 small, White Rice 170g. Meal C: Whey 1.5 scoops. Meal D: Mang Inasal PM2 (Single Rice) 1 order. Meal E: Stik-O Wafer Rolls 3 sticks.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  138.8, 14.02, 13.30, 3.28, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1600 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 2 whole, Canned Tuna in Water 1 can, Pandesal 1 pc. Meal B: Chicken (white meat) 1 breast, White Rice 170g. Meal C: Whey 1.5 scoops, Banana 1 small (100g). Meal D: Chicken (dark meat) 2 pcs, White Rice 170g. Meal E: Koko Crunch Cereal 1/2 serving.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  159.2, 16.26, 15.22, 3.70, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1600 kcal (Plan 3)',
  'Meal A: Canned Tuna in Oil 1 can, Whey 1 heaping scoop, Pandesal 1 pc. Meal B: Subway Roasted Chicken Sub 6" Wheat. Meal C: Whey 1 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 (Single Rice) 1 order. Meal E: SkyFlakes Crackers 1 packet (3 each).',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  176.6, 17.82, 16.67, 4.29, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1900 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 2 whole, White Rice 170g, Banana 1 small (100g). Meal B: Canned Tuna in Oil 2 cans, Tomato 1 small, White Rice 170g. Meal C: Whey 1 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 (Single Rice) 1 order. Meal E: Ice Cream (Selecta) 100g, Stik-O Wafer Rolls 3 sticks.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  129.9, 11.20, 14.82, 2.87, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1900 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 2 whole, Whey 1 heaping scoop, Wheat Bread 2 slices. Meal B: Chicken (dark meat) 2 pcs, Cucumber 1/2 cup, White Rice 170g. Meal C: Whey 1 heaping scoop, Banana 1 small (100g). Meal D: Chicken (white meat) 1 breast, Tomato 1 small, White Rice 170g. Meal E: Ice Cream (Selecta) 100g, SkyFlakes Crackers 2 packets.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  157.5, 13.93, 17.04, 3.74, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 1900 kcal (Plan 3)',
  'Meal A: Canned Tuna in Oil 1 can, White Rice 170g, Whey 1 scoop. Meal B: Subway Roasted Chicken Sub 6" Wheat, Banana 1 small (100g). Meal C: Whey 1 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 (Single Rice) 1 order. Meal E: SkyFlakes Crackers 2 packets.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  163.5, 14.73, 18.07, 3.59, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 2200 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 3 whole, White Rice 170g, Banana 1 small (100g). Meal B: Canned Tuna in Oil 2 cans, Tomato 1 small, White Rice 170g. Meal C: Whey 1 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 (Unli Rice) 1 order + 1 refill. Meal E: Siopao Pork Asado 1 pc.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  137.7, 11.00, 16.59, 3.03, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 2200 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 2 whole, Whey 1 heaping scoop, Wheat Bread 2 slices, Banana 1 small (100g). Meal B: Chicken (dark meat) 2 pcs, Cucumber 1/2 cup, White Rice 170g, Banana 1 small (100g). Meal C: Whey 1 scoop, Peanut Butter (Lily''s) 2 tbsp, Banana 1 small (100g). Meal D: Chicken (white meat) 1 breast, Tomato 1 small, White Rice 170g. Meal E: Ice Cream (Selecta) 200g, Koko Crunch Cereal 1 serving.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  142.7, 11.38, 16.90, 3.29, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 2200 kcal (Plan 3)',
  'Meal A: Canned Tuna in Oil 1 can, Whey 1 scoop, Pandesal 2 pcs, Banana 1 small (100g). Meal B: Subway Roasted Chicken Sub 6" Wheat, Banana 1 small (100g). Meal C: Whey 1 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 (Single Rice) 1 order. Meal E (Snack): Pandesal 1 pc, SkyFlakes Crackers 2 packets.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  183.7, 14.80, 21.61, 4.23, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 2500 kcal (Plan 1)',
  'Meal A: Eggs (boiled) 3 whole, White Rice 170g, Banana 1 small (100g). Meal B: Canned Tuna in Oil 2 cans, Tomato 1 small, White Rice 170g. Meal C: Whey 1 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 (Unli Rice) 1 order + 1 refill. Meal E: Siopao Pork Asado 1 pc, Stik-O Wafer Rolls 6 sticks.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  153.2, 11.11, 19.83, 3.27, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 2500 kcal (Plan 2)',
  'Meal A: Eggs (boiled) 2 whole, Whey 1 heaping scoop, Wheat Bread 2 slices, Banana 1 small (100g). Meal B: Chicken (dark meat) 2 pcs, Cucumber 1/2 cup, White Rice 170g, Banana 1 small (100g). Meal C: Whey 1 scoop, Peanut Butter (Lily''s) 2 tbsp, Banana 1 small (100g). Meal D: Chicken (white meat) 1 breast, Tomato 1 small, White Rice 170g. Meal E: Ice Cream (Selecta) 200g, Koko Crunch Cereal 1 serving.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  164.6, 11.83, 20.88, 3.75, 0, 0, true, null, 1, 50, 50);

select admin_upsert_prep_meal('WF-B932GB', 'EMA082801', null, 'full_meal',
  'No-Cook Cutting — 2500 kcal (Plan 3)',
  'Meal A: Canned Tuna in Oil 1 can, Whey 1 scoop, Pandesal 2 pcs, Banana 1 small (100g). Meal B: Subway Roasted Chicken Sub 6" Wheat, Banana 1 small (100g). Meal C: Whey 1 scoop, Banana 1 small (100g). Meal D: Mang Inasal PM2 (Single Rice) 1 order. Meal E (Snack): Pandesal 1 pc, SkyFlakes Crackers 2 packets.',
  'No-cook / ready-to-eat combo — no cooking required, just assemble as listed.',
  208.5, 14.88, 27.14, 4.49, 0, 0, true, null, 1, 50, 50);
