-- Admin-configurable "Media Synchronizer" widget on the Nutrition tab: a
-- single image or an auto-cycling slideshow, admin-managed via the Media
-- Core Calibration modal (gear icon on the widget, admin-only). One global
-- singleton row — every user sees the same media, same as ad_settings.

create table if not exists media_sync_settings (
  id int primary key default 1,
  mode text not null default 'still',
  image_urls jsonb not null default '[]'::jsonb,
  duration_sec int not null default 10,
  updated_at timestamptz not null default now(),
  constraint media_sync_settings_single_row check (id = 1),
  constraint media_sync_settings_mode_check check (mode in ('still', 'slideshow'))
);
insert into media_sync_settings (id, mode, image_urls, duration_sec) values (1, 'still', '[]'::jsonb, 10) on conflict (id) do nothing;
alter table media_sync_settings enable row level security;
create policy "anon read media_sync_settings" on media_sync_settings for select using (true);
-- No anon write policy — only admin_set_media_sync() below can change it.

create or replace function admin_set_media_sync(
  p_digital_id text, p_password text,
  p_mode text, p_image_urls jsonb, p_duration_sec int
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update media_sync_settings
  set mode = p_mode,
      image_urls = p_image_urls,
      duration_sec = greatest(3, least(60, p_duration_sec)),
      updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_media_sync(text, text, text, jsonb, int) to anon;
