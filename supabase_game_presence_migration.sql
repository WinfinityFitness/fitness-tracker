-- Lightweight "who's currently in the game" signal for the Tavern's Direct
-- Message picker (see the Adventure Map's Tavern tab) -- nothing like this
-- existed before; the Nexus "online now" count is a derived read of
-- leaderboard sync staleness, not a purpose-built presence table, and its
-- 5-minute staleness window is too coarse for "who's in the Adventure Map
-- right now." One row per user, upserted every ~20s while the Adventure
-- Map overlay is open, read back filtered to the last 90 seconds.
--
-- RLS enabled with NO policies for anon/authenticated -- every read and
-- write goes through the two security definer functions below, so the raw
-- table is never exposed directly via PostgREST.

create table if not exists public.game_presence (
  share_key uuid primary key,
  code_name text not null,
  updated_at timestamptz not null default now()
);
alter table public.game_presence enable row level security;

create or replace function touch_game_presence(
  p_share_key uuid,
  p_code_name text
) returns void
language plpgsql
security definer
as $$
begin
  insert into game_presence (share_key, code_name, updated_at)
  values (p_share_key, p_code_name, now())
  on conflict (share_key) do update
    set code_name = excluded.code_name, updated_at = excluded.updated_at;
end;
$$;
grant execute on function touch_game_presence(uuid, text) to anon;

create or replace function get_game_presence()
returns table (share_key uuid, code_name text)
language sql
security definer
stable
as $$
  select share_key, code_name
  from game_presence
  where updated_at > now() - interval '90 seconds';
$$;
grant execute on function get_game_presence() to anon;

notify pgrst, 'reload schema';
