-- Facebook-style multi-emoji reactions for feed posts AND comments,
-- replacing the single "Cheer" like toggle. Mirrors the existing chat
-- reaction system (chat_message_reactions / set_chat_reaction) — same
-- QUICK_REACTIONS emoji set, same "pick one reaction per item, tap the
-- same one again to remove it, tap a different one to switch" semantics.

alter table feed_post_likes add column if not exists emoji text not null default '👍';

create table if not exists feed_comment_likes (
  comment_id bigint not null references feed_post_comments(id) on delete cascade,
  share_key uuid not null,
  emoji text not null default '👍',
  created_at timestamptz not null default now(),
  primary key (comment_id, share_key)
);
alter table feed_comment_likes enable row level security;
create policy "Public read access" on feed_comment_likes for select using (true);
-- No direct write policy — toggled through toggle_feed_comment_like() below,
-- same convention as toggle_feed_post_like/set_chat_reaction.

-- Signature is changing (adding p_emoji), so the old 2-arg version is
-- dropped first rather than left to linger as a separate overload.
drop function if exists toggle_feed_post_like(bigint, uuid);
create or replace function toggle_feed_post_like(p_post_id bigint, p_share_key uuid, p_emoji text default '👍') returns boolean
language plpgsql
security definer
as $$
declare
  existing text;
  liked boolean;
begin
  select emoji into existing from feed_post_likes where post_id = p_post_id and share_key = p_share_key;
  if existing is null then
    insert into feed_post_likes (post_id, share_key, emoji) values (p_post_id, p_share_key, p_emoji);
    liked := true;
  elsif existing = p_emoji then
    delete from feed_post_likes where post_id = p_post_id and share_key = p_share_key;
    liked := false;
  else
    update feed_post_likes set emoji = p_emoji where post_id = p_post_id and share_key = p_share_key;
    liked := true;
  end if;
  return liked;
end;
$$;
grant execute on function toggle_feed_post_like(bigint, uuid, text) to anon;

create or replace function toggle_feed_comment_like(p_comment_id bigint, p_share_key uuid, p_emoji text default '👍') returns boolean
language plpgsql
security definer
as $$
declare
  existing text;
  liked boolean;
begin
  select emoji into existing from feed_comment_likes where comment_id = p_comment_id and share_key = p_share_key;
  if existing is null then
    insert into feed_comment_likes (comment_id, share_key, emoji) values (p_comment_id, p_share_key, p_emoji);
    liked := true;
  elsif existing = p_emoji then
    delete from feed_comment_likes where comment_id = p_comment_id and share_key = p_share_key;
    liked := false;
  else
    update feed_comment_likes set emoji = p_emoji where comment_id = p_comment_id and share_key = p_share_key;
    liked := true;
  end if;
  return liked;
end;
$$;
grant execute on function toggle_feed_comment_like(bigint, uuid, text) to anon;
