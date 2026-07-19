-- Lets the ORIGINAL REQUESTER learn whether their friend request was
-- accepted or declined — previously respond_friend_request either
-- updated status to 'accepted' or hard-DELETED the row on decline, so a
-- requester had no way to ever find out what happened; only the
-- recipient got a notification via list_pending_friend_requests.
--
-- Decline now sets status = 'declined' (a record the requester's client
-- can poll for) instead of deleting. Since a friendships row's mere
-- EXISTENCE used to permanently block any future request between the
-- same two people regardless of status, send_friend_request's exists
-- check is narrowed to only 'pending'/'accepted', and a stale
-- accepted/declined row between the same pair gets cleared out before
-- inserting the fresh pending one (so a decline doesn't lock the pair
-- out of ever becoming friends later).

create or replace function send_friend_request(p_share_key uuid, p_target_public_id text) returns void
language plpgsql
security definer
as $$
declare
  v_target_key uuid;
begin
  select share_key into v_target_key from leaderboard where public_id = p_target_public_id limit 1;
  if v_target_key is null then
    raise exception 'No user found with that Digital ID';
  end if;
  if v_target_key = p_share_key then
    raise exception 'You can''t add yourself as a friend';
  end if;
  -- Already friends, or a request already pending either direction: no-op
  -- rather than erroring, so a double-tap of "Add Friend" is harmless.
  if exists (
    select 1 from friendships
    where ((requester_share_key = p_share_key and addressee_share_key = v_target_key)
        or (requester_share_key = v_target_key and addressee_share_key = p_share_key))
      and status in ('pending', 'accepted')
  ) then
    return;
  end if;
  -- A previously declined request (either direction) is replaced by this
  -- fresh one rather than accumulating duplicate rows.
  delete from friendships
  where (requester_share_key = p_share_key and addressee_share_key = v_target_key)
     or (requester_share_key = v_target_key and addressee_share_key = p_share_key);
  insert into friendships (requester_share_key, addressee_share_key, status)
  values (p_share_key, v_target_key, 'pending');
end;
$$;
grant execute on function send_friend_request(uuid, text) to anon;

create or replace function respond_friend_request(p_share_key uuid, p_requester_share_key uuid, p_accept boolean) returns void
language plpgsql
security definer
as $$
begin
  if p_accept then
    update friendships set status = 'accepted', responded_at = now()
    where requester_share_key = p_requester_share_key and addressee_share_key = p_share_key and status = 'pending';
  else
    update friendships set status = 'declined', responded_at = now()
    where requester_share_key = p_requester_share_key and addressee_share_key = p_share_key and status = 'pending';
  end if;
end;
$$;
grant execute on function respond_friend_request(uuid, uuid, boolean) to anon;

-- The requester's own client polls this for outcomes of requests THEY
-- sent (mirrors list_pending_friend_requests, which is the recipient's
-- side of the same flow).
create or replace function list_sent_friend_request_outcomes(p_share_key uuid)
returns table (addressee_share_key uuid, code_name text, status text, responded_at timestamptz)
language sql
security definer
as $$
  select l.share_key, l.code_name, f.status, f.responded_at
  from friendships f
  join leaderboard l on l.share_key = f.addressee_share_key
  where f.requester_share_key = p_share_key
    and f.status in ('accepted', 'declined')
    and f.responded_at is not null;
$$;
grant execute on function list_sent_friend_request_outcomes(uuid) to anon;

notify pgrst, 'reload schema';
