-- Site visit counter for winfinityfitness.com (footer-embed.html).
-- Single-row counter, only ever touched through record_site_visit() -- the
-- table itself stays locked down (RLS on, no policies), same posture as
-- other admin-only counters in this project.

create table if not exists public.site_visits (
  id int primary key default 1,
  visit_count bigint not null default 0,
  constraint site_visits_singleton check (id = 1)
);

insert into public.site_visits (id, visit_count)
values (1, 0)
on conflict (id) do nothing;

alter table public.site_visits enable row level security;

-- Atomically increments and returns the new total. Called once per browser
-- session from footer-embed.html (guarded client-side via sessionStorage so
-- navigating between pages within one visit doesn't multi-count) -- runs for
-- every visitor, not just admins; the admin gate in the embed only controls
-- whether the *returned* count is ever displayed on screen.
create or replace function public.record_site_visit()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count bigint;
begin
  update public.site_visits set visit_count = visit_count + 1 where id = 1
  returning visit_count into new_count;
  return new_count;
end;
$$;

grant execute on function public.record_site_visit() to anon, authenticated;

-- Read-only companion for the admin-unlock flow in footer-embed.html: a
-- repeat page load within the same browser session skips record_site_visit
-- (see the sessionStorage guard client-side), so if admin unlock happens on
-- one of those loads there's no fresh increment result to show -- this just
-- reads the current total without touching it.
create or replace function public.get_site_visit_count()
returns bigint
language sql
security definer
set search_path = public
as $$
  select visit_count from public.site_visits where id = 1;
$$;

grant execute on function public.get_site_visit_count() to anon, authenticated;
