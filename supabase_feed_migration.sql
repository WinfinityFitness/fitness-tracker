-- Nexus Feed: the desktop dashboard's Facebook-style center column. Same
-- trust model as the existing public chat (chat_messages/chat_rooms) —
-- share_key is the identity anchor, posting/commenting go through plain
-- permissive INSERT policies (no real per-user auth exists anywhere in
-- this app), and only the toggle-y/ownership-checked actions (liking,
-- unsending your own post/comment) go through SECURITY DEFINER RPCs,
-- mirroring set_chat_reaction/unsend_chat_message exactly.

create table if not exists feed_posts (
  id bigint generated always as identity primary key,
  share_key uuid not null,
  code_name text not null,
  message text not null default '',
  image_url text,
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);
alter table feed_posts enable row level security;
create policy "Public read access" on feed_posts for select using (true);
create policy "Public insert" on feed_posts for insert with check (char_length(message) <= 2000);
-- No update/delete policy — unsending your own post goes through
-- unsend_feed_post() below, same as chat's unsend_chat_message.

create table if not exists feed_post_likes (
  post_id bigint not null references feed_posts(id) on delete cascade,
  share_key uuid not null,
  created_at timestamptz not null default now(),
  primary key (post_id, share_key)
);
alter table feed_post_likes enable row level security;
create policy "Public read access" on feed_post_likes for select using (true);
-- No direct write policy — likes are toggled through toggle_feed_post_like()
-- below (an RPC, not a plain insert policy, because "like if not already
-- liked, otherwise unlike" needs an atomic check-then-act that a client
-- issuing its own insert/delete can't safely do without a race).

create table if not exists feed_post_comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references feed_posts(id) on delete cascade,
  share_key uuid not null,
  code_name text not null,
  message text not null,
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);
alter table feed_post_comments enable row level security;
create policy "Public read access" on feed_post_comments for select using (true);
create policy "Public insert" on feed_post_comments for insert with check (char_length(message) > 0 and char_length(message) <= 500);
-- No update/delete policy — unsend_feed_comment() below, same pattern.

create or replace function toggle_feed_post_like(p_post_id bigint, p_share_key uuid) returns boolean
language plpgsql
security definer
as $$
declare
  liked boolean;
begin
  if exists (select 1 from feed_post_likes where post_id = p_post_id and share_key = p_share_key) then
    delete from feed_post_likes where post_id = p_post_id and share_key = p_share_key;
    liked := false;
  else
    insert into feed_post_likes (post_id, share_key) values (p_post_id, p_share_key);
    liked := true;
  end if;
  return liked;
end;
$$;
grant execute on function toggle_feed_post_like(bigint, uuid) to anon;

create or replace function unsend_feed_post(p_post_id bigint, p_share_key uuid) returns void
language sql
security definer
as $$
  update feed_posts set deleted = true where id = p_post_id and share_key = p_share_key;
$$;
grant execute on function unsend_feed_post(bigint, uuid) to anon;

create or replace function unsend_feed_comment(p_comment_id bigint, p_share_key uuid) returns void
language sql
security definer
as $$
  update feed_post_comments set deleted = true where id = p_comment_id and share_key = p_share_key;
$$;
grant execute on function unsend_feed_comment(bigint, uuid) to anon;

-- Addendum: stores the fetched Open Graph preview (title/description/image)
-- at post time, via the new link-preview Edge Function, so a post's link
-- card doesn't need to be re-fetched (and can't silently change) every time
-- it's viewed.
alter table feed_posts add column if not exists link_preview jsonb;
