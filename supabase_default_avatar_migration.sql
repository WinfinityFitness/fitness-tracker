-- Auto-assigns a consistent (never re-randomized) default avatar, picked
-- from the 400-image "Shinobi Pulse" pool now hosted at
-- icons/avatars/s{1-4}-{001-100}.png on GH Pages, to any real user who
-- hasn't uploaded (or picked) their own photo -- replacing the plain
-- initial-letter circle everywhere avatar_data_url is already rendered
-- (chat, feed, friends, profile, showcase) with zero client-side render
-- changes, since every one of those call sites already just shows
-- whatever avatar_data_url comes back non-null.
--
-- default_avatar_url(seed) is a pure/deterministic djb2-style hash of the
-- seed (share_key) mod 400 -> one fixed pool image. Mirrored client-side
-- in app.js's defaultAvatarUrlForSeed() with the *same* hash so a user's
-- own local preview (before their first sync) matches what everyone else
-- will see once it syncs -- not load-bearing for correctness (the DB
-- value here is the real source of truth for other viewers), just avoids
-- a cosmetic flash of a different avatar.
create or replace function default_avatar_url(p_seed text)
returns text
language plpgsql
immutable
as $$
declare
  h bigint := 5381;
  i int;
  idx int;
  sheet int;
  cell int;
begin
  for i in 1..length(p_seed) loop
    h := (h * 33 + ascii(substr(p_seed, i, 1))) % 4294967296;
  end loop;
  idx := h % 400;
  sheet := (idx / 100) + 1;
  cell := (idx % 100) + 1;
  return format(
    'https://winfinityfitness.github.io/fitness-tracker/icons/avatars/s%s-%s.png',
    sheet, lpad(cell::text, 3, '0')
  );
end;
$$;

-- set_leaderboard_avatar is the single write path for avatar_data_url
-- (confirmed: upsert_leaderboard_entry never touches that column). A null
-- p_avatar_data_url now means "fall back to this user's default" instead
-- of "leave it blank" -- covers both the explicit "Remove photo" flow
-- (reverts to the auto-assigned default, not a blank letter circle) and
-- any future caller that passes null.
drop function if exists set_leaderboard_avatar(uuid, text, text, text);

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
  values (
    p_share_key, coalesce(p_code_name, 'Winfinity User'), p_public_id,
    coalesce(p_avatar_data_url, default_avatar_url(p_share_key::text))
  )
  on conflict (share_key) do update
    set avatar_data_url = coalesce(excluded.avatar_data_url, default_avatar_url(p_share_key::text));
end;
$$;
grant execute on function set_leaderboard_avatar(uuid, text, text, text) to anon;

-- One-time backfill: existing rows created via upsert_leaderboard_entry
-- (opting into the public leaderboard) that never separately called
-- set_leaderboard_avatar are still sitting on a null avatar_data_url.
update leaderboard
set avatar_data_url = default_avatar_url(share_key::text)
where avatar_data_url is null;

-- Showcase demo users (all 500) never had avatar_data_url populated by the
-- 500-user generation migration -- seeded by public_id (e.g. 'WF-DEMO123')
-- since demo rows have no share_key. Same pool, same deterministic-per-user
-- rule as real users.
update showcase_demo_users
set avatar_data_url = default_avatar_url(public_id)
where avatar_data_url is null;

notify pgrst, 'reload schema';
