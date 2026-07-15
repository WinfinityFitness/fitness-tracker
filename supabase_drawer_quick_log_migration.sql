-- Extends ad_settings (see supabase_ads_migration.sql) with the set of
-- Quick Log buttons shown in the Admin Command Center dial for EVERY user
-- (the dial itself is visible to all users now, not just admin — only the
-- admin-only icons inside it stay gated client-side). Which Quick Log
-- shortcuts appear is a single global admin-set list, same "one shared
-- row" pattern as ads_enabled/updates_enabled. Defaults to all six enabled
-- so the dial is immediately useful without any admin setup.

alter table ad_settings add column if not exists quick_log_dial_buttons jsonb not null default
  '["startDayLog","endDayLog","weekendLog","trainingLog","fuelLog","communityLog"]'::jsonb;

create or replace function admin_set_quick_log_dial_buttons(p_digital_id text, p_password text, p_buttons jsonb) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update ad_settings set quick_log_dial_buttons = p_buttons, updated_at = now() where id = 1;
end;
$$;
grant execute on function admin_set_quick_log_dial_buttons(text, text, jsonb) to anon;
