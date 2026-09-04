-- Admin-editable footer link lists -- Affiliate, Careers, Team, and
-- Contact Us all become the same thing: a tap on the footer opens a
-- popup listing admin-managed entries (icon + name, linking out), instead
-- of Affiliate being a single hardcoded URL and Team/Careers being
-- non-clickable placeholders. One shared table + RPC set for all four
-- categories rather than four near-duplicate tables.
--
-- Logos: same two-path pattern as client_results_photos -- upload a file
-- (goes to the footer-link-logos bucket) or paste an image URL hosted
-- elsewhere, either way the RPC just receives a URL. logo_url is
-- nullable: a link with no icon still renders, just without one.

insert into storage.buckets (id, name, public)
values ('footer-link-logos', 'footer-link-logos', true)
on conflict (id) do nothing;

drop policy if exists "footer link logos are publicly readable" on storage.objects;
create policy "footer link logos are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'footer-link-logos');

drop policy if exists "anyone can upload a footer link logo" on storage.objects;
create policy "anyone can upload a footer link logo"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'footer-link-logos');

-- Tracking table -- zero anon policies/grants, only reachable through the
-- RPCs below (matches client_results_photos/coaching_inquiries's lockdown).
create table if not exists footer_links (
  id bigint generated always as identity primary key,
  category text not null check (category in ('affiliate', 'careers', 'team', 'contact')),
  name text not null,
  url text not null,
  logo_url text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table footer_links enable row level security;
create index if not exists footer_links_category_idx on footer_links (category, sort_order, id);

-- Public read for whichever category's popup is open -- no admin
-- credentials, this is meant to be seen by every site visitor.
create or replace function get_footer_links(p_category text)
returns table (id bigint, name text, url text, logo_url text)
language sql
security definer
set search_path = public
as $$
  select id, name, url, logo_url
  from footer_links
  where category = p_category
  order by sort_order asc, id asc;
$$;
grant execute on function get_footer_links(text) to anon;

-- Owner adds a link to one of the four categories.
create or replace function admin_add_footer_link(
  p_admin_digital_id text, p_admin_password text,
  p_category text, p_name text, p_url text, p_logo_url text default null
) returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id bigint;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  if p_category not in ('affiliate', 'careers', 'team', 'contact') then
    raise exception 'Invalid category';
  end if;
  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Name is required';
  end if;
  if trim(coalesce(p_url, '')) = '' then
    raise exception 'Link URL is required';
  end if;

  insert into footer_links (category, name, url, logo_url, sort_order)
  values (
    p_category, trim(p_name), trim(p_url), nullif(trim(coalesce(p_logo_url, '')), ''),
    coalesce((select max(sort_order) + 1 from footer_links where category = p_category), 0)
  )
  returning id into v_id;

  return v_id;
end;
$$;
grant execute on function admin_add_footer_link(text, text, text, text, text, text) to anon;

-- Owner edits an existing link (name/url/logo only -- category and
-- ordering don't change via this call).
create or replace function admin_update_footer_link(
  p_admin_digital_id text, p_admin_password text,
  p_id bigint, p_name text, p_url text, p_logo_url text default null
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Name is required';
  end if;
  if trim(coalesce(p_url, '')) = '' then
    raise exception 'Link URL is required';
  end if;

  update footer_links
  set name = trim(p_name),
      url = trim(p_url),
      logo_url = nullif(trim(coalesce(p_logo_url, '')), '')
  where id = p_id;
end;
$$;
grant execute on function admin_update_footer_link(text, text, bigint, text, text, text) to anon;

-- Owner removes a link.
create or replace function admin_delete_footer_link(
  p_admin_digital_id text, p_admin_password text, p_id bigint
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  delete from footer_links where id = p_id;
end;
$$;
grant execute on function admin_delete_footer_link(text, text, bigint) to anon;

notify pgrst, 'reload schema';
