-- Extends footer_links (see supabase_footer_links_migration.sql) with a
-- 'social' category to replace the old fixed Webpage/Facebook/Instagram
-- single-URL fields (ad_settings.footer_webpage_url etc., see
-- supabase_footer_settings_migration.sql) with an open-ended admin-managed
-- list of {name, url} links, same popup-on-tap pattern as Contact Us.
-- Those old ad_settings columns are left in place (harmless, just no
-- longer written to) rather than dropped, to avoid touching data other
-- code might still read during rollout.
--
-- Affiliate itself moves OUT of Social and becomes its own footer_links
-- category (the 'affiliate' category already existed in the schema from
-- supabase_footer_links_migration.sql, just never had a live UI wired up
-- to it until now) -- Team and Careers get the same popup+editor
-- treatment, replacing their old non-clickable placeholders.

alter table footer_links drop constraint if exists footer_links_category_check;
alter table footer_links add constraint footer_links_category_check
  check (category in ('affiliate', 'careers', 'team', 'contact', 'social'));

-- Replace-all RPC, same convenience pattern as admin_set_ai_keys (see
-- supabase_ai_key_rotation_migration.sql) — the admin editor sends the
-- full current list on every save rather than diffing adds/edits/removes
-- against individual admin_add/update/delete_footer_link calls.
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

  if p_category not in ('affiliate', 'careers', 'team', 'contact', 'social') then
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

-- Seed 'social' and 'affiliate' with the app's current hardcoded defaults
-- so those two popups aren't empty on first load (Team/Careers had no
-- real URL before -- just non-clickable placeholders -- so nothing to
-- seed there; they start genuinely empty until an admin adds entries).
-- Only runs if nothing's been saved there yet (safe to re-run this
-- migration without duplicating).
insert into footer_links (category, name, url, sort_order)
select 'social', v.name, v.url, v.sort_order
from (values
  ('Webpage', 'https://winfinityfitness.com', 0),
  ('Facebook', 'https://www.facebook.com/winfinityfit/', 1),
  ('Instagram', 'https://www.instagram.com/windalchamp/', 2)
) as v(name, url, sort_order)
where not exists (select 1 from footer_links where category = 'social');

insert into footer_links (category, name, url, sort_order)
select 'affiliate', 'Affiliate', 'http://www.facebook.com/aldruz3dsign', 0
where not exists (select 1 from footer_links where category = 'affiliate');

notify pgrst, 'reload schema';
