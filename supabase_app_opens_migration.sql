-- Global "app opens" counter for Winfinity Tracker.
-- Run this once in the Supabase SQL editor for the project.
--
-- Tracks how many times the app has been opened/launched across every
-- user (not per-device) — shown on the Nexus tab next to "operators
-- synced". Increments happen only through increment_app_opens() below,
-- never a direct client-side UPDATE, so nothing lets a client set the
-- count to an arbitrary value.

create table if not exists app_stats (
  id int primary key default 1,
  open_count bigint not null default 0,
  constraint app_stats_single_row check (id = 1)
);
insert into app_stats (id, open_count) values (1, 0) on conflict (id) do nothing;

alter table app_stats enable row level security;

drop policy if exists "anon read app_stats" on app_stats;
create policy "anon read app_stats" on app_stats for select using (true);
-- Deliberately no anon insert/update/delete policy — all writes go through
-- increment_app_opens() below.

create or replace function increment_app_opens() returns bigint
language plpgsql
security definer
as $$
declare
  new_count bigint;
begin
  update app_stats set open_count = open_count + 1 where id = 1
    returning open_count into new_count;
  return new_count;
end;
$$;

grant execute on function increment_app_opens() to anon;
