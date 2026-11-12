-- Admin: per-tile background images -- a launcher grid tile's thumbnail
-- AND (for the 6 tiles that are real tabs: status/training/nutrition/bio/
-- leaderboard/menu) that tab's own hero banner, both set from one image
-- per tile id. Extends ad_settings, the same single-row global-settings
-- table footer_settings/updates_enabled/the Quick Log dial buttons admin
-- controls already live on (see supabase_footer_settings_migration.sql) --
-- read via the SAME cached fetchAdSettings() call every client already
-- makes on boot, so this adds zero extra network round trips.
--
-- A single jsonb map (tile_id -> image url) rather than one column per
-- tile: there are 12 fixed tile ids today, but this way adding a 13th
-- later needs no migration, and the read/write code stays generic instead
-- of one near-identical branch per tile.
alter table ad_settings add column if not exists tile_images jsonb not null default '{}'::jsonb;

-- p_image_url null (or blank) clears that tile back to the plain default
-- look, same "null/blank means fall back to default" convention
-- admin_set_footer_settings already uses.
create or replace function admin_set_tile_image(p_digital_id text, p_password text, p_tile_id text, p_image_url text) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  if p_tile_id is null or trim(p_tile_id) = '' then
    raise exception 'Missing tile id';
  end if;
  if p_image_url is null or trim(p_image_url) = '' then
    update ad_settings set tile_images = tile_images - p_tile_id, updated_at = now() where id = 1;
  else
    update ad_settings set tile_images = jsonb_set(tile_images, array[p_tile_id], to_jsonb(p_image_url), true), updated_at = now() where id = 1;
  end if;
end;
$$;
grant execute on function admin_set_tile_image(text, text, text, text) to anon;

notify pgrst, 'reload schema';
