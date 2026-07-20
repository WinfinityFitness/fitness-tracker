'use strict';
// One-off maintenance script: migrates existing base64 avatar/cover photos
// (leaderboard.avatar_data_url, web_sync_accounts.profile.{photoDataUrl,
// coverPhotoDataUrl}) into Supabase Storage (chat-images bucket), replacing
// each base64 value with the resulting https:// URL. See
// C:\Users\aldwi\.claude\plans\staged-dazzling-candle.md for the full plan
// this is part of.
//
// Idempotent: both passes only touch rows that still look like base64, so
// a partial/failed run is safe to just re-run.
//
// Usage:
//   node scripts/backfill-profile-images.js                # leaderboard only (anon key)
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-profile-images.js   # also backfills web_sync_accounts
//
// SUPABASE_SERVICE_ROLE_KEY is required for the web_sync_accounts pass
// because that table has zero anon RLS policies (by design — see
// supabase_friends_and_visibility_migration.sql). Get it from Supabase
// dashboard -> Project Settings -> API -> service_role key. Pass it via
// environment variable only — never hardcode it here or commit it anywhere.

const SUPABASE_URL = 'https://mzkjboplfalauivwcnni.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16a2pib3BsZmFsYXVpdndjbm5pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNTM4MTMsImV4cCI6MjA5ODcyOTgxM30.62tmKUxeKSLHhPuDZ6akBJq4e8QV4LqfklZEqa4OGUM';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;

function isBase64DataUrl(v) {
  return typeof v === 'string' && v.startsWith('data:');
}

async function uploadBase64ToStorage(dataUrl, path, apiKey) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Not a valid base64 data URL');
  const [, contentType, b64] = match;
  const buf = Buffer.from(b64, 'base64');
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/chat-images/${path}`, {
    method: 'POST',
    headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': contentType },
    body: buf,
  });
  if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/chat-images/${path}`;
}

async function backfillLeaderboard() {
  console.log('\n=== leaderboard.avatar_data_url ===');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/leaderboard?avatar_data_url=like.data:*&select=share_key,avatar_data_url,code_name,public_id`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  console.log(`${rows.length} row(s) with a base64 avatar to migrate.`);

  let ok = 0, failed = 0;
  for (const row of rows) {
    try {
      const path = `avatars/${row.share_key}/backfill-${Date.now()}.jpg`;
      const url = await uploadBase64ToStorage(row.avatar_data_url, path, SUPABASE_ANON_KEY);
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_leaderboard_avatar`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_share_key: row.share_key, p_avatar_data_url: url,
          p_code_name: row.code_name, p_public_id: row.public_id,
        }),
      });
      if (!rpcRes.ok) throw new Error(`set_leaderboard_avatar failed (${rpcRes.status}): ${await rpcRes.text()}`);
      console.log(`  OK   ${row.share_key}`);
      ok++;
    } catch (e) {
      console.error(`  FAIL ${row.share_key}: ${e.message}`);
      failed++;
    }
  }
  console.log(`leaderboard: ${ok} migrated, ${failed} failed.`);
}

async function backfillWebSyncAccounts() {
  console.log('\n=== web_sync_accounts.profile ===');
  if (!SERVICE_ROLE_KEY) {
    console.log('Skipped — set SUPABASE_SERVICE_ROLE_KEY to also backfill this table (requires bypassing RLS).');
    return;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/web_sync_accounts?select=share_key,profile`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${await res.text()}`);
  const rows = await res.json();

  let ok = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    const profile = row.profile || {};
    let changed = false;
    try {
      if (isBase64DataUrl(profile.photoDataUrl)) {
        const path = `avatars/${row.share_key}/backfill-${Date.now()}.jpg`;
        profile.photoDataUrl = await uploadBase64ToStorage(profile.photoDataUrl, path, SERVICE_ROLE_KEY);
        changed = true;
      }
      if (isBase64DataUrl(profile.coverPhotoDataUrl)) {
        const path = `covers/${row.share_key}/backfill-${Date.now()}.jpg`;
        profile.coverPhotoDataUrl = await uploadBase64ToStorage(profile.coverPhotoDataUrl, path, SERVICE_ROLE_KEY);
        changed = true;
      }
      if (!changed) { skipped++; continue; }
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/web_sync_accounts?share_key=eq.${row.share_key}`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ profile }),
      });
      if (!patchRes.ok) throw new Error(`Row update failed (${patchRes.status}): ${await patchRes.text()}`);
      console.log(`  OK   ${row.share_key}`);
      ok++;
    } catch (e) {
      console.error(`  FAIL ${row.share_key}: ${e.message}`);
      failed++;
    }
  }
  console.log(`web_sync_accounts: ${ok} migrated, ${failed} failed, ${skipped} already clean.`);
}

(async () => {
  try {
    await backfillLeaderboard();
    await backfillWebSyncAccounts();
    console.log('\nDone.');
  } catch (e) {
    console.error('\nBackfill aborted:', e.message);
    process.exit(1);
  }
})();
