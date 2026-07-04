-- Winfinity Tracker: opt-in leaderboard + public chat setup
-- Run this once in Supabase: Project -> SQL Editor -> New query -> paste -> Run
-- Safe to re-run: drops any previous version of these objects first.

drop function if exists public.upsert_leaderboard_entry(text, uuid, numeric, text, numeric, integer, numeric, text);
drop function if exists public.upsert_leaderboard_entry(uuid, text, numeric, text, numeric, integer, numeric, text);
drop function if exists public.upsert_leaderboard_entry(uuid, text, numeric, text, numeric, numeric, integer, numeric, text);
drop function if exists public.delete_leaderboard_entry(text, uuid);
drop function if exists public.delete_leaderboard_entry(uuid);
drop table if exists public.leaderboard;
drop table if exists public.chat_messages;

-- share_key (generated once per device, never shown) is the real identity anchor.
-- code_name is just a display label pulled from each user's Bio "Name" field,
-- so renaming in Bio updates the same row instead of creating a duplicate.
create table public.leaderboard (
  share_key uuid primary key,
  code_name text not null,
  weight numeric,
  weight_unit text,
  weight_progress numeric,
  weight_progress_pct numeric,
  steps integer,
  volume_lifted numeric,
  volume_unit text,
  updated_at timestamptz not null default now()
);

alter table public.leaderboard enable row level security;

create policy "Public read access"
  on public.leaderboard for select
  using (true);

-- Writes go through this function instead of direct table access, so a device
-- can only create or update its OWN row (matched by its private share_key).
create or replace function public.upsert_leaderboard_entry(
  p_share_key uuid,
  p_code_name text,
  p_weight numeric,
  p_weight_unit text,
  p_weight_progress numeric,
  p_weight_progress_pct numeric,
  p_steps integer,
  p_volume_lifted numeric,
  p_volume_unit text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.leaderboard (share_key, code_name, weight, weight_unit, weight_progress, weight_progress_pct, steps, volume_lifted, volume_unit, updated_at)
  values (p_share_key, p_code_name, p_weight, p_weight_unit, p_weight_progress, p_weight_progress_pct, p_steps, p_volume_lifted, p_volume_unit, now())
  on conflict (share_key) do update set
    code_name = excluded.code_name,
    weight = excluded.weight,
    weight_unit = excluded.weight_unit,
    weight_progress = excluded.weight_progress,
    weight_progress_pct = excluded.weight_progress_pct,
    steps = excluded.steps,
    volume_lifted = excluded.volume_lifted,
    volume_unit = excluded.volume_unit,
    updated_at = now();
end;
$$;

create or replace function public.delete_leaderboard_entry(
  p_share_key uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.leaderboard where share_key = p_share_key;
end;
$$;

grant execute on function public.upsert_leaderboard_entry to anon;
grant execute on function public.delete_leaderboard_entry to anon;

-- Public chat: open channel, no accounts. Anyone with the app link can read
-- and post. Fine for a small trusted beta group; there is no moderation tooling.
create table public.chat_messages (
  id bigint generated always as identity primary key,
  code_name text not null,
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

create policy "Public read access"
  on public.chat_messages for select
  using (true);

create policy "Public insert with basic length limits"
  on public.chat_messages for insert
  with check (char_length(message) between 1 and 280 and char_length(code_name) between 1 and 40);
