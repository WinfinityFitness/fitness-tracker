-- Lets a post's own author edit its text after posting (the new post-menu's
-- "Edit" option). Ownership is checked server-side via the where clause —
-- a tampered client request for someone else's post_id/share_key pair
-- simply updates zero rows, same defensive pattern as unsend_feed_post.
create or replace function edit_feed_post(p_post_id bigint, p_share_key uuid, p_message text) returns void
language plpgsql
security definer
as $$
begin
  update feed_posts set message = p_message
  where id = p_post_id and share_key = p_share_key;
end;
$$;

grant execute on function edit_feed_post(bigint, uuid, text) to anon;
