-- "Assess for New Assignment" — an admin (coach), viewing a real opted-in
-- user's card on the Progress Showcase, can request an updated assessment
-- bundle from them. The request goes to the user's own phone as a push
-- notification; they fulfill it by opening FT and tapping the EXISTING
-- Request Assessment button (buildAssessmentBlobs/initRequestAssessment in
-- app.js), which already generates PNG summary cards from their own local
-- data. This migration adds the pieces needed for that submission to also
-- reach the admin: a storage bucket for the zipped bundle, a tracking
-- table, and the RPCs connecting the two sides.
--
-- Admin-only, confirmed with the user — the showcase page has no
-- authentication otherwise, so every read/write here that exposes a real
-- user's data is gated behind verify_admin_login (existing function, same
-- re-verify-every-call pattern every other admin RPC in this app already
-- uses — there's no server-side admin session to rely on).

-- ---------------------------------------------------------------------
-- Storage bucket for the zipped assessment bundle — same shape as the
-- existing chat-images bucket, kept separate since it's unrelated content.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('assessment-zips', 'assessment-zips', true)
on conflict (id) do nothing;

drop policy if exists "assessment zips are publicly readable" on storage.objects;
create policy "assessment zips are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'assessment-zips');

drop policy if exists "anyone can upload an assessment zip" on storage.objects;
create policy "anyone can upload an assessment zip"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'assessment-zips');

-- ---------------------------------------------------------------------
-- Tracking table — zero anon policies/grants, only reachable through the
-- RPCs below (matches web_sync_accounts's lockdown, not chat-images's own
-- permissive table policies).
-- ---------------------------------------------------------------------
create table if not exists assessment_requests (
  share_key uuid primary key references leaderboard(share_key) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  requested_by_admin text,
  requested_at timestamptz,
  zip_url text,
  ready_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table assessment_requests enable row level security;

-- Admin taps "Assess for New Assignment" on a user's showcase card.
-- Resets any stale prior zip -- a fresh request always starts clean.
create or replace function request_assessment(
  p_admin_digital_id text, p_admin_password text, p_target_public_id text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share_key uuid;
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  select share_key into v_share_key from leaderboard where public_id = p_target_public_id;
  if v_share_key is null then
    raise exception 'No user found with that Digital ID';
  end if;

  insert into assessment_requests (share_key, status, requested_by_admin, requested_at, zip_url, ready_at, updated_at)
  values (v_share_key, 'pending', p_admin_digital_id, now(), null, null, now())
  on conflict (share_key) do update set
    status = 'pending',
    requested_by_admin = excluded.requested_by_admin,
    requested_at = now(),
    zip_url = null,
    ready_at = null,
    updated_at = now();

  perform notify_push(
    v_share_key, 'New Assessment Requested',
    'Your coach requested an updated assessment. Open Request Assessment to send it.',
    'assessment_request', '["ft"]'::jsonb, './?openSheet=requestAssessment'
  );
end;
$$;
grant execute on function request_assessment(text, text, text) to anon;

-- Admin re-opens the card later to check status / get the download link.
create or replace function get_assessment_request_status(
  p_admin_digital_id text, p_admin_password text, p_target_public_id text
)
returns table (status text, zip_url text, requested_at timestamptz, ready_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform verify_admin_login(p_admin_digital_id, p_admin_password);

  return query
  select ar.status, ar.zip_url, ar.requested_at, ar.ready_at
  from assessment_requests ar
  join leaderboard l on l.share_key = ar.share_key
  where l.public_id = p_target_public_id;
end;
$$;
grant execute on function get_assessment_request_status(text, text, text) to anon;

-- The user's OWN device checking whether they have a pending request --
-- no admin credentials involved, same "share_key is the trust anchor, no
-- real per-request auth exists" convention as the rest of this app (e.g.
-- send_chat_message, upsert_leaderboard_entry).
create or replace function get_my_assessment_request(p_share_key uuid)
returns table (status text, requested_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select ar.status, ar.requested_at from assessment_requests ar where ar.share_key = p_share_key;
$$;
grant execute on function get_my_assessment_request(uuid) to anon;

-- The user's device, after zipping+uploading, marks the request ready.
-- A call with no matching pending row is a harmless no-op.
create or replace function submit_assessment_zip(p_share_key uuid, p_zip_url text) returns void
language sql
security definer
set search_path = public
as $$
  update assessment_requests
  set status = 'ready', zip_url = p_zip_url, ready_at = now(), updated_at = now()
  where share_key = p_share_key and status = 'pending';
$$;
grant execute on function submit_assessment_zip(uuid, text) to anon;

notify pgrst, 'reload schema';
