-- "Could not find the function ... in the schema cache" for
-- coach_set_splash_image means PostgREST's cached function list doesn't
-- match what's actually in the database -- re-running the exact same
-- create (with an explicit drop first, since the argument list changed
-- from the pre-caption version) and a fresh reload notification clears it.
drop function if exists coach_set_splash_image(text, text, text, numeric, numeric, numeric);
drop function if exists coach_set_splash_image(text, text, text, numeric, numeric, numeric, text);

create or replace function coach_set_splash_image(
  p_coach_digital_id text, p_coach_password text, p_image_url text,
  p_image_zoom numeric, p_image_pos_x numeric, p_image_pos_y numeric,
  p_splash_caption text default null
) returns void
language plpgsql
security definer
as $$
declare v_coach_id uuid;
begin
  v_coach_id := verify_coach_login(p_coach_digital_id, p_coach_password);
  insert into coach_splash_settings (coach_id, splash_image_url, splash_image_zoom, splash_image_pos_x, splash_image_pos_y, splash_caption)
  values (
    v_coach_id, nullif(p_image_url, ''),
    greatest(1, least(3, coalesce(p_image_zoom, 1))),
    greatest(0, least(100, coalesce(p_image_pos_x, 50))),
    greatest(0, least(100, coalesce(p_image_pos_y, 50))),
    nullif(p_splash_caption, '')
  )
  on conflict (coach_id) do update set
    splash_image_url = excluded.splash_image_url,
    splash_image_zoom = excluded.splash_image_zoom,
    splash_image_pos_x = excluded.splash_image_pos_x,
    splash_image_pos_y = excluded.splash_image_pos_y,
    splash_caption = excluded.splash_caption,
    updated_at = now();
end;
$$;
grant execute on function coach_set_splash_image(text, text, text, numeric, numeric, numeric, text) to anon;

notify pgrst, 'reload schema';
