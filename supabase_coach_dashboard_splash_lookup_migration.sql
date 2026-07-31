-- Coach Dashboard: the in-page web splash defaults to the same FT splash
-- everyone sees, but should show a coach's OWN custom splash (set via
-- Coach Portal > Boot Splash Logo) on their own device going forward --
-- same idea as how an attached CLIENT's app already picks up their coach's
-- splash via get_my_coach_features. There's no equivalent lookup for the
-- COACH's own account (that function is keyed by an attached client's
-- share_key), and the splash needs to resolve before login (no password
-- typed yet) using a digital_id remembered from the coach's last login on
-- this device.
--
-- Public/no-credential by design, same precedent as get_coach_branding_by_slug:
-- this only exposes a coach's OWN splash image/caption, which is already
-- meant to be publicly visible (their own clients see it), keyed by their
-- already-shared-with-clients Digital ID -- not a new privacy exposure.
create or replace function get_coach_splash_by_digital_id(p_coach_digital_id text)
returns table (
  splash_image_url text,
  splash_image_zoom numeric,
  splash_image_pos_x numeric,
  splash_image_pos_y numeric,
  splash_caption text
)
language sql
security definer
as $$
  select s.splash_image_url, s.splash_image_zoom, s.splash_image_pos_x, s.splash_image_pos_y, s.splash_caption
  from coaches c
  join coach_splash_settings s on s.coach_id = c.id
  where c.digital_id = p_coach_digital_id and c.active;
$$;
grant execute on function get_coach_splash_by_digital_id(text) to anon;

notify pgrst, 'reload schema';
