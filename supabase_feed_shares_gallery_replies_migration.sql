-- Three additions to the Nexus Feed, same trust model as the rest of it
-- (share_key is the identity anchor; plain permissive insert policies for
-- normal writes, RPCs only where a real check is needed):
--
-- 1. Multi-image posts: a new image_urls text[] column, additive next to
--    the existing single image_url — old posts/code paths that only ever
--    used image_url keep working unchanged; a post with multiple photos
--    fills image_urls instead and the client renders a collage grid.
-- 2. Nested comment replies: parent_comment_id on feed_post_comments.
-- 3. Shares: a "share" is just another feed_posts row that references the
--    original via shared_post_id (with its own optional caption/message),
--    exactly like Facebook's own model — it shows up in the sharer's own
--    feed, can be liked/commented on separately from the original, and
--    "who shared this" is just "every post with this shared_post_id".

alter table feed_posts add column if not exists image_urls text[];
alter table feed_posts add column if not exists shared_post_id bigint references feed_posts(id) on delete set null;
alter table feed_post_comments add column if not exists parent_comment_id bigint references feed_post_comments(id) on delete cascade;

-- Sharing goes through an RPC (not a plain insert) so the "only public
-- posts can be shared" rule is enforced server-side too, not just by
-- hiding the Share button client-side — same reasoning as
-- create_wall_post checking can_post_on_wall before inserting.
create or replace function share_feed_post(p_share_key uuid, p_code_name text, p_original_post_id bigint, p_message text default null) returns bigint
language plpgsql
security definer
as $$
declare
  v_visibility text;
  v_deleted boolean;
  v_new_id bigint;
begin
  select visibility, deleted into v_visibility, v_deleted from feed_posts where id = p_original_post_id;
  if v_deleted is null then
    raise exception 'Original post not found';
  end if;
  if v_deleted then
    raise exception 'This post has been removed';
  end if;
  if coalesce(v_visibility, 'public') <> 'public' then
    raise exception 'Only public posts can be shared';
  end if;
  insert into feed_posts (share_key, code_name, message, shared_post_id)
  values (p_share_key, p_code_name, coalesce(p_message, ''), p_original_post_id)
  returning id into v_new_id;
  return v_new_id;
end;
$$;
grant execute on function share_feed_post(uuid, text, bigint, text) to anon;

-- Fetching the original post an existing share references, and listing
-- who shared a given post, both stay plain selects (not RPCs) — sharing
-- is restricted to public posts above, so there's nothing
-- visibility-sensitive left to check for either read.
notify pgrst, 'reload schema';
