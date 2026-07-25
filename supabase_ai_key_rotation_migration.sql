-- Multiple admin-managed Gemini API keys with silent quota rotation, same
-- idea as QuizForge's client-side BYOK rotation but adapted for Winfinity's
-- different trust model: the key(s) stay server-side (never shipped to the
-- public GitHub Pages bundle), shared by every user transparently. The
-- admin can add several keys (e.g. from different Google accounts) via a
-- new "AI API Keys" button in FT's Menu tab; estimate-food-nutrition tries
-- each key in turn on a quota-exhausted error before actually failing.
--
-- Singleton row, same pattern as ad_settings/app_splash_settings. No public
-- read/write policies/grants at all -- only reachable via the two admin
-- RPCs below (both password-gated, same stateless verify_admin_login-per-
-- call convention as every other admin RPC in this project) and the edge
-- function's own service-role client (Supabase auto-injects SUPABASE_URL/
-- SUPABASE_SERVICE_ROLE_KEY into every edge function -- no new secret to
-- set manually for this).
create table if not exists ai_key_settings (
  id int primary key default 1 check (id = 1),
  keys jsonb not null default '[]'::jsonb  -- [{ "label": "Key 1", "key": "AIza..." }, ...]
);
insert into ai_key_settings (id, keys) values (1, '[]'::jsonb) on conflict (id) do nothing;
alter table ai_key_settings enable row level security;

create or replace function admin_set_ai_keys(
  p_digital_id text,
  p_password text,
  p_keys jsonb
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_digital_id, p_password);
  update ai_key_settings set keys = p_keys where id = 1;
end;
$$;
grant execute on function admin_set_ai_keys(text, text, jsonb) to anon;

create or replace function admin_get_ai_keys(
  p_digital_id text,
  p_password text
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_keys jsonb;
begin
  perform verify_admin_login(p_digital_id, p_password);
  select keys into v_keys from ai_key_settings where id = 1;
  return coalesce(v_keys, '[]'::jsonb);
end;
$$;
grant execute on function admin_get_ai_keys(text, text) to anon;

notify pgrst, 'reload schema';
