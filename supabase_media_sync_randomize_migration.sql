-- Adds a "randomize image in slide" option to the Food Prep Options
-- widget's slideshow settings — when on, the slideshow picks a random
-- (different) image each tick instead of cycling in order.

alter table media_sync_settings add column if not exists randomize boolean not null default false;

drop function if exists admin_set_media_sync(text, text, text, jsonb, int);

create or replace function admin_set_media_sync(
  p_digital_id text, p_password text,
  p_mode text, p_image_urls jsonb, p_duration_sec int, p_randomize boolean
) returns void
language plpgsql
security definer
as $$
begin
  if not (p_digital_id = 'WF-B932GB' and p_password = 'admin082801') then
    raise exception 'Not authorized';
  end if;
  update media_sync_settings
  set mode = p_mode,
      image_urls = p_image_urls,
      duration_sec = greatest(3, least(60, p_duration_sec)),
      randomize = coalesce(p_randomize, false),
      updated_at = now()
  where id = 1;
end;
$$;
grant execute on function admin_set_media_sync(text, text, text, jsonb, int, boolean) to anon;
