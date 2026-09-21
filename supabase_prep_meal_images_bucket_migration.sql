-- Storage bucket backing the new "Choose from gallery" / Ctrl+V paste
-- upload option in the Prep Meal editor (uploadPrepMealImage in app.js).
-- Same fully-open bucket pattern as chat-images/assessment-zips
-- elsewhere in this app -- the admin gate is client-side only (there's no
-- server-side admin check on storage uploads anywhere in this app), so
-- this doesn't weaken anything that wasn't already this permissive.

insert into storage.buckets (id, name, public)
values ('prep-meal-images', 'prep-meal-images', true)
on conflict (id) do nothing;

drop policy if exists "prep meal images are publicly readable" on storage.objects;
create policy "prep meal images are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'prep-meal-images');

drop policy if exists "anyone can upload a prep meal image" on storage.objects;
create policy "anyone can upload a prep meal image"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'prep-meal-images');
