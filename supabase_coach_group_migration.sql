-- Coach white-label tenancy — Phase D: FT Nexus group chat per coach.
-- Reuses the existing generic chat_rooms/chat_room_members system as-is
-- (create_chat_room, invite_to_chat_room, leave_chat_room, etc. are all
-- untouched) rather than building a parallel schema -- a coach group IS a
-- chat_rooms row, just tagged with owner_coach_id and auto-provisioned.
--
-- The existing room switcher (app.js refreshChatRooms(), queries
-- chat_room_members by the caller's own share_key) needs ZERO changes --
-- once a client has a 'joined' chat_room_members row, their coach's group
-- just shows up in the same dropdown as any other room, automatically.

alter table chat_rooms add column if not exists owner_coach_id uuid references coaches(id) on delete set null;

-- Two existing triggers/functions need a narrow exception: they were
-- designed for peer-created ad-hoc groups (correctly auto-deleted when
-- abandoned), but a coach's official group must NOT disappear just because
-- they briefly have 0 or 1 clients -- that's normal early on, not
-- abandonment.
create or replace function update_room_member_state() returns trigger
language plpgsql
security definer
as $$
declare
  v_room_id uuid;
  v_count int;
  v_is_coach_room boolean;
begin
  v_room_id := coalesce(new.room_id, old.room_id);
  select (owner_coach_id is not null) into v_is_coach_room from chat_rooms where id = v_room_id;
  select count(*) into v_count from chat_room_members where room_id = v_room_id and status = 'joined';
  if v_count = 0 then
    if not coalesce(v_is_coach_room, false) then
      delete from chat_rooms where id = v_room_id;
    end if;
  elsif v_count = 1 then
    update chat_rooms set single_member_since = coalesce(single_member_since, now()) where id = v_room_id;
  else
    update chat_rooms set single_member_since = null where id = v_room_id;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function cleanup_stale_solo_rooms() returns void
language sql
security definer
as $$
  delete from chat_rooms
  where single_member_since is not null
    and single_member_since < now() - interval '24 hours'
    and owner_coach_id is null;
$$;

-- Auto-provision/join on attach: extends coach_attach_client (Phase A) so
-- attaching a client also lands them in their coach's canonical group room
-- -- created lazily on first attach, reused for every client after. Note:
-- chat_rooms.created_by_key must be a real leaderboard share_key (a coach
-- isn't necessarily a leaderboard entity itself), so the attaching client
-- becomes the technical "creator" in that generic bookkeeping column --
-- cosmetic only, the room's real ownership is owner_coach_id, which is
-- what the coach group feature actually keys off.
create or replace function coach_attach_client(
  p_coach_digital_id text, p_coach_password text, p_client_public_id text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_share_key uuid;
declare v_code_name text;
declare v_existing_coach uuid;
declare v_room_id uuid;
declare v_brand_name text;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select share_key, code_name into v_share_key, v_code_name from leaderboard where public_id = p_client_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
  select coach_id into v_existing_coach from coach_clients
    where share_key = v_share_key and status = 'active';
  if found and v_existing_coach <> v_coach_id then
    raise exception 'This client is already attached to a different coach';
  end if;
  insert into coach_clients (coach_id, share_key, public_id, attached_via)
  values (v_coach_id, v_share_key, p_client_public_id, 'manual')
  on conflict (coach_id, share_key) do update
    set status = 'active', public_id = excluded.public_id;

  select id into v_room_id from chat_rooms where owner_coach_id = v_coach_id limit 1;
  if v_room_id is null then
    select brand_name into v_brand_name from coaches where id = v_coach_id;
    insert into chat_rooms (name, created_by_key, created_by_name, owner_coach_id)
    values (v_brand_name || ' Group', v_share_key, v_code_name, v_coach_id)
    returning id into v_room_id;
    insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
    values (v_room_id, v_share_key, v_code_name, 'joined', v_share_key);
  else
    insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
    values (v_room_id, v_share_key, v_code_name, 'joined', v_share_key)
    on conflict (room_id, share_key) do update set status = 'joined';
  end if;
end;
$$;
grant execute on function coach_attach_client(text, text, text) to anon;

-- Mirror on removal: detaching a client also removes them from the
-- coach's group room, so they stop seeing it once they're no longer that
-- coach's client.
create or replace function coach_remove_client(
  p_coach_digital_id text, p_coach_password text, p_client_public_id text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_share_key uuid;
declare v_room_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select share_key into v_share_key from leaderboard where public_id = p_client_public_id;

  update coach_clients set status = 'removed'
    where coach_id = v_coach_id and public_id = p_client_public_id and status = 'active';
  if not found then
    raise exception 'No active client found with that Digital ID under your roster';
  end if;

  if v_share_key is not null then
    select id into v_room_id from chat_rooms where owner_coach_id = v_coach_id limit 1;
    if v_room_id is not null then
      delete from chat_room_members where room_id = v_room_id and share_key = v_share_key;
    end if;
  end if;
end;
$$;
grant execute on function coach_remove_client(text, text, text) to anon;

notify pgrst, 'reload schema';
