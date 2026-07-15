-- Admin-configurable app boot logo (the "stage 2" splash — the smaller
-- logo+text screen shown by the web app itself while it loads, as opposed
-- to the big logo flashed natively by the Android APK before the WebView
-- even starts, which is baked into the app and can't change without a
-- rebuild). One global singleton row, same pattern as media_sync_settings.
-- Zoom/position mirror prep_meals' image framing (image_zoom/pos_x/pos_y).

create table if not exists app_splash_settings (
  id int primary key default 1,
  splash_image_url text,
  splash_image_zoom numeric not null default 1,
  splash_image_pos_x numeric not null default 50,
  splash_image_pos_y numeric not null default 50,
  updated_at timestamptz not null default now(),
  constraint app_splash_settings_single_row check (id = 1)
);
insert into app_splash_settings (id, splash_image_url) values (1, null) on conflict (id) do nothing;
alter table app_splash_settings enable row level security;
drop policy if exists "anon read app_splash_settings" on app_splash_settings;
create policy "anon read app_splash_settings" on app_splash_settings for select using (true);
-- No anon write policy — only admin_set_splash_image() below can change it.

create or replace function admin_set_splash_image(
  p_digital_id text, p_password text, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update app_splash_settings
  set splash_image_url = nullif(p_image_url, ''),
      splash_image_zoom = greatest(1, least(3, coalesce(p_image_zoom, 1))),
      splash_image_pos_x = greatest(0, least(100, coalesce(p_image_pos_x, 50))),
      splash_image_pos_y = greatest(0, least(100, coalesce(p_image_pos_y, 50))),
      updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_splash_image(text, text, text, numeric, numeric, numeric) to anon;
