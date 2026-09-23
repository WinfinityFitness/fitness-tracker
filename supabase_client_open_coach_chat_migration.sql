-- Lets a regular client open (find-or-create) a DM with their OWN attached
-- coach, without needing the coach's credentials -- the coach-initiated
-- side of this already existed (coach_open_client_chat, see
-- supabase_coach_nexus_chat_migration.sql), this is the missing client-
-- initiated mirror of it. Reuses the same start_dm_by_share_key primitive
-- every other DM (including coach-initiated ones) is built on, so once the
-- room exists it's a completely normal DM room -- same chat_messages rows,
-- same send_chat_message RPC, nothing coach-specific about it from here on.
--
-- p_share_key/p_code_name are the calling client's own identity (same
-- values already used for every other anon-permissive call in this app --
-- getOrCreateShareKey()/effectiveLeaderboardName() client-side). No
-- password: this only needs to know WHICH coach this share_key is
-- currently attached to (coach_clients), which is public-ish info the
-- client already effectively knows (get_my_coach_features exposes the same
-- coach's brand name to this client already).
create or replace function client_open_coach_chat(
  p_share_key uuid, p_code_name text
) returns table(room_id uuid, coach_brand_name text)
language plpgsql
security definer
as $$
declare
  v_coach_chat_key uuid;
  v_brand_name text;
  v_room_id uuid;
begin
  select c.chat_share_key, c.brand_name into v_coach_chat_key, v_brand_name
  from coach_clients cc
  join coaches c on c.id = cc.coach_id
  where cc.share_key = p_share_key and cc.status = 'active' and c.active
  limit 1;

  if v_coach_chat_key is null then
    raise exception 'No coach attached to this account.';
  end if;

  v_room_id := start_dm_by_share_key(p_share_key, p_code_name, v_coach_chat_key, v_brand_name);

  return query select v_room_id, v_brand_name;
end;
$$;
grant execute on function client_open_coach_chat(uuid, text) to anon;

notify pgrst, 'reload schema';
