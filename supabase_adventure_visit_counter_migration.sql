-- View counter for the Adventure Map field guide (adventure-guide.html /
-- adventure.winfinityfitness.com). Same pattern as
-- supabase_site_visit_counter_migration.sql -- a dedicated singleton
-- counter, kept separate from app_stats/site_visits since this tracks
-- opens of the guide page specifically, not the app or the main site.

create table if not exists public.adventure_visits (
  id int primary key default 1,
  visit_count bigint not null default 0,
  constraint adventure_visits_singleton check (id = 1)
);

insert into public.adventure_visits (id, visit_count)
values (1, 0)
on conflict (id) do nothing;

alter table public.adventure_visits enable row level security;
-- Deliberately no anon select/insert/update policy -- all reads and
-- writes go through the two security-definer functions below.

-- Atomically increments and returns the new total. Called once per browser
-- session from adventure-guide.html (guarded client-side via
-- sessionStorage so navigating/refreshing within one visit doesn't
-- multi-count).
create or replace function public.record_adventure_visit()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count bigint;
begin
  update public.adventure_visits set visit_count = visit_count + 1 where id = 1
  returning visit_count into new_count;
  return new_count;
end;
$$;

grant execute on function public.record_adventure_visit() to anon, authenticated;

-- Read-only companion: a repeat page load within the same browser session
-- skips record_adventure_visit (see the sessionStorage guard client-side),
-- so this just reads the current total without touching it.
create or replace function public.get_adventure_visit_count()
returns bigint
language sql
security definer
set search_path = public
as $$
  select visit_count from public.adventure_visits where id = 1;
$$;

grant execute on function public.get_adventure_visit_count() to anon, authenticated;
