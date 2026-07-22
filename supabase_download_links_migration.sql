-- Admin-editable download/launch links for the three apps (FT, Wellness,
-- Messenger), shown on the "Digital Arsenal" download section of
-- winfinityfitness.com (arsenal.html). Same pattern as the footer settings
-- feature: extends the single-row ad_settings table, write-gated behind
-- verify_admin_login, read directly via ad_settings' existing blanket anon
-- SELECT policy (no new RPC needed for the public read side).
alter table ad_settings add column if not exists download_url_ft text;
alter table ad_settings add column if not exists download_url_wellness text;
alter table ad_settings add column if not exists download_url_messenger text;

create or replace function admin_set_download_links(
  p_digital_id text, p_password text,
  p_ft_url text, p_wellness_url text, p_messenger_url text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update ad_settings set
    download_url_ft = nullif(trim(p_ft_url), ''),
    download_url_wellness = nullif(trim(p_wellness_url), ''),
    download_url_messenger = nullif(trim(p_messenger_url), ''),
    updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_download_links(text, text, text, text, text) to anon;

notify pgrst, 'reload schema';
