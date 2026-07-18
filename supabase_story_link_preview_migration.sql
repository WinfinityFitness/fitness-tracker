-- Adds a link-preview column to My Day stories, mirroring the existing
-- feed_posts.link_preview jsonb column/pattern exactly. Used two ways from
-- the client: (1) pasting/typing a URL into the story composer's new Link
-- button, unfurled via the same link-preview Edge Function feed posts
-- already use; (2) "Share to My Day" from a feed post, which builds a
-- lightweight preview object locally from that post's own fields (no
-- external fetch needed) with `internal: true` so it renders as a plain
-- (non-clickable) card instead of a link, since there's no real per-post
-- URL to link to in this single-page app.
alter table feed_stories add column if not exists link_preview jsonb;

notify pgrst, 'reload schema';
