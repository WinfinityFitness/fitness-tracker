-- Extends footer_links (see supabase_footer_links_migration.sql, which
-- already had 'affiliate'/'careers'/'team'/'contact') with three new
-- categories -- 'website', 'facebook', 'instagram' -- to replace the old
-- fixed single-URL ad_settings fields (footer_webpage_url etc., see
-- supabase_footer_settings_migration.sql) with the same open-ended
-- admin-managed {name, url} list + popup-on-tap pattern already used for
-- Team/Affiliate/Careers/Contact Us. Those old ad_settings columns are
-- left in place (harmless, just no longer written to) rather than
-- dropped, to avoid touching data other code might still read.
--
-- Affiliate itself was ALSO previously bundled into a single 'social'
-- category alongside Website/Facebook/Instagram during this same day's
-- work, then split back out again once it became clear each of Website/
-- Facebook/Instagram/Affiliate/Team/Careers/Contact Us should be its own
-- independent popup+editor (matching what the public website's
-- footer-embed.html + Coach Portal's "Footer Links" tab already expected
-- for Team/Affiliate/Careers/Contact Us) -- 'social' is NOT used anywhere
-- in the app/website code as of this migration and does not need to be
-- in the category list.

alter table footer_links drop constraint if exists footer_links_category_check;
alter table footer_links add constraint footer_links_category_check
  check (category in ('affiliate', 'careers', 'team', 'contact', 'website', 'facebook', 'instagram'));

-- Replace-all RPC, same convenience pattern as admin_set_ai_keys (see
-- supabase_ai_key_rotation_migration.sql) — the admin editor sends the
-- full current list on every save rather than diffing adds/edits/removes
-- against individual admin_add/update/delete_footer_link calls. Coach
-- Portal's existing Footer Links tab still uses the older per-item
-- admin_add/update/delete_footer_link RPCs from supabase_footer_links_
-- migration.sql -- both write to the same table, so either admin surface
-- sees the other's changes via get_footer_links, no conflict.
create or replace function admin_set_footer_links(
  p_admin_digital_id text, p_admin_password text,
  p_category text, p_links jsonb
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_link jsonb;
  v_order int := 0;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  if p_category not in ('affiliate', 'careers', 'team', 'contact', 'website', 'facebook', 'instagram') then
    raise exception 'Invalid category';
  end if;

  delete from footer_links where category = p_category;

  for v_link in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb))
  loop
    if trim(coalesce(v_link->>'name', '')) = '' or trim(coalesce(v_link->>'url', '')) = '' then
      continue;
    end if;
    insert into footer_links (category, name, url, logo_url, sort_order)
    values (
      p_category, trim(v_link->>'name'), trim(v_link->>'url'),
      nullif(trim(coalesce(v_link->>'logo_url', '')), ''),
      v_order
    );
    v_order := v_order + 1;
  end loop;
end;
$$;
grant execute on function admin_set_footer_links(text, text, text, jsonb) to anon;

-- Seed website/facebook/instagram/affiliate/contact with the app's
-- current hardcoded defaults so those popups aren't empty on first load
-- (Team/Careers had no real URL before -- just non-clickable placeholders
-- -- so nothing to seed there; they start genuinely empty until an admin
-- adds entries). Only runs if nothing's been saved in that category yet
-- (safe to re-run this migration without duplicating). Contact Us's
-- three messaging entries use real deep-link URLs (viber://, wa.me,
-- t.me) instead of bare phone numbers so they're actually tappable here,
-- matching how the website's Contact Us popup already renders every
-- entry as a clickable link.
insert into footer_links (category, name, url, sort_order)
select v.category, v.name, v.url, v.sort_order
from (values
  ('website', 'Website', 'https://winfinityfitness.com', 0),
  ('facebook', 'Facebook', 'https://www.facebook.com/winfinityfit/', 0),
  ('instagram', 'Instagram', 'https://www.instagram.com/windalchamp/', 0),
  ('affiliate', 'Affiliate', 'http://www.facebook.com/aldruz3dsign', 0),
  ('contact', 'Viber', 'viber://chat?number=%2B639153703821', 0),
  ('contact', 'WhatsApp', 'https://wa.me/639153703821', 1),
  ('contact', 'Telegram', 'https://t.me/+639153703821', 2),
  ('contact', 'Email', 'mailto:winfinityfitness@gmail.com', 3)
) as v(category, name, url, sort_order)
where not exists (select 1 from footer_links where category = v.category);

notify pgrst, 'reload schema';
