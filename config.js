'use strict';
// Fill in with your own OAuth Client ID from Google Cloud Console (see setup walkthrough).
// Leave as-is to keep the app fully functional without Google Drive backup.
const GOOGLE_CLIENT_ID = '61766354133-38gfl9pkak9955639ubh5svaq0fginc3.apps.googleusercontent.com';

// Supabase project powering the anonymous opt-in Leaderboard tab.
const SUPABASE_URL = 'https://mzkjboplfalauivwcnni.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16a2pib3BsZmFsYXVpdndjbm5pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNTM4MTMsImV4cCI6MjA5ODcyOTgxM30.62tmKUxeKSLHhPuDZ6akBJq4e8QV4LqfklZEqa4OGUM';

// Free API key from https://api.data.gov/signup (instant, no cost) — powers the
// Food Diary's search-as-you-type. Without it, search falls back to the shared
// public DEMO_KEY, which is heavily rate-limited across every app that uses it.
const USDA_API_KEY = 'bep5rhM1sI50XKr8XvsY7OHK908TU3Rds21hVgIa';
