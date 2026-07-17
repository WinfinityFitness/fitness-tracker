-- Security hardening pass #1: the two clearest, lowest-risk fixes from the
-- RLS/RPC audit. Both are pure lockdowns — nothing a legitimate client call
-- currently relies on is removed, only access paths the app itself never
-- uses (confirmed by grepping every call site in app.js first).

-- ---------------------------------------------------------------------
-- 1. leaderboard.share_key was fully readable by anyone with the public
--    anon key (e.g. GET /rest/v1/leaderboard?select=share_key,public_id),
--    despite being described everywhere in this codebase as "private,
--    never shown" — RLS controls which ROWS are visible, not which
--    COLUMNS are, so the existing "Public read access" policy (for
--    select using (true), by design — the leaderboard itself is meant to
--    be public) never restricted this column on its own. share_key is
--    the bearer credential nearly every write RPC in the app trusts, so
--    this one leak was undermining most of the rest of the trust model.
--    No client code anywhere selects share_key from leaderboard (every
--    read only ever asks for public_id/code_name/stats), so this is a
--    pure lockdown with zero functional impact.
-- ---------------------------------------------------------------------
revoke select (share_key) on leaderboard from anon;
revoke select (share_key) on leaderboard from authenticated;

-- ---------------------------------------------------------------------
-- 2. chat_room_members allowed direct UPDATE/DELETE from anyone with the
--    anon key and no ownership check at all (using (true)) — meaning
--    anyone could self-join any room as 'joined', kick another member,
--    or otherwise edit arbitrary membership rows directly via REST,
--    bypassing invite_to_chat_room/leave_chat_room/kick_chat_room_member
--    entirely. The only two things that legitimately used direct
--    update/delete on this table (accepting/declining an invite, in both
--    the mobile popover and the desktop Chats panel) get their own
--    ownership-checked RPCs below instead; app.js is updated in the same
--    deploy to call these instead of writing the table directly.
-- ---------------------------------------------------------------------
drop policy if exists "anon update chat_room_members" on chat_room_members;
drop policy if exists "anon delete chat_room_members" on chat_room_members;

create or replace function accept_chat_room_invite(p_room_id uuid, p_share_key uuid) returns boolean
language plpgsql
security definer
as $$
begin
  update chat_room_members set status = 'joined' where room_id = p_room_id and share_key = p_share_key;
  return found;
end;
$$;
grant execute on function accept_chat_room_invite(uuid, uuid) to anon;

create or replace function decline_chat_room_invite(p_room_id uuid, p_share_key uuid) returns boolean
language plpgsql
security definer
as $$
begin
  delete from chat_room_members where room_id = p_room_id and share_key = p_share_key;
  return found;
end;
$$;
grant execute on function decline_chat_room_invite(uuid, uuid) to anon;
