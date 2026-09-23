-- Lets ANY client open (find-or-create) a DM with a named coach by brand
-- name, with no coach_clients attachment required -- this is the "Coach
-- Win" quick-message shortcut in the Nexus chat dropdown, meant to be as
-- universally reachable as Public Chat itself, not gated behind already
-- being one of that coach's assigned clients.
--
-- Superseded design note: an earlier version of this migration
-- (client_open_coach_chat) required an active coach_clients row, mirroring
-- the existing coach-initiated flow (coach_open_client_chat). Replaced by
-- this brand-name lookup per explicit direction -- the shortcut should
-- behave like Public Chat: always visible, no attachment prerequisite.
drop function if exists client_open_coach_chat(uuid, text);

create or replace function open_chat_with_named_coach(
  p_share_key uuid, p_code_name text, p_coach_brand_name text
) returns table(room_id uuid, coach_brand_name text)
language plpgsql
security definer
as $$
declare
  v_coach_chat_key uuid;
  v_brand_name text;
  v_room_id uuid;
begin
  select chat_share_key, brand_name into v_coach_chat_key, v_brand_name
  from coaches
  where brand_name = p_coach_brand_name and active
  limit 1;

  if v_coach_chat_key is null then
    raise exception 'No active coach found with that name.';
  end if;

  v_room_id := start_dm_by_share_key(p_share_key, p_code_name, v_coach_chat_key, v_brand_name);

  return query select v_room_id, v_brand_name;
end;
$$;
grant execute on function open_chat_with_named_coach(uuid, text, text) to anon;

notify pgrst, 'reload schema';
