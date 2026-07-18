-- Denormalized code_name on feed_post_likes/feed_comment_likes, same
-- convention as feed_posts.code_name and chat_messages.code_name — lets
-- the "who reacted with what" popover show names without a join against
-- a private table. toggle_feed_post_like/toggle_feed_comment_like gain a
-- new p_code_name parameter; both are dropped first since a changed
-- argument count creates a new overload instead of replacing the
-- existing function (a plain `create or replace` would leave the old
-- 3-argument version lingering as an ambiguous duplicate).

alter table feed_post_likes add column if not exists code_name text;
alter table feed_comment_likes add column if not exists code_name text;

drop function if exists toggle_feed_post_like(bigint, uuid, text);
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

drop function if exists toggle_feed_comment_like(bigint, uuid, text);
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
