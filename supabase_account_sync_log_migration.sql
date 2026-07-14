-- Sync Logs: records the email address (via Google sign-in during Drive
-- backup), gender, and manually-set weather location for each Digital ID
-- that has ever connected Google Drive backup. Purely additive — separate
-- table from leaderboard, RLS-locked with no anon read policy at all, so
-- the only way to read rows back is the admin-gated RPC below (SECURITY
-- DEFINER bypasses RLS). Write path (set_account_sync_log) stays open to
-- anon, same trust model as set_fitness_mode/set_public_id/etc: a device
-- can only ever write its own share_key's row, same as everywhere else in
-- this app that has no real user auth.

create table if not exists account_sync_log (
  share_key uuid primary key,
  public_id text,
  email text,
  gender text,
  location text,
  updated_at timestamptz not null default now()
);
alter table account_sync_log enable row level security;
-- No policies at all — anon has zero direct table access either way;
-- every read/write goes through the SECURITY DEFINER functions below.

create or replace function set_account_sync_log(
  p_share_key uuid,
  p_public_id text,
  p_email text,
  p_gender text,
  p_location text
) returns void
language sql
security definer
as $$
  insert into account_sync_log (share_key, public_id, email, gender, location, updated_at)
  values (p_share_key, p_public_id, p_email, p_gender, p_location, now())
  on conflict (share_key) do update
  set public_id = excluded.public_id,
      email = excluded.email,
      gender = excluded.gender,
      location = excluded.location,
      updated_at = now();
$$;
grant execute on function set_account_sync_log(uuid, text, text, text, text) to anon;

create or replace function admin_list_account_sync_log(p_digital_id text, p_password text)
returns table (public_id text, email text, gender text, location text, updated_at timestamptz)
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  return query
    select a.public_id, a.email, a.gender, a.location, a.updated_at
    from account_sync_log a
    order by a.public_id asc nulls last;
end;
$$;
grant execute on function admin_list_account_sync_log(text, text) to anon;
