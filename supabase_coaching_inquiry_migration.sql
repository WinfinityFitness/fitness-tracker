-- Coaching Inquiry card on winfinityfitness.com (WordPress, embedded via
-- coaching-inquiry-embed.js) -- lets a site visitor with no account submit
-- their name/contact/message, landing in an admin-only inbox inside the
-- Coach Portal. Same lockdown shape as assessment_requests: RLS on with
-- zero anon table policies, everything routed through SECURITY DEFINER
-- RPCs, admin reads re-verified via verify_admin_login on every call (no
-- server-side admin session exists to trust instead).

create table if not exists coaching_inquiries (
  id bigint generated always as identity primary key,
  name text not null,
  contact text not null,
  message text not null,
  submitted_at timestamptz not null default now(),
  is_read boolean not null default false
);
alter table coaching_inquiries enable row level security;

-- Public submission from the WordPress card -- no admin credentials
-- involved, matches the "anyone can write, nobody can read back" shape
-- anon gets everywhere else in this app (e.g. submit_assessment_zip).
create or replace function submit_coaching_inquiry(
  p_name text, p_contact text, p_message text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Name is required';
  end if;
  if trim(coalesce(p_contact, '')) = '' then
    raise exception 'A phone number or email is required';
  end if;
  if trim(coalesce(p_message, '')) = '' then
    raise exception 'Message is required';
  end if;

  insert into coaching_inquiries (name, contact, message)
  values (trim(p_name), trim(p_contact), trim(p_message));
end;
$$;
grant execute on function submit_coaching_inquiry(text, text, text) to anon;

-- Admin-only inbox listing, newest first.
create or replace function admin_list_coaching_inquiries(
  p_admin_digital_id text, p_admin_password text
)
returns table (
  id bigint, name text, contact text, message text,
  submitted_at timestamptz, is_read boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  return query
  select ci.id, ci.name, ci.contact, ci.message, ci.submitted_at, ci.is_read
  from coaching_inquiries ci
  order by ci.submitted_at desc;
end;
$$;
grant execute on function admin_list_coaching_inquiries(text, text) to anon;

-- Admin marks one inquiry read/unread from the inbox UI.
create or replace function admin_set_coaching_inquiry_read(
  p_admin_digital_id text, p_admin_password text, p_id bigint, p_is_read boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  update coaching_inquiries set is_read = p_is_read where id = p_id;
end;
$$;
grant execute on function admin_set_coaching_inquiry_read(text, text, bigint, boolean) to anon;

-- Admin deletes an inquiry once handled/no longer needed.
create or replace function admin_delete_coaching_inquiry(
  p_admin_digital_id text, p_admin_password text, p_id bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  delete from coaching_inquiries where id = p_id;
end;
$$;
grant execute on function admin_delete_coaching_inquiry(text, text, bigint) to anon;

notify pgrst, 'reload schema';
