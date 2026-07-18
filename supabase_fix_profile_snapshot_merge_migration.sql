-- Fix: web_sync_push_snapshot was doing `profile = p_profile` — a full
-- REPLACE of the stored profile blob, not a merge. Both the mobile app's
-- auto-sync (pushWebSyncSnapshot) and the desktop cover-photo editor
-- (wdsPushProfileUpdate) call this same RPC. Mobile's own local profile
-- has never had coverPhotoDataUrl/coverPhotoPosY (those only ever get
-- set from the desktop cover editor), so any mobile sync AFTER a desktop
-- cover-photo save would silently wipe it back out — the profile column
-- got overwritten with mobile's version, which never carried those keys.
--
-- Merging via jsonb `||` instead preserves any existing key the incoming
-- payload doesn't mention, while still letting a field explicitly present
-- in the payload (including an explicit null, e.g. removing the cover
-- photo from the desktop side) overwrite the old value as before.
create or replace function web_sync_push_snapshot(p_share_key uuid, p_profile jsonb, p_theme text, p_skin text) returns void
language plpgsql
security definer
as $$
begin
  update web_sync_accounts
  set profile = coalesce(profile, '{}'::jsonb) || p_profile, theme = p_theme, skin = p_skin, updated_at = now()
  where share_key = p_share_key;
  if not found then
    raise exception 'Web sync is not enabled for this account';
  end if;
end;
$$;

notify pgrst, 'reload schema';
