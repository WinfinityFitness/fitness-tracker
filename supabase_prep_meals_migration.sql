-- Admin-configurable "Nutritional Synchronical" prep-meal menu on the
-- Nutrition tab: a community list of suggested meals (category, name,
-- ingredients, procedure, amount) whose grams/calories/macros are entered
-- once — by an admin OR by any regular user — as they'd be for a reference
-- 2000 kcal day, then scaled proportionally client-side for whichever
-- calorie target (400-3000) the viewing user picks.
--
-- Every row is visible to every user regardless of who authored it — same
-- "no real auth, self-reported" trust model as leaderboard/chat elsewhere
-- in this app. author_type/author_share_key/author_name exist purely for
-- the "prepared by Admin / by <name>" label and to let a regular user
-- edit or delete only their own submissions (admins can moderate any row).

create table if not exists prep_meals (
  id bigint generated always as identity primary key,
  category text not null default 'full_meal',
  name text not null,
  ingredients text not null,
  procedure text not null default '',
  ref_grams numeric not null default 0,
  ref_calories numeric not null default 0,
  ref_protein numeric not null default 0,
  ref_carbs numeric not null default 0,
  ref_fat numeric not null default 0,
  active boolean not null default true,
  author_type text not null default 'admin',
  author_share_key uuid,
  author_name text,
  created_at timestamptz not null default now(),
  constraint prep_meals_category_check check (category in ('breakfast', 'full_meal', 'snack')),
  constraint prep_meals_author_type_check check (author_type in ('admin', 'user'))
);
alter table prep_meals enable row level security;
create policy "anon read prep_meals" on prep_meals for select using (true);
-- No anon write policy — every insert/update/delete goes through the
-- SECURITY DEFINER functions below, admin-gated or ownership-gated.

create or replace function admin_upsert_prep_meal(
  p_digital_id text, p_password text,
  p_id bigint, p_category text, p_name text, p_ingredients text, p_procedure text,
  p_ref_grams numeric, p_ref_calories numeric, p_ref_protein numeric, p_ref_carbs numeric, p_ref_fat numeric,
  p_active boolean
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  if p_id is null then
    insert into prep_meals (category, name, ingredients, procedure, ref_grams, ref_calories, ref_protein, ref_carbs, ref_fat, active, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_ref_grams, p_ref_calories, p_ref_protein, p_ref_carbs, p_ref_fat, p_active, 'admin', null, null);
  else
    -- Deliberately leaves author_type/author_share_key/author_name untouched
    -- on update, so an admin correcting a user-submitted meal doesn't
    -- silently reassign its "prepared by" credit to Admin.
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        ref_grams = p_ref_grams, ref_calories = p_ref_calories,
        ref_protein = p_ref_protein, ref_carbs = p_ref_carbs, ref_fat = p_ref_fat,
        active = p_active
    where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_prep_meal(text, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric, boolean) to anon;

create or replace function admin_delete_prep_meal(p_digital_id text, p_password text, p_id bigint) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  delete from prep_meals where id = p_id;
end;
$$;
grant execute on function admin_delete_prep_meal(text, text, bigint) to anon;

-- p_id null = a regular user adding a brand-new meal (always saved active,
-- no moderation queue — same as everything else self-reported in this
-- app). p_id set = that same user editing one of their own past
-- submissions; silently no-ops (via "not found") if p_id belongs to
-- someone else or to an admin-authored row.
create or replace function user_upsert_prep_meal(
  p_share_key uuid, p_author_name text,
  p_id bigint, p_category text, p_name text, p_ingredients text, p_procedure text,
  p_ref_grams numeric, p_ref_calories numeric, p_ref_protein numeric, p_ref_carbs numeric, p_ref_fat numeric
) returns void
language plpgsql
security definer
as $$
begin
  if p_id is null then
    insert into prep_meals (category, name, ingredients, procedure, ref_grams, ref_calories, ref_protein, ref_carbs, ref_fat, active, author_type, author_share_key, author_name)
    values (p_category, p_name, p_ingredients, p_procedure, p_ref_grams, p_ref_calories, p_ref_protein, p_ref_carbs, p_ref_fat, true, 'user', p_share_key, p_author_name);
  else
    update prep_meals
    set category = p_category, name = p_name, ingredients = p_ingredients, procedure = p_procedure,
        ref_grams = p_ref_grams, ref_calories = p_ref_calories,
        ref_protein = p_ref_protein, ref_carbs = p_ref_carbs, ref_fat = p_ref_fat,
        author_name = p_author_name
    where id = p_id and author_type = 'user' and author_share_key = p_share_key;
  end if;
end;
$$;
grant execute on function user_upsert_prep_meal(uuid, text, bigint, text, text, text, text, numeric, numeric, numeric, numeric, numeric) to anon;

create or replace function user_delete_prep_meal(p_share_key uuid, p_id bigint) returns void
language plpgsql
security definer
as $$
begin
  delete from prep_meals where id = p_id and author_type = 'user' and author_share_key = p_share_key;
end;
$$;
grant execute on function user_delete_prep_meal(uuid, bigint) to anon;
