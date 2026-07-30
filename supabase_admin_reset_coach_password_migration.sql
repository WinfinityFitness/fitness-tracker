-- Owner-only: reset a coach's password directly when they're locked out and
-- contact the owner out-of-band -- no email/token flow to build or secure.
-- Gated by the existing, UNMODIFIED verify_admin_login, same convention as
-- every other admin_* function in supabase_coach_tenancy_migration.sql.
-- Also clears failed_attempts/locked_until -- a real incident (2026-07-30)
-- showed a password-only reset can leave a coach still locked out even with
-- the correct new password, since verify_coach_login's lockout counter is
-- separate from the password hash.

create or replace function admin_reset_coach_password(
  p_admin_digital_id text, p_admin_password text,
  p_coach_id uuid, p_new_password text
) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  if p_new_password is null or length(p_new_password) < 6 then
    raise exception 'New password must be at least 6 characters.';
  end if;
  update coaches set
    password_hash = crypt(p_new_password, gen_salt('bf')),
    failed_attempts = 0,
    locked_until = null,
    updated_at = now()
  where id = p_coach_id;
  if not found then
    raise exception 'No coach found with that id';
  end if;
end;
$$;
grant execute on function admin_reset_coach_password(text, text, uuid, text) to anon;
