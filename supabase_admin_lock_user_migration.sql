-- Master-admin account lock/unlock by Digital ID. A locked account can no
-- longer push updates to the leaderboard (its own sync silently no-ops,
-- via a WHERE clause on the upsert's ON CONFLICT DO UPDATE rather than an
-- exception -- a locked user's app shouldn't show scary errors, it just
-- stops taking effect server-side) and can't be attached to any coach.
-- Owner-only, gated by the existing, unmodified verify_admin_login.

alter table leaderboard add column if not exists locked boolean not null default false;

create or replace function public.upsert_leaderboard_entry(
  p_share_key uuid,
  p_code_name text,
  p_weight numeric,
  p_weight_unit text,
  p_weight_progress numeric,
  p_weight_progress_pct numeric,
  p_steps integer,
  p_volume_lifted numeric,
  p_volume_unit text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.leaderboard (share_key, code_name, weight, weight_unit, weight_progress, weight_progress_pct, steps, volume_lifted, volume_unit, updated_at)
  values (p_share_key, p_code_name, p_weight, p_weight_unit, p_weight_progress, p_weight_progress_pct, p_steps, p_volume_lifted, p_volume_unit, now())
  on conflict (share_key) do update set
    code_name = excluded.code_name,
    weight = excluded.weight,
    weight_unit = excluded.weight_unit,
    weight_progress = excluded.weight_progress,
    weight_progress_pct = excluded.weight_progress_pct,
    steps = excluded.steps,
    volume_lifted = excluded.volume_lifted,
    volume_unit = excluded.volume_unit,
    updated_at = now()
  where public.leaderboard.locked = false;
end;
$$;

create or replace function admin_lock_user(p_admin_digital_id text, p_admin_password text, p_target_public_id text) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  update leaderboard set locked = true where public_id = p_target_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
end;
$$;
grant execute on function admin_lock_user(text, text, text) to anon;

create or replace function admin_unlock_user(p_admin_digital_id text, p_admin_password text, p_target_public_id text) returns void
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  update leaderboard set locked = false where public_id = p_target_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
end;
$$;
grant execute on function admin_unlock_user(text, text, text) to anon;

create or replace function admin_get_user_status(p_admin_digital_id text, p_admin_password text, p_target_public_id text)
returns table (public_id text, code_name text, locked boolean, attached_coach_name text)
language plpgsql
security definer
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);
  return query
    select l.public_id, l.code_name, l.locked,
      (select c.brand_name from coach_clients cc join coaches c on c.id = cc.coach_id
       where cc.share_key = l.share_key and cc.status = 'active' limit 1)
    from leaderboard l
    where l.public_id = p_target_public_id;
end;
$$;
grant execute on function admin_get_user_status(text, text, text) to anon;

-- A locked user can't be handed to a coach either.
create or replace function coach_attach_client(
  p_coach_digital_id text, p_coach_password text, p_client_public_id text
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
declare v_share_key uuid;
declare v_code_name text;
declare v_locked boolean;
declare v_existing_coach uuid;
declare v_room_id uuid;
declare v_brand_name text;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  select share_key, code_name, locked into v_share_key, v_code_name, v_locked from leaderboard where public_id = p_client_public_id;
  if not found then
    raise exception 'No user found with that Digital ID';
  end if;
  if coalesce(v_locked, false) then
    raise exception 'This account is locked and cannot be attached to a coach.';
  end if;
  select coach_id into v_existing_coach from coach_clients
    where share_key = v_share_key and status = 'active';
  if found and v_existing_coach <> v_coach_id then
    raise exception 'This client is already attached to a different coach';
  end if;
  insert into coach_clients (coach_id, share_key, public_id, attached_via)
  values (v_coach_id, v_share_key, p_client_public_id, 'manual')
  on conflict (coach_id, share_key) do update
    set status = 'active', public_id = excluded.public_id;

  select id into v_room_id from chat_rooms where owner_coach_id = v_coach_id limit 1;
  if v_room_id is null then
    select brand_name into v_brand_name from coaches where id = v_coach_id;
    insert into chat_rooms (name, created_by_key, created_by_name, owner_coach_id)
    values (v_brand_name || ' Group', v_share_key, v_code_name, v_coach_id)
    returning id into v_room_id;
    insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
    values (v_room_id, v_share_key, v_code_name, 'joined', v_share_key);
  else
    insert into chat_room_members (room_id, share_key, code_name, status, invited_by_key)
    values (v_room_id, v_share_key, v_code_name, 'joined', v_share_key)
    on conflict (room_id, share_key) do update set status = 'joined';
  end if;
end;
$$;
grant execute on function coach_attach_client(text, text, text) to anon;

notify pgrst, 'reload schema';
