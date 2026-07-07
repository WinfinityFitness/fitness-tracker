-- Group chat migration for Winfinity Tracker Nexus.
-- Run this once in the Supabase SQL editor for the project.
-- Assumes chat_messages/leaderboard already exist with anon-permissive RLS
-- (matching the app's existing no-login, share_key-anchored trust model).
-- leaderboard.share_key is `uuid` in production, so every share_key-shaped
-- column/parameter below is typed `uuid` to match (not `text`).
--
-- NOTE: this does NOT touch the existing upsert_leaderboard_entry function —
-- it only adds a new nullable column + a separate small RPC, so it can't
-- break the existing leaderboard sync flow.

create extension if not exists pgcrypto;

-- Public, safe-to-share invite code. Distinct from share_key, which stays
-- private because it also authorizes deleting one's own leaderboard entry.
alter table leaderboard add column if not exists public_id text;
create unique index if not exists leaderboard_public_id_idx on leaderboard (public_id) where public_id is not null;

create or replace function set_public_id(p_share_key uuid, p_public_id text) returns void
language sql
security definer
as $$
  update leaderboard set public_id = p_public_id where share_key = p_share_key;
$$;

grant execute on function set_public_id(uuid, text) to anon;

create table if not exists chat_rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by_key uuid not null,
  created_by_name text not null,
  single_member_since timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists chat_room_members (
  room_id uuid not null references chat_rooms(id) on delete cascade,
  share_key uuid not null,
  code_name text not null,
  status text not null default 'invited', -- 'invited' | 'joined'
  invited_by_key uuid,
  created_at timestamptz not null default now(),
  primary key (room_id, share_key)
);

alter table chat_messages add column if not exists room_id uuid references chat_rooms(id) on delete cascade;

alter table chat_rooms enable row level security;
alter table chat_room_members enable row level security;

-- Same permissive-for-anon model as the existing leaderboard/chat_messages tables.
-- Note: there is no real login system in this app, so this is a soft/best-effort
-- privacy boundary (same trust level as the rest of Nexus), not a hard guarantee.
drop policy if exists "anon read chat_rooms" on chat_rooms;
create policy "anon read chat_rooms" on chat_rooms for select using (true);
drop policy if exists "anon insert chat_rooms" on chat_rooms;
create policy "anon insert chat_rooms" on chat_rooms for insert with check (true);

drop policy if exists "anon read chat_room_members" on chat_room_members;
create policy "anon read chat_room_members" on chat_room_members for select using (true);
drop policy if exists "anon update chat_room_members" on chat_room_members;
create policy "anon update chat_room_members" on chat_room_members for update using (true);
drop policy if exists "anon delete chat_room_members" on chat_room_members;
create policy "anon delete chat_room_members" on chat_room_members for delete using (true);

-- Creates a room, joins the creator, and invites operators by their Digital
-- ID (public_id) — never by mutable display name. SECURITY DEFINER so the
-- invitee's share_key lookup never has to be exposed to the client.
create or replace function create_chat_room(
  p_name text,
  p_creator_key uuid,
  p_creator_name text,
  p_invitee_ids text[]
) returns uuid
language plpgsql
security definer
as $$
declare
  v_room_id uuid;
  v_id text;
  v_share_key uuid;
  v_code_name text;
begin
  insert into chat_rooms (name, created_by_key, created_by_name)
  values (p_name, p_creator_key, p_creator_name)
  returning id into v_room_id;

  insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
  values (v_room_id, p_creator_key, p_creator_name, 'joined', p_creator_key);

  if p_invitee_ids is not null then
    foreach v_id in array p_invitee_ids loop
      select share_key, code_name into v_share_key, v_code_name from leaderboard where public_id = v_id limit 1;
      if v_share_key is not null and v_share_key <> p_creator_key then
        insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
        values (v_room_id, v_share_key, v_code_name, 'invited', p_creator_key)
        on conflict (room_id, share_key) do nothing;
      end if;
    end loop;
  end if;

  return v_room_id;
end;
$$;

grant execute on function create_chat_room(text, uuid, text, text[]) to anon;

-- Invite additional Digital IDs into an existing room (creator/any member can invite).
create or replace function invite_to_chat_room(
  p_room_id uuid,
  p_inviter_key uuid,
  p_invitee_ids text[]
) returns void
language plpgsql
security definer
as $$
declare
  v_id text;
  v_share_key uuid;
  v_code_name text;
begin
  foreach v_id in array p_invitee_ids loop
    select share_key, code_name into v_share_key, v_code_name from leaderboard where public_id = v_id limit 1;
    if v_share_key is not null then
      insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
      values (p_room_id, v_share_key, v_code_name, 'invited', p_inviter_key)
      on conflict (room_id, share_key) do nothing;
    end if;
  end loop;
end;
$$;

grant execute on function invite_to_chat_room(uuid, uuid, text[]) to anon;

-- Membership bookkeeping: recompute joined-member count whenever membership
-- changes. 0 joined members -> delete the room immediately. Exactly 1 ->
-- start (or keep) a 24h countdown. 2+ -> cancel any countdown.
create or replace function update_room_member_state() returns trigger
language plpgsql
security definer
as $$
declare
  v_room_id uuid;
  v_count int;
begin
  v_room_id := coalesce(new.room_id, old.room_id);
  select count(*) into v_count from chat_room_members where room_id = v_room_id and status = 'joined';
  if v_count = 0 then
    delete from chat_rooms where id = v_room_id;
  elsif v_count = 1 then
    update chat_rooms set single_member_since = coalesce(single_member_since, now()) where id = v_room_id;
  else
    update chat_rooms set single_member_since = null where id = v_room_id;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_room_member_state on chat_room_members;
create trigger trg_room_member_state
after insert or update or delete on chat_room_members
for each row execute function update_room_member_state();

-- Deletes any group that's been down to a single joined member for 24h+.
-- No pg_cron dependency: the client calls this opportunistically (best
-- effort) whenever it opens the Nexus tab or syncs.
create or replace function cleanup_stale_solo_rooms() returns void
language sql
security definer
as $$
  delete from chat_rooms
  where single_member_since is not null
    and single_member_since < now() - interval '24 hours';
$$;

grant execute on function cleanup_stale_solo_rooms() to anon;

-- Leave a room. Membership trigger handles the 0/1-member consequences.
create or replace function leave_chat_room(p_room_id uuid, p_share_key uuid) returns void
language sql
security definer
as $$
  delete from chat_room_members where room_id = p_room_id and share_key = p_share_key;
$$;

grant execute on function leave_chat_room(uuid, uuid) to anon;
