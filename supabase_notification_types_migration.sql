-- Curated external (OS) notification types per surface. Wellness's in-app
-- bell (wdsPushNotification/renderWdsNotifications) is untouched — this is
-- only about which events ever leave the app as a real push notification.
--
-- Wellness external pushes: New Post, New Comment, New Story (My Day), New
-- Shout, New Share, Friend Request, Friend Request Accepted.
-- Messenger external pushes: New Message (DM), New Nexus Chat (throttled to
-- once per unread streak, not every message), Reaction on a message, New
-- Shout.
-- Nothing else pushes externally. In particular this REPLACES notify_dm_push
-- from supabase_notification_routing_migration.sql: chat DMs are now
-- Messenger-only, no more falling back to Wellness/FT when Messenger isn't
-- installed (a user without Messenger installed simply won't get an
-- external ping for a new DM — they'll still see it in-app whenever they
-- next open Wellness/FT). The existing messenger_auto_redirect toggle/RPC
-- is left in place but has no effect anymore, since routing no longer
-- varies by it — every DM push already targets Messenger directly now.
--
-- Send-push and app_filter (from supabase_notification_routing_migration.sql)
-- are reused unchanged -- this file is pure SQL, no Edge Function redeploy
-- needed.

-- ---------------------------------------------------------------------
-- Shared helper -- every trigger below calls this instead of repeating
-- the net.http_post boilerplate. Not granted to anon; only ever called
-- from inside other SECURITY DEFINER trigger functions.
-- ---------------------------------------------------------------------
create or replace function notify_push(
  p_share_key uuid, p_title text, p_body text, p_type text, p_app_filter jsonb, p_url text default null
) returns void
language plpgsql
security definer
as $$
declare
  v_service_key text;
begin
  select decrypted_secret into v_service_key from vault.decrypted_secrets where name = 'service_role_key' limit 1;
  if v_service_key is null then
    return;
  end if;
  perform net.http_post(
    url := 'https://mzkjboplfalauivwcnni.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
    body := jsonb_build_object('share_key', p_share_key, 'title', p_title, 'body', p_body, 'type', p_type, 'app_filter', p_app_filter, 'url', p_url)
  );
end;
$$;

-- Fans a Wellness push out to every accepted friend of p_poster_share_key.
-- Used by New Post / New Story / New Shout -- all "your friends should
-- know" events, regardless of a post's own public/friends/only_me
-- visibility (friends are already an opt-in, bounded, mutual-accept
-- audience, so this stays simple rather than replicating
-- get_visible_feed_posts' full visibility logic here too).
create or replace function notify_friends_push(p_poster_share_key uuid, p_title text, p_body text, p_type text) returns void
language plpgsql
security definer
as $$
declare
  r record;
begin
  for r in
    select case when requester_share_key = p_poster_share_key then addressee_share_key else requester_share_key end as friend_key
    from friendships
    where status = 'accepted' and (requester_share_key = p_poster_share_key or addressee_share_key = p_poster_share_key)
  loop
    perform notify_push(r.friend_key, p_title, p_body, p_type, '["wellness"]'::jsonb);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Wellness: New Post (a plain post, not a share of someone else's)
-- ---------------------------------------------------------------------
create or replace function notify_feed_post() returns trigger
language plpgsql
security definer
as $$
begin
  if new.shared_post_id is not null then
    return new; -- a share, handled by notify_feed_share below
  end if;
  perform notify_friends_push(new.share_key, 'New Post', new.code_name || ' shared a new post.', 'post');
  return new;
end;
$$;
drop trigger if exists trg_notify_feed_post on feed_posts;
create trigger trg_notify_feed_post after insert on feed_posts for each row execute function notify_feed_post();

-- ---------------------------------------------------------------------
-- Wellness: New Share (someone shared YOUR post — single recipient, the
-- original post's owner, not the sharer's own friends)
-- ---------------------------------------------------------------------
create or replace function notify_feed_share() returns trigger
language plpgsql
security definer
as $$
declare
  v_owner_key uuid;
begin
  if new.shared_post_id is null then
    return new;
  end if;
  select share_key into v_owner_key from feed_posts where id = new.shared_post_id;
  if v_owner_key is null or v_owner_key = new.share_key then
    return new;
  end if;
  perform notify_push(v_owner_key, 'New Share', new.code_name || ' shared your post.', 'share', '["wellness"]'::jsonb);
  return new;
end;
$$;
drop trigger if exists trg_notify_feed_share on feed_posts;
create trigger trg_notify_feed_share after insert on feed_posts for each row execute function notify_feed_share();

-- ---------------------------------------------------------------------
-- Wellness: New Comment (on your post — single recipient, the post owner)
-- ---------------------------------------------------------------------
create or replace function notify_feed_comment() returns trigger
language plpgsql
security definer
as $$
declare
  v_owner_key uuid;
begin
  select share_key into v_owner_key from feed_posts where id = new.post_id;
  if v_owner_key is null or v_owner_key = new.share_key then
    return new;
  end if;
  perform notify_push(v_owner_key, 'New Comment', new.code_name || ' commented on your post.', 'comment', '["wellness"]'::jsonb);
  return new;
end;
$$;
drop trigger if exists trg_notify_feed_comment on feed_post_comments;
create trigger trg_notify_feed_comment after insert on feed_post_comments for each row execute function notify_feed_comment();

-- ---------------------------------------------------------------------
-- Wellness: New Story (My Day)
-- ---------------------------------------------------------------------
create or replace function notify_feed_story() returns trigger
language plpgsql
security definer
as $$
begin
  perform notify_friends_push(new.share_key, 'New Story', new.code_name || ' added to My Day.', 'story');
  return new;
end;
$$;
drop trigger if exists trg_notify_feed_story on feed_stories;
create trigger trg_notify_feed_story after insert on feed_stories for each row execute function notify_feed_story();

-- ---------------------------------------------------------------------
-- Wellness: New Shout (fires only when shout_text actually changes to a
-- real value -- leaderboard rows update constantly for stat syncing, this
-- must not fire on every one of those)
-- ---------------------------------------------------------------------
create or replace function notify_leaderboard_shout() returns trigger
language plpgsql
security definer
as $$
begin
  if new.shout_text is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.shout_text is not distinct from new.shout_text then
    return new;
  end if;
  perform notify_friends_push(new.share_key, 'New Shout', new.code_name || ' posted a new Shout: "' || new.shout_text || '"', 'shout');
  return new;
end;
$$;
drop trigger if exists trg_notify_leaderboard_shout on leaderboard;
create trigger trg_notify_leaderboard_shout after insert or update on leaderboard for each row execute function notify_leaderboard_shout();

-- ---------------------------------------------------------------------
-- Wellness: Friend Request (received) + Friend Request Accepted
-- ---------------------------------------------------------------------
create or replace function notify_friend_request() returns trigger
language plpgsql
security definer
as $$
declare
  v_name text;
begin
  if new.status <> 'pending' then
    return new;
  end if;
  select code_name into v_name from leaderboard where share_key = new.requester_share_key;
  perform notify_push(new.addressee_share_key, 'Friend Request', coalesce(v_name, 'Someone') || ' sent you a friend request.', 'friend_request', '["wellness"]'::jsonb);
  return new;
end;
$$;
drop trigger if exists trg_notify_friend_request on friendships;
create trigger trg_notify_friend_request after insert on friendships for each row execute function notify_friend_request();

create or replace function notify_friend_accept() returns trigger
language plpgsql
security definer
as $$
declare
  v_name text;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    select code_name into v_name from leaderboard where share_key = new.addressee_share_key;
    perform notify_push(new.requester_share_key, 'Friend Request Accepted', coalesce(v_name, 'Someone') || ' accepted your friend request.', 'friend_accept', '["wellness"]'::jsonb);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_notify_friend_accept on friendships;
create trigger trg_notify_friend_accept after update on friendships for each row execute function notify_friend_accept();

-- ---------------------------------------------------------------------
-- Messenger: New Message (DM) -- Messenger-only now, replaces the
-- Messenger>Wellness>FT fallback chain from
-- supabase_notification_routing_migration.sql.
-- ---------------------------------------------------------------------
create or replace function notify_dm_push() returns trigger
language plpgsql
security definer
as $$
declare
  v_is_dm boolean;
  v_sender_key uuid;
  v_recipient_key uuid;
begin
  if new.room_id is null then
    return new;
  end if;

  select is_dm into v_is_dm from chat_rooms where id = new.room_id;
  if not coalesce(v_is_dm, false) then
    return new;
  end if;

  select share_key into v_sender_key from chat_room_members
    where room_id = new.room_id and code_name = new.code_name limit 1;

  select share_key into v_recipient_key from chat_room_members
    where room_id = new.room_id and share_key is distinct from v_sender_key limit 1;

  if v_recipient_key is null then
    return new;
  end if;

  perform notify_push(v_recipient_key, 'New message from ' || new.code_name, left(new.message, 120), 'chat', '["messenger"]'::jsonb);
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Messenger: New Nexus Chat -- throttled to once per "went from read to
-- unread," not once per message (an active public room could otherwise
-- push every single line someone types). last_notified_at tracks when we
-- last pushed; a fresh push only fires once last_notified_at falls behind
-- their real last_read_at again (i.e. they've actually opened Nexus Com
-- since the last push, so a new one is warranted).
-- ---------------------------------------------------------------------
alter table chat_read_receipts add column if not exists last_notified_at timestamptz;

create or replace function notify_nexus_chat() returns trigger
language plpgsql
security definer
as $$
declare
  r record;
begin
  if new.room_id is not null or new.sender_share_key is null then
    return new;
  end if;
  for r in
    select ps.share_key,
           coalesce(max(crr.last_read_at), 'epoch'::timestamptz) as last_read_at,
           max(crr.last_notified_at) as last_notified_at
    from push_subscriptions ps
    left join chat_read_receipts crr on crr.room_key = 'global' and crr.share_key = ps.share_key
    where ps.app = 'messenger' and ps.share_key <> new.sender_share_key
    group by ps.share_key
  loop
    if r.last_read_at < new.created_at and (r.last_notified_at is null or r.last_notified_at < r.last_read_at) then
      perform notify_push(r.share_key, 'Nexus', 'New messages in Nexus Com.', 'nexus_chat', '["messenger"]'::jsonb);
      insert into chat_read_receipts (room_key, share_key, code_name, last_read_at, last_notified_at)
      values ('global', r.share_key, '', r.last_read_at, now())
      on conflict (room_key, share_key) do update set last_notified_at = excluded.last_notified_at;
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists trg_notify_nexus_chat on chat_messages;
create trigger trg_notify_nexus_chat after insert on chat_messages for each row execute function notify_nexus_chat();

-- ---------------------------------------------------------------------
-- Messenger: Reaction on a message (skip reacting to your own message)
-- ---------------------------------------------------------------------
create or replace function notify_chat_reaction() returns trigger
language plpgsql
security definer
as $$
declare
  v_sender_key uuid;
  v_reactor_name text;
begin
  select sender_share_key into v_sender_key from chat_messages where id = new.message_id;
  if v_sender_key is null or v_sender_key = new.share_key then
    return new;
  end if;
  select code_name into v_reactor_name from leaderboard where share_key = new.share_key;
  perform notify_push(v_sender_key, 'New Reaction', coalesce(v_reactor_name, 'Someone') || ' reacted ' || new.emoji || ' to your message.', 'reaction', '["messenger"]'::jsonb);
  return new;
end;
$$;
drop trigger if exists trg_notify_chat_reaction on chat_message_reactions;
create trigger trg_notify_chat_reaction after insert or update on chat_message_reactions for each row execute function notify_chat_reaction();

notify pgrst, 'reload schema';
