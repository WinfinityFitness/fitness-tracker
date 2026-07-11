-- Chat message unsend (soft delete) + emoji reactions. Run this after
-- leaderboard_setup.sql and the group chat migrations are already applied.
--
-- Same anon-permissive, share_key-honor-system trust model as the rest of
-- the chat schema (see leaderboard_setup.sql's comment: "small trusted beta
-- group; there is no moderation tooling"). RLS stays permissive; ownership
-- ("can I unsend THIS message" / "whose reaction is this") is enforced
-- inside the SECURITY DEFINER RPCs below, the same pattern already used by
-- upsert_leaderboard_entry / set_public_id elsewhere in this app.

alter table chat_messages add column if not exists deleted boolean not null default false;
-- Nullable: rows sent before this migration have no sender_share_key, so
-- they simply can't be unsent (harmless — new messages all get one).
alter table chat_messages add column if not exists sender_share_key uuid;

create table if not exists chat_message_reactions (
  message_id bigint not null references chat_messages(id) on delete cascade,
  share_key uuid not null,
  emoji text not null,
  updated_at timestamptz not null default now(),
  primary key (message_id, share_key)
);
alter table chat_message_reactions enable row level security;

create policy "anon read chat_message_reactions"
  on chat_message_reactions for select
  using (true);

create or replace function unsend_chat_message(p_message_id bigint, p_share_key uuid) returns void
language sql
security definer
as $$
  update chat_messages set deleted = true
  where id = p_message_id and sender_share_key = p_share_key;
$$;
grant execute on function unsend_chat_message(bigint, uuid) to anon;

-- p_emoji = null (or empty string) removes the caller's reaction — this is
-- how the client implements "tap the same emoji again to undo."
create or replace function set_chat_reaction(p_message_id bigint, p_share_key uuid, p_emoji text) returns void
language plpgsql
security definer
as $$
begin
  if p_emoji is null or p_emoji = '' then
    delete from chat_message_reactions where message_id = p_message_id and share_key = p_share_key;
  else
    insert into chat_message_reactions (message_id, share_key, emoji, updated_at)
    values (p_message_id, p_share_key, p_emoji, now())
    on conflict (message_id, share_key) do update set emoji = excluded.emoji, updated_at = now();
  end if;
end;
$$;
grant execute on function set_chat_reaction(bigint, uuid, text) to anon;
