-- "My Day" Stories — Instagram/Facebook-style: a photo or short text that
-- disappears after 24 hours. Expiry is enforced right in the SELECT
-- policy itself (created_at >= now() - 24h), so an expired story simply
-- becomes invisible via RLS — no cleanup job needed. Same trust model as
-- everything else in Nexus: share_key identity, permissive insert,
-- ownership-checked unsend via RPC.

create table if not exists feed_stories (
  id bigint generated always as identity primary key,
  share_key uuid not null,
  code_name text not null,
  message text,
  image_url text,
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);
alter table feed_stories enable row level security;
create policy "Public read access to recent stories" on feed_stories
  for select using (created_at >= now() - interval '24 hours');
create policy "Public insert" on feed_stories
  for insert with check (coalesce(char_length(message), 0) <= 500);
-- No update/delete policy — unsend_feed_story() below, same pattern as posts.

create or replace function unsend_feed_story(p_story_id bigint, p_share_key uuid) returns void
language sql
security definer
as $$
  update feed_stories set deleted = true where id = p_story_id and share_key = p_share_key;
$$;
grant execute on function unsend_feed_story(bigint, uuid) to anon;
