-- Admin-only global kill switch for app updates, reusing the same
-- single-row ad_settings table/RLS pattern from supabase_ads_migration.sql.
-- When off, no client checks for or applies a new service worker version —
-- everyone stays frozen on whatever build they currently have cached until
-- an admin flips it back on. Toggle itself is only visible in the app UI
-- when logged in as admin; the effect applies to every user.

alter table ad_settings add column if not exists updates_enabled boolean not null default true;

create or replace function admin_set_updates_enabled(p_digital_id text, p_password text, p_enabled boolean) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update ad_settings set updates_enabled = p_enabled, updated_at = now() where id = 1;
end;
$$;
grant execute on function admin_set_updates_enabled(text, text, boolean) to anon;
