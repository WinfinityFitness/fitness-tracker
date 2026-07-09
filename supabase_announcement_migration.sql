-- Nexus announcement banner migration for Winfinity Tracker.
-- Run this once in the Supabase SQL editor for the project.
--
-- The admin's Digital ID and password live ONLY in this SQL, inside
-- security-definer functions that run on the database, never in app.js,
-- index.html, or config.js. Nothing shipped to the client (or visible by
-- viewing page source / dev tools "Sources") can reveal them — the client
-- only ever sends a login attempt and gets back true/false.
--
-- To change the admin credentials later, edit the two literal values below
-- (both functions) and re-run this file.

create table if not exists announcements (
  id int primary key default 1,
  message text not null default '',
  updated_at timestamptz not null default now(),
  constraint announcements_single_row check (id = 1)
);
insert into announcements (id, message) values (1, '') on conflict (id) do nothing;

alter table announcements enable row level security;

drop policy if exists "anon read announcements" on announcements;
create policy "anon read announcements" on announcements for select using (true);
-- Deliberately no anon insert/update/delete policy — all writes go through
-- set_announcement() below, which enforces the admin check server-side.

create or replace function verify_admin_login(p_digital_id text, p_password text) returns boolean
language sql
security definer
as $$
  select p_digital_id = 'WF-B932GB' and p_password = '082801';
$$;

grant execute on function verify_admin_login(text, text) to anon;

create or replace function set_announcement(p_digital_id text, p_password text, p_message text) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = '082801') then
    raise exception 'Not authorized';
  end if;
  update announcements set message = p_message, updated_at = now() where id = 1;
end;
$$;

grant execute on function set_announcement(text, text, text) to anon;
