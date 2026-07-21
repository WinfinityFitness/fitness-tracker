'use strict';
// Fill in with your own OAuth Client ID from Google Cloud Console (see setup walkthrough).
// Leave as-is to keep the app fully functional without Google Drive backup.
const GOOGLE_CLIENT_ID = '61766354133-38gfl9pkak9955639ubh5svaq0fginc3.apps.googleusercontent.com';

// Supabase project powering the anonymous opt-in Leaderboard tab. Uses the
// new publishable-key format (replaces the old JWT-format anon key after
// the legacy HS256 signing secret was revoked) -- safe to expose client-
// side same as the old anon key was, access is still governed entirely by
// RLS policies, not by keeping this value secret.
const SUPABASE_URL = 'https://mzkjboplfalauivwcnni.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_YwHBnvbBjd8Oj8hgPXb_JA_buurC92v';

// Web Push VAPID public key — safe to expose client-side (that's how VAPID
// works, only the matching private key must stay secret). The private key
// lives ONLY as a Supabase Edge Function secret (VAPID_PRIVATE_KEY), never
// in any file shipped to the browser. See supabase_push_notifications_migration.sql
// and supabase/functions/send-push/ for the server side of this.
const VAPID_PUBLIC_KEY = 'BEEvlHWjIuYKVvt5FFFPDDtGAy2TRpOJm97kGrnd-LwQOoX6KCWFs-NEOw2C0b57lQrqldljs4b0GR-G2YelZeY';

// Free API key from https://api.data.gov/signup (instant, no cost) — powers the
// Food Diary's search-as-you-type. Without it, search falls back to the shared
// public DEMO_KEY, which is heavily rate-limited across every app that uses it.
const USDA_API_KEY = 'bep5rhM1sI50XKr8XvsY7OHK908TU3Rds21hVgIa';

// Free App ID + App Key from https://developer.nutritionix.com/signup — adds
// restaurant/fast-food coverage (Jollibee, McDonald's, etc.) to the Dietary
// Algorithm's food search, which USDA/Open Food Facts don't cover well. Leave
// blank to skip Nutritionix entirely — search still works fine with USDA alone.
const NUTRITIONIX_APP_ID = '';
const NUTRITIONIX_APP_KEY = '';
