-- Enables Realtime push for chat_messages so Nexus/Tavern/the WDS chat
-- list badge can react to new/edited messages instantly instead of
-- polling every 4-5s. That tight polling (multiplied across every open
-- Nexus/Tavern/dashboard panel, all day) is what drove the Supabase
-- org's Cached Egress over its free-tier quota last billing cycle.
-- Wrapped in a check so this is safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table chat_messages;
  end if;
end $$;