// Winfinity Tracker — scheduled reminder push checker.
// Deploy with: supabase functions deploy check-reminders
// Reuses the VAPID_PRIVATE_KEY secret already set for send-push — no new
// secret needed. Runs on a pg_cron schedule (see
// supabase_reminder_push_migration.sql for the exact schedule command),
// NOT called by a database trigger — it's the schedule-based counterpart
// to send-push's event-based DM path.
//
// For every row in reminder_settings, computes that user's current local
// time (from their stored IANA timezone) and checks it against the same
// hydration schedule the client already generates locally (see
// getHydrationSchedule() in app.js — this mirrors that logic so the
// server-side reminders line up with what you'd see if the app were open),
// plus the two Start/End Day Log reminders at the same wake/bed times.
// last_sent tracks which slots already fired today (per user's local
// date) so a 10-minute cron interval doesn't double-send.

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

interface ReminderRow {
  share_key: string;
  timezone: string;
  hydration_enabled: boolean;
  wake_time: string;
  bed_time: string;
  meal_times: string[];
  hourly_enabled: boolean;
  log_reminders_enabled: boolean;
  last_sent: Record<string, string>;
}

interface Slot {
  id: string;
  time: string;
  title: string;
  body: string;
  url: string;
}

function timeStrToMin(t: string): number {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function minToTimeStr(min: number): string {
  min = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

// Mirrors getHydrationSchedule() in app.js exactly: wake-up, 30 min before
// each meal, hourly through waking hours (skipping slots too close to
// another one), and a wind-down slot 2h before bed.
function getHydrationSlots(row: ReminderRow): Slot[] {
  if (!row.hydration_enabled) return [];
  const wakeMin = timeStrToMin(row.wake_time || '07:00');
  const bedMin = timeStrToMin(row.bed_time || '22:00');
  const meals = (row.meal_times && row.meal_times.length === 3) ? row.meal_times : ['07:00', '12:00', '19:00'];
  const mealLabels = ['Breakfast', 'Lunch', 'Dinner'];

  const slots: Slot[] = [{
    id: 'wake', time: minToTimeStr(wakeMin), url: './',
    title: '💧 Hydration reminder',
    body: 'Morning! Drink 1-2 glasses of water (~250-500 mL) to rehydrate after sleep.',
  }];

  meals.forEach((mt, i) => {
    slots.push({
      id: 'meal' + i, time: minToTimeStr(timeStrToMin(mt) - 30), url: './',
      title: '💧 Hydration reminder',
      body: `Drink a glass of water (~250 mL) before ${mealLabels[i].toLowerCase()} to prep digestion.`,
    });
  });

  if (row.hourly_enabled !== false) {
    const cutoff = bedMin - 120;
    for (let m = wakeMin + 60; m < cutoff; m += 60) {
      const tooClose = slots.some((s) => Math.abs(timeStrToMin(s.time) - m) < 20);
      if (!tooClose) {
        slots.push({ id: 'hourly' + m, time: minToTimeStr(m), url: './', title: '💧 Hydration reminder', body: 'Time for a cup of water (~250 mL).' });
      }
    }
  }

  slots.push({
    id: 'bed', time: minToTimeStr(bedMin - 120), url: './',
    title: '💧 Hydration reminder',
    body: "If you're thirsty, a small glass now — then taper off fluids before bed so you're not up at night.",
  });

  return slots;
}

// Same wake/bed time as hydration — a separate notification, deep-linking
// straight to the relevant log sheet instead of just opening the app.
function getLogReminderSlots(row: ReminderRow): Slot[] {
  if (!row.log_reminders_enabled) return [];
  return [
    {
      id: 'morning_log', time: row.wake_time || '07:00', url: './?openSheet=startDayLog',
      title: '📋 Start Day Log', body: 'Log your morning weight, sleep, and get set up for the day.',
    },
    {
      id: 'evening_log', time: row.bed_time || '22:00', url: './?openSheet=endDayLog',
      title: '📋 End Day Log', body: 'Wrap up your day — log your final stats before bed.',
    },
  ];
}

function getLocalNowMinutes(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}
function getLocalDateStr(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC' }).format(new Date());
}

async function sendPushToShareKey(shareKey: string, title: string, body: string, url: string) {
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('share_key', shareKey);
  if (!subs || subs.length === 0) return;
  const payload = JSON.stringify({ title, body, url });
  const results = await Promise.allSettled(
    subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)),
  );
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
}

Deno.serve(async (_req: Request) => {
  if (!VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'VAPID_PRIVATE_KEY secret not set' }), { status: 500 });
  }

  const { data: rows, error } = await supabase.from('reminder_settings').select('*');
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  let sentCount = 0;
  for (const row of (rows ?? []) as ReminderRow[]) {
    const nowMin = getLocalNowMinutes(row.timezone);
    const today = getLocalDateStr(row.timezone);
    const lastSent = row.last_sent || {};
    const slots = [...getHydrationSlots(row), ...getLogReminderSlots(row)];
    const updates: Record<string, string> = {};

    for (const slot of slots) {
      const slotMin = timeStrToMin(slot.time);
      const withinWindow = nowMin >= slotMin && nowMin < slotMin + 10;
      const alreadySentToday = lastSent[slot.id] === today;
      if (withinWindow && !alreadySentToday) {
        await sendPushToShareKey(row.share_key, slot.title, slot.body, slot.url);
        updates[slot.id] = today;
        sentCount++;
      }
    }

    if (Object.keys(updates).length) {
      await supabase
        .from('reminder_settings')
        .update({ last_sent: { ...lastSent, ...updates } })
        .eq('share_key', row.share_key);
    }
  }

  return new Response(JSON.stringify({ sent: sentCount }), { status: 200 });
});
