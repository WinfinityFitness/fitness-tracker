-- Admin tool: transfer a Digital ID from one leaderboard account to another
-- label, fully replacing whatever currently sits at the destination ID.
-- Run this once in the Supabase SQL editor. Companion to
-- supabase_announcement_migration.sql — reuses the exact same admin
-- credential check pattern (hardcoded inside a SECURITY DEFINER function,
-- never shipped to the client).
--
-- Everything else tied to an account (chat rooms, push subscriptions,
-- reminder settings) is keyed by the account's share_key, which this
-- function never touches — only the public_id label moves, so nothing
-- else needs to be migrated.

create or replace function admin_transfer_digital_id(
  p_digital_id text, p_password text,
  p_old_public_id text, p_new_public_id text
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  if not exists (select 1 from leaderboard where public_id = p_old_public_id) then
    raise exception 'No user found with that Digital ID';
  end if;
  -- Clear out whatever's currently at the destination ID first — the old
  -- unique constraint on public_id would otherwise block the update below.
  delete from leaderboard where public_id = p_new_public_id and public_id <> p_old_public_id;
  update leaderboard set public_id = p_new_public_id where public_id = p_old_public_id;
end;
$$;

grant execute on function admin_transfer_digital_id(text, text, text, text) to anon;
