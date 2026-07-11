// Winfinity Tracker — Web Push sender.
// Deploy with: supabase functions deploy send-push
// Requires the VAPID_PRIVATE_KEY secret (see supabase_push_notifications_migration.sql
// for setup steps). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
// automatically by the platform — no need to set those manually.
//
// Called by the notify_dm_push() Postgres trigger on new DM messages, with
// { share_key, title, body }. Looks up that share_key's saved push
// subscriptions and sends a real Web Push notification to each one, so it
// arrives even with the app fully closed and the phone locked.

import webpush from 'https://esm.sh/web-push@3.6.7';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC_KEY = 'BEEvlHWjIuYKVvt5FFFPDDtGAy2TRpOJm97kGrnd-LwQOoX6KCWFs-NEOw2C0b57lQrqldljs4b0GR-G2YelZeY';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';

if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:support@winfinityfitness.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

Deno.serve(async (req: Request) => {
  if (!VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'VAPID_PRIVATE_KEY secret not set' }), { status: 500 });
  }

  let payload: { share_key?: string; title?: string; body?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const { share_key, title, body } = payload;
  if (!share_key || !title) {
    return new Response(JSON.stringify({ error: 'share_key and title are required' }), { status: 400 });
  }

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('share_key', share_key);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  if (!subs || subs.length === 0) {
    return new Response(JSON.stringify({ sent: 0, total: 0 }), { status: 200 });
  }

  const notifPayload = JSON.stringify({ title, body: body ?? '' });
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        notifPayload,
      )
    ),
  );

  // A 404/410 from the push service means that subscription is dead (user
  // uninstalled, cleared data, etc.) — clean it up so we stop retrying it.
  const staleEndpoints: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const statusCode = (r.reason && (r.reason as { statusCode?: number }).statusCode) || 0;
      if (statusCode === 404 || statusCode === 410) staleEndpoints.push(subs[i].endpoint);
    }
  });
  if (staleEndpoints.length) {
    await supabase.from('push_subscriptions').delete().in('endpoint', staleEndpoints);
  }

  const sent = results.filter((r) => r.status === 'fulfilled').length;
  return new Response(JSON.stringify({ sent, total: subs.length }), { status: 200 });
});
