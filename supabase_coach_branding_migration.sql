-- Coach white-label tenancy — Phase B (branding resolution). Adds a
-- per-coach splash-logo config (parallel to app_splash_settings, not a
-- modification of it -- that table's own RPC still uses the pre-existing
-- hardcoded-credential pattern rather than verify_admin_login, not worth
-- touching) and the one PUBLIC lookup this whole feature needs: resolving
-- a subdomain slug to a coach's brand, reachable by anyone (a visitor on
-- a coach's subdomain hasn't necessarily attached as a client yet, or may
-- never have an account at all) without any credentials.
--
-- This is the "2nd splash" per the owner's own framing -- the in-page
-- logo+text screen the web app shows while loading, separate from the
-- native Android boot splash (baked into the APK, stays Winfinity-branded
-- for every coach, out of scope here per the plan's native-Android
-- decision).

create table if not exists coach_splash_settings (
  coach_id uuid primary key references coaches(id) on delete cascade,
  splash_image_url text,
  splash_image_zoom numeric not null default 1,
  splash_image_pos_x numeric not null default 50,
  splash_image_pos_y numeric not null default 50,
  updated_at timestamptz not null default now()
);
alter table coach_splash_settings enable row level security;
-- zero anon policies -- matches coaches/coach_clients' lockdown. Reachable
-- only through coach_set_splash_image (coach-scoped write) and
-- get_coach_branding_by_slug (public read, joined against coaches) below.

create or replace function coach_set_splash_image(
  p_coach_digital_id text, p_coach_password text, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  insert into coach_splash_settings (coach_id, splash_image_url, splash_image_zoom, splash_image_pos_x, splash_image_pos_y)
  values (
    v_coach_id, nullif(p_image_url, ''),
    greatest(1, least(3, coalesce(p_image_zoom, 1))),
    greatest(0, least(100, coalesce(p_image_pos_x, 50))),
    greatest(0, least(100, coalesce(p_image_pos_y, 50)))
  )
  on conflict (coach_id) do update set
    splash_image_url = excluded.splash_image_url,
    splash_image_zoom = excluded.splash_image_zoom,
    splash_image_pos_x = excluded.splash_image_pos_x,
    splash_image_pos_y = excluded.splash_image_pos_y,
    updated_at = now();
end;
$$;
grant execute on function coach_set_splash_image(text, text, text, numeric, numeric, numeric) to anon;

-- Public, no credentials -- a subdomain visitor needs to see the coach's
-- brand (name/logo/colors/splash) before they necessarily have an account
-- or are attached as a client at all. Only returns rows for active coaches;
-- an inactive/unknown slug returns zero rows, and callers (the PHP proxy,
-- index.html, app.js) all fall back to default Winfinity branding on that.
create or replace function get_coach_branding_by_slug(p_slug text)
returns table (
  brand_name text, brand_logo_url text, brand_color_primary text, brand_color_accent text,
  splash_image_url text, splash_image_zoom numeric, splash_image_pos_x numeric, splash_image_pos_y numeric
)
language plpgsql
security definer
as $$
begin
  return query
    select c.brand_name, c.brand_logo_url, c.brand_color_primary, c.brand_color_accent,
      s.splash_image_url, s.splash_image_zoom, s.splash_image_pos_x, s.splash_image_pos_y
    from coaches c
    left join coach_splash_settings s on s.coach_id = c.id
    where c.slug = lower(trim(p_slug)) and c.active;
end;
$$;
grant execute on function get_coach_branding_by_slug(text) to anon;

notify pgrst, 'reload schema';
