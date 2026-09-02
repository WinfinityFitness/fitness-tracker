-- Client Results Progress slideshow -- the right-hand card next to
-- Coaching Inquiry on winfinityfitness.com. Photos are publicly visible
-- (that's the whole point of a results showcase), but only the owner can
-- add or remove one, from a new "Client Results" tab in the Coach Portal.
--
-- Two ways for the owner to add a photo, both converge on the same
-- admin_add_client_result_photo RPC once a URL exists:
--   1. Upload a file -> goes to the client-results-photos storage bucket
--      (same public-bucket shape as chat-images/assessment-zips), then the
--      resulting public URL is passed to the RPC.
--   2. Paste an image URL hosted elsewhere -> passed to the RPC directly,
--      no storage bucket involved at all.

insert into storage.buckets (id, name, public)
values ('client-results-photos', 'client-results-photos', true)
on conflict (id) do nothing;

drop policy if exists "client result photos are publicly readable" on storage.objects;
create policy "client result photos are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'client-results-photos');

drop policy if exists "anyone can upload a client result photo" on storage.objects;
create policy "anyone can upload a client result photo"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'client-results-photos');

-- Tracking table -- zero anon policies/grants, only reachable through the
-- RPCs below (matches assessment_requests/coaching_inquiries's lockdown,
-- not the storage bucket's own permissive policies above).
create table if not exists client_results_photos (
  id bigint generated always as identity primary key,
  image_url text not null,
  caption text,
  created_at timestamptz not null default now()
);
alter table client_results_photos enable row level security;

-- Public slideshow read -- no admin credentials, this is meant to be seen.
create or replace function get_client_results_photos()
returns table (id bigint, image_url text, caption text)
language sql
security definer
set search_path = public
as $$
  select id, image_url, caption from client_results_photos order by id asc;
$$;
grant execute on function get_client_results_photos() to anon;

-- Owner adds a photo -- whether the URL came from a fresh upload to the
-- bucket above or was pasted in manually makes no difference here.
create or replace function admin_add_client_result_photo(
  p_admin_digital_id text, p_admin_password text, p_image_url text, p_caption text default null
) returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id bigint;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  if trim(coalesce(p_image_url, '')) = '' then
    raise exception 'Image URL is required';
  end if;

  insert into client_results_photos (image_url, caption)
  values (trim(p_image_url), nullif(trim(coalesce(p_caption, '')), ''))
  returning id into v_id;

  return v_id;
end;
$$;
grant execute on function admin_add_client_result_photo(text, text, text, text) to anon;

-- Owner removes a photo from the slideshow.
create or replace function admin_delete_client_result_photo(
  p_admin_digital_id text, p_admin_password text, p_id bigint
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  delete from client_results_photos where id = p_id;
end;
$$;
grant execute on function admin_delete_client_result_photo(text, text, bigint) to anon;

notify pgrst, 'reload schema';
