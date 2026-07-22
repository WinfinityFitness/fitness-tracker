-- Admin-editable footer content — tagline + the four footer links
-- (Webpage, Facebook, Instagram, Affiliate) — synced across FT, wellness,
-- and (once it gets a footer) Messenger, all reading the same single
-- global row instead of each surface having its own hardcoded copy.
-- Extends ad_settings (see supabase_ads_migration.sql), same single-row
-- global-settings table the "Force Updates" and Quick Log dial buttons
-- admin controls already live on.
--
-- Every field is nullable and cleared to null on a blank submission
-- (nullif(trim(...), '')) rather than an empty string — null means "fall
-- back to this app's own hardcoded default" client-side, so an admin can
-- edit just the tagline and leave the links alone, or clear one field
-- back to default without having to know/retype the original URL.
alter table ad_settings add column if not exists footer_tagline text;
alter table ad_settings add column if not exists footer_webpage_url text;
alter table ad_settings add column if not exists footer_facebook_url text;
alter table ad_settings add column if not exists footer_instagram_url text;
alter table ad_settings add column if not exists footer_affiliate_url text;

create or replace function admin_set_footer_settings(
  p_digital_id text, p_password text,
  p_tagline text, p_webpage_url text, p_facebook_url text, p_instagram_url text, p_affiliate_url text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update ad_settings set
    footer_tagline = nullif(trim(p_tagline), ''),
    footer_webpage_url = nullif(trim(p_webpage_url), ''),
    footer_facebook_url = nullif(trim(p_facebook_url), ''),
    footer_instagram_url = nullif(trim(p_instagram_url), ''),
    footer_affiliate_url = nullif(trim(p_affiliate_url), ''),
    updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_footer_settings(text, text, text, text, text, text, text) to anon;

notify pgrst, 'reload schema';
