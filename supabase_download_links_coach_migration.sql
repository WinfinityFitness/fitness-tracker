-- Extends the download-links feature (supabase_download_links_migration.sql)
-- with a 4th app: Coach. Same pattern - single-row ad_settings column,
-- write-gated behind verify_admin_login via admin_set_download_links,
-- read directly via ad_settings' existing blanket anon SELECT policy.
--
-- admin_set_download_links changes from 5 args to 6 (adds p_coach_url), so
-- the old 5-arg version is dropped first the same way verify_admin_login's
-- signature change was handled in supabase_security_hardening_migration_2.sql.
alter table ad_settings add column if not exists download_url_coach text;

drop function if exists admin_set_download_links(text, text, text, text, text);

create or replace function admin_set_download_links(
  p_digital_id text, p_password text,
  p_ft_url text, p_wellness_url text, p_messenger_url text, p_coach_url text
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
    download_url_coach = nullif(trim(p_coach_url), ''),
    updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_download_links(text, text, text, text, text, text) to anon;

notify pgrst, 'reload schema';
