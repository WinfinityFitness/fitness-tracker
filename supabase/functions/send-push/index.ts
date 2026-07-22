// Winfinity Tracker — push sender. Delivers to BOTH Web Push subscribers
// (browser/PWA installs) and native Android app installs (Firebase Cloud
// Messaging) for a given share_key — the native Capacitor WebView doesn't
// implement the Web Push API at all, so it registers an FCM token instead
// (see fcm_tokens table / supabase_fcm_tokens_migration.sql).
//
// Deploy with: paste into Dashboard -> Edge Functions -> smooth-service's
// sibling "send-push" function (or supabase functions deploy send-push if
// CLI login is ever available — see CONVENTIONS.md, no CLI access as of
// this writing).
//
// Secrets required (Dashboard -> Edge Functions -> send-push -> Secrets):
//   VAPID_PRIVATE_KEY        — Web Push, see supabase_push_notifications_migration.sql
//   FCM_SERVICE_ACCOUNT_JSON — the FULL contents of the Firebase service
//                              account key JSON (Firebase Console -> Project
//                              settings -> Service accounts -> Generate new
//                              private key), pasted as one secret value.
//                              NEVER commit this file/value anywhere.
// SUPABASE_URL and SUPABASE_SECRET_KEYS (or the deprecated
// SUPABASE_SERVICE_ROLE_KEY, kept only as a fallback) are injected
// automatically.
//
// Called by the notify_dm_push() Postgres trigger on new DM messages, with
// { share_key, title, body }.

import webpush from 'https://esm.sh/web-push@3.6.7';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC_KEY = 'BEEvlHWjIuYKVvt5FFFPDDtGAy2TRpOJm97kGrnd-LwQOoX6KCWFs-NEOw2C0b57lQrqldljs4b0GR-G2YelZeY';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON') ?? '';

if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:support@winfinityfitness.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// SUPABASE_SECRET_KEYS replaces the deprecated SUPABASE_SERVICE_ROLE_KEY --
// a JSON dictionary (key name isn't guaranteed, so just take the first
// value) rather than a single JWT string. Falls back to the deprecated var
// in case a project hasn't rotated onto the new key system yet.
function getSupabaseServiceKey(): string {
  const dict = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (dict) {
    try {
      const first = Object.values(JSON.parse(dict))[0];
      if (typeof first === 'string' && first) return first;
    } catch { /* fall through to legacy var */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  getSupabaseServiceKey(),
);

// --- FCM HTTP v1 auth: sign a JWT with the service account's private key,
// exchange it for a short-lived OAuth2 access token, cache until it's
// close to expiring (function instances can be reused across invocations,
// so this avoids re-signing on every single call). ---
type ServiceAccount = { project_id: string; client_email: string; private_key: string };
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function base64url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function getFcmAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60) return cachedAccessToken.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const enc = new TextEncoder();
  const unsigned = `${base64url(enc.encode(JSON.stringify(header)))}.${base64url(enc.encode(JSON.stringify(claims)))}`;
  const key = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
  const jwt = `${unsigned}.${base64url(new Uint8Array(signature))}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`FCM token exchange failed: ${JSON.stringify(json)}`);
  cachedAccessToken = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
  return cachedAccessToken.token;
}

async function sendFcm(sa: ServiceAccount, token: string, title: string, body: string): Promise<{ ok: boolean; stale: boolean }> {
  const accessToken = await getFcmAccessToken(sa);
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ message: { token, notification: { title, body } } }),
  });
  if (resp.ok) return { ok: true, stale: false };
  const json = await resp.json().catch(() => ({}));
  // UNREGISTERED / NOT_FOUND means the token is dead (app uninstalled,
  // data cleared, etc.) — same cleanup treatment as a stale Web Push
  // subscription's 404/410.
  const status = json?.error?.status;
  return { ok: false, stale: status === 'UNREGISTERED' || status === 'NOT_FOUND' };
}

Deno.serve(async (req: Request) => {
  let payload: { share_key?: string; title?: string; body?: string; type?: string; url?: string; app_filter?: string[] };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const { share_key, title, body, type, url, app_filter } = payload;
  if (!share_key || !title) {
    return new Response(JSON.stringify({ error: 'share_key and title are required' }), { status: 400 });
  }

  let webSent = 0, webTotal = 0, fcmSent = 0, fcmTotal = 0;

  // --- Web Push (browser / installed PWA) ---
  if (VAPID_PRIVATE_KEY) {
    // app_filter restricts delivery to specific surfaces (FT/wellness/
    // messenger — see push_subscriptions.app, set at subscribe time). Rows
    // predating that column are null and count as 'ft' wherever 'ft' is in
    // the filter, same convention check-reminders uses for its own FT-only
    // reminder pushes.
    let subsQuery = supabase.from('push_subscriptions').select('endpoint, p256dh, auth').eq('share_key', share_key);
    if (app_filter && app_filter.length) {
      subsQuery = app_filter.includes('ft')
        ? subsQuery.or(`app.in.(${app_filter.join(',')}),app.is.null`)
        : subsQuery.in('app', app_filter);
    }
    const { data: subs } = await subsQuery;
    if (subs && subs.length) {
      webTotal = subs.length;
      // url was never forwarded here before this fix -- check-reminders'
      // own pushes set their own url directly in its own payload (not
      // through this function), so this only ever mattered for DM pushes,
      // which previously always fell through to sw.js's './' default.
      const notifPayload = JSON.stringify({ title, body: body ?? '', type: type ?? undefined, url: url ?? undefined });
      const results = await Promise.allSettled(
        subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, notifPayload)),
      );
      const staleEndpoints: string[] = [];
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          const statusCode = (r.reason && (r.reason as { statusCode?: number }).statusCode) || 0;
          if (statusCode === 404 || statusCode === 410) staleEndpoints.push(subs[i].endpoint);
        }
      });
      if (staleEndpoints.length) await supabase.from('push_subscriptions').delete().in('endpoint', staleEndpoints);
      webSent = results.filter((r) => r.status === 'fulfilled').length;
    }
  }

  // --- FCM (native Android app) ---
  // fcm_tokens has no app column -- it's only ever the Capacitor-wrapped FT
  // native app (Wellness/Messenger ship as TWAs, which use Web Push like
  // any other browser install, not FCM) -- so an app_filter that excludes
  // 'ft' means skip this branch entirely rather than double-notify FT here
  // too after Web Push above already routed elsewhere.
  if (FCM_SERVICE_ACCOUNT_JSON && (!app_filter || app_filter.includes('ft'))) {
    let sa: ServiceAccount;
    try {
      sa = JSON.parse(FCM_SERVICE_ACCOUNT_JSON);
    } catch {
      sa = null as unknown as ServiceAccount;
    }
    if (sa) {
      const { data: tokens } = await supabase.from('fcm_tokens').select('token').eq('share_key', share_key);
      if (tokens && tokens.length) {
        fcmTotal = tokens.length;
        const results = await Promise.allSettled(tokens.map((t) => sendFcm(sa, t.token, title, body ?? '')));
        const staleTokens: string[] = [];
        results.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value.ok) fcmSent++;
          else if (r.status === 'fulfilled' && r.value.stale) staleTokens.push(tokens[i].token);
        });
        if (staleTokens.length) await supabase.from('fcm_tokens').delete().in('token', staleTokens);
      }
    }
  }

  return new Response(JSON.stringify({ web: { sent: webSent, total: webTotal }, fcm: { sent: fcmSent, total: fcmTotal } }), { status: 200 });
});
