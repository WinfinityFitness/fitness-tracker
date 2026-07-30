-- Lets a coach assign their own private nickname/name for a client --
-- visible only to that coach (lives on coach_clients, which is already
-- scoped per-coach, so no extra access-control is needed beyond the
-- existing coach_id ownership check every coach_* function already does).
-- The client never sees this, and it has no effect on their own Digital
-- ID, code name, or anything else in their own app.

alter table coach_clients add column if not exists client_nickname text;

create or replace function coach_set_client_nickname(
  p_coach_digital_id text, p_coach_password text, p_client_public_id text, p_nickname text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  update coach_clients set client_nickname = nullif(trim(p_nickname), '')
  where coach_id = v_coach_id and public_id = p_client_public_id and status = 'active';
  if not found then
    raise exception 'This user is not one of your attached clients.';
  end if;
end;
$$;
grant execute on function coach_set_client_nickname(text, text, text, text) to anon;

-- Drop first: adding client_nickname to the returned columns changes the
-- function's row type, which plain CREATE OR REPLACE can't do (see
-- supabase_coach_splash_caption_migration.sql for the same situation).
drop function if exists coach_list_clients(text, text);
create or replace function coach_list_clients(p_coach_digital_id text, p_coach_password text)
returns table (share_key uuid, public_id text, client_nickname text, attached_at timestamptz)
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  return query
    select cc.share_key, cc.public_id, cc.client_nickname, cc.created_at
    from coach_clients cc
    where cc.coach_id = v_coach_id and cc.status = 'active'
    order by cc.created_at desc;
end;
$$;
grant execute on function coach_list_clients(text, text) to anon;

notify pgrst, 'reload schema';
