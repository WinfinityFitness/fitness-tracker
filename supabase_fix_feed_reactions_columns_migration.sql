-- Full self-contained repair for feed reactions. Root cause: the very
-- first reactions migration (supabase_feed_reactions_migration.sql, run
-- much earlier this session) apparently never actually committed —
-- same silent-rollback pattern later found with feed_comment_likes —
-- so feed_post_likes never actually got its `emoji` column, even though
-- toggle_feed_post_like's body has been doing `select emoji from
-- feed_post_likes` ever since. This adds every column either migration
-- was supposed to add (all `if not exists`, so harmless if already
-- present), and drops every historical signature of both toggle
-- functions before recreating the current 4-argument version, so there
-- is no ambiguous leftover overload no matter which of the earlier
-- attempts actually stuck.

alter table feed_post_likes add column if not exists emoji text not null default '👍';
alter table feed_post_likes add column if not exists code_name text;

create table if not exists feed_comment_likes (
  comment_id bigint not null references feed_post_comments(id) on delete cascade,
  share_key uuid not null,
  emoji text not null default '👍',
  created_at timestamptz not null default now(),
  primary key (comment_id, share_key)
);
alter table feed_comment_likes enable row level security;
drop policy if exists "Public read access" on feed_comment_likes;
create policy "Public read access" on feed_comment_likes for select using (true);
alter table feed_comment_likes add column if not exists emoji text not null default '👍';
alter table feed_comment_likes add column if not exists code_name text;

drop function if exists toggle_feed_post_like(bigint, uuid);
drop function if exists toggle_feed_post_like(bigint, uuid, text);
drop function if exists toggle_feed_post_like(bigint, uuid, text, text);
create or replace function toggle_feed_post_like(p_post_id bigint, p_share_key uuid, p_emoji text default '👍', p_code_name text default null) returns boolean
language plpgsql
security definer
as $$
declare
  existing text;
  liked boolean;
begin
  select emoji into existing from feed_post_likes where post_id = p_post_id and share_key = p_share_key;
  if existing is null then
    insert into feed_post_likes (post_id, share_key, emoji, code_name) values (p_post_id, p_share_key, p_emoji, p_code_name);
    liked := true;
  elsif existing = p_emoji then
    delete from feed_post_likes where post_id = p_post_id and share_key = p_share_key;
    liked := false;
  else
    update feed_post_likes set emoji = p_emoji, code_name = coalesce(p_code_name, code_name) where post_id = p_post_id and share_key = p_share_key;
    liked := true;
  end if;
  return liked;
end;
$$;
grant execute on function toggle_feed_post_like(bigint, uuid, text, text) to anon;

drop function if exists toggle_feed_comment_like(bigint, uuid);
drop function if exists toggle_feed_comment_like(bigint, uuid, text);
drop function if exists toggle_feed_comment_like(bigint, uuid, text, text);
create or replace function toggle_feed_comment_like(p_comment_id bigint, p_share_key uuid, p_emoji text default '👍', p_code_name text default null) returns boolean
language plpgsql
security definer
as $$
declare
  existing text;
  liked boolean;
begin
  select emoji into existing from feed_comment_likes where comment_id = p_comment_id and share_key = p_share_key;
  if existing is null then
    insert into feed_comment_likes (comment_id, share_key, emoji, code_name) values (p_comment_id, p_share_key, p_emoji, p_code_name);
    liked := true;
  elsif existing = p_emoji then
    delete from feed_comment_likes where comment_id = p_comment_id and share_key = p_share_key;
    liked := false;
  else
    update feed_comment_likes set emoji = p_emoji, code_name = coalesce(p_code_name, code_name) where comment_id = p_comment_id and share_key = p_share_key;
    liked := true;
  end if;
  return liked;
end;
$$;
grant execute on function toggle_feed_comment_like(bigint, uuid, text, text) to anon;

notify pgrst, 'reload schema';
