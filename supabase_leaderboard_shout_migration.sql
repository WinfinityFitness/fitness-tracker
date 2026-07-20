-- "Shout" — a short (<=60 char), persistent status bubble shown above a
-- user's avatar on their profile page. Public/anon-readable, same trust
-- model as leaderboard's existing avatar_data_url/code_name columns.
-- Stays until the user posts a new one or clears it -- no expiry, unlike
-- Stories (this is a status/tagline, not an ephemeral post).
alter table leaderboard add column if not exists shout_text text;
alter table leaderboard add column if not exists shout_updated_at timestamptz;

-- Same upsert-with-defaults shape as set_leaderboard_avatar (see
-- supabase_leaderboard_avatar_upsert_migration.sql) so a user with no
-- leaderboard row yet still gets one created here instead of failing.
-- Passing an empty/whitespace-only string clears the shout (nullif turns
-- '' into null) -- same RPC handles both "post" and "clear".
create or replace function set_leaderboard_shout(
  p_share_key uuid,
  p_shout_text text,
  p_code_name text default null,
  p_public_id text default null
) returns void
language plpgsql
security definer
as $$
begin
  if p_shout_text is not null and length(p_shout_text) > 60 then
    raise exception 'Shout must be 60 characters or fewer.';
  end if;
  insert into leaderboard (share_key, code_name, public_id, shout_text, shout_updated_at)
  values (p_share_key, coalesce(p_code_name, 'Winfinity User'), p_public_id, nullif(trim(p_shout_text), ''), now())
  on conflict (share_key) do update set
    shout_text = nullif(trim(excluded.shout_text), ''),
    shout_updated_at = now();
end;
$$;
grant execute on function set_leaderboard_shout(uuid, text, text, text) to anon;

notify pgrst, 'reload schema';
