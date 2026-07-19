-- set_leaderboard_avatar was a bare UPDATE — if a user never had a
-- leaderboard row to begin with (that row is normally only created by
-- opting into the PUBLIC leaderboard, a completely separate feature from
-- Web Dashboard Sync), the UPDATE silently affected zero rows every
-- single time it was called, no matter how many times the client tried.
-- That's why the photo-sync fix in the previous deploy still didn't make
-- avatars show up for some users: the write itself was a no-op before it
-- ever got there.
--
-- Turned into an upsert: if the row doesn't exist yet, this creates one
-- (code_name/public_id filled in from the two new optional params so a
-- freshly-created row isn't left with a placeholder name or a missing
-- Digital ID) with the avatar already set; if it exists, only
-- avatar_data_url is touched — code_name/public_id stay exactly as
-- upsert_leaderboard_entry/set_public_id already manage them elsewhere,
-- never overwritten from here.

drop function if exists set_leaderboard_avatar(uuid, text);

create or replace function set_leaderboard_avatar(
  p_share_key uuid,
  p_avatar_data_url text,
  p_code_name text default null,
  p_public_id text default null
) returns void
language plpgsql
security definer
as $$
begin
  insert into leaderboard (share_key, code_name, public_id, avatar_data_url)
  values (p_share_key, coalesce(p_code_name, 'Winfinity User'), p_public_id, p_avatar_data_url)
  on conflict (share_key) do update set avatar_data_url = excluded.avatar_data_url;
end;
$$;
grant execute on function set_leaderboard_avatar(uuid, text, text, text) to anon;

notify pgrst, 'reload schema';
