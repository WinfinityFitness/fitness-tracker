-- "Seen by" receipts for the desktop Nexus chat — a row of tiny avatar
-- initials under the most recent message, Messenger-group-chat style.
-- room_key is a plain string ('global' for the public room the desktop
-- chat uses today) rather than a nullable room_id uuid — avoids relying on
-- NULLS NOT DISTINCT unique-constraint behavior for an upsert target.

create table if not exists chat_read_receipts (
  room_key text not null default 'global',
  share_key uuid not null,
  code_name text not null,
  last_read_at timestamptz not null default now(),
  primary key (room_key, share_key)
);
alter table chat_read_receipts enable row level security;
create policy "Public read access" on chat_read_receipts for select using (true);
-- No direct write policy — upserted through mark_chat_read() below, same
-- "toggle/upsert actions go through an RPC" convention as
-- toggle_feed_post_like (a plain client-side upsert would need both insert
-- and update policies open, which is no safer here, but keeping every
-- write path consistent makes the schema easier to audit as a whole).

create or replace function mark_chat_read(p_room_key text, p_share_key uuid, p_code_name text) returns void
language sql
security definer
as $$
  insert into chat_read_receipts (room_key, share_key, code_name, last_read_at)
  values (p_room_key, p_share_key, p_code_name, now())
  on conflict (room_key, share_key) do update
  set code_name = excluded.code_name, last_read_at = excluded.last_read_at;
$$;
grant execute on function mark_chat_read(text, uuid, text) to anon;
