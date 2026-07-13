-- Backs the "Keep Digital ID" checkbox on Clear All Data: when left
-- unchecked, this fully removes the user's server-side footprint across
-- every table keyed by share_key, so clearing data genuinely resets them
-- to a blank slate on the Nexus too, not just locally. The client then
-- generates a brand-new share_key/Digital ID afterward.

create or replace function delete_account_data(p_share_key uuid) returns void
language plpgsql
security definer
as $$
begin
  delete from leaderboard where share_key = p_share_key;
  delete from chat_room_members where share_key = p_share_key;
  delete from chat_messages where sender_share_key = p_share_key;
  delete from chat_message_reactions where share_key = p_share_key;
  delete from push_subscriptions where share_key = p_share_key;
  delete from reminder_settings where share_key = p_share_key;
  delete from assigned_targets where share_key = p_share_key;
end;
$$;

grant execute on function delete_account_data(uuid) to anon;
