-- Coach white-label tenancy — Phase D.5: Wellness dashboard "Group Page"
-- per coach (Facebook-Groups-style, per owner-provided reference). Unlike
-- the FT Nexus group chat (which reuses chat_rooms), Wellness's feed
-- system has no group concept at all today -- feed_posts is one global
-- feed with only Public/Friends/Only-Me visibility. This is genuinely new
-- schema, modeled directly on feed_posts' own shape (share_key anchor,
-- code_name snapshot, soft-delete via `deleted`), but LOCKED DOWN (zero
-- anon policies) rather than feed_posts' permissive public-read pattern --
-- a coach's group must only be visible to that coach's own members,
-- enforced inside these RPCs since RLS can't express that without real
-- per-request auth.
--
-- Scope for this pass, per explicit owner direction: only the Discussion
-- tab (post + read) is real. Everything else in the FB-Groups-style UI
-- (Events/Media/Files/People, Featured, admin tools sidebar, Insights) is
-- a visible "coming soon" preview in the UI, not backed by anything here.

create table if not exists coach_group_posts (
  id bigint generated always as identity primary key,
  coach_id uuid not null references coaches(id) on delete cascade,
  share_key uuid not null,
  code_name text not null,
  message text not null default '',
  image_url text,
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);
alter table coach_group_posts enable row level security;
-- zero anon policies -- reachable only through the RPCs below.

create or replace function post_to_coach_group(p_share_key uuid, p_message text, p_image_url text default null)
returns bigint
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_code_name text;
declare v_post_id bigint;
begin
  select cc.coach_id into v_coach_id from coach_clients cc where cc.share_key = p_share_key and cc.status = 'active';
  if v_coach_id is null then
    raise exception 'You are not attached to a coach.';
  end if;
  if (p_message is null or char_length(trim(p_message)) = 0) and p_image_url is null then
    raise exception 'Post cannot be empty.';
  end if;
  if p_message is not null and char_length(p_message) > 2000 then
    raise exception 'Post is too long.';
  end if;
  select code_name into v_code_name from leaderboard where share_key = p_share_key;
  insert into coach_group_posts (coach_id, share_key, code_name, message, image_url)
  values (v_coach_id, p_share_key, coalesce(v_code_name, 'Member'), coalesce(p_message, ''), p_image_url)
  returning id into v_post_id;
  return v_post_id;
end;
$$;
grant execute on function post_to_coach_group(uuid, text, text) to anon;

create or replace function get_coach_group_posts(p_share_key uuid)
returns table (id bigint, share_key uuid, code_name text, message text, image_url text, created_at timestamptz)
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  select cc.coach_id into v_coach_id from coach_clients cc where cc.share_key = p_share_key and cc.status = 'active';
  if v_coach_id is null then
    return; -- not a member of any coach's group -- empty result, not an error
  end if;
  return query
    select p.id, p.share_key, p.code_name, p.message, p.image_url, p.created_at
    from coach_group_posts p
    where p.coach_id = v_coach_id and p.deleted = false
    order by p.created_at desc
    limit 100;
end;
$$;
grant execute on function get_coach_group_posts(uuid) to anon;

create or replace function unsend_coach_group_post(p_post_id bigint, p_share_key uuid) returns void
language sql
security definer
as $$
  update coach_group_posts set deleted = true where id = p_post_id and share_key = p_share_key;
$$;
grant execute on function unsend_coach_group_post(bigint, uuid) to anon;

-- Group page header info: brand + member count, for a MEMBER's own view
-- (distinct from coach_list_clients, which needs coach credentials --
-- this is self-service like get_my_coach_features, no credentials needed).
create or replace function get_coach_group_info(p_share_key uuid)
returns table (has_coach boolean, brand_name text, brand_logo_url text, member_count bigint)
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  select cc.coach_id into v_coach_id from coach_clients cc where cc.share_key = p_share_key and cc.status = 'active';
  if v_coach_id is null then
    return query select false, null::text, null::text, 0::bigint;
    return;
  end if;
  return query
    select true, c.brand_name, c.brand_logo_url,
      (select count(*) from coach_clients cc2 where cc2.coach_id = v_coach_id and cc2.status = 'active')
    from coaches c where c.id = v_coach_id;
end;
$$;
grant execute on function get_coach_group_info(uuid) to anon;

notify pgrst, 'reload schema';
