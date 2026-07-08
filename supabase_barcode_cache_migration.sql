-- Self-learning barcode -> nutrition cache.
-- Open Food Facts has thin coverage for Philippine local/imported goods, so
-- when a scan comes up empty, the app lets the user fill it in once and the
-- entry gets saved here — checked first on every future scan, by everyone.

create table if not exists public.barcode_products (
  code text primary key,
  name text not null,
  brands text,
  calories numeric not null default 0,
  protein numeric not null default 0,
  carbs numeric not null default 0,
  fat numeric not null default 0,
  fiber numeric not null default 0,
  sodium numeric not null default 0,
  contributed_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.barcode_products enable row level security;

drop policy if exists "barcode_products_select_all" on public.barcode_products;
create policy "barcode_products_select_all" on public.barcode_products
  for select using (true);

create or replace function public.contribute_barcode_product(
  p_code text,
  p_name text,
  p_brands text,
  p_calories numeric,
  p_protein numeric,
  p_carbs numeric,
  p_fat numeric,
  p_fiber numeric,
  p_sodium numeric,
  p_contributed_by_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.barcode_products
    (code, name, brands, calories, protein, carbs, fat, fiber, sodium, contributed_by_name, updated_at)
  values
    (p_code, p_name, p_brands, p_calories, p_protein, p_carbs, p_fat, p_fiber, p_sodium, p_contributed_by_name, now())
  on conflict (code) do update set
    name = excluded.name,
    brands = excluded.brands,
    calories = excluded.calories,
    protein = excluded.protein,
    carbs = excluded.carbs,
    fat = excluded.fat,
    fiber = excluded.fiber,
    sodium = excluded.sodium,
    contributed_by_name = excluded.contributed_by_name,
    updated_at = now();
end;
$$;

grant execute on function public.contribute_barcode_product(
  text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, text
) to anon;
