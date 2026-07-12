-- Startup ad splash: global on/off switch, admin-managed product list, and
-- per-user (per Digital ID) temporary ad-free grants. Same admin credential
-- pattern as supabase_announcement_migration.sql (hardcoded inside
-- SECURITY DEFINER functions, never shipped to the client).
--
-- Three independent pieces:
--   1. ad_settings — one global row: are ads on at all right now? Applies
--      to EVERY user regardless of whether they've ever synced to Nexus —
--      this is the "I don't have an affiliate link yet, pause everything"
--      switch.
--   2. ad_products — the admin-editable list of banners shown in the
--      splash (name, image, link). Editable from the new admin widget on
--      the Nexus tab — no code redeploy needed to add/change/remove one.
--   3. leaderboard.ad_free_until — a per-user temporary grant (e.g. after
--      manually confirming a GCash donation). Only meaningful for users who
--      have a leaderboard row at all, i.e. have synced to Nexus with
--      "Share my progress" on at least once — there's no way to target an
--      ad override at someone who's never shared a Digital ID with you.

create table if not exists ad_settings (
  id int primary key default 1,
  ads_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint ad_settings_single_row check (id = 1)
);
insert into ad_settings (id, ads_enabled) values (1, true) on conflict (id) do nothing;
alter table ad_settings enable row level security;
create policy "anon read ad_settings" on ad_settings for select using (true);
-- No anon write policy — only admin_set_ads_enabled() below can change it.

create table if not exists ad_products (
  id bigint generated always as identity primary key,
  name text not null,
  image_url text not null,
  link_url text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table ad_products enable row level security;
create policy "anon read ad_products" on ad_products for select using (true);
-- No anon write policy — only the admin_*_ad_product() functions below can
-- insert/update/delete.

alter table leaderboard add column if not exists ad_free_until timestamptz;

create or replace function admin_set_ads_enabled(p_digital_id text, p_password text, p_enabled boolean) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update ad_settings set ads_enabled = p_enabled, updated_at = now() where id = 1;
end;
$$;
grant execute on function admin_set_ads_enabled(text, text, boolean) to anon;

-- p_id null = insert a new product; p_id set = update that existing one.
create or replace function admin_upsert_ad_product(
  p_digital_id text, p_password text,
  p_id bigint, p_name text, p_image_url text, p_link_url text, p_active boolean
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  if p_id is null then
    insert into ad_products (name, image_url, link_url, active) values (p_name, p_image_url, p_link_url, p_active);
  else
    update ad_products set name = p_name, image_url = p_image_url, link_url = p_link_url, active = p_active where id = p_id;
  end if;
end;
$$;
grant execute on function admin_upsert_ad_product(text, text, bigint, text, text, text, boolean) to anon;

create or replace function admin_delete_ad_product(p_digital_id text, p_password text, p_id bigint) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  delete from ad_products where id = p_id;
end;
$$;
grant execute on function admin_delete_ad_product(text, text, bigint) to anon;

create or replace function admin_grant_ad_free(p_digital_id text, p_password text, p_target_public_id text, p_hours int) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update leaderboard set ad_free_until = now() + (greatest(1, p_hours) || ' hours')::interval where public_id = p_target_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
end;
$$;
grant execute on function admin_grant_ad_free(text, text, text, int) to anon;

create or replace function admin_revoke_ad_free(p_digital_id text, p_password text, p_target_public_id text) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update leaderboard set ad_free_until = null where public_id = p_target_public_id;
end;
$$;
grant execute on function admin_revoke_ad_free(text, text, text) to anon;
