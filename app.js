'use strict';

// Bump this alongside sw.js's CACHE_NAME on every edit — shown on the Status
// tab as a real build marker instead of decorative placeholder text.
const APP_VERSION = 'WF_SYS_V.1.87';

/* ---------------------------------------------------------------- */
/* Storage                                                           */
/* ---------------------------------------------------------------- */
const KEYS = { profile: 'wft_profile', logs: 'wft_logs', reviews: 'wft_reviews', dailyReviews: 'wft_daily_reviews' };

function getProfile() {
  try { return JSON.parse(localStorage.getItem(KEYS.profile)) || null; }
  catch { return null; }
}
function saveProfile(p) { localStorage.setItem(KEYS.profile, JSON.stringify(p)); }

function getLogs() {
  try { return JSON.parse(localStorage.getItem(KEYS.logs)) || {}; }
  catch { return {}; }
}
function saveLogs(logs) { localStorage.setItem(KEYS.logs, JSON.stringify(logs)); }

/* One-time migration: water tracking switched from 16oz cups to milliliters. */
function migrateWaterUnitsIfNeeded() {
  if (localStorage.getItem('wft_water_migrated_v1')) return;
  const CUP_ML = 473;
  const profile = getProfile();
  if (profile && profile.waterGoal != null && profile.waterGoal < 100) {
    profile.waterGoal = Math.round((profile.waterGoal * CUP_ML) / 50) * 50;
    saveProfile(profile);
  }
  const logs = getLogs();
  let changed = false;
  Object.keys(logs).forEach(date => {
    const e = logs[date];
    if (e.water != null && e.water < 100) {
      e.water = Math.round((e.water * CUP_ML) / 50) * 50;
      changed = true;
    }
  });
  if (changed) saveLogs(logs);
  localStorage.setItem('wft_water_migrated_v1', '1');
}

function updateLogFields(date, partial) {
  const logs = getLogs();
  logs[date] = Object.assign({ date }, logs[date] || {}, partial);
  saveLogs(logs);
  return logs[date];
}

function getReviews() {
  try { return JSON.parse(localStorage.getItem(KEYS.reviews)) || {}; }
  catch { return {}; }
}
function saveReviews(r) { localStorage.setItem(KEYS.reviews, JSON.stringify(r)); }

function getDailyReviews() {
  try { return JSON.parse(localStorage.getItem(KEYS.dailyReviews)) || {}; }
  catch { return {}; }
}
function saveDailyReviews(r) { localStorage.setItem(KEYS.dailyReviews, JSON.stringify(r)); }

/* ---------------------------------------------------------------- */
/* Unit conversions (canonical storage: kg, cm)                      */
/* ---------------------------------------------------------------- */
const KG_PER_LB = 0.45359237;
const kgToLb = kg => kg / KG_PER_LB;
const lbToKg = lb => lb * KG_PER_LB;
const cmToIn = cm => cm / 2.54;
const ftInToCm = (ft, inch) => (ft * 12 + inch) * 2.54;

function toKg(value, unit) { return unit === 'lb' ? lbToKg(value) : value; }
function fromKg(kg, unit) { return unit === 'lb' ? kgToLb(kg) : kg; }

function getTrainUnit() {
  const stored = localStorage.getItem('wft_train_unit');
  if (stored === 'kg' || stored === 'lb') return stored;
  const profile = getProfile();
  return profile ? (profile.weightUnit || 'kg') : 'kg';
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysBetween(a, b) {
  return Math.round((b.setHours(0,0,0,0) - a.setHours(0,0,0,0)) / 86400000);
}
function fmtDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function round2(n) { return Math.round(n * 100) / 100; }
function round0(n) { return Math.round(n); }
function parseIntOrNull(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
function fmtOrDash(val, fn) { return val == null ? '–' : fn(val); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ---------------------------------------------------------------- */
/* Fitness math                                                       */
/* ---------------------------------------------------------------- */
function computeBMI(kg, cm) {
  if (!kg || !cm) return null;
  const m = cm / 100;
  return kg / (m * m);
}

/* Illustrative estimate, not a clinical measurement:
   nudges the standard BMI down for users showing high training intensity and step
   activity (a rough proxy for muscle mass BMI alone can't distinguish from fat),
   with a small extra credit if trend weight is falling alongside heavy training
   (suggesting fat loss/recomposition rather than plain weight loss). */
function computeAdjustedBMI(profile, baseBMI, logsArr) {
  const cutoff7 = new Date(); cutoff7.setDate(cutoff7.getDate() - 6); cutoff7.setHours(0, 0, 0, 0);
  const recent7 = logsArr.filter(l => parseISO(l.date) >= cutoff7);

  const workouts7d = recent7.filter(l => l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))).length;
  const workoutIntensity = Math.min(1, workouts7d / 5);

  const avgSteps = avgOfLastNDays(logsArr, 'steps', 7);
  const stepGoal = getEffectiveStepGoal(profile);
  const stepsIndex = avgSteps != null ? Math.min(1, avgSteps / stepGoal) : 0;

  const trendSeries = computeTrendSeries(logsArr);
  const delta14 = trendDeltaDaysAgo(trendSeries, 14);
  const losingWeight = delta14 != null && delta14 < -0.2;

  let activityIndex = (workoutIntensity + stepsIndex) / 2;
  if (losingWeight && workoutIntensity > 0.5) activityIndex = Math.min(1, activityIndex + 0.15);

  const adjustment = -2.5 * activityIndex;
  const adjustedBMI = Math.max(15, baseBMI + adjustment);
  return { adjustedBMI, activityIndex };
}

const SKINFOLD_SITES = ['chest', 'abdomen', 'thigh', 'triceps', 'suprailiac', 'subscapular', 'midaxillary'];

// Jackson-Pollock 7-site skinfold method (Siri equation for body fat % from
// body density). Same seven sites for both sexes; only the density formula
// coefficients differ by gender.
function computeBodyFatJP7(skinfolds, age, gender) {
  const sum = SKINFOLD_SITES.reduce((s, key) => s + (skinfolds[key] || 0), 0);
  if (sum <= 0 || !age) return null;
  const density = gender === 'female'
    ? 1.097 - 0.00046971 * sum + 0.00000056 * sum * sum - 0.00012828 * age
    : 1.112 - 0.00043499 * sum + 0.00000055 * sum * sum - 0.00028826 * age;
  return (495 / density) - 450;
}

function hasLoggedSkinfolds(entry) {
  return !!(entry && entry.skinfolds && SKINFOLD_SITES.some(k => (entry.skinfolds[k] || 0) > 0));
}

// Most recent entry on or before `onOrBeforeDate` that actually has skinfold
// data — lets the Body Fat widget keep showing your last known reading
// instead of dropping to "–" on days you didn't re-measure.
function findLastBodyFatEntry(onOrBeforeDate) {
  const logsArr = sortedLogsArray();
  let found = null;
  for (const l of logsArr) {
    if (l.date > onOrBeforeDate) break;
    if (hasLoggedSkinfolds(l)) found = l;
  }
  return found;
}

function classifyBodyFat(pct, gender) {
  if (pct == null) return { label: '–', status: 'muted' };
  const bounds = gender === 'female' ? [14, 21, 25, 32] : [6, 14, 18, 25];
  const labels = ['Essential/Athletic', 'Fitness', 'Average', 'Above average', 'Obese range'];
  const statuses = ['good', 'good', 'warning', 'serious', 'critical'];
  const idx = bounds.findIndex(b => pct < b);
  const i = idx === -1 ? labels.length - 1 : idx;
  return { label: labels[i], status: statuses[i] };
}

function computeBMR(kg, cm, age, gender) {
  if (!kg || !cm || !age) return null;
  const base = 10 * kg + 6.25 * cm - 5 * age;
  return gender === 'female' ? base - 161 : base + 5;
}
function computeTargets(profile, currentKg) {
  const bmr = computeBMR(currentKg, profile.heightCm, profile.age, profile.gender);
  if (!bmr) return null;
  const tdee = bmr * parseFloat(profile.activity || '1.2');
  return {
    bmr, tdee,
    cutting: [tdee * 0.75, tdee * 0.95],
    bulking: [tdee * 1.05, tdee * 1.15],
    protein: [1.6 * currentKg, 2.2 * currentKg],
  };
}

// A refeed window (set alongside the coach assignment) adds a flat +kcal
// bonus to the calorie target on every day from start through end, inclusive.
function getRefeedBonusForDate(profile, date) {
  if (!profile || !profile.refeedCalories || !profile.refeedStart || !profile.refeedEnd) return 0;
  if (date >= profile.refeedStart && date <= profile.refeedEnd) return profile.refeedCalories;
  return 0;
}

/* A coach-assigned value (set on the Fuel page) overrides the computed default
   wherever a single-number target is needed, until the coach updates it again.
   date (optional, defaults to today) only affects whether an active refeed
   window's +kcal bonus applies — it doesn't change which base target is used. */
function getEffectiveCalorieTarget(profile, date) {
  if (!profile) return null;
  let base;
  if (profile.coachCalorieTarget) base = profile.coachCalorieTarget;
  else {
    const kg = currentWeightKg(profile);
    const targets = kg ? computeTargets(profile, kg) : null;
    if (!targets) return null;
    const range = profile.goalMode === 'bulk' ? targets.bulking : targets.cutting;
    base = round0((range[0] + range[1]) / 2);
  }
  return base + getRefeedBonusForDate(profile, date || todayISO());
}

// Signed running balance, day by day: eating under target banks a surplus
// (adds to a later day's target), eating over target racks up a debt
// (subtracts from it) — a debt from one day and a surplus from another net
// against each other as they carry forward. Asymmetric weekly boundary: any
// banked surplus is forfeited at the start of each week (Monday) — "use it
// by Sunday or lose it" — but an unresolved debt is never forgiven, it keeps
// carrying into the next week until cancelled out by under-eating.
function getCarryoverResets() {
  try { return JSON.parse(localStorage.getItem('wft_carryover_resets')) || {}; } catch (e) { return {}; }
}
function saveCarryoverResets(obj) { localStorage.setItem('wft_carryover_resets', JSON.stringify(obj)); }

function getCalorieCarryover(date, profile) {
  if (!profile) return 0;
  const target = getEffectiveCalorieTarget(profile);
  if (!target) return 0;
  const logs = getLogs();
  const loggedDates = Object.keys(logs).filter(iso => logs[iso].calories != null).sort();
  if (!loggedDates.length) return 0;
  const cutoff = parseISO(date);

  // A manual reset (see resetCalorieCarryover) zeroes the running balance as
  // of a given day — everything logged before that day is ignored, everything
  // from that day forward accumulates normally.
  const resets = getCarryoverResets();
  let startIso = loggedDates[0];
  Object.keys(resets).forEach(rd => { if (rd <= date && rd > startIso) startIso = rd; });
  const cursor = parseISO(startIso);

  // Unused calories bank forward as a bonus for tomorrow; overeating banks
  // forward as debt that shrinks tomorrow's allowance. Surplus banked
  // (positive balance) is forfeited at each weekly reset (Monday); debt is
  // never forgiven and persists until offset by future undereating.
  let balance = 0;
  while (cursor < cutoff) {
    const iso = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0') + '-' + String(cursor.getDate()).padStart(2, '0');
    const entry = logs[iso];
    if (entry && entry.calories != null) balance += target - entry.calories;
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() === 1 && balance > 0) balance = 0; // crossed into Monday — forfeit unused surplus
  }
  return balance;
}

function resetCalorieCarryover() {
  const profile = getProfile();
  if (!profile) return;
  const today = todayISO();
  const before = getCalorieCarryover(today, profile);
  if (Math.abs(before) < 1) { showRestToast('No banked or overflow calories to reset.'); return; }
  const label = before > 0 ? `+${round0(before)} kcal banked` : `${round0(before)} kcal overflow`;
  if (!confirm(`Reset ${label} to 0? This clears both banked and overflow calorie carryover going forward.`)) return;
  const resets = getCarryoverResets();
  resets[today] = { balanceBefore: before };
  saveCarryoverResets(resets);
  renderNutritionTargets();
  const missionLogOverlay = document.getElementById('missionLogOverlay');
  if (missionLogOverlay && !missionLogOverlay.hidden) renderMissionLogCalendar();
  showRestToast(`Carryover reset: ${label} cleared for ${fmtDate(parseISO(today))}. Noted on the calendar.`);
}

// Undoes the most recent cancel — since getCalorieCarryover always derives
// the balance fresh from the logs plus whichever reset markers still exist,
// simply removing the latest marker is enough to make the exact same math
// "see" further back into history again. Nothing about the balance is
// stored separately, so there's no way for this to drift out of sync no
// matter how many times it's cancelled and returned.
function returnCalorieOverflow() {
  const resets = getCarryoverResets();
  const resetDates = Object.keys(resets).sort();
  if (!resetDates.length) { showRestToast('No cancelled overflow to return yet.'); return; }
  const latestDate = resetDates[resetDates.length - 1];
  const record = resets[latestDate];
  const label = record.balanceBefore > 0 ? `+${round0(record.balanceBefore)} kcal banked` : `${round0(Math.abs(record.balanceBefore))} kcal overflow`;
  if (!confirm(`Bring back the ${label} that was cancelled on ${fmtDate(parseISO(latestDate))}?`)) return;
  delete resets[latestDate];
  saveCarryoverResets(resets);
  renderNutritionTargets();
  const missionLogOverlay = document.getElementById('missionLogOverlay');
  if (missionLogOverlay && !missionLogOverlay.hidden) renderMissionLogCalendar();
  showRestToast(`Returned: ${label} is back in your carryover.`);
}

function hasCancelledOverflow() {
  return Object.keys(getCarryoverResets()).length > 0;
}

function getEffectiveStepGoal(profile) {
  if (!profile) return 8000;
  return profile.coachStepGoal || profile.stepGoal || 8000;
}

function sortedLogsArray() {
  return Object.values(getLogs()).sort((a, b) => a.date.localeCompare(b.date));
}

function currentWeightKg(profile) {
  const logs = Object.values(getLogs()).filter(l => l.weightKg != null).sort((a, b) => a.date.localeCompare(b.date));
  if (logs.length) return logs[logs.length - 1].weightKg;
  return profile ? profile.startWeightKg : null;
}

function avgOfLastNDays(logsArr, field, n) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (n - 1)); cutoff.setHours(0,0,0,0);
  const vals = logsArr.filter(l => parseISO(l.date) >= cutoff && l[field] != null).map(l => l[field]);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function minOfLastNDays(logsArr, field, n) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (n - 1)); cutoff.setHours(0,0,0,0);
  const vals = logsArr.filter(l => parseISO(l.date) >= cutoff && l[field] != null).map(l => l[field]);
  if (!vals.length) return null;
  return Math.min(...vals);
}

function computeTrendSeries(logsArr) {
  const weightLogs = logsArr.filter(l => l.weightKg != null).sort((a, b) => a.date.localeCompare(b.date));
  return weightLogs.map((l) => {
    const d = parseISO(l.date);
    const windowStart = new Date(d); windowStart.setDate(windowStart.getDate() - 6);
    const windowVals = weightLogs.filter(w => {
      const wd = parseISO(w.date);
      return wd >= windowStart && wd <= d;
    }).map(w => w.weightKg);
    const trend = windowVals.reduce((a, b) => a + b, 0) / windowVals.length;
    return { date: l.date, dateObj: d, actualKg: l.weightKg, trendKg: trend };
  });
}

function trendDeltaDaysAgo(series, days) {
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const targetDate = new Date(latest.dateObj); targetDate.setDate(targetDate.getDate() - days);
  if (parseISO(series[0].date) > targetDate) return null;
  let best = null;
  for (const pt of series) {
    if (pt.dateObj <= targetDate) best = pt; else break;
  }
  if (!best) return null;
  return latest.trendKg - best.trendKg;
}

function statusForLevel(field, value) {
  if (value == null) return 'muted';
  if (field === 'sleep') {
    if (value >= 4) return 'good';
    if (value >= 3) return 'warning';
    return 'critical';
  }
  if (value <= 2) return 'good';
  if (value <= 3) return 'warning';
  if (value <= 4) return 'serious';
  return 'critical';
}

function labelForLevel(field, value) {
  if (value == null) return 'N/A';
  if (field === 'sleep') {
    if (value >= 4) return 'Good';
    if (value >= 3) return 'Fair';
    return 'Poor';
  }
  if (value <= 2) return 'Low';
  if (value <= 3) return 'Moderate';
  if (value <= 4) return 'Elevated';
  return 'High';
}

function last7DailyValues(field) {
  const logs = getLogs();
  const base = parseISO(todayISO());
  const arr = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const e = logs[iso];
    arr.push(e && e[field] != null ? e[field] : null);
  }
  return arr;
}

function getCurrentWeekReview() {
  const reviews = getReviews();
  const today = new Date(todayISO());
  let best = null;
  Object.values(reviews).forEach(r => {
    const diffDays = (today - new Date(r.date)) / 86400000;
    if (diffDays >= 0 && diffDays < 7 && (!best || r.date > best.date)) best = r;
  });
  return best;
}

function computeHabitCompletion(profile, entry) {
  const review = getCurrentWeekReview();
  const checks = [
    !!(entry && entry.exercises && entry.exercises.length > 0), // workout progress
    !!(entry && entry.steps != null && entry.steps >= getEffectiveStepGoal(profile)), // steps target
    !!(entry && entry.weightKg != null), // weight input
    localStorage.getItem('wft_lb_optin') === '1', // nexus synced
    !!(review && review.adjustments && review.adjustments.trim() !== ''), // adjustments made to keep progress on track
    !!(review && review.wins && review.wins.trim() !== ''), // wins this week
    !!(review && review.improvements && review.improvements.trim() !== ''), // improvements this week
    !!(review && review.focus && review.focus.length >= 1 && review.focus.length <= 2), // pick 1-2 focus for next week
    localStorage.getItem('wft_drive_last_backup') === todayISO(), // back up now
  ];
  let total = checks.length;
  let done = checks.filter(Boolean).length;
  (profile ? profile.extraHabits || [] : []).forEach((label, i) => {
    if (!label) return;
    total++;
    if (entry && entry.extra && entry.extra[i]) done++;
  });
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { pct, done, total };
}

/* ---------------------------------------------------------------- */
/* Radial ring renderer (reused by Status rings + Training timer)     */
/* ---------------------------------------------------------------- */
let ringGradCounter = 0;

function renderRing(container, pct, opts) {
  opts = opts || {};
  const size = opts.size || 120;
  const stroke = opts.stroke || 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, pct));
  const offset = c - (clamped / 100) * c;
  const center = opts.centerHtml || `<span style="font-size:${Math.round(size * 0.22)}px;font-weight:800;font-family:var(--font-mono);color:var(--text-primary);">${opts.centerText || ''}</span>`;
  const gradId = `ringGrad${ringGradCounter++}`;
  const strokeAttr = opts.gradient ? `url(#${gradId})` : '';
  const glow = opts.gradient ? `filter: drop-shadow(0 0 6.6px var(--gradient-glow));` : '';

  // Optional inset red arc showing progress beyond 100% (e.g. calories over target),
  // drawn just inside the main ring so it stays within the same viewBox.
  const overflowPct = Math.min(100, Math.max(0, opts.overflowPct || 0));
  const overflowStroke = Math.max(3, Math.round(stroke * 0.4));
  const overflowR = Math.max(4, r - stroke / 2 - overflowStroke / 2 - 3);
  const overflowC = 2 * Math.PI * overflowR;
  const overflowOffset = overflowC - (overflowPct / 100) * overflowC;
  const overflowRing = overflowPct > 0
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${overflowR}" stroke-width="${overflowStroke}" fill="none" stroke="var(--critical)"
        stroke-dasharray="${overflowC.toFixed(2)}" stroke-dashoffset="${overflowOffset.toFixed(2)}" stroke-linecap="round"
        transform="rotate(-90 ${size / 2} ${size / 2})" style="filter: drop-shadow(0 0 4px var(--critical));"></circle>`
    : '';

  container.innerHTML = `
    ${opts.modTag ? `<p class="mod-tag">${opts.modTag}</p>` : ''}
    <div style="position:relative;width:${size}px;height:${size}px;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        ${opts.gradient ? `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#8b6bf2"/>
          <stop offset="55%" stop-color="#3f8ff0"/>
          <stop offset="100%" stop-color="#2de2e6"/>
        </linearGradient></defs>` : ''}
        <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"></circle>
        <circle class="ring-fill${opts.violet ? ' violet' : ''}${opts.magenta ? ' magenta' : ''}" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
          style="${strokeAttr ? `stroke:${strokeAttr};${glow}` : ''}"
          transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
        ${overflowRing}
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;">${center}</div>
    </div>
    ${opts.label ? `<div class="ring-label">${opts.label}</div>` : ''}
    ${opts.sub ? `<div class="ring-sub">${opts.sub}</div>` : ''}
  `;
}

/* ---------------------------------------------------------------- */
/* Tab + sheet navigation                                              */
/* ---------------------------------------------------------------- */
function initSwipeNavigation() {
  const app = document.getElementById('app');
  const noSwipeSelector = 'input[type="range"], .weight-chart, .table-wrap, .tab-bar';
  let startX = 0, startY = 0, tracking = false;

  app.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest(noSwipeSelector)) { tracking = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  app.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const btns = Array.from(document.querySelectorAll('.tab-btn[data-target]'));
    const activeIdx = btns.findIndex(b => b.classList.contains('is-active'));
    if (activeIdx === -1) return;
    const nextIdx = Math.max(0, Math.min(btns.length - 1, dx < 0 ? activeIdx + 1 : activeIdx - 1));
    if (nextIdx !== activeIdx) btns[nextIdx].click();
  }, { passive: true });
}

// Android hardware/gesture back button: closes the topmost open sheet, or
// returns to the previously viewed tab, instead of the TWA/browser default
// (exiting the app) — only falls through to that default once nothing is
// open and the user is already on the Status (home) tab.
//
// Generic by design rather than hand-wiring history.pushState into each of
// the ~20 individual overlay open functions: a MutationObserver watches
// every .sheet-overlay's `hidden` attribute and pushes/pops a history entry
// whenever one opens/closes, however it was opened or closed (trigger
// button, backdrop tap, or another code path). The donation prompt
// (.donation-overlay) is deliberately excluded — its multi-step flow
// (prompt -> QR view) doesn't map cleanly onto a single close button, and
// it already has its own always-visible IGNORE button.
function initBackButtonNav() {
  const DISMISSIBLE_SELECTOR = '.sheet-overlay';
  let handlingPopstate = false;

  history.replaceState({ wftNav: true }, '');

  const observer = new MutationObserver(mutations => {
    if (handlingPopstate) return;
    mutations.forEach(m => {
      const el = m.target;
      if (!(el instanceof Element) || !el.matches(DISMISSIBLE_SELECTOR)) return;
      if (!el.hidden) {
        history.pushState({ wftNav: true }, '');
      } else {
        // Closed via the UI (close button / backdrop tap / other code),
        // not via the back button — pop the entry pushed on open so the
        // history stack doesn't drift out of sync with the visible UI.
        history.back();
      }
    });
  });
  document.querySelectorAll(DISMISSIBLE_SELECTOR).forEach(el => {
    observer.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });

  document.querySelectorAll('.tab-btn[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (handlingPopstate) return;
      history.pushState({ wftNav: true }, '');
    });
  });

  window.addEventListener('popstate', () => {
    handlingPopstate = true;
    let openOverlay = null;
    document.querySelectorAll(DISMISSIBLE_SELECTOR).forEach(el => { if (!el.hidden) openOverlay = el; });
    if (openOverlay) {
      const closeBtn = openOverlay.querySelector('.sheet-close');
      if (closeBtn) closeBtn.click(); else openOverlay.hidden = true;
    } else {
      const activeTab = document.querySelector('.tab-btn.is-active');
      if (activeTab && activeTab.dataset.target !== 'status') {
        const statusBtn = document.querySelector('.tab-btn[data-target="status"]');
        if (statusBtn) statusBtn.click();
      }
      // Else: already on Status with nothing open — let the browser/TWA's
      // own back behavior proceed (exits the app), the expected outcome at
      // the true "root" screen.
    }
    // MutationObserver callbacks run as a microtask (before this timeout's
    // macrotask), so it still sees handlingPopstate=true and correctly
    // skips pushing/popping for the change just made above.
    setTimeout(() => { handlingPopstate = false; }, 0);
  });
}

// Curated top-level overlays worth restoring on reopen — each maps to the
// same trigger button a user would tap to open it, so restoring re-runs the
// real open logic (populating content) instead of just toggling `hidden` and
// risking stale/empty content. Nested or action-specific overlays (Add Food,
// barcode scan, date picker, the donation prompt, etc.) are deliberately left
// out since their state can't be safely reconstructed from just an ID.
const RESTORABLE_OVERLAYS = {
  foodDiaryOverlay: 'btnOpenFoodDiary',
  settingsOverlay: 'btnOpenSettings',
  prBoardOverlay: 'btnOpenPRBoard',
  missionLogOverlay: 'btnOpenMissionLog',
};

function initLastStateRestore() {
  Object.entries(RESTORABLE_OVERLAYS).forEach(([overlayId, triggerId]) => {
    const overlay = document.getElementById(overlayId);
    const trigger = document.getElementById(triggerId);
    if (!overlay || !trigger) return;
    trigger.addEventListener('click', () => localStorage.setItem('wft_last_overlay', overlayId));
    const clearIfCurrent = () => {
      if (localStorage.getItem('wft_last_overlay') === overlayId) localStorage.removeItem('wft_last_overlay');
    };
    const closeBtn = overlay.querySelector('.sheet-close');
    if (closeBtn) closeBtn.addEventListener('click', clearIfCurrent);
    overlay.addEventListener('click', e => { if (e.target === overlay) clearIfCurrent(); });
  });
}

function restoreLastState() {
  const savedTab = localStorage.getItem('wft_last_tab');
  if (savedTab) {
    const btn = document.querySelector(`.tab-btn[data-target="${savedTab}"]`);
    if (btn && !btn.classList.contains('is-active')) btn.click();
  }
  const savedOverlay = localStorage.getItem('wft_last_overlay');
  const triggerId = savedOverlay && RESTORABLE_OVERLAYS[savedOverlay];
  if (triggerId) {
    const trigger = document.getElementById(triggerId);
    if (trigger) setTimeout(() => trigger.click(), 150);
  }
}

function initTabs() {
  const btns = document.querySelectorAll('.tab-btn[data-target]');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      localStorage.setItem('wft_last_tab', target);
      document.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.tab !== target);
      btns.forEach(b => b.classList.toggle('is-active', b === btn));
      window.scrollTo(0, 0);
      if (target === 'status') { loadCheckinForm(); renderDashboard(); }
      if (target === 'training') {
        loadTrainingForDate(document.getElementById('trainDate').value);
        renderTrainingStats();
        renderExerciseTimerDisplays();
        checkTrainingIdle();
      }
      if (target === 'nutrition') {
        const nutDate = document.getElementById('nutDate').value;
        loadNutritionForDate(nutDate);
        renderNutritionTargets();
        renderNutritionAverages();
        refreshFuelWaterViews(nutDate);
      }
      if (target === 'bio') {
        loadBioForDate(document.getElementById('bioDate').value);
        const p = getProfile();
        if (p) renderComputedTargets(p);
        renderWaterRetentionOrb();
      }
      if (target === 'leaderboard' && sbConfigured()) {
        pullLeaderboard().then(renderNexusRankings).catch(() => {});
        fetchChatMessages().then(renderChatMessages).then(() => {
          if (!currentChatRoomId) markRoomRead('public');
        }).catch(() => {});
        refreshChatRooms();
        startNexusPolling();
      } else {
        stopNexusPolling();
      }
      if (target === 'menu') {
        renderHistory();
        renderMeasureHistory();
        renderBodyFatHistory();
        renderDailyReviewChecklist(document.getElementById('dailyReviewDate').value || todayISO());
      }
      updateTabDots();
    });
  });
}

function isProfileComplete(p) {
  return !!(p && p.name && p.gender && p.age && p.heightCm && p.startWeightKg != null && p.activity && p.goalTargetKg != null);
}

function getTabCompletionMap() {
  const profile = getProfile();
  const entry = getLogs()[todayISO()] || {};
  return {
    status: entry.weightKg != null && entry.sleep != null,
    training: !!(entry.exercises && entry.exercises.length > 0),
    nutrition: entry.calories != null,
    bio: entry.stress != null && entry.fatigue != null && entry.hunger != null,
    menu: isProfileComplete(profile),
  };
}

function updateTabDots() {
  const map = getTabCompletionMap();
  Object.keys(map).forEach(tab => {
    const dot = document.querySelector(`.tab-btn[data-target="${tab}"] .tab-dot`);
    if (dot) dot.hidden = map[tab];
  });
}

let nexusPollId = null;
let nexusFastUntil = 0;
function startNexusPolling() {
  stopNexusPolling();
  const interval = Date.now() < nexusFastUntil ? 1500 : 5000;
  nexusPollId = setInterval(() => {
    fetchChatMessages().then(renderChatMessages).catch(() => {});
    if (interval !== 5000 && Date.now() >= nexusFastUntil) startNexusPolling();
  }, interval);
}
function stopNexusPolling() {
  if (nexusPollId) { clearInterval(nexusPollId); nexusPollId = null; }
}
function activateNexusFastChat() {
  nexusFastUntil = Date.now() + 3 * 60 * 1000;
  const lbTab = document.querySelector('.tab-btn[data-target="leaderboard"]');
  if (lbTab && lbTab.classList.contains('is-active')) startNexusPolling();
}

function initSettingsOverlay() {
  const overlay = document.getElementById('settingsOverlay');
  document.getElementById('btnOpenSettings').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseSettings').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });

  const toneSelect = document.getElementById('alarmToneSelect');
  toneSelect.value = localStorage.getItem('wft_alarm_tone') || 'chime';
  toneSelect.addEventListener('change', () => {
    localStorage.setItem('wft_alarm_tone', toneSelect.value);
    playAlarmTone(toneSelect.value);
  });
  document.getElementById('btnPreviewAlarmTone').addEventListener('click', () => playAlarmTone(toneSelect.value));

  initHydrationReminderSettings();
}

function initContact() {
  const overlay = document.getElementById('contactOverlay');
  document.getElementById('btnFooterContact').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseContact').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

async function generateShareCardBlob({ emoji, title, stats }) {
  const canvas = document.createElement('canvas');
  canvas.width = 600; canvas.height = 600;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 600, 600);
  bg.addColorStop(0, '#171f24');
  bg.addColorStop(1, '#0a0e12');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 600, 600);
  ctx.strokeStyle = 'rgba(51,200,204,0.4)';
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, 584, 584);

  ctx.textAlign = 'center';
  ctx.font = '76px sans-serif';
  ctx.fillText(emoji, 300, 140);
  ctx.fillStyle = '#33c8cc';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(title, 300, 205);

  ctx.textAlign = 'left';
  let y = 310;
  const colW = 260, startX = 55;
  stats.forEach((s, i) => {
    const x = startX + (i % 2) * colW;
    if (i % 2 === 0 && i > 0) y += 110;
    ctx.fillStyle = '#7e8e95';
    ctx.font = '15px monospace';
    ctx.fillText(s.label.toUpperCase(), x, y);
    ctx.fillStyle = '#dde3e5';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(s.value, x, y + 36);
  });

  await drawShareWatermark(ctx, 600, 600);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

// Browsers won't let a website silently write into the phone's protected
// Photos/Gallery library — that would be a privacy hole any site could
// abuse. Triggering a normal file download is the closest legitimate
// equivalent: on Android it lands in Downloads, which the OS's MediaStore
// auto-indexes into Gallery/Photos apps in most setups. On iOS/Safari it
// saves to the Files app instead (Safari doesn't support silently saving
// straight to Photos), so it isn't quite "automatic" there.
function slugifyFilename(text) {
  return (text || 'winfinity-share').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'winfinity-share';
}

function downloadImageBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function shareViaWebShare(shareData, imageBlob) {
  if (imageBlob) {
    downloadImageBlob(imageBlob, `${slugifyFilename(shareData.title)}.png`);
    showRestToast('Image saved to your device.');
  }
  if (imageBlob && navigator.canShare) {
    const file = new File([imageBlob], 'winfinity-activity.png', { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: shareData.title, text: shareData.text, files: [file] });
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
  }
  if (navigator.share) {
    try { await navigator.share(shareData); } catch (e) { /* user cancelled or share failed — no-op */ }
  } else if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(shareData.text ? `${shareData.text} ${shareData.url || ''}`.trim() : shareData.url);
      showRestToast('Copied — paste it anywhere to share!');
    } catch (e) { /* ignore */ }
  }
}

// Returns 'shared' (share sheet opened and completed), 'cancelled' (user
// dismissed the share sheet — not a failure), or 'unsupported' (no share
// API path worked at all). Images are downloaded to the device in every
// case, matching "save automatically when share is tapped" regardless of
// what happens with the OS share sheet afterward.
async function shareMultipleViaWebShare(shareData, namedBlobs) {
  // The share attempt goes first, as close as possible to the click that
  // triggered it — a mobile browser's "this came from a real tap" grace
  // period for navigator.share() is short, and generating several images
  // before attempting it can already eat into that window on slower devices.
  let result = 'unsupported';
  if (namedBlobs.length && navigator.canShare) {
    const files = namedBlobs.map(({ name, blob }) => new File([blob], name, { type: 'image/png' }));
    if (navigator.canShare({ files })) {
      try {
        await navigator.share({ title: shareData.title, text: shareData.text, files });
        result = 'shared';
      } catch (e) { result = (e && e.name === 'AbortError') ? 'cancelled' : 'unsupported'; }
    }
  }
  if (result === 'unsupported' && navigator.share) {
    try { await navigator.share(shareData); result = 'shared'; }
    catch (e) { result = (e && e.name === 'AbortError') ? 'cancelled' : 'unsupported'; }
  }
  if (namedBlobs.length) {
    namedBlobs.forEach(({ name, blob }) => downloadImageBlob(blob, name));
    showRestToast(`${namedBlobs.length} image${namedBlobs.length > 1 ? 's' : ''} saved to your device.`);
  }
  return result;
}

function initFooterShare() {
  const shareUrl = 'https://winfinityfitness.github.io/fitness-tracker';
  document.getElementById('btnFooterShare').addEventListener('click', () => {
    shareViaWebShare({
      title: 'Winfinity Tracker',
      text: 'Check out Winfinity Tracker — my fitness tracking app:',
      url: shareUrl,
    });
  });
  // Same GCash QR as the Saturday-night donation prompt — jumps straight to
  // the QR view since tapping a dedicated Donate button is already explicit
  // intent, no need for the prompt's IGNORE/SURE step first.
  document.getElementById('btnFooterDonate').addEventListener('click', openDonationQr);
}

const FOOTER_TAGLINES = [
  "The only bad workout is the one that didn't happen.",
  "Don't stop when you're tired. Stop when you're done.",
  "Your body can stand almost anything. It's your mind that you have to convince.",
  "Fitness is not about being better than someone else. It's about being better than you were yesterday.",
  "Motivation is what gets you started. Habit is what keeps you going.",
  "Success starts with self-discipline.",
  "Push yourself because no one else is going to do it for you.",
  "It does not matter how slowly you go as long as you do not stop.",
  "Transformation is not five minutes from now; it's a present activity. In this moment, you can make a different choice, and it will lead to a different result.",
  "Believe in yourself and all that you are. Know that there is something inside you that is greater than any obstacle.",
];

function initFooterTagline() {
  const el = document.getElementById('footerTagline');
  if (!el) return;
  let lastIdx = -1;
  setInterval(() => {
    let idx;
    do { idx = Math.floor(Math.random() * FOOTER_TAGLINES.length); } while (idx === lastIdx && FOOTER_TAGLINES.length > 1);
    lastIdx = idx;
    el.textContent = `"${FOOTER_TAGLINES[idx]}"`;
  }, 15000);
}

function initPrivacyPolicy() {
  const overlay = document.getElementById('privacyOverlay');
  document.getElementById('btnFooterPrivacy').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnClosePrivacy').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

function initTermsOfService() {
  const overlay = document.getElementById('termsOverlay');
  document.getElementById('btnFooterTerms').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseTerms').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

async function sharePersonalRecords() {
  const rows = computePRBoard();
  if (!rows.length) return;
  const top = rows
    .slice()
    .sort((a, b) => b.current.oneRM - a.current.oneRM)
    .slice(0, 6);
  const blob = await generateShareCardBlob({
    emoji: '🏆',
    title: 'Personal Records',
    stats: top.map(r => ({ label: r.name, value: `${round2(r.current.weightKg)}kg × ${r.current.reps}` })),
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Personal Records', text: '🏆 New personal records logged with Winfinity Tracker!' }, blob);
}

function initPRBoardOverlay() {
  const overlay = document.getElementById('prBoardOverlay');
  document.getElementById('btnOpenPRBoard').addEventListener('click', () => {
    renderPRBoard();
    overlay.hidden = false;
  });
  document.getElementById('btnClosePRBoard').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
  document.getElementById('btnSharePR').addEventListener('click', sharePersonalRecords);
}

function getSavedTimezone() {
  return localStorage.getItem('wft_timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function renderDateTimeClock() {
  const tz = getSavedTimezone();
  const now = new Date();
  try {
    document.getElementById('dtDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: tz });
    document.getElementById('dtClock').textContent = now.toLocaleTimeString('en-GB', { timeZone: tz });
  } catch (e) {
    document.getElementById('dtDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    document.getElementById('dtClock').textContent = now.toLocaleTimeString('en-GB');
  }
}

function initDateTimeWidget() {
  renderDateTimeClock();
  setInterval(renderDateTimeClock, 1000);
}

function initTimezonePicker() {
  const overlay = document.getElementById('timezoneOverlay');
  const select = document.getElementById('timezoneSelect');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) {
    zones = ['UTC', 'Asia/Manila', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Dubai', 'Asia/Kolkata',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver',
      'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland'];
  }
  select.innerHTML = zones.map(z => `<option value="${z}">${z.replace(/_/g, ' ')}</option>`).join('');

  document.getElementById('btnTimezone').addEventListener('click', () => {
    select.value = getSavedTimezone();
    overlay.hidden = false;
  });
  document.getElementById('btnCloseTimezone').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
  document.getElementById('btnSaveTimezone').addEventListener('click', () => {
    localStorage.setItem('wft_timezone', select.value);
    renderDateTimeClock();
    const note = document.getElementById('timezoneSaveNote');
    note.textContent = 'Timezone saved.';
    setTimeout(() => { note.textContent = ''; }, 2000);
    overlay.hidden = true;
  });
}

/* ---------------------------------------------------------------- */
/* Status: weather widget (Open-Meteo, no API key required)            */
/* ---------------------------------------------------------------- */
// Thin-line neon icons (cyan clouds/rain, amber sun/bolt) matching the app's
// terminal aesthetic, replacing default-emoji weather glyphs.
const WX_CLOUD_PATH = 'M6 15a4.5 4.5 0 0 1-.5-8.98A5.5 5.5 0 0 1 16 7.5a3.9 3.9 0 0 1-1 7.5H6z';
const WX_SUN_RAYS = `<g stroke="var(--warning)" stroke-width="1.5" stroke-linecap="round">
  <line x1="12" y1="1.6" x2="12" y2="3.8"/><line x1="12" y1="20.2" x2="12" y2="22.4"/>
  <line x1="1.6" y1="12" x2="3.8" y2="12"/><line x1="20.2" y1="12" x2="22.4" y2="12"/>
  <line x1="4.4" y1="4.4" x2="5.9" y2="5.9"/><line x1="18.1" y1="18.1" x2="19.6" y2="19.6"/>
  <line x1="4.4" y1="19.6" x2="5.9" y2="18.1"/><line x1="18.1" y1="5.9" x2="19.6" y2="4.4"/>
</g>`;
function wxSvg(inner) { return `<svg viewBox="0 0 24 24" class="wx-icon" fill="none">${inner}</svg>`; }
function wxCloud(cy) { return `<path d="${WX_CLOUD_PATH}" transform="translate(0 ${cy})" stroke="var(--cyan)" stroke-width="1.6" stroke-linejoin="round" style="filter:drop-shadow(0 0 3px var(--cyan-glow));"/>`; }
function wxSun(r, cy) { return `<circle cx="12" cy="${cy}" r="${r}" stroke="var(--warning)" stroke-width="1.5" style="filter:drop-shadow(0 0 3px rgba(219,165,44,0.6));"/>`; }
function wxRain(y) { return `<g stroke="var(--cyan)" stroke-width="1.6" stroke-linecap="round"><line x1="8" y1="${y}" x2="7" y2="${y + 3}"/><line x1="12" y1="${y}" x2="11" y2="${y + 3}"/><line x1="16" y1="${y}" x2="15" y2="${y + 3}"/></g>`; }
function wxSnow(y) { return `<g stroke="var(--cyan)" stroke-width="2.2" stroke-linecap="round"><line x1="8" y1="${y}" x2="8" y2="${y + 0.1}"/><line x1="12" y1="${y + 1.5}" x2="12" y2="${y + 1.6}"/><line x1="16" y1="${y}" x2="16" y2="${y + 0.1}"/></g>`; }
function wxBolt() { return `<path d="M12.8 12.5l-3.3 5.4h2.7l-1.6 4.2 4.4-6h-2.7l1.7-3.6z" fill="var(--warning)" stroke="var(--warning)" stroke-width="0.8" stroke-linejoin="round" style="filter:drop-shadow(0 0 3px rgba(219,165,44,0.7));"/>`; }

function weatherIconFor(code) {
  if (code === 0) return wxSvg(wxSun(4.6, 12) + WX_SUN_RAYS);
  if (code <= 3) return wxSvg(wxSun(3, 7) + `<g stroke="var(--warning)" stroke-width="1.4" stroke-linecap="round"><line x1="7" y1="1.4" x2="7" y2="2.6"/><line x1="1.4" y1="7" x2="2.6" y2="7"/><line x1="3" y1="3" x2="3.9" y2="3.9"/></g>` + wxCloud(2));
  if (code <= 48) return wxSvg(wxCloud(1) + `<g stroke="var(--cyan)" stroke-width="1.4" stroke-linecap="round" opacity="0.65"><line x1="4" y1="18" x2="20" y2="18"/><line x1="6.5" y1="20.5" x2="17.5" y2="20.5"/></g>`);
  if (code <= 67) return wxSvg(wxCloud(-1) + wxRain(14));
  if (code <= 77) return wxSvg(wxCloud(-1) + wxSnow(14));
  if (code <= 82) return wxSvg(wxSun(2.8, 6) + wxCloud(1) + wxRain(15));
  return wxSvg(wxCloud(-2) + wxBolt());
}

async function fetchWeather(lat, lon) {
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`);
  if (!res.ok) throw new Error('weather fetch failed');
  const data = await res.json();
  return { tempC: data.current.temperature_2m, code: data.current.weather_code };
}

function renderWeather(w) {
  document.getElementById('weatherIcon').innerHTML = weatherIconFor(w.code);
  document.getElementById('weatherTemp').textContent = Math.round(w.tempC) + '°C';
  // Fresh weather feeds the auto-computed hydration target — refresh it if that's on.
  const profile = getProfile();
  const nutDateEl = document.getElementById('nutDate');
  if (profile && profile.autoWaterGoal && nutDateEl) {
    renderFuelWaterOrb(nutDateEl.value || todayISO());
    renderNutritionTargets();
  }
}

function getManualWeatherLocation() {
  try { return JSON.parse(localStorage.getItem('wft_weather_location')); } catch (e) { return null; }
}

function initWeatherWidget() {
  // Icon/temp open weather.com in an external tab — kept off the location-pin
  // button (a separate element right next to these) so tapping that to change
  // location doesn't also trigger a tab open.
  document.getElementById('weatherIcon').addEventListener('click', openWeatherWebsite);
  document.getElementById('weatherTemp').addEventListener('click', openWeatherWebsite);

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('wft_weather_cache')); } catch (e) { /* ignore */ }
  if (cached && Date.now() - cached.time < 30 * 60 * 1000) renderWeather(cached);

  const manualLoc = getManualWeatherLocation();
  if (manualLoc) {
    fetchWeather(manualLoc.lat, manualLoc.lon).then(w => {
      renderWeather(w);
      localStorage.setItem('wft_weather_cache', JSON.stringify({ ...w, lat: manualLoc.lat, lon: manualLoc.lon, time: Date.now() }));
    }).catch(() => {
      if (!cached) { document.getElementById('weatherIcon').textContent = '⚠️'; document.getElementById('weatherTemp').textContent = '--°'; }
    });
    return;
  }

  if (!navigator.geolocation) {
    if (!cached) { document.getElementById('weatherIcon').textContent = '❔'; document.getElementById('weatherTemp').textContent = 'N/A'; }
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      fetchWeather(lat, lon).then(w => {
        renderWeather(w);
        localStorage.setItem('wft_weather_cache', JSON.stringify({ ...w, lat, lon, time: Date.now() }));
      }).catch(() => {
        if (!cached) { document.getElementById('weatherIcon').textContent = '⚠️'; document.getElementById('weatherTemp').textContent = '--°'; }
      });
    },
    () => {
      if (!cached) { document.getElementById('weatherIcon').textContent = '📍'; document.getElementById('weatherTemp').textContent = 'Off'; }
    },
    { timeout: 8000 }
  );
}

// weather.com resolves a plain lat,lon in its "today" URL to the nearest
// named location page (confirmed via direct request — it 301s to the
// resolved locality) — no need for its internal opaque location IDs.
function openWeatherWebsite() {
  const manualLoc = getManualWeatherLocation();
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('wft_weather_cache')); } catch (e) { /* ignore */ }
  const lat = (manualLoc && manualLoc.lat) ?? (cached && cached.lat);
  const lon = (manualLoc && manualLoc.lon) ?? (cached && cached.lon);
  const url = (lat != null && lon != null)
    ? `https://weather.com/weather/today/l/${lat},${lon}`
    : 'https://weather.com/';
  window.open(url, '_blank', 'noopener');
}

async function searchWeatherLocations(query) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`);
  if (!res.ok) throw new Error('geocoding failed');
  const data = await res.json();
  return data.results || [];
}

function renderWeatherLocationResults(results) {
  const container = document.getElementById('weatherLocationResults');
  if (!results.length) { container.innerHTML = '<p class="empty-note">No matches found.</p>'; return; }
  container.innerHTML = results.map(r => {
    const label = [r.name, r.admin2, r.admin1, r.country].filter(Boolean).join(', ');
    return `<button type="button" class="weather-location-row" data-lat="${r.latitude}" data-lon="${r.longitude}" data-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
  }).join('');
}

function initWeatherLocationPicker() {
  const overlay = document.getElementById('weatherLocationOverlay');
  const searchInput = document.getElementById('weatherLocationSearch');
  let debounceId = null;

  document.getElementById('btnWeatherLocation').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseWeatherLocation').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceId);
    const q = searchInput.value.trim();
    if (q.length < 2) { document.getElementById('weatherLocationResults').innerHTML = ''; return; }
    debounceId = setTimeout(() => {
      searchWeatherLocations(q).then(renderWeatherLocationResults).catch(() => {
        document.getElementById('weatherLocationResults').innerHTML = '<p class="empty-note">Search failed — check your connection.</p>';
      });
    }, 400);
  });

  document.getElementById('weatherLocationResults').addEventListener('click', e => {
    const row = e.target.closest('.weather-location-row');
    if (!row) return;
    const lat = parseFloat(row.dataset.lat), lon = parseFloat(row.dataset.lon);
    localStorage.setItem('wft_weather_location', JSON.stringify({ lat, lon, label: row.dataset.label }));
    localStorage.removeItem('wft_weather_cache');
    fetchWeather(lat, lon).then(w => {
      renderWeather(w);
      localStorage.setItem('wft_weather_cache', JSON.stringify({ ...w, time: Date.now() }));
    }).catch(() => {});
    const note = document.getElementById('weatherLocationNote');
    note.textContent = `Location set to ${row.dataset.label}.`;
    setTimeout(() => { overlay.hidden = true; note.textContent = ''; }, 1200);
  });

  document.getElementById('btnWeatherLocationAuto').addEventListener('click', () => {
    localStorage.removeItem('wft_weather_location');
    localStorage.removeItem('wft_weather_cache');
    initWeatherWidget();
    overlay.hidden = true;
  });
}

/* ---------------------------------------------------------------- */
/* Bio: profile form                                                   */
/* ---------------------------------------------------------------- */
/* ---------------------------------------------------------------- */
/* Auto-computed hydration target                                      */
/* ---------------------------------------------------------------- */
const AUTO_WATER_HINT_BASE_TEXT = "Base guidance: ~2.7L/day (women) or ~3.7L/day (men) total fluid, ~80% from drinking — plus extra for your logged training/cardio, today's weather (needs location access), and any health status above.";
const HEALTH_STATUS_WATER_EXTRA_ML = { pregnant: 300, breastfeeding: 700, illness: 500 };

// ~80% of total fluid need comes from drinking water (rest from food), per the
// guidance the app targets: 2.7L/day total for women, 3.7L/day for men.
function baseWaterTargetML(profile) {
  const totalFluidNeedMl = (profile && profile.gender === 'female') ? 2700 : 3700;
  return Math.round(totalFluidNeedMl * 0.8);
}

// Strength sets: ~3 min of work+rest per completed set at ~8 mL/min sweat rate.
// Cardio: duration-based sweat rate that varies by activity intensity.
function computeWaterActivityExtraML(date) {
  const entry = getLogs()[date] || {};
  let extraMl = 0;

  const completedSets = (entry.exercises || []).reduce((sum, ex) =>
    sum + (ex.sets || []).filter(s => s.completed).length, 0);
  extraMl += completedSets * 3 * 8;

  (entry.cardioSessions || []).forEach(s => {
    const minutes = (s.durationSec || 0) / 60;
    const rateMlPerMin = s.type === 'run' ? 12 : (s.type === 'walk' ? 6 : 9);
    extraMl += minutes * rateMlPerMin;
  });

  return Math.round(extraMl);
}

function healthStatusExtraML(profile) {
  return (profile && HEALTH_STATUS_WATER_EXTRA_ML[profile.healthStatus]) || 0;
}

function weatherExtraFromTempC(tempC) {
  if (tempC == null) return 0;
  if (tempC >= 32) return 750;
  if (tempC >= 27) return 400;
  if (tempC >= 21) return 150;
  return 0;
}

// Reuses the same Open-Meteo cache the Status weather widget already
// maintains (wft_weather_cache, refreshed by initWeatherWidget on load and
// on manual location changes) rather than running a second geolocation/fetch
// flow. Returns null if no fresh (<30 min) reading is cached yet.
function getCachedWeatherTempC() {
  try {
    const cached = JSON.parse(localStorage.getItem('wft_weather_cache'));
    if (cached && Date.now() - cached.time < 30 * 60 * 1000) return cached.tempC;
  } catch (e) { /* ignore */ }
  return null;
}

function computeAutoWaterTargetML(profile, date) {
  const base = baseWaterTargetML(profile);
  const activity = computeWaterActivityExtraML(date);
  const health = healthStatusExtraML(profile);
  const weather = (date === todayISO()) ? weatherExtraFromTempC(getCachedWeatherTempC()) : 0;
  return Math.round((base + activity + health + weather) / 50) * 50;
}

function effectiveWaterTargetML(date) {
  const profile = getProfile();
  if (!profile) return 3000;
  if (profile.autoWaterGoal) return computeAutoWaterTargetML(profile, date);
  return profile.waterGoal || 3000;
}

function updateAutoWaterHint() {
  const hintEl = document.getElementById('setupAutoWaterHint');
  const draftProfile = {
    gender: document.getElementById('setupGender').value,
    healthStatus: document.getElementById('setupHealthStatus').value,
    autoWaterGoal: true,
  };
  const est = computeAutoWaterTargetML(draftProfile, todayISO());
  hintEl.textContent = `Estimated for today: ${est} mL (updates daily with your training + weather). ` + AUTO_WATER_HINT_BASE_TEXT;
}

function initSetupForm() {
  const form = document.getElementById('setupForm');
  const heightUnitSel = document.getElementById('setupHeightUnit');
  const cmField = document.getElementById('heightCmField');
  const ftInField = document.getElementById('heightFtInField');
  const weightUnitSel = document.getElementById('setupWeightUnit');

  heightUnitSel.addEventListener('change', () => {
    cmField.hidden = heightUnitSel.value !== 'cm';
    ftInField.hidden = heightUnitSel.value !== 'ftin';
  });

  weightUnitSel.addEventListener('change', () => {
    document.getElementById('setupWeightUnitLabel').textContent = weightUnitSel.value.toUpperCase();
  });

  document.getElementById('setupAutoWaterGoal').addEventListener('change', e => {
    document.getElementById('setupWaterGoal').disabled = e.target.checked;
    if (e.target.checked) updateAutoWaterHint();
    else document.getElementById('setupAutoWaterHint').textContent = AUTO_WATER_HINT_BASE_TEXT;
  });
  document.getElementById('setupHealthStatus').addEventListener('change', () => {
    if (document.getElementById('setupAutoWaterGoal').checked) updateAutoWaterHint();
  });
  document.getElementById('setupGender').addEventListener('change', () => {
    if (document.getElementById('setupAutoWaterGoal').checked) updateAutoWaterHint();
    updateHealthStatusOptions();
  });

  form.querySelectorAll('.proto-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      const input = form.querySelector(`.extraHabitInput[data-idx="${idx}"]`);
      if (input) { input.value = ''; input.focus(); }
    });
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const weightUnit = document.getElementById('setupWeightUnit').value;
    const heightUnit = heightUnitSel.value;
    let heightCm;
    if (heightUnit === 'cm') {
      heightCm = parseFloat(document.getElementById('setupHeightCm').value) || null;
    } else {
      const ft = parseFloat(document.getElementById('setupHeightFt').value) || 0;
      const inch = parseFloat(document.getElementById('setupHeightIn').value) || 0;
      heightCm = ftInToCm(ft, inch);
    }
    const startWeightRaw = parseFloat(document.getElementById('setupStartWeight').value) || null;
    const goalMinRaw = parseFloat(document.getElementById('setupGoalMin').value) || null;
    const goalTargetRaw = parseFloat(document.getElementById('setupGoalTarget').value) || null;
    const goalDreamRaw = parseFloat(document.getElementById('setupGoalDream').value) || null;

    const extraHabits = Array.from(document.querySelectorAll('.extraHabitInput')).map(i => i.value.trim());

    const profile = {
      name: document.getElementById('setupName').value.trim(),
      weightUnit, heightUnit, heightCm,
      gender: document.getElementById('setupGender').value,
      age: parseInt(document.getElementById('setupAge').value, 10) || null,
      startWeightKg: startWeightRaw != null ? toKg(startWeightRaw, weightUnit) : null,
      activity: document.getElementById('setupActivity').value,
      goalMode: document.getElementById('setupGoalMode').value,
      lifting: document.getElementById('setupLifting').value,
      goalMinKg: goalMinRaw != null ? toKg(goalMinRaw, weightUnit) : null,
      goalTargetKg: goalTargetRaw != null ? toKg(goalTargetRaw, weightUnit) : null,
      goalDreamKg: goalDreamRaw != null ? toKg(goalDreamRaw, weightUnit) : null,
      startDate: document.getElementById('setupStartDate').value || null,
      programDays: parseInt(document.getElementById('setupProgramDays').value, 10) || 100,
      waterGoal: parseInt(document.getElementById('setupWaterGoal').value, 10) || 3000,
      autoWaterGoal: document.getElementById('setupAutoWaterGoal').checked,
      healthStatus: document.getElementById('setupHealthStatus').value,
      stepGoal: parseInt(document.getElementById('setupStepGoal').value, 10) || 8000,
      extraHabits,
    };
    saveProfile(profile);
    document.getElementById('setupSaveNote').textContent = 'Saved.';
    setTimeout(() => { document.getElementById('setupSaveNote').textContent = ''; }, 2000);
    renderComputedTargets(profile);
    renderExtraHabitFields(profile);
    document.getElementById('bioMenstruatingField').hidden = profile.gender !== 'female';
    renderNutritionTargets();
    renderDashboard();
    renderMeasureGuide();
    updateCodeNameHint();
    updateTabDots();
    setTimeout(() => {
      const overlay = document.getElementById('entityIdentityOverlay');
      if (overlay && !overlay.hidden) overlay.hidden = true;
    }, 600);
  });
}

function updateHealthStatusOptions() {
  const isFemale = document.getElementById('setupGender').value === 'female';
  const select = document.getElementById('setupHealthStatus');
  select.querySelectorAll('option[value="pregnant"], option[value="breastfeeding"]').forEach(opt => {
    opt.hidden = !isFemale;
  });
  if (!isFemale && (select.value === 'pregnant' || select.value === 'breastfeeding')) select.value = '';
}

function loadSetupForm() {
  const p = getProfile();
  if (!p) { renderExtraHabitFields({ extraHabits: [] }); return; }
  document.getElementById('setupName').value = p.name || '';
  document.getElementById('setupWeightUnit').value = p.weightUnit || 'kg';
  document.getElementById('setupWeightUnitLabel').textContent = (p.weightUnit || 'kg').toUpperCase();
  document.getElementById('setupHeightUnit').value = p.heightUnit || 'cm';
  document.getElementById('setupGender').value = p.gender || 'male';
  document.getElementById('setupAge').value = p.age || '';
  document.getElementById('heightCmField').hidden = (p.heightUnit === 'ftin');
  document.getElementById('heightFtInField').hidden = (p.heightUnit !== 'ftin');
  if (p.heightCm) {
    if (p.heightUnit === 'ftin') {
      const totalIn = cmToIn(p.heightCm);
      document.getElementById('setupHeightFt').value = Math.floor(totalIn / 12);
      document.getElementById('setupHeightIn').value = Math.round((totalIn % 12) * 10) / 10;
    } else {
      document.getElementById('setupHeightCm').value = Math.round(p.heightCm * 10) / 10;
    }
  }
  const wu = p.weightUnit || 'kg';
  if (p.startWeightKg != null) document.getElementById('setupStartWeight').value = round2(fromKg(p.startWeightKg, wu));
  document.getElementById('setupActivity').value = p.activity || '1.2';
  document.getElementById('setupGoalMode').value = p.goalMode || 'cut';
  document.getElementById('setupLifting').value = p.lifting || '3-6';
  if (p.goalMinKg != null) document.getElementById('setupGoalMin').value = round2(fromKg(p.goalMinKg, wu));
  if (p.goalTargetKg != null) document.getElementById('setupGoalTarget').value = round2(fromKg(p.goalTargetKg, wu));
  if (p.goalDreamKg != null) document.getElementById('setupGoalDream').value = round2(fromKg(p.goalDreamKg, wu));
  document.getElementById('setupStartDate').value = p.startDate || '';
  document.getElementById('setupProgramDays').value = p.programDays || 100;
  document.getElementById('setupWaterGoal').value = p.waterGoal || 3000;
  document.getElementById('setupAutoWaterGoal').checked = !!p.autoWaterGoal;
  document.getElementById('setupHealthStatus').value = p.healthStatus || '';
  updateHealthStatusOptions();
  document.getElementById('setupWaterGoal').disabled = !!p.autoWaterGoal;
  if (p.autoWaterGoal) updateAutoWaterHint(); else document.getElementById('setupAutoWaterHint').textContent = AUTO_WATER_HINT_BASE_TEXT;
  document.getElementById('setupStepGoal').value = p.stepGoal || 8000;
  (p.extraHabits || []).forEach((v, i) => {
    const el = document.querySelector(`.extraHabitInput[data-idx="${i}"]`);
    if (el) el.value = v;
  });
  document.getElementById('bioMenstruatingField').hidden = p.gender !== 'female';
  renderComputedTargets(p);
  renderExtraHabitFields(p);
}

function renderComputedTargets(profile) {
  const list = document.getElementById('computedList');
  list.innerHTML = '';
  const kg = currentWeightKg(profile);
  const bmi = computeBMI(kg, profile.heightCm);
  const targets = kg ? computeTargets(profile, kg) : null;

  const rows = [];
  if (bmi) rows.push(['BMI', bmi.toFixed(1)]);
  if (targets) {
    rows.push(['Suggested calories (cutting)', `${round0(targets.cutting[0])}–${round0(targets.cutting[1])} kcal/day`]);
    rows.push(['Suggested calories (bulking)', `${round0(targets.bulking[0])}–${round0(targets.bulking[1])} kcal/day`]);
    rows.push(['Suggested protein', `${round0(targets.protein[0])}–${round0(targets.protein[1])} g/day`]);
  }
  if (!rows.length) {
    list.innerHTML = '<p class="empty-note">Fill in age, height and starting weight to see BMI and calorie/protein targets.</p>';
    return;
  }
  rows.forEach(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    list.appendChild(dt); list.appendChild(dd);
  });
}

function renderExtraHabitFields(profile) {
  const group = document.getElementById('extraHabitsGroup');
  group.querySelectorAll('.field--checkbox').forEach(el => el.remove());
  (profile.extraHabits || []).forEach((label, i) => {
    if (!label) return;
    const wrap = document.createElement('label');
    wrap.className = 'field field--checkbox';
    wrap.innerHTML = `<input type="checkbox" id="checkinExtra${i}"><span>${escapeHtml(label)}</span>`;
    group.appendChild(wrap);
  });
}

/* ---------------------------------------------------------------- */
/* Bio: today's biometrics                                             */
/* ---------------------------------------------------------------- */
function loadBioForDate(date) {
  const profile = getProfile();
  const logs = getLogs();
  const e = logs[date] || {};

  document.getElementById('bioMenstruating').checked = !!e.menstruating;
  document.getElementById('bioPeriodDays').value = e.periodDays ?? '';
  document.getElementById('bioPeriodFlow').value = e.periodFlow || 'normal';
  document.getElementById('bioStress').value = e.stress ?? 3;
  document.getElementById('bioStressOut').textContent = e.stress ?? 3;
  document.getElementById('bioFatigue').value = e.fatigue ?? 3;
  document.getElementById('bioFatigueOut').textContent = e.fatigue ?? 3;
  document.getElementById('bioHunger').value = e.hunger ?? 3;
  document.getElementById('bioHungerOut').textContent = e.hunger ?? 3;
  document.getElementById('bioMenstruatingField').hidden = !profile || profile.gender !== 'female';

  const skinfolds = e.skinfolds || {};
  SKINFOLD_SITES.forEach(key => {
    const input = document.getElementById('skin' + key.charAt(0).toUpperCase() + key.slice(1));
    if (input) input.value = skinfolds[key] ?? '';
  });
  renderBodyFatWidget();
}

function readSkinfoldInputs() {
  const skinfolds = {};
  SKINFOLD_SITES.forEach(key => {
    const input = document.getElementById('skin' + key.charAt(0).toUpperCase() + key.slice(1));
    const v = input ? parseFloat(input.value) : NaN;
    skinfolds[key] = isNaN(v) ? 0 : v;
  });
  return skinfolds;
}

function renderBodyFatWidget() {
  const profile = getProfile();
  const date = document.getElementById('bioDate').value || todayISO();
  const skinfolds = readSkinfoldInputs();
  const sum = SKINFOLD_SITES.reduce((s, key) => s + skinfolds[key], 0);
  const age = profile ? profile.age : null;
  const gender = profile ? profile.gender : 'male';

  let pct = (sum > 0 && age) ? computeBodyFatJP7(skinfolds, age, gender) : null;
  let carriedFromDate = null;
  if (pct == null) {
    const last = findLastBodyFatEntry(date);
    if (last) {
      pct = last.bodyFatPct ?? computeBodyFatJP7(last.skinfolds, age, gender);
      if (pct != null) carriedFromDate = last.date;
    }
  }

  const cls = classifyBodyFat(pct, gender);
  document.getElementById('bodyFatEmptyNote').hidden = pct != null;
  renderRing(document.getElementById('bodyFatRing'), pct != null ? Math.min(100, Math.max(0, pct)) : 0, {
    size: 108, stroke: 8,
    centerText: pct != null ? round2(pct) + '%' : '–',
    label: 'Body Fat',
    sub: carriedFromDate ? `${cls.label} · last logged ${fmtDate(parseISO(carriedFromDate))}` : cls.label,
  });
}

function initBioLog() {
  document.getElementById('bioDate').value = todayISO();
  document.getElementById('bioDate').addEventListener('change', e => loadBioForDate(e.target.value));

  ['bioStress', 'bioFatigue', 'bioHunger'].forEach(id => {
    const input = document.getElementById(id);
    const out = document.getElementById(id + 'Out');
    input.addEventListener('input', () => { out.textContent = input.value; });
  });

  document.getElementById('btnSaveBio').addEventListener('click', () => {
    const profile = getProfile();
    const date = document.getElementById('bioDate').value;
    updateLogFields(date, {
      menstruating: document.getElementById('bioMenstruating').checked,
      periodDays: parseInt(document.getElementById('bioPeriodDays').value, 10) || 0,
      periodFlow: document.getElementById('bioPeriodFlow').value,
      stress: parseInt(document.getElementById('bioStress').value, 10),
      fatigue: parseInt(document.getElementById('bioFatigue').value, 10),
      hunger: parseInt(document.getElementById('bioHunger').value, 10),
    });
    document.getElementById('bioSaveNote').textContent = 'Saved biometrics for ' + date;
    setTimeout(() => { document.getElementById('bioSaveNote').textContent = ''; }, 2000);
    if (profile) renderComputedTargets(profile);
    renderWaterRetentionOrb();
    if (date === todayISO()) { renderDashboard(); }
    updateTabDots();
  });

  SKINFOLD_SITES.forEach(key => {
    const input = document.getElementById('skin' + key.charAt(0).toUpperCase() + key.slice(1));
    if (input) input.addEventListener('input', renderBodyFatWidget);
  });
  document.getElementById('btnToggleCaliperEntry').addEventListener('click', () => {
    const btn = document.getElementById('btnToggleCaliperEntry');
    const panel = document.getElementById('caliperEntryPanel');
    const expanded = panel.hidden;
    panel.hidden = !expanded;
    btn.setAttribute('aria-expanded', String(expanded));
  });
  document.getElementById('btnSaveSkinfolds').addEventListener('click', () => {
    const date = document.getElementById('bioDate').value;
    const skinfolds = readSkinfoldInputs();
    const profile = getProfile();
    const bodyFatPct = computeBodyFatJP7(skinfolds, profile ? profile.age : null, profile ? profile.gender : 'male');
    updateLogFields(date, { skinfolds, bodyFatPct: bodyFatPct != null ? round2(bodyFatPct) : null });
    document.getElementById('skinfoldSaveNote').textContent = 'Saved skinfold measurements for ' + date;
    setTimeout(() => { document.getElementById('skinfoldSaveNote').textContent = ''; }, 2500);
    renderBodyFatWidget();
    renderBodyFatHistory();
  });

  loadBioForDate(todayISO());
  renderWaterRetentionOrb();
}

/* Watson (1980) total body water formula, in liters. */
function computeWatsonTBW(profile, kg) {
  if (!profile || !kg || !profile.heightCm || !profile.age) return null;
  const cm = profile.heightCm, age = profile.age;
  if (profile.gender === 'female') {
    return -2.097 + 0.1069 * cm + 0.2466 * kg;
  }
  return 2.447 - 0.09156 * age + 0.1074 * cm + 0.3362 * kg;
}

/* Illustrative estimate, not a medical measurement:
   ((carbs_g + sodium_g) x 3) glycogen-bound water, plus 1%-5% of Watson TBW
   scaled by today's 1-5 stress/fatigue/sleep average. */
function renderWaterRetentionOrb() {
  const container = document.getElementById('waterRetentionOrb');
  if (!container) return;
  const profile = getProfile();
  const kg = profile ? currentWeightKg(profile) : null;
  const tbwLiters = kg ? computeWatsonTBW(profile, kg) : null;

  if (!tbwLiters) {
    renderRing(container, 0, {
      size: 108, stroke: 8, magenta: true,
      centerText: '–', label: 'Edema extrapolation', sub: 'Complete Bio profile to estimate',
    });
    return;
  }

  const date = todayISO();
  const entry = getLogs()[date] || {};
  const carbsG = entry.carbs || 0;
  const sodiumG = (entry.sodium || 0) / 1000;
  const glycogenWaterG = (carbsG + sodiumG) * 3;

  const avgLevel = ((entry.stress ?? 3) + (entry.fatigue ?? 3) + (entry.sleep ?? 3)) / 3;
  const pct = avgLevel; // 1-5 scale maps directly to 1%-5%
  const stateWaterG = (pct / 100) * tbwLiters * 1000;

  // Flow intensity sets the base retention estimate (mild/normal/strong), and
  // longer estimated duration nudges it up slightly — both are rough
  // self-reported references, not a clinical model.
  const PERIOD_FLOW_BONUS_G = { mild: 1000, normal: 1750, strong: 2500 };
  const periodDaysFactor = 1 + Math.min(entry.periodDays || 0, 7) * 0.05;
  const periodBonusG = (profile.gender === 'female' && entry.menstruating)
    ? Math.round((PERIOD_FLOW_BONUS_G[entry.periodFlow] ?? PERIOD_FLOW_BONUS_G.normal) * periodDaysFactor)
    : 0;

  const totalG = glycogenWaterG + stateWaterG + periodBonusG;
  const gaugePct = Math.min(100, (totalG / 3500) * 100);

  renderRing(container, gaugePct, {
    size: 108, stroke: 8, magenta: true,
    centerText: round0(totalG) + 'g', label: 'Edema extrapolation', sub: `Estimate for ${fmtDate(parseISO(date))}`,
  });
}

/* ---------------------------------------------------------------- */
/* Status: check-in form                                              */
/* ---------------------------------------------------------------- */
function initCheckin() {
  const form = document.getElementById('checkinForm');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const profile = getProfile();
    const date = todayISO();
    const extra = {};
    (profile ? profile.extraHabits || [] : []).forEach((label, i) => {
      if (!label) return;
      const el = document.getElementById('checkinExtra' + i);
      if (el) extra[i] = el.checked;
    });
    updateLogFields(date, { extra });
    document.getElementById('checkinSaveNote').textContent = 'Check-in saved.';
    setTimeout(() => { document.getElementById('checkinSaveNote').textContent = ''; }, 2000);
    renderDashboard();
  });
}

function loadCheckinForm() {
  const profile = getProfile();
  renderExtraHabitFields(profile || { extraHabits: [] });
  const date = todayISO();
  const logs = getLogs();
  const e = logs[date] || {};
  (profile ? profile.extraHabits || [] : []).forEach((label, i) => {
    if (!label) return;
    const el = document.getElementById('checkinExtra' + i);
    if (el) el.checked = !!(e.extra && e.extra[i]);
  });
}

/* ---------------------------------------------------------------- */
/* Status: quick log (Start Day / End Day / Weekend floating logs)     */
/* ---------------------------------------------------------------- */
// Populates the sheet's fields for whichever date is selected — called both
// on first open (today) and whenever the date field itself changes, so a
// previous day can be picked and edited manually rather than only today.
function loadStartDayLogFields(date) {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const e = getLogs()[date] || {};
  document.getElementById('sdlWeight').value = e.weightKg != null ? round2(fromKg(e.weightKg, wu)) : '';
  document.getElementById('sdlWeightUnitLabel').textContent = wu;
  document.getElementById('sdlSleep').value = e.sleep ?? 3;
  document.getElementById('sdlSleepOut').textContent = e.sleep ?? 3;
  document.getElementById('sdlWater250').checked = false;
  document.getElementById('sdlSaveNote').textContent = '';
  document.getElementById('btnShareFromStartDayLog').hidden = true;
}

function openStartDayLog() {
  const date = todayISO();
  document.getElementById('sdlDate').value = date;
  loadStartDayLogFields(date);
  document.getElementById('startDayLogOverlay').hidden = false;
}

function saveStartDayLog() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const date = document.getElementById('sdlDate').value || todayISO();
  const weightRaw = parseFloat(document.getElementById('sdlWeight').value);
  const partial = {
    weightKg: isNaN(weightRaw) ? null : toKg(weightRaw, wu),
    sleep: parseInt(document.getElementById('sdlSleep').value, 10),
  };
  if (document.getElementById('sdlWater250').checked) {
    const current = getLogs()[date] || {};
    partial.water = (current.water || 0) + WATER_GLASS_ML;
  }
  updateLogFields(date, partial);
  document.getElementById('sdlWater250').checked = false;
  document.getElementById('sdlSaveNote').textContent = 'Saved.';
  document.getElementById('btnShareFromStartDayLog').hidden = false;
  renderDashboard();
  if (profile) renderComputedTargets(profile);
  // Refresh the Fuel tab's own currently-selected date, not necessarily the
  // date just edited here — passing the edited date directly would make the
  // water orb silently show a past day's data while the rest of the Fuel
  // tab still shows whatever date it actually has selected.
  refreshFuelWaterViews(document.getElementById('nutDate').value || todayISO());
  renderNutritionTargets();
  renderNutritionAverages();
  if (document.getElementById('bioDate').value === date) loadBioForDate(date);
  updateTabDots();
}

// Same as loadStartDayLogFields — populates for whichever date is selected,
// called on open (today) and whenever the date field changes.
function loadEndDayLogFields(date) {
  const profile = getProfile();
  const e = getLogs()[date] || {};
  document.getElementById('edlSteps').value = e.steps ?? '';
  document.getElementById('edlWorkoutDone').checked = !!e.workoutDone;
  document.getElementById('edlFatigue').value = e.fatigue ?? 3;
  document.getElementById('edlFatigueOut').textContent = e.fatigue ?? 3;
  document.getElementById('edlStress').value = e.stress ?? 3;
  document.getElementById('edlStressOut').textContent = e.stress ?? 3;
  document.getElementById('edlHunger').value = e.hunger ?? 3;
  document.getElementById('edlHungerOut').textContent = e.hunger ?? 3;

  const calorieTarget = profile ? getEffectiveCalorieTarget(profile, date) : null;
  const effectiveCalorieTarget = calorieTarget != null
    ? Math.max(1, calorieTarget + getCalorieCarryover(date, profile))
    : null;
  document.getElementById('edlCaloriesNow').textContent = e.calories ?? 0;
  document.getElementById('edlCaloriesTarget').textContent = effectiveCalorieTarget != null ? effectiveCalorieTarget : '–';

  const kg = profile ? currentWeightKg(profile) : null;
  const targets = (profile && kg) ? computeTargets(profile, kg) : null;
  const proteinTarget = targets ? round0((targets.protein[0] + targets.protein[1]) / 2) : null;
  document.getElementById('edlProteinNow').textContent = e.protein ?? 0;
  document.getElementById('edlProteinTarget').textContent = proteinTarget != null ? proteinTarget : '–';

  document.getElementById('edlSaveNote').textContent = '';
  document.getElementById('btnShareFromEndDayLog').hidden = true;
}

function openEndDayLog() {
  const date = todayISO();
  document.getElementById('edlDate').value = date;
  loadEndDayLogFields(date);
  document.getElementById('endDayLogOverlay').hidden = false;
}

function saveEndDayLog() {
  const profile = getProfile();
  const date = document.getElementById('edlDate').value || todayISO();
  updateLogFields(date, {
    steps: parseIntOrNull(document.getElementById('edlSteps').value),
    workoutDone: document.getElementById('edlWorkoutDone').checked,
    fatigue: parseInt(document.getElementById('edlFatigue').value, 10),
    stress: parseInt(document.getElementById('edlStress').value, 10),
    hunger: parseInt(document.getElementById('edlHunger').value, 10),
  });
  document.getElementById('edlSaveNote').textContent = 'Saved.';
  document.getElementById('btnShareFromEndDayLog').hidden = false;
  renderDashboard();
  if (profile) renderComputedTargets(profile);
  renderWaterRetentionOrb();
  if (document.getElementById('bioDate').value === date) loadBioForDate(date);
  updateTabDots();
}

function openWeekendLog() {
  const date = todayISO();
  const r = getReviews()[date] || {};
  document.getElementById('wlDate').value = date;
  document.getElementById('wlProgressPhoto').checked = !!r.progressPhoto;
  document.getElementById('wlMeasurement').checked = !!r.measurementDone;
  document.getElementById('wlAdjustments').value = r.adjustments || '';
  document.getElementById('wlWins').value = r.wins || '';
  document.getElementById('wlImprovements').value = r.improvements || '';
  document.querySelectorAll('.wlFocus').forEach(c => { c.checked = (r.focus || []).includes(c.value); });
  document.getElementById('wlOther').value = r.other || '';
  document.getElementById('wlSaveNote').textContent = '';
  document.getElementById('btnShareFromWeekendLog').hidden = true;
  document.getElementById('weekendLogOverlay').hidden = false;
}

function saveWeekendLog() {
  const date = document.getElementById('wlDate').value || todayISO();
  const reviews = getReviews();
  const focus = Array.from(document.querySelectorAll('.wlFocus')).filter(c => c.checked).map(c => c.value);
  reviews[date] = {
    date,
    progressPhoto: document.getElementById('wlProgressPhoto').checked,
    measurementDone: document.getElementById('wlMeasurement').checked,
    adjustments: document.getElementById('wlAdjustments').value,
    wins: document.getElementById('wlWins').value,
    improvements: document.getElementById('wlImprovements').value,
    focus,
    other: document.getElementById('wlOther').value,
  };
  saveReviews(reviews);
  document.getElementById('wlSaveNote').textContent = 'Saved review for week ending ' + date;
  document.getElementById('btnShareFromWeekendLog').hidden = false;
  renderDashboard();
  updateTabDots();
}

function initQuickLogLaunchers() {
  document.getElementById('btnOpenStartDayLog').addEventListener('click', openStartDayLog);
  document.getElementById('btnCloseStartDayLog').addEventListener('click', () => { document.getElementById('startDayLogOverlay').hidden = true; });
  document.getElementById('startDayLogOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  document.getElementById('sdlSleep').addEventListener('input', e => { document.getElementById('sdlSleepOut').textContent = e.target.value; });
  document.getElementById('sdlDate').addEventListener('change', e => loadStartDayLogFields(e.target.value || todayISO()));
  document.getElementById('btnSaveStartDayLog').addEventListener('click', saveStartDayLog);
  document.getElementById('btnShareFromStartDayLog').addEventListener('click', () => {
    document.getElementById('startDayLogOverlay').hidden = true;
    openAssessmentOverlay();
  });

  document.getElementById('btnOpenEndDayLog').addEventListener('click', openEndDayLog);
  document.getElementById('btnCloseEndDayLog').addEventListener('click', () => { document.getElementById('endDayLogOverlay').hidden = true; });
  document.getElementById('endDayLogOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  ['edlFatigue', 'edlStress', 'edlHunger'].forEach(id => {
    document.getElementById(id).addEventListener('input', e => { document.getElementById(id + 'Out').textContent = e.target.value; });
  });
  document.getElementById('edlDate').addEventListener('change', e => loadEndDayLogFields(e.target.value || todayISO()));
  document.getElementById('btnSaveEndDayLog').addEventListener('click', saveEndDayLog);
  document.getElementById('btnShareFromEndDayLog').addEventListener('click', () => {
    document.getElementById('endDayLogOverlay').hidden = true;
    openAssessmentOverlay();
  });

  document.getElementById('btnOpenWeekendLog').addEventListener('click', openWeekendLog);
  document.getElementById('btnCloseWeekendLog').addEventListener('click', () => { document.getElementById('weekendLogOverlay').hidden = true; });
  document.getElementById('weekendLogOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  document.getElementById('btnSaveWeekendLog').addEventListener('click', saveWeekendLog);
  document.getElementById('btnShareFromWeekendLog').addEventListener('click', () => {
    document.getElementById('weekendLogOverlay').hidden = true;
    openAssessmentOverlay();
  });
}

/* ---------------------------------------------------------------- */
/* Status: body measurement scan                                       */
/* ---------------------------------------------------------------- */
function renderMeasureGuide() {
  const profile = getProfile();
  const gender = profile ? profile.gender : 'male';
  const src = gender === 'female' ? 'icons/measure-guide-female.jpg' : 'icons/measure-guide-male.jpg';
  document.getElementById('measureGuide').innerHTML = `<img src="${src}" alt="${gender === 'female' ? 'Female' : 'Male'} measurement slice guide">`;
  document.getElementById('hipsField').hidden = gender !== 'female';
}

function loadMeasurementsForDate(date) {
  const logs = getLogs();
  const m = (logs[date] && logs[date].measurements) || {};
  document.getElementById('measureChest').value = m.chest ?? '';
  document.getElementById('measureShoulder').value = m.shoulder ?? '';
  document.getElementById('measureLBicep').value = m.lBicep ?? '';
  document.getElementById('measureRBicep').value = m.rBicep ?? '';
  document.getElementById('measureAbdSupra').value = m.abdSupra ?? '';
  document.getElementById('measureStomach').value = m.stomach ?? '';
  document.getElementById('measureAbdInfra').value = m.abdInfra ?? '';
  document.getElementById('measureHips').value = m.hips ?? '';
  document.getElementById('measureLThigh').value = m.lThigh ?? '';
  document.getElementById('measureRThigh').value = m.rThigh ?? '';
  document.getElementById('measureLCalf').value = m.lCalf ?? '';
  document.getElementById('measureRCalf').value = m.rCalf ?? '';
}

function initMeasurements() {
  renderMeasureGuide();
  document.getElementById('measureDate').value = todayISO();
  document.getElementById('measureDate').addEventListener('change', e => loadMeasurementsForDate(e.target.value));

  document.getElementById('btnSaveMeasurements').addEventListener('click', () => {
    const date = document.getElementById('measureDate').value;
    const val = id => {
      const n = parseFloat(document.getElementById(id).value);
      return isNaN(n) ? null : Math.round(n * 10) / 10;
    };
    updateLogFields(date, {
      measurements: {
        chest: val('measureChest'),
        shoulder: val('measureShoulder'),
        lBicep: val('measureLBicep'),
        rBicep: val('measureRBicep'),
        abdSupra: val('measureAbdSupra'),
        stomach: val('measureStomach'),
        abdInfra: val('measureAbdInfra'),
        hips: val('measureHips'),
        lThigh: val('measureLThigh'),
        rThigh: val('measureRThigh'),
        lCalf: val('measureLCalf'),
        rCalf: val('measureRCalf'),
      },
    });
    renderMeasureHistory();
    const note = document.getElementById('measureSaveNote');
    note.textContent = 'Saved measurements for ' + date;
    setTimeout(() => {
      note.textContent = '';
      const overlay = document.getElementById('measureEntryOverlay');
      if (overlay && !overlay.hidden) overlay.hidden = true;
    }, 900);
  });

  loadMeasurementsForDate(todayISO());
}

function initMeasureEntryOverlay() {
  const overlay = document.getElementById('measureEntryOverlay');
  document.getElementById('btnOpenMeasureEntry').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseMeasureEntry').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

function initEntityIdentityOverlay() {
  const overlay = document.getElementById('entityIdentityOverlay');
  document.getElementById('btnOpenEntityIdentity').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseEntityIdentity').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

/* ---------------------------------------------------------------- */
/* Status: dashboard rendering                                         */
/* ---------------------------------------------------------------- */
function renderStepsCaloriesChart() {
  const profile = getProfile();
  const stepGoal = getEffectiveStepGoal(profile);
  const calorieTarget = getEffectiveCalorieTarget(profile) || 2000;

  const logsArr = sortedLogsArray();
  const MAX_SCALE = 130; // % of goal a bar can visually reach before being capped
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const entry = logsArr.find(l => l.date === iso);
    const stepsPct = entry && entry.steps != null ? (entry.steps / stepGoal) * 100 : 0;
    const calPct = entry && entry.calories != null ? (entry.calories / calorieTarget) * 100 : 0;
    days.push({ dateObj: d, stepsPct, calPct });
  }

  const container = document.getElementById('stepsCaloriesChart');
  const labels = document.getElementById('stepsCaloriesLabels');
  container.innerHTML = ''; labels.innerHTML = '';
  days.forEach(d => {
    const col = document.createElement('div');
    col.className = 'dual-bar-day';

    const stepsBar = document.createElement('div');
    stepsBar.className = 'dual-bar dual-bar--steps';
    stepsBar.style.height = `${Math.min(100, (d.stepsPct / MAX_SCALE) * 100)}%`;
    stepsBar.title = `Steps: ${round0(d.stepsPct)}% of daily goal`;

    const calBar = document.createElement('div');
    calBar.className = 'dual-bar dual-bar--calories';
    calBar.style.height = `${Math.min(100, (d.calPct / MAX_SCALE) * 100)}%`;
    calBar.title = `Calories: ${round0(d.calPct)}% of daily target`;

    col.appendChild(stepsBar);
    col.appendChild(calBar);
    container.appendChild(col);

    const lbl = document.createElement('span');
    lbl.textContent = d.dateObj.toLocaleDateString(undefined, { weekday: 'narrow' });
    labels.appendChild(lbl);
  });
}



function renderDashboard() {
  const profile = getProfile();
  const logsArr = sortedLogsArray();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';

  document.getElementById('heroName').textContent = (profile && profile.name) ? profile.name : 'Operator';

  if (profile && profile.startDate) {
    const start = parseISO(profile.startDate);
    const total = profile.programDays || 100;
    const elapsed = Math.max(0, Math.min(total, daysBetween(new Date(start), new Date())));
    document.getElementById('daysLeftValue').textContent = `${elapsed} / ${total}`;
  } else {
    document.getElementById('daysLeftValue').textContent = '–';
  }

  const today = todayISO();
  const todayEntry = getLogs()[today];

  const habit = computeHabitCompletion(profile, todayEntry);
  renderRing(document.getElementById('ringHabitCard'), habit.pct, {
    size: 140, stroke: 9, modTag: 'MOD_HABIT_01', centerText: habit.pct + '%', label: 'Habit completion', sub: `${habit.done}/${habit.total} today`,
  });

  const waterGoal = (profile && profile.waterGoal) || 3000;
  const waterToday = (todayEntry && todayEntry.water != null) ? todayEntry.water : 0;
  const waterPct = waterGoal > 0 ? (waterToday / waterGoal) * 100 : 0;

  const calorieTarget = getEffectiveCalorieTarget(profile) || 2000;
  const caloriesToday = (todayEntry && todayEntry.calories != null) ? todayEntry.calories : 0;
  const caloriePct = calorieTarget > 0 ? (caloriesToday / calorieTarget) * 100 : 0;

  const kgForFuel = currentWeightKg(profile);
  const targetsForFuel = (profile && kgForFuel) ? computeTargets(profile, kgForFuel) : null;
  const proteinTarget = targetsForFuel ? round0((targetsForFuel.protein[0] + targetsForFuel.protein[1]) / 2) : null;
  const proteinToday = (todayEntry && todayEntry.protein != null) ? todayEntry.protein : 0;
  const proteinPct = proteinTarget ? (proteinToday / proteinTarget) * 100 : 0;

  const lifeFuelPct = Math.round((Math.min(100, waterPct) + Math.min(100, caloriePct) + Math.min(100, proteinPct)) / 3);
  const fuelMetCount = [waterPct, caloriePct, proteinPct].filter(p => p >= 100).length;
  renderRing(document.getElementById('ringHydrationCard'), lifeFuelPct, {
    size: 140, stroke: 9, magenta: true, modTag: 'MOD_FUEL_02', centerText: lifeFuelPct + '%', label: 'Life Fuel', sub: `${fuelMetCount}/3 today`,
  });

  document.getElementById('avgSteps').textContent = fmtOrDash(avgOfLastNDays(logsArr, 'steps', 7), v => round0(v));
  const kgNow = currentWeightKg(profile);
  const bmi = profile ? computeBMI(kgNow, profile.heightCm) : null;
  document.getElementById('currentBMI').textContent = bmi ? bmi.toFixed(1) : '–';

  const adjTile = document.getElementById('adjustedBmiTile');
  const adjHint = document.getElementById('adjustedBmiHint');
  const adjusted = (profile && bmi) ? computeAdjustedBMI(profile, bmi, logsArr) : null;
  if (adjusted) {
    adjTile.hidden = false;
    adjHint.hidden = false;
    document.getElementById('adjustedBMI').textContent = adjusted.adjustedBMI.toFixed(1);
  } else {
    adjTile.hidden = true;
    adjHint.hidden = true;
  }

  const trendSeries = computeTrendSeries(logsArr);
  ['7', '14', '21'].forEach(n => {
    const delta = trendDeltaDaysAgo(trendSeries, parseInt(n, 10));
    const el = document.getElementById('delta' + n);
    if (delta == null) { el.textContent = '–'; return; }
    const val = wu === 'lb' ? kgToLb(delta) : delta;
    const sign = val > 0 ? '+' : '';
    el.textContent = sign + round2(val) + ' ' + wu;
  });

  const perfGrid = document.getElementById('perfGrid');
  perfGrid.innerHTML = '';
  const perfItems = [
    ['Sleep quality', avgOfLastNDays(logsArr, 'sleep', 7), 'sleep'],
    ['Stress', avgOfLastNDays(logsArr, 'stress', 7), 'stress'],
    ['Fatigue', avgOfLastNDays(logsArr, 'fatigue', 7), 'fatigue'],
    ['Hunger', avgOfLastNDays(logsArr, 'hunger', 7), 'hunger'],
  ];
  perfItems.forEach(([label, val, field]) => {
    const status = statusForLevel(field, val);
    const days = last7DailyValues(field);
    const bars = days.map((v, i) => {
      const h = v != null ? Math.max(6, Math.round((v / 5) * 100)) : 4;
      const dayStatus = statusForLevel(field, v);
      const today = i === days.length - 1;
      return `<div class="perf-spark-bar status-${dayStatus}${today ? ' is-today' : ''}" style="height:${h}%"></div>`;
    }).join('');
    const tile = document.createElement('div');
    tile.className = 'perf-tile';
    tile.innerHTML = `<div class="perf-tile-head">
        <span class="perf-tile-label">${label}</span>
        <span class="perf-tile-value"><span class="status-dot status-${status}"></span>${labelForLevel(field, val)}</span>
      </div>
      <div class="perf-spark">${bars}</div>`;
    perfGrid.appendChild(tile);
  });

  renderWeightChart(trendSeries, wu);
  renderGoalProgress(profile, kgNow, wu, logsArr);
  renderStepsCaloriesChart();
}

/* ---- Weight chart (SVG, hover tooltip) ---- */
let weightChartFullJourney = false;

function renderWeightChart(fullSeries, wu) {
  const series = weightChartFullJourney ? fullSeries : fullSeries.slice(-60);
  const container = document.getElementById('weightChart');
  const legend = document.getElementById('chartLegend');
  const emptyNote = document.getElementById('chartEmptyNote');
  container.innerHTML = '';
  legend.innerHTML = '';
  document.getElementById('chartRange').textContent = series.length ? `${series.length} entries` : '';

  if (series.length < 1) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  const W = 600, H = 260, padL = 40, padR = 14, padT = 14, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const displayVals = series.map(p => fromKg(p.actualKg, wu));
  const trendVals = series.map(p => fromKg(p.trendKg, wu));
  const allVals = displayVals.concat(trendVals);
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;

  const xFor = i => padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const yFor = v => padT + plotH - ((v - min) / (max - min)) * plotH;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const v = min + (g / gridCount) * (max - min);
    const y = yFor(v);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--gridline)'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', 4); label.setAttribute('y', y + 3);
    label.setAttribute('font-size', '9'); label.setAttribute('fill', 'var(--text-muted)');
    label.textContent = round2(v);
    svg.appendChild(label);
  }

  [0, Math.floor((series.length - 1) / 2), series.length - 1].forEach(i => {
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', xFor(i));
    label.setAttribute('y', H - 6);
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', 'var(--text-muted)');
    label.setAttribute('text-anchor', i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle');
    label.textContent = fmtDate(series[i].dateObj);
    svg.appendChild(label);
  });

  if (series.length > 1) {
    const trendPath = trendVals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ');
    const tp = document.createElementNS(svgNS, 'path');
    tp.setAttribute('d', trendPath);
    tp.setAttribute('fill', 'none');
    tp.setAttribute('stroke', 'var(--series-2)');
    tp.setAttribute('stroke-width', '2');
    tp.setAttribute('stroke-dasharray', '5 4');
    svg.appendChild(tp);
  }

  if (series.length > 1) {
    const actualPath = displayVals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ');
    const ap = document.createElementNS(svgNS, 'path');
    ap.setAttribute('d', actualPath);
    ap.setAttribute('fill', 'none');
    ap.setAttribute('stroke', 'var(--series-1)');
    ap.setAttribute('stroke-width', '2.5');
    ap.setAttribute('stroke-linejoin', 'round');
    ap.setAttribute('stroke-linecap', 'round');
    ap.style.filter = 'drop-shadow(0 0 4px var(--cyan-glow))';
    svg.appendChild(ap);
  }

  const lowestIdx = displayVals.indexOf(Math.min(...displayVals));
  displayVals.forEach((v, i) => {
    const isLowest = i === lowestIdx;
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', xFor(i)); c.setAttribute('cy', yFor(v));
    c.setAttribute('r', (isLowest ? 1.4 : 1) * (series.length > 40 ? 2 : 3.5));
    c.setAttribute('fill', isLowest ? 'var(--warning)' : 'var(--series-1)');
    if (isLowest) c.style.filter = 'drop-shadow(0 0 4px var(--warning))';
    svg.appendChild(c);
  });

  const crosshair = document.createElementNS(svgNS, 'line');
  crosshair.setAttribute('y1', padT); crosshair.setAttribute('y2', H - padB);
  crosshair.setAttribute('stroke', 'var(--baseline)'); crosshair.setAttribute('stroke-width', '1');
  crosshair.setAttribute('visibility', 'hidden');
  svg.appendChild(crosshair);

  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  container.appendChild(tooltip);

  const hitArea = document.createElementNS(svgNS, 'rect');
  hitArea.setAttribute('x', padL); hitArea.setAttribute('y', padT);
  hitArea.setAttribute('width', plotW); hitArea.setAttribute('height', plotH);
  hitArea.setAttribute('fill', 'transparent');
  svg.appendChild(hitArea);

  function showAt(i) {
    const x = xFor(i);
    crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
    crosshair.setAttribute('visibility', 'visible');
    const pt = series[i];
    tooltip.innerHTML = `<strong>${fmtDate(pt.dateObj)}</strong><br>Weight: ${round2(fromKg(pt.actualKg, wu))} ${wu}<br>Trend: ${round2(fromKg(pt.trendKg, wu))} ${wu}`;
    tooltip.style.display = 'block';
    const containerWidth = container.clientWidth || W;
    const pxX = (x / W) * containerWidth;
    const tooltipWidth = tooltip.offsetWidth;
    let left = pxX + 8;
    if (left + tooltipWidth > containerWidth) left = pxX - tooltipWidth - 8;
    if (left < 4) left = 4;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = '4px';
  }
  function hideTooltip() {
    crosshair.setAttribute('visibility', 'hidden');
    tooltip.style.display = 'none';
  }
  function pointerToIndex(evt) {
    const rect = svg.getBoundingClientRect();
    const relX = ((evt.clientX - rect.left) / rect.width) * W;
    let closest = 0, closestDist = Infinity;
    series.forEach((_, i) => {
      const d = Math.abs(xFor(i) - relX);
      if (d < closestDist) { closestDist = d; closest = i; }
    });
    return closest;
  }
  // Press-and-hold (works for both touch and mouse) instead of hover-only —
  // details for any point stay hidden until pressed, and disappear on
  // release. Disabled in the full-journey view (see weightChartFullJourney
  // below) since that series can be long enough to make per-point touch
  // targets impractical.
  if (!weightChartFullJourney) {
    let pressed = false;
    svg.addEventListener('pointerdown', evt => {
      pressed = true;
      svg.setPointerCapture(evt.pointerId);
      showAt(pointerToIndex(evt));
    });
    svg.addEventListener('pointermove', evt => { if (pressed) showAt(pointerToIndex(evt)); });
    const release = () => { pressed = false; hideTooltip(); };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
    svg.addEventListener('pointerleave', () => { if (!pressed) hideTooltip(); });
  }

  legend.innerHTML = `<span><span class="legend-swatch" style="background:var(--series-1)"></span>Actual weight</span>
    <span><span class="legend-dash"></span>Trend (7-day avg)</span>
    <button type="button" id="chartFullJourneyToggle" class="chart-toggle-link">${weightChartFullJourney ? 'Show recent' : 'Full journey'}</button>`;
}

function initWeightChartToggle() {
  document.getElementById('chartLegend').addEventListener('click', e => {
    if (e.target.closest('#chartFullJourneyToggle')) {
      weightChartFullJourney = !weightChartFullJourney;
      renderDashboard();
    }
  });
  document.getElementById('btnShareWeightJourney').addEventListener('click', shareWeightJourney);
  document.getElementById('btnShareRecentPerformance').addEventListener('click', shareRecentPerformance);
}

/* ---- Goal progress bar ---- */
function renderGoalProgress(profile, kgNow, wu, logsArr) {
  const card = document.getElementById('goalProgressCard');
  const emptyNote = document.getElementById('goalEmptyNote');
  card.querySelectorAll('.goal-track').forEach(el => el.remove());

  if (!profile || kgNow == null || profile.goalTargetKg == null) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  const lowestKg7d = logsArr ? minOfLastNDays(logsArr, 'weightKg', 7) : null;

  const points = [
    { label: 'Start', kg: profile.startWeightKg },
    { label: 'Min goal', kg: profile.goalMinKg },
    { label: 'Target', kg: profile.goalTargetKg },
    { label: 'Dream', kg: profile.goalDreamKg },
  ].filter(p => p.kg != null);

  const allKg = points.map(p => p.kg).concat([kgNow]);
  if (lowestKg7d != null) allKg.push(lowestKg7d);
  let min = Math.min(...allKg), max = Math.max(...allKg);
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const pctFor = kg => ((kg - min) / range) * 100;

  const track = document.createElement('div');
  track.className = 'goal-track';

  const startPct = points.length ? pctFor(points[0].kg) : 0;
  const nowPct = pctFor(kgNow);
  const fill = document.createElement('div');
  fill.className = 'goal-fill';
  fill.style.left = Math.min(startPct, nowPct) + '%';
  fill.style.width = Math.abs(nowPct - startPct) + '%';
  track.appendChild(fill);

  points.forEach(p => {
    const marker = document.createElement('div');
    marker.className = 'goal-marker';
    marker.style.left = pctFor(p.kg) + '%';
    marker.textContent = `${p.label}: ${round2(fromKg(p.kg, wu))}${wu}`;
    track.appendChild(marker);
  });

  if (lowestKg7d != null) {
    const lowest = document.createElement('div');
    lowest.className = 'goal-lowest';
    lowest.style.left = pctFor(lowestKg7d) + '%';
    lowest.textContent = `Lowest (7d): ${round2(fromKg(lowestKg7d, wu))}${wu}`;
    track.appendChild(lowest);
  }

  const now = document.createElement('div');
  now.className = 'goal-now';
  now.style.left = nowPct + '%';
  now.textContent = `Now: ${round2(fromKg(kgNow, wu))}${wu}`;
  track.appendChild(now);

  card.appendChild(track);
}

/* ---------------------------------------------------------------- */
/* Training: Strong-style exercise log + rest timer                    */
/* ---------------------------------------------------------------- */
let currentExercises = [];

function loadTrainingForDate(date) {
  const logs = getLogs();
  currentExercises = (logs[date] && logs[date].exercises) ? JSON.parse(JSON.stringify(logs[date].exercises)) : [];
  renderExerciseCards();
  const label = document.getElementById('trainDateLabel');
  if (label) label.textContent = fmtDate(parseISO(date));
}

function persistExercises() {
  const date = document.getElementById('trainDate').value;
  const completedCount = currentExercises.reduce((n, ex) => n + ex.sets.filter(s => s.completed).length, 0);
  updateLogFields(date, { exercises: JSON.parse(JSON.stringify(currentExercises)), workout: completedCount > 0 });
  markTrainingActivity();
  if (date === todayISO()) updateTabDots();
}

function markTrainingActivity() {
  localStorage.setItem('wft_train_last_activity', Date.now().toString());
  localStorage.removeItem('wft_train_idle_notified');
}

function checkTrainingIdle() {
  const dateEl = document.getElementById('trainDate');
  if (!dateEl) return;
  const date = dateEl.value;
  if (!currentExercises.length || isSessionFinished(date)) return;
  const last = parseInt(localStorage.getItem('wft_train_last_activity'), 10);
  if (!last) return;
  const idleMs = Date.now() - last;
  if (idleMs < 30 * 60 * 1000) return;
  if (localStorage.getItem('wft_train_idle_notified') === String(last)) return;
  localStorage.setItem('wft_train_idle_notified', String(last));

  const message = 'Still training? Finish this session or keep going.';
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  playBeep();
  showAppReminder(message);
  fireSystemNotification('Winfinity Tracker', message);
}

function findPreviousSets(name, beforeDate) {
  const logs = getLogs();
  const dates = Object.keys(logs).filter(d => d < beforeDate).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const ex = (logs[dates[i]].exercises || []).find(e => e.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (ex) return ex.sets;
  }
  return null;
}

function estOneRM(weightKg, reps) {
  if (weightKg == null || reps == null || reps <= 0) return 0;
  return weightKg * (1 + reps / 30);
}

function bestHistoricalOneRM(name, beforeDate) {
  const logs = getLogs();
  let best = 0;
  Object.keys(logs).forEach(d => {
    if (d >= beforeDate) return;
    (logs[d].exercises || []).forEach(ex => {
      if (ex.name.trim().toLowerCase() !== name.trim().toLowerCase()) return;
      (ex.sets || []).forEach(s => {
        if (!s.completed) return;
        const rm = estOneRM(s.weightKg, s.reps);
        if (rm > best) best = rm;
      });
    });
  });
  return best;
}

let exerciseDb = [];
let exerciseDbLoaded = false;
let recentExerciseNames = [];
let exerciseSuggestDebounceId = null;

async function loadExerciseDb() {
  if (exerciseDbLoaded) return;
  try {
    const res = await fetch('data/exercises.json');
    exerciseDb = await res.json();
  } catch (e) { exerciseDb = []; /* offline-friendly: suggestions from own history still work */ }
  exerciseDbLoaded = true;
}

function initExerciseNameAutocomplete() {
  renderExerciseNameOptions();
  loadExerciseDb();

  const input = document.getElementById('exerciseName');
  const results = document.getElementById('exerciseSuggestResults');

  input.addEventListener('input', () => {
    clearTimeout(exerciseSuggestDebounceId);
    const q = input.value.trim();
    if (!q) { results.hidden = true; results.innerHTML = ''; return; }
    exerciseSuggestDebounceId = setTimeout(() => renderExerciseSuggestions(q), 150);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) renderExerciseSuggestions(input.value.trim());
  });
  document.addEventListener('click', e => {
    if (!results.hidden && !results.contains(e.target) && e.target !== input) results.hidden = true;
  });
}

function renderExerciseSuggestions(query) {
  const results = document.getElementById('exerciseSuggestResults');
  const q = query.toLowerCase();

  const seen = new Set();
  const matches = [];

  // Own exercise history first — these are the ones actually relevant to this user.
  recentExerciseNames.forEach(name => {
    if (name.toLowerCase().includes(q) && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      matches.push({ name, tag: 'Recent' });
    }
  });

  // Then the exercise library, prefix matches ranked above substring matches.
  const dbMatches = exerciseDb
    .filter(ex => ex.name.toLowerCase().includes(q) && !seen.has(ex.name.toLowerCase()))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    });
  dbMatches.forEach(ex => {
    if (seen.has(ex.name.toLowerCase())) return;
    seen.add(ex.name.toLowerCase());
    matches.push(ex);
  });

  const top = matches.slice(0, 20);
  if (!top.length) { results.hidden = true; results.innerHTML = ''; return; }

  results.innerHTML = top.map((ex, i) => {
    const muscles = (ex.primaryMuscles || []).slice(0, 2);
    const tags = [];
    if (ex.tag === 'Recent') tags.push('<span class="exercise-tag">Recent</span>');
    muscles.forEach(m => tags.push(`<span class="exercise-tag exercise-tag--muscle">${escapeHtml(m)}</span>`));
    if (ex.equipment) tags.push(`<span class="exercise-tag">${escapeHtml(ex.equipment)}</span>`);
    return `
      <button type="button" class="food-search-result-row" data-idx="${i}">
        <div>
          <div class="food-result-name">${escapeHtml(ex.name)}</div>
          <div class="exercise-result-tags">${tags.join('')}</div>
        </div>
      </button>
    `;
  }).join('');
  results.hidden = false;

  results.querySelectorAll('.food-search-result-row').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('exerciseName').value = top[parseInt(btn.dataset.idx, 10)].name;
      results.hidden = true;
    });
  });
}

function renderExerciseNameOptions() {
  const logs = getLogs();
  const seen = new Map();
  Object.keys(logs).forEach(date => {
    (logs[date].exercises || []).forEach(ex => {
      if (!ex.name) return;
      const key = ex.name.trim().toLowerCase();
      const existing = seen.get(key);
      if (!existing || date > existing.lastDate) seen.set(key, { name: ex.name.trim(), lastDate: date });
    });
  });
  recentExerciseNames = Array.from(seen.values()).sort((a, b) => b.lastDate.localeCompare(a.lastDate)).map(v => v.name);
}

function getFinishedDates() {
  try { return JSON.parse(localStorage.getItem('wft_finished_dates')) || {}; } catch (e) { return {}; }
}
function setSessionFinished(date, val) {
  const all = getFinishedDates();
  if (val) all[date] = true; else delete all[date];
  localStorage.setItem('wft_finished_dates', JSON.stringify(all));
}
function isSessionFinished(date) { return !!getFinishedDates()[date]; }

function renderExerciseCards() {
  const container = document.getElementById('exerciseCards');
  const emptyNote = document.getElementById('exerciseEmptyNote');
  const newProtocolBox = document.getElementById('newProtocolBox');
  const profile = getProfile();
  const wu = getTrainUnit();
  const date = document.getElementById('trainDate').value;
  container.innerHTML = '';

  if (!currentExercises.length) { emptyNote.hidden = false; newProtocolBox.hidden = false; return; }
  emptyNote.hidden = true;

  if (isSessionFinished(date)) {
    newProtocolBox.hidden = true;
    const totalSets = currentExercises.reduce((n, ex) => n + ex.sets.filter(s => s.completed).length, 0);
    const isToday = date === todayISO();
    container.innerHTML = `<div class="session-done-card">
      <p class="session-done-title">✓ Workout finished</p>
      <p class="session-done-meta">${currentExercises.length} exercise${currentExercises.length !== 1 ? 's' : ''} · ${totalSets} set${totalSets !== 1 ? 's' : ''} logged</p>
      <div class="session-done-actions">
        ${isToday ? '<button type="button" class="btn" id="btnSessionContinue">Continue</button>' : ''}
        <button type="button" class="btn" id="btnSessionEdit">Edit</button>
        <button type="button" class="btn btn--danger" id="btnSessionCompleted">Completed</button>
      </div>
    </div>`;
    return;
  }
  newProtocolBox.hidden = false;

  currentExercises.forEach((ex, exIdx) => {
    const exUnit = ex.unit || wu;
    const prevSets = findPreviousSets(ex.name, date);
    const card = document.createElement('div');
    card.className = 'ex-card';
    const restMins = Math.round((ex.restSeconds || 180) / 60);
    const restOptions = Array.from({ length: 15 }, (_, i) => i + 1)
      .map(m => `<option value="${m}"${m === restMins ? ' selected' : ''}>${m}m</option>`).join('');

    const rows = ex.sets.map((s, setIdx) => {
      const prev = prevSets && prevSets[setIdx] ? `${prevSets[setIdx].reps} × ${round2(fromKg(prevSets[setIdx].weightKg, exUnit))}${exUnit}` : '–';
      const weightDisplay = s.weightKg != null ? round2(fromKg(s.weightKg, exUnit)) : '';
      return `<tr class="${s.completed ? 'is-complete' : ''}">
        <td>${setIdx + 1}</td>
        <td class="ex-set-prev">${prev}</td>
        <td><input type="number" class="ex-set-reps" data-ex="${exIdx}" data-set="${setIdx}" value="${s.reps ?? ''}" min="0"></td>
        <td><input type="number" class="ex-set-weight" data-ex="${exIdx}" data-set="${setIdx}" value="${weightDisplay}" step="0.5" min="0"></td>
        <td><button type="button" class="ex-set-check${s.completed ? ' is-done' : ''}" data-ex="${exIdx}" data-set="${setIdx}">✓</button></td>
        <td><button type="button" class="ex-set-remove" data-ex="${exIdx}" data-set="${setIdx}">✕</button></td>
      </tr>`;
    }).join('');

    const timerInfo = exTimerDisplayFor(date, exIdx);
    const completedSets = ex.sets.filter(s => s.completed && s.weightKg != null && s.reps != null);
    const bestOneRM = completedSets.reduce((max, s) => Math.max(max, estOneRM(s.weightKg, s.reps)), 0);
    const historicalBest = bestHistoricalOneRM(ex.name, date);
    const isPR = completedSets.length > 0 && historicalBest > 0 && bestOneRM > historicalBest + 0.01;
    card.innerHTML = `
      <p class="mod-tag">MOD_P_${String(exIdx + 1).padStart(2, '0')}</p>
      <div class="ex-card-head">
        <div class="ex-card-title">${escapeHtml(ex.name)}</div>
        <div class="ex-unit-toggle" data-ex="${exIdx}">
          <button type="button" class="ex-unit-btn${exUnit === 'kg' ? ' is-active' : ''}" data-ex="${exIdx}" data-unit="kg">KG</button>
          <button type="button" class="ex-unit-btn${exUnit === 'lb' ? ' is-active' : ''}" data-ex="${exIdx}" data-unit="lb">LB</button>
        </div>
        <div class="ex-card-rest">
          ${isPR ? '<span class="pr-pill">🏆 PR</span>' : ''}
          <span class="ex-rest-timer ${timerInfo.state}" data-ex="${exIdx}">${timerInfo.text}</span>
          ⏱ <select class="ex-rest-select" data-ex="${exIdx}">${restOptions}</select>
        </div>
        <div class="ex-card-menu-wrap">
          <button type="button" class="ex-card-remove" data-ex="${exIdx}">⋮</button>
          <div class="ex-card-menu" data-ex="${exIdx}" hidden>
            <button type="button" class="ex-menu-item ex-menu-rename" data-ex="${exIdx}">Rename</button>
            <button type="button" class="ex-menu-item ex-menu-reset" data-ex="${exIdx}">Reset</button>
            <button type="button" class="ex-menu-item ex-menu-delete" data-ex="${exIdx}">Delete</button>
          </div>
        </div>
      </div>
      <input type="text" class="ex-card-notes" data-ex="${exIdx}" placeholder="Add notes here…" value="${escapeHtml(ex.notes || '')}">
      <table class="ex-sets-table">
        <thead><tr><th>Set</th><th>Previous</th><th>Reps</th><th>Load (${exUnit})</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button type="button" class="btn btn--sm ex-add-set" data-ex="${exIdx}">+ Append set block</button>
    `;
    container.appendChild(card);
  });
}

/* ---------------------------------------------------------------- */
/* Training: outdoor activity tracker (GPS, foreground-only)          */
/* ---------------------------------------------------------------- */
let cardioWatchId = null;
let cardioTickId = null;
let cardioTrack = [];
let cardioDistanceKm = 0;
let cardioMaxSpeedKmh = 0;
let cardioStartTime = null;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distUnitForProfile(profile) { return (profile && profile.weightUnit === 'lb') ? 'mi' : 'km'; }
function kmToMi(km) { return km * 0.621371; }

function formatCardioClock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatCardioDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function renderCardioRouteSketch() {
  const svg = document.getElementById('cardioRouteSketch');
  if (cardioTrack.length < 2) { svg.innerHTML = ''; return; }
  const lats = cardioTrack.map(p => p.lat), lons = cardioTrack.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const w = 300, h = 300, pad = 12;
  const spanLat = Math.max(maxLat - minLat, 0.0001);
  const spanLon = Math.max(maxLon - minLon, 0.0001);
  const points = cardioTrack.map(p => {
    const x = pad + ((p.lon - minLon) / spanLon) * (w - pad * 2);
    const y = h - pad - ((p.lat - minLat) / spanLat) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
}

function formatPaceSecPerUnit(sec) {
  if (!sec || !isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const CARDIO_STRIDE_M = { run: 1.0, walk: 0.75 };

function estimateCardioSteps(distanceKm, type) {
  const stride = CARDIO_STRIDE_M[type];
  if (!stride) return null; // e.g. "ride" — steps don't apply
  return Math.round((distanceKm * 1000) / stride);
}

function updateCardioStats() {
  const elapsed = Math.round((Date.now() - cardioStartTime) / 1000);
  document.getElementById('cardioDuration').textContent = formatCardioClock(elapsed);
  const unit = distUnitForProfile(getProfile());
  const dist = unit === 'mi' ? kmToMi(cardioDistanceKm) : cardioDistanceKm;
  document.getElementById('cardioDistance').textContent = dist.toFixed(2);
  document.getElementById('cardioDistanceLabel').textContent = `Distance (${unit})`;
  document.getElementById('cardioPaceLabel').textContent = `Avg pace /${unit}`;
  document.getElementById('cardioBestPaceLabel').textContent = `Fastest /${unit}`;
  document.getElementById('cardioAvgSpeedLabel').textContent = `Avg speed ${unit === 'mi' ? 'mph' : 'km/h'}`;
  document.getElementById('cardioMaxSpeedLabel').textContent = `Max speed ${unit === 'mi' ? 'mph' : 'km/h'}`;

  if (dist > 0.05) {
    document.getElementById('cardioPace').textContent = formatPaceSecPerUnit(elapsed / dist);
  }
  const avgSpeedKmh = elapsed > 0 ? cardioDistanceKm / (elapsed / 3600) : 0;
  const avgSpeed = unit === 'mi' ? kmToMi(avgSpeedKmh) : avgSpeedKmh;
  document.getElementById('cardioAvgSpeed').textContent = avgSpeed.toFixed(1);
  const maxSpeed = unit === 'mi' ? kmToMi(cardioMaxSpeedKmh) : cardioMaxSpeedKmh;
  document.getElementById('cardioMaxSpeed').textContent = maxSpeed.toFixed(1);
  if (cardioMaxSpeedKmh > 0) {
    const bestPaceSecPerKm = 3600 / cardioMaxSpeedKmh;
    const bestPaceSecPerUnit = unit === 'mi' ? bestPaceSecPerKm / 0.621371 : bestPaceSecPerKm;
    document.getElementById('cardioBestPace').textContent = formatPaceSecPerUnit(bestPaceSecPerUnit);
  }

  const type = document.getElementById('cardioType').value;
  const steps = estimateCardioSteps(cardioDistanceKm, type);
  document.getElementById('cardioStepsTile').hidden = steps == null;
  if (steps != null) document.getElementById('cardioSteps').textContent = steps.toLocaleString();
}

function startCardioTracking() {
  if (!navigator.geolocation) { alert('Geolocation is not available on this device/browser.'); return; }
  cardioTrack = [];
  cardioDistanceKm = 0;
  cardioMaxSpeedKmh = 0;
  cardioStartTime = Date.now();
  document.getElementById('btnCardioStart').hidden = true;
  document.getElementById('btnCardioStop').hidden = false;
  document.getElementById('btnShareCardio').hidden = true;
  document.getElementById('cardioType').disabled = true;
  document.getElementById('cardioDuration').textContent = '00:00';
  document.getElementById('cardioDistance').textContent = '0.00';
  document.getElementById('cardioPace').textContent = '--:--';
  document.getElementById('cardioBestPace').textContent = '--:--';
  document.getElementById('cardioAvgSpeed').textContent = '0.0';
  document.getElementById('cardioMaxSpeed').textContent = '0.0';
  document.getElementById('cardioSteps').textContent = '0';
  document.getElementById('cardioStepsTile').hidden = estimateCardioSteps(0, document.getElementById('cardioType').value) == null;
  document.getElementById('cardioRouteSketch').hidden = false;
  document.getElementById('cardioMapView').hidden = true;
  document.getElementById('cardioMapZoomRow').hidden = true;
  renderCardioRouteSketch();

  cardioWatchId = navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy != null && accuracy > 50) return;
    const point = { lat: latitude, lon: longitude, t: Date.now() };
    if (cardioTrack.length) {
      const last = cardioTrack[cardioTrack.length - 1];
      const segKm = haversineKm(last.lat, last.lon, point.lat, point.lon);
      if (segKm > 0.003) {
        const segHours = (point.t - last.t) / 3600000;
        const segSpeedKmh = segHours > 0 ? segKm / segHours : 0;
        const speedCap = document.getElementById('cardioType').value === 'ride' ? 80 : 45;
        if (segSpeedKmh > 0 && segSpeedKmh <= speedCap) cardioMaxSpeedKmh = Math.max(cardioMaxSpeedKmh, segSpeedKmh);
        cardioDistanceKm += segKm;
        cardioTrack.push(point);
        renderCardioRouteSketch();
      }
    } else {
      cardioTrack.push(point);
    }
  }, () => { /* GPS error: keep timer running, just no new distance */ }, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 10000,
  });

  cardioTickId = setInterval(updateCardioStats, 1000);
  startCardioHydrationReminders();
}

let lastCardioSession = null;

function stopCardioTracking() {
  if (cardioWatchId != null) navigator.geolocation.clearWatch(cardioWatchId);
  if (cardioTickId) clearInterval(cardioTickId);
  cardioWatchId = null;
  cardioTickId = null;
  stopCardioHydrationReminders();

  const elapsedSec = Math.round((Date.now() - cardioStartTime) / 1000);
  const type = document.getElementById('cardioType').value;
  const date = document.getElementById('trainDate').value;
  const logs = getLogs();
  const sessions = (logs[date] && logs[date].cardioSessions) || [];
  const session = {
    type,
    distanceKm: round2(cardioDistanceKm),
    durationSec: elapsedSec,
    startedAt: new Date(cardioStartTime).toISOString(),
    maxSpeedKmh: round2(cardioMaxSpeedKmh),
  };
  sessions.push(session);
  updateLogFields(date, { cardioSessions: sessions });
  lastCardioSession = session;

  document.getElementById('btnCardioStart').hidden = false;
  document.getElementById('btnCardioStop').hidden = true;
  document.getElementById('cardioType').disabled = false;
  document.getElementById('cardioSaveNote').textContent = 'Activity saved.';
  setTimeout(() => { document.getElementById('cardioSaveNote').textContent = ''; }, 2500);
  document.getElementById('btnShareCardio').hidden = false;
  renderCardioMap(cardioTrack);
  renderCardioHistory();
  autoSyncLeaderboardIfOptedIn();
}

let cardioMapInstance = null;

function renderCardioMap(track) {
  const sketch = document.getElementById('cardioRouteSketch');
  const mapEl = document.getElementById('cardioMapView');
  if (!window.L || track.length < 2) return; // no internet/Leaflet, or nothing to plot — keep the offline sketch visible
  sketch.hidden = true;
  mapEl.hidden = false;
  document.getElementById('cardioMapZoomRow').hidden = false;

  if (cardioMapInstance) { cardioMapInstance.remove(); cardioMapInstance = null; }
  const map = L.map(mapEl, { zoomControl: false, attributionControl: true });
  cardioMapInstance = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const latlngs = track.map(p => [p.lat, p.lon]);
  const path = L.polyline(latlngs, { color: '#33c8cc', weight: 4, lineCap: 'round', lineJoin: 'round' }).addTo(map);
  L.circleMarker(latlngs[0], { radius: 7, weight: 2, color: '#fff', fillColor: '#34bd7c', fillOpacity: 1 }).addTo(map);
  L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, weight: 2, color: '#fff', fillColor: '#e6516a', fillOpacity: 1 }).addTo(map);
  map.fitBounds(path.getBounds(), { padding: [20, 20] });
}

function lonToPixelX(lon, zoom) { return (lon + 180) / 360 * 256 * Math.pow(2, zoom); }
function latToPixelY(lat, zoom) {
  const latRad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * 256 * Math.pow(2, zoom);
}

function pickMapZoom(track, mapW, mapH) {
  const lats = track.map(p => p.lat), lons = track.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  for (let z = 18; z >= 1; z--) {
    const w = lonToPixelX(maxLon, z) - lonToPixelX(minLon, z);
    const h = latToPixelY(minLat, z) - latToPixelY(maxLat, z);
    if (w <= mapW * 0.8 && h <= mapH * 0.8) return z;
  }
  return 1;
}

function loadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function drawMapBackground(ctx, track, mapW, mapH) {
  const zoom = pickMapZoom(track, mapW, mapH);
  const lats = track.map(p => p.lat), lons = track.map(p => p.lon);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const originX = lonToPixelX(centerLon, zoom) - mapW / 2;
  const originY = latToPixelY(centerLat, zoom) - mapH / 2;

  const tileMin = { x: Math.floor(originX / 256), y: Math.floor(originY / 256) };
  const tileMax = { x: Math.floor((originX + mapW) / 256), y: Math.floor((originY + mapH) / 256) };
  const subdomains = ['a', 'b', 'c'];
  let sIdx = 0;
  const loads = [];
  for (let tx = tileMin.x; tx <= tileMax.x; tx++) {
    for (let ty = tileMin.y; ty <= tileMax.y; ty++) {
      const s = subdomains[sIdx++ % subdomains.length];
      const url = `https://${s}.tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
      loads.push(loadImage(url).then(img => ({ img, tx, ty })));
    }
  }
  const tiles = await Promise.all(loads);
  tiles.forEach(({ img, tx, ty }) => {
    if (!img) return;
    ctx.drawImage(img, tx * 256 - originX, ty * 256 - originY, 256, 256);
  });

  return { zoom, originX, originY };
}

function projectTrackToMap(track, proj) {
  return track.map(p => ({
    x: lonToPixelX(p.lon, proj.zoom) - proj.originX,
    y: latToPixelY(p.lat, proj.zoom) - proj.originY,
  }));
}

async function generateCardioShareCardWithMap(track, { emoji, title, stats }) {
  const canvas = document.createElement('canvas');
  canvas.width = 600; canvas.height = 600;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#171f24';
  ctx.fillRect(0, 0, 600, 600);

  let proj = null;
  if (track.length > 1) {
    try { proj = await drawMapBackground(ctx, track, 600, 600); } catch (e) { proj = null; }
  }
  if (!proj) return generateShareCardBlob({ emoji, title, stats }); // offline or track too short — plain card instead

  {
    const pts = projectTrackToMap(track, proj);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 7;
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    ctx.strokeStyle = '#33c8cc';
    ctx.lineWidth = 4;
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();

    [{ p: pts[0], color: '#34bd7c' }, { p: pts[pts.length - 1], color: '#e6516a' }].forEach(({ p, color }) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    });
  }

  const bannerTop = stats.length > 3 ? 330 : 380;
  const gradient = ctx.createLinearGradient(0, bannerTop, 0, 600);
  gradient.addColorStop(0, 'rgba(10,14,18,0)');
  gradient.addColorStop(1, 'rgba(10,14,18,0.92)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, bannerTop, 600, 600 - bannerTop);

  ctx.textAlign = 'left';
  ctx.font = '32px sans-serif';
  ctx.fillText(emoji, 30, bannerTop + 55);
  ctx.fillStyle = '#33c8cc';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(title, 76, bannerTop + 50);

  const cols = [30, 220, 410];
  const rowY = [bannerTop + 115, bannerTop + 175];
  stats.forEach((s, i) => {
    const x = cols[i % 3];
    const y = rowY[Math.floor(i / 3)];
    ctx.fillStyle = '#7e8e95';
    ctx.font = '12px monospace';
    ctx.fillText(s.label.toUpperCase(), x, y);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 21px sans-serif';
    ctx.fillText(s.value, x, y + 28);
  });

  await drawShareWatermark(ctx, 600, 600);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareCardioSession() {
  if (!lastCardioSession) return;
  const unit = distUnitForProfile(getProfile());
  const dist = unit === 'mi' ? kmToMi(lastCardioSession.distanceKm) : lastCardioSession.distanceKm;
  const typeLabel = { run: 'run', walk: 'walk', ride: 'ride' }[lastCardioSession.type] || 'activity';
  const emoji = { run: '🏃', walk: '🚶', ride: '🚴' }[lastCardioSession.type] || '🏁';
  const text = `${emoji} Just finished a ${dist.toFixed(2)} ${unit} ${typeLabel} in ${formatCardioDuration(lastCardioSession.durationSec)} with Winfinity Tracker!`;
  const paceMin = lastCardioSession.distanceKm > 0 ? (lastCardioSession.durationSec / 60) / dist : 0;
  const paceText = paceMin > 0 ? `${Math.floor(paceMin)}:${String(Math.round((paceMin % 1) * 60)).padStart(2, '0')} /${unit}` : '--';
  const avgSpeedKmh = lastCardioSession.durationSec > 0 ? lastCardioSession.distanceKm / (lastCardioSession.durationSec / 3600) : 0;
  const avgSpeed = unit === 'mi' ? kmToMi(avgSpeedKmh) : avgSpeedKmh;
  const maxSpeedKmh = lastCardioSession.maxSpeedKmh || 0;
  const maxSpeed = unit === 'mi' ? kmToMi(maxSpeedKmh) : maxSpeedKmh;
  const bestPaceSecPerUnit = maxSpeedKmh > 0 ? (unit === 'mi' ? (3600 / maxSpeedKmh) / 0.621371 : 3600 / maxSpeedKmh) : 0;
  const bestPaceText = bestPaceSecPerUnit > 0 ? formatPaceSecPerUnit(bestPaceSecPerUnit) + ` /${unit}` : '--';
  const speedUnit = unit === 'mi' ? 'mph' : 'km/h';
  const blob = await generateCardioShareCardWithMap(cardioTrack, {
    emoji,
    title: `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} complete!`,
    stats: [
      { label: 'Distance', value: `${dist.toFixed(2)} ${unit}` },
      { label: 'Duration', value: formatCardioDuration(lastCardioSession.durationSec) },
      { label: 'Avg pace', value: paceText },
      { label: 'Fastest', value: bestPaceText },
      { label: 'Avg speed', value: `${avgSpeed.toFixed(1)} ${speedUnit}` },
      { label: 'Max speed', value: `${maxSpeed.toFixed(1)} ${speedUnit}` },
    ],
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Activity', text }, blob);
}

function renderCardioHistory() {
  const logsArr = sortedLogsArray().slice().reverse();
  const unit = distUnitForProfile(getProfile());
  const container = document.getElementById('cardioHistory');
  const empty = document.getElementById('cardioHistoryEmpty');
  const rows = [];
  logsArr.forEach(l => { (l.cardioSessions || []).forEach(s => rows.push({ date: l.date, ...s })); });
  container.innerHTML = '';
  if (!rows.length) { empty.hidden = false; return; }
  empty.hidden = true;
  rows.slice(0, 10).forEach(s => {
    const dist = unit === 'mi' ? kmToMi(s.distanceKm) : s.distanceKm;
    const row = document.createElement('div');
    row.className = 'cardio-history-row';
    row.innerHTML = `<span class="cardio-history-date">${s.date}</span>
      <span class="cardio-history-type">${s.type}</span>
      <span class="cardio-history-dist">${dist.toFixed(2)} ${unit}</span>
      <span class="cardio-history-dur">${formatCardioDuration(s.durationSec)}</span>`;
    container.appendChild(row);
  });
}

function initCardioTracker() {
  document.getElementById('btnCardioStart').addEventListener('click', startCardioTracking);
  document.getElementById('btnCardioStop').addEventListener('click', stopCardioTracking);
  document.getElementById('btnShareCardio').addEventListener('click', shareCardioSession);
  document.getElementById('btnCardioZoomIn').addEventListener('click', () => { if (cardioMapInstance) cardioMapInstance.zoomIn(); });
  document.getElementById('btnCardioZoomOut').addEventListener('click', () => { if (cardioMapInstance) cardioMapInstance.zoomOut(); });
  renderCardioHistory();
}

function getActiveTrainingDate() {
  const stored = localStorage.getItem('wft_active_train_date');
  if (!stored) return todayISO();
  const logs = getLogs();
  const hasData = logs[stored] && logs[stored].exercises && logs[stored].exercises.length > 0;
  return (hasData && !isSessionFinished(stored)) ? stored : todayISO();
}

/* ---------------------------------------------------------------- */
/* Training: temporal mission log (calendar of workout days)          */
/* ---------------------------------------------------------------- */
let missionLogViewDate = new Date();

function getWorkoutDaysSet() {
  const logs = getLogs();
  const set = new Set();
  Object.keys(logs).forEach(date => {
    const l = logs[date];
    if (l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))) set.add(date);
  });
  return set;
}

function getPeriodDaysSet() {
  const logs = getLogs();
  const set = new Set();
  Object.keys(logs).forEach(date => {
    if (logs[date].menstruating) set.add(date);
  });
  return set;
}

function renderMissionLogCalendar() {
  const year = missionLogViewDate.getFullYear();
  const month = missionLogViewDate.getMonth();
  document.getElementById('missionLogMonthLabel').textContent =
    missionLogViewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const profile = getProfile();
  const showPeriod = profile && profile.gender === 'female';
  const workoutDays = getWorkoutDaysSet();
  const periodDays = showPeriod ? getPeriodDaysSet() : new Set();
  const carryoverResets = getCarryoverResets();
  const todayIso = todayISO();

  document.getElementById('missionLogPeriodLegend').hidden = !showPeriod;

  const firstOfMonth = new Date(year, month, 1);
  const firstWeekday = firstOfMonth.getDay(); // Sunday-first index
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push({ day: daysInPrevMonth - firstWeekday + 1 + i, muted: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, iso, isToday: iso === todayIso, isWorkout: workoutDays.has(iso), isPeriod: periodDays.has(iso), isReset: !!carryoverResets[iso] });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) { cells.push({ day: nextDay++, muted: true }); }

  const grid = document.getElementById('missionLogGrid');
  grid.innerHTML = cells.map(c => {
    const classes = ['mission-log-day'];
    if (c.muted) classes.push('is-muted');
    if (c.isWorkout) classes.push('is-workout');
    if (c.isToday) classes.push('is-today');
    if (c.isPeriod) classes.push('is-period');
    if (c.isReset) classes.push('is-reset');
    const dot = c.isPeriod ? '<span class="mission-log-period-dot"></span>' : '';
    const resetDot = c.isReset ? '<span class="mission-log-reset-dot"></span>' : '';
    const isoAttr = c.iso ? ` data-iso="${c.iso}"` : '';
    return `<div class="${classes.join(' ')}"${isoAttr}>${c.day}${dot}${resetDot}</div>`;
  }).join('');
}

function initMissionLog() {
  const overlay = document.getElementById('missionLogOverlay');
  document.getElementById('btnOpenMissionLog').addEventListener('click', () => {
    missionLogViewDate = new Date();
    renderMissionLogCalendar();
    overlay.hidden = false;
  });
  document.getElementById('btnCloseMissionLog').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
  document.getElementById('btnMissionLogPrev').addEventListener('click', () => {
    missionLogViewDate = new Date(missionLogViewDate.getFullYear(), missionLogViewDate.getMonth() - 1, 1);
    renderMissionLogCalendar();
  });
  document.getElementById('btnMissionLogNext').addEventListener('click', () => {
    missionLogViewDate = new Date(missionLogViewDate.getFullYear(), missionLogViewDate.getMonth() + 1, 1);
    renderMissionLogCalendar();
  });
  document.getElementById('missionLogGrid').addEventListener('click', e => {
    const cell = e.target.closest('.mission-log-day.is-reset');
    if (!cell) return;
    const iso = cell.dataset.iso;
    const rec = getCarryoverResets()[iso];
    if (!rec) return;
    const label = rec.balanceBefore > 0 ? `+${round0(rec.balanceBefore)} kcal banked` : `${round0(rec.balanceBefore)} kcal overflow`;
    showRestToast(`Carryover reset on ${fmtDate(parseISO(iso))}: ${label} cleared.`);
  });
}

/* ---------------------------------------------------------------- */
/* Shared date-picker popup (same visual as Temporal Mission Log)     */
/* Every readonly .date-picker-trigger input opens this instead of     */
/* the native OS picker; selecting a day sets .value + fires change,  */
/* so every existing change-listener keeps working unmodified.        */
/* ---------------------------------------------------------------- */
let datePickerViewDate = new Date();
let datePickerTargetInput = null;

function renderDatePickerGrid(selectedIso) {
  const year = datePickerViewDate.getFullYear();
  const month = datePickerViewDate.getMonth();
  document.getElementById('datePickerMonthLabel').textContent =
    datePickerViewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const todayIso = todayISO();
  const firstOfMonth = new Date(year, month, 1);
  const firstWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({ day: daysInPrevMonth - firstWeekday + 1 + i, muted: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, iso, isToday: iso === todayIso, isSelected: iso === selectedIso });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) cells.push({ day: nextDay++, muted: true });

  const grid = document.getElementById('datePickerGrid');
  grid.innerHTML = cells.map(c => {
    const classes = ['mission-log-day'];
    if (c.isToday) classes.push('is-today');
    if (c.isSelected) classes.push('is-selected');
    if (c.muted) { classes.push('is-muted'); return `<div class="${classes.join(' ')}">${c.day}</div>`; }
    return `<button type="button" class="${classes.join(' ')}" data-iso="${c.iso}">${c.day}</button>`;
  }).join('');
}

function openDatePicker(inputEl, title) {
  const current = inputEl.value;
  const base = current ? parseISO(current) : new Date();
  datePickerViewDate = new Date(base.getFullYear(), base.getMonth(), 1);
  datePickerTargetInput = inputEl;
  document.getElementById('datePickerTitle').textContent = title || 'Select Date';
  renderDatePickerGrid(current);
  document.getElementById('datePickerOverlay').hidden = false;
}

function initDatePicker() {
  const overlay = document.getElementById('datePickerOverlay');
  document.getElementById('btnCloseDatePicker').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
  document.getElementById('btnDatePickerPrev').addEventListener('click', () => {
    datePickerViewDate = new Date(datePickerViewDate.getFullYear(), datePickerViewDate.getMonth() - 1, 1);
    renderDatePickerGrid(datePickerTargetInput ? datePickerTargetInput.value : null);
  });
  document.getElementById('btnDatePickerNext').addEventListener('click', () => {
    datePickerViewDate = new Date(datePickerViewDate.getFullYear(), datePickerViewDate.getMonth() + 1, 1);
    renderDatePickerGrid(datePickerTargetInput ? datePickerTargetInput.value : null);
  });
  document.getElementById('btnDatePickerToday').addEventListener('click', () => {
    datePickerViewDate = new Date();
    renderDatePickerGrid(todayISO());
  });
  document.getElementById('datePickerGrid').addEventListener('click', e => {
    const btn = e.target.closest('button[data-iso]');
    if (!btn || !datePickerTargetInput) return;
    overlay.hidden = true;
    datePickerTargetInput.value = btn.dataset.iso;
    datePickerTargetInput.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const titles = {
    trainDate: 'Training Date', nutDate: 'Fuel Date', bioDate: 'Bio Date',
    reviewDate: 'Week Ending', setupStartDate: 'Challenge Start', measureDate: 'Measurement Date',
    foodDiaryDateInput: 'Food Diary Date',
    coachRefeedStart: 'Refeed Start', coachRefeedEnd: 'Refeed End',
  };
  document.querySelectorAll('.date-picker-trigger').forEach(input => {
    input.addEventListener('click', () => openDatePicker(input, titles[input.id] || 'Select Date'));
  });
}

function initTraining() {
  document.getElementById('trainDate').value = getActiveTrainingDate();
  localStorage.setItem('wft_active_train_date', document.getElementById('trainDate').value);
  document.getElementById('trainDate').addEventListener('change', e => {
    localStorage.setItem('wft_active_train_date', e.target.value);
    loadTrainingForDate(e.target.value);
  });

  document.getElementById('btnAddExercise').addEventListener('click', () => {
    const nameInput = document.getElementById('exerciseName');
    const name = nameInput.value.trim();
    if (!name) return;
    const date = document.getElementById('trainDate').value;
    const prevSets = findPreviousSets(name, date);
    const firstSet = prevSets && prevSets[0] ? { reps: prevSets[0].reps, weightKg: prevSets[0].weightKg, completed: false } : { reps: null, weightKg: null, completed: false };
    currentExercises.push({ name, restSeconds: 180, notes: '', unit: getTrainUnit(), sets: [firstSet] });
    persistExercises();
    renderExerciseCards();
    renderExerciseNameOptions();
    nameInput.value = '';
    nameInput.focus();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.ex-card-menu-wrap')) {
      document.querySelectorAll('.ex-card-menu').forEach(m => { m.hidden = true; });
    }
  });

  const cards = document.getElementById('exerciseCards');

  cards.addEventListener('click', e => {
    const wu = (getProfile() || {}).weightUnit || 'kg';

    const sessionContinueBtn = e.target.closest('#btnSessionContinue');
    if (sessionContinueBtn) {
      const date = document.getElementById('trainDate').value;
      setSessionFinished(date, false);
      markTrainingActivity();
      renderExerciseCards();
      renderTrainingStats();
      return;
    }

    const sessionEditBtn = e.target.closest('#btnSessionEdit');
    if (sessionEditBtn) {
      const date = document.getElementById('trainDate').value;
      setSessionFinished(date, false);
      renderExerciseCards();
      renderTrainingStats();
      return;
    }

    const sessionCompletedBtn = e.target.closest('#btnSessionCompleted');
    if (sessionCompletedBtn) {
      if (confirm('Mark this session as completed? Your logged exercises stay saved in your history.')) {
        const date = document.getElementById('trainDate').value;
        const allTimers = getExTimers();
        if (allTimers[date]) { delete allTimers[date]; saveExTimers(allTimers); }
        showRestToast('Session completed — saved to your Accomplishment Log.');
        renderExerciseCards();
        renderTrainingStats();
      }
      return;
    }

    const menuToggleBtn = e.target.closest('.ex-card-remove');
    if (menuToggleBtn) {
      const menu = menuToggleBtn.closest('.ex-card-menu-wrap').querySelector('.ex-card-menu');
      const wasOpen = !menu.hidden;
      document.querySelectorAll('.ex-card-menu').forEach(m => { m.hidden = true; });
      menu.hidden = wasOpen;
      return;
    }

    const unitBtn = e.target.closest('.ex-unit-btn');
    if (unitBtn) {
      const exIdx = parseInt(unitBtn.dataset.ex, 10);
      currentExercises[exIdx].unit = unitBtn.dataset.unit;
      persistExercises();
      renderExerciseCards();
      return;
    }

    const renameBtn = e.target.closest('.ex-menu-rename');
    if (renameBtn) {
      const exIdx = parseInt(renameBtn.dataset.ex, 10);
      const newName = prompt('Rename exercise', currentExercises[exIdx].name);
      if (newName && newName.trim()) {
        currentExercises[exIdx].name = newName.trim();
        persistExercises();
        renderExerciseCards();
        renderExerciseNameOptions();
      }
      return;
    }

    const resetBtn = e.target.closest('.ex-menu-reset');
    if (resetBtn) {
      const exIdx = parseInt(resetBtn.dataset.ex, 10);
      if (confirm('Reset all sets for this exercise? Completed checkmarks will be cleared.')) {
        currentExercises[exIdx].sets.forEach(s => { s.completed = false; });
        persistExercises();
        const date = document.getElementById('trainDate').value;
        const allTimers = getExTimers();
        if (allTimers[date]) { delete allTimers[date][exIdx]; saveExTimers(allTimers); }
        renderExerciseCards();
        renderTrainingStats();
      }
      return;
    }

    const deleteBtn = e.target.closest('.ex-menu-delete');
    if (deleteBtn) {
      const exIdx = parseInt(deleteBtn.dataset.ex, 10);
      if (confirm('Delete this exercise from today\'s session?')) {
        currentExercises.splice(exIdx, 1);
        persistExercises();
        renderExerciseCards();
        renderTrainingStats();
      }
      return;
    }

    const addSetBtn = e.target.closest('.ex-add-set');
    if (addSetBtn) {
      const exIdx = parseInt(addSetBtn.dataset.ex, 10);
      const ex = currentExercises[exIdx];
      const last = ex.sets[ex.sets.length - 1];
      const date = document.getElementById('trainDate').value;
      const prevSets = findPreviousSets(ex.name, date);
      const nextIdx = ex.sets.length;
      const fallback = prevSets && prevSets[nextIdx] ? { reps: prevSets[nextIdx].reps, weightKg: prevSets[nextIdx].weightKg } : (last ? { reps: last.reps, weightKg: last.weightKg } : { reps: null, weightKg: null });
      ex.sets.push({ reps: fallback.reps, weightKg: fallback.weightKg, completed: false });
      persistExercises(); renderExerciseCards(); return;
    }

    const removeSetBtn = e.target.closest('.ex-set-remove');
    if (removeSetBtn) {
      if (!confirm('Delete this set? This cannot be undone.')) return;
      const exIdx = parseInt(removeSetBtn.dataset.ex, 10);
      const setIdx = parseInt(removeSetBtn.dataset.set, 10);
      currentExercises[exIdx].sets.splice(setIdx, 1);
      if (!currentExercises[exIdx].sets.length) currentExercises.splice(exIdx, 1);
      persistExercises(); renderExerciseCards(); return;
    }

    const checkBtn = e.target.closest('.ex-set-check');
    if (checkBtn) {
      const exIdx = parseInt(checkBtn.dataset.ex, 10);
      const setIdx = parseInt(checkBtn.dataset.set, 10);
      const set = currentExercises[exIdx].sets[setIdx];
      set.completed = !set.completed;
      persistExercises();
      renderExerciseCards();
      renderTrainingStats();
      if (set.completed) startExerciseTimer(exIdx, currentExercises[exIdx].restSeconds || 180);
      return;
    }
  });

  cards.addEventListener('change', e => {
    if (e.target.classList.contains('ex-set-reps')) {
      const exIdx = parseInt(e.target.dataset.ex, 10), setIdx = parseInt(e.target.dataset.set, 10);
      currentExercises[exIdx].sets[setIdx].reps = parseIntOrNull(e.target.value);
      persistExercises();
    } else if (e.target.classList.contains('ex-set-weight')) {
      const exIdx = parseInt(e.target.dataset.ex, 10), setIdx = parseInt(e.target.dataset.set, 10);
      const exUnit = currentExercises[exIdx].unit || getTrainUnit();
      const val = parseFloat(e.target.value);
      currentExercises[exIdx].sets[setIdx].weightKg = isNaN(val) ? null : toKg(val, exUnit);
      persistExercises();
    } else if (e.target.classList.contains('ex-card-notes')) {
      const exIdx = parseInt(e.target.dataset.ex, 10);
      currentExercises[exIdx].notes = e.target.value;
      persistExercises();
    } else if (e.target.classList.contains('ex-rest-select')) {
      const exIdx = parseInt(e.target.dataset.ex, 10);
      currentExercises[exIdx].restSeconds = parseInt(e.target.value, 10) * 60;
      persistExercises();
    }
  });

  let lastWorkoutSummary = null;
  document.getElementById('btnFinishWorkout').addEventListener('click', () => {
    persistExercises();
    const date = document.getElementById('trainDate').value;
    const summary = computeWorkoutSummary(date);
    lastWorkoutSummary = summary;
    renderWorkoutSummary(summary);
    document.getElementById('summaryOverlay').hidden = false;
    if (currentExercises.length) setSessionFinished(date, true);
    renderExerciseCards();
    renderTrainingStats();
    autoSyncLeaderboardIfOptedIn();
  });

  document.getElementById('btnCloseSummary').addEventListener('click', () => { document.getElementById('summaryOverlay').hidden = true; });
  document.getElementById('btnDoneSummary').addEventListener('click', () => { document.getElementById('summaryOverlay').hidden = true; });
  document.getElementById('btnShareSummary').addEventListener('click', async () => {
    if (!lastWorkoutSummary) return;
    const wu = lastWorkoutSummary.wu;
    const prCount = lastWorkoutSummary.exercises.filter(e => e.isPR).length;
    const vol = round0(fromKg(lastWorkoutSummary.totalVolumeKg, wu));
    let text = `💪 Just finished a Winfinity Tracker session: ${lastWorkoutSummary.exercises.length} exercises, ${lastWorkoutSummary.totalSets} sets, ${vol} ${wu} total volume.`;
    if (prCount > 0) text += ` 🏆 ${prCount} new PR${prCount > 1 ? 's' : ''}!`;
    const profile = getProfile();
    const trainDate = document.getElementById('trainDate').value || todayISO();
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const blob = await generateWorkoutSummaryShareCard({
      name: (profile && profile.name) || 'Operator',
      digitalId: getOrCreatePublicId(),
      dateTime: `${fmtDate(parseISO(trainDate))} · ${timeStr}`,
      summary: lastWorkoutSummary,
    });
    shareViaWebShare({ title: 'Winfinity Tracker — Workout Summary', text }, blob);
  });

  loadTrainingForDate(document.getElementById('trainDate').value);
  renderTrainingStats();
  ensureExTimerTicking();
  initSessionTemplates();
  initExerciseNameAutocomplete();
  checkTrainingIdle();
  setInterval(checkTrainingIdle, 60000);
}

function renderTrainingStats() {
  const logsArr = sortedLogsArray();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0,0,0,0);
  const recent = logsArr.filter(l => parseISO(l.date) >= cutoff);
  const workouts = recent.filter(l => l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))).length;
  const sets = recent.reduce((sum, l) => sum + (l.exercises || []).reduce((s, ex) => s + ex.sets.filter(st => st.completed).length, 0), 0);
  const profile = getProfile();
  const workoutTarget = profile && profile.coachWorkoutsPerWeek;
  document.getElementById('statWorkoutsWeek').textContent = workoutTarget ? `${workouts} / ${workoutTarget}` : workouts;
  document.getElementById('statSetsWeek').textContent = sets;
  renderPRBoard();
  renderVolumeTrendChart();
}

function computeDayVolumeKg(entry) {
  if (!entry || !entry.exercises) return 0;
  return entry.exercises.reduce((sum, ex) =>
    sum + (ex.sets || []).filter(s => s.completed && s.weightKg != null && s.reps != null)
      .reduce((s2, s) => s2 + s.weightKg * s.reps, 0), 0);
}

function renderVolumeTrendChart() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray();
  const gymDays = logsArr.filter(l => l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))).slice(-8);
  const chart = document.getElementById('volumeTrendChart');
  const labels = document.getElementById('volumeTrendLabels');
  const emptyNote = document.getElementById('volumeTrendEmptyNote');
  const totalLabel = document.getElementById('volumeTrendTotal');
  chart.innerHTML = ''; labels.innerHTML = '';
  if (!gymDays.length) {
    emptyNote.hidden = false;
    totalLabel.textContent = '';
    return;
  }
  emptyNote.hidden = true;
  const volumes = gymDays.map(l => fromKg(computeDayVolumeKg(l), wu));
  totalLabel.textContent = `${round0(volumes.reduce((s, v) => s + v, 0)).toLocaleString()} ${wu} total`;
  const max = Math.max(...volumes, 1);
  const w = 280, h = 90, pad = 6;
  const stepX = gymDays.length > 1 ? w / (gymDays.length - 1) : 0;
  const points = volumes.map((v, i) => ({
    x: gymDays.length > 1 ? i * stepX : w / 2,
    y: h - pad - (v / max) * (h - pad * 2),
  }));
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `M${points[0].x.toFixed(1)},${h} ${linePath.replace(/^M/, 'L')} L${points[points.length - 1].x.toFixed(1)},${h} Z`;

  const dots = points.map((p, i) => {
    const tip = `${fmtDate(parseISO(gymDays[i].date))}: ${round0(volumes[i])} ${wu}`;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"><title>${escapeHtml(tip)}</title></circle>`;
  }).join('');

  chart.innerHTML = `
    <path d="${areaPath}" fill="var(--cyan)" opacity="0.12"></path>
    <path d="${linePath}" fill="none" stroke="var(--cyan)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <g fill="var(--cyan)">${dots}</g>
  `;
  gymDays.forEach(l => {
    const lbl = document.createElement('span');
    const d = parseISO(l.date);
    lbl.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
    labels.appendChild(lbl);
  });
}

/* ---- Session templates ---- */
function getSessionTemplates() {
  try { return JSON.parse(localStorage.getItem('wft_session_templates')) || []; }
  catch { return []; }
}
function saveSessionTemplates(list) { localStorage.setItem('wft_session_templates', JSON.stringify(list)); }

function renderSessionTemplateOptions() {
  const sel = document.getElementById('sessionTemplateSelect');
  const templates = getSessionTemplates();
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>' +
    templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  if (templates.some(t => t.id === current)) sel.value = current;
}

function initSessionTemplates() {
  renderSessionTemplateOptions();

  document.getElementById('btnSaveTemplate').addEventListener('click', () => {
    const nameInput = document.getElementById('sessionTemplateName');
    const name = nameInput.value.trim();
    const note = document.getElementById('sessionTemplateNote');
    if (!name) { alert('Enter a name for this session.'); return; }
    if (!currentExercises.length) { alert('Add at least one exercise before saving a session.'); return; }
    const templates = getSessionTemplates();
    const templateExercises = currentExercises.map(ex => ({
      name: ex.name,
      restSeconds: ex.restSeconds,
      unit: ex.unit || getTrainUnit(),
      sets: ex.sets.map(s => ({ reps: s.reps, weightKg: s.weightKg })),
    }));
    templates.push({ id: generateShareKey(), name, exercises: templateExercises });
    saveSessionTemplates(templates);
    renderSessionTemplateOptions();
    nameInput.value = '';
    note.textContent = `Saved "${name}".`;
    setTimeout(() => { note.textContent = ''; }, 2500);
  });

  document.getElementById('btnLoadTemplate').addEventListener('click', () => {
    const id = document.getElementById('sessionTemplateSelect').value;
    if (!id) { alert('Select a session to load.'); return; }
    const template = getSessionTemplates().find(t => t.id === id);
    if (!template) return;
    if (currentExercises.length && !confirm('This replaces the exercises currently logged for this date. Continue?')) return;
    currentExercises = template.exercises.map(ex => ({
      name: ex.name,
      restSeconds: ex.restSeconds || 180,
      notes: '',
      unit: ex.unit || getTrainUnit(),
      sets: ex.sets.map(s => ({ reps: s.reps, weightKg: s.weightKg, completed: false })),
    }));
    persistExercises();
    setSessionFinished(document.getElementById('trainDate').value, false);
    renderExerciseCards();
    renderTrainingStats();
    const note = document.getElementById('sessionTemplateNote');
    note.textContent = `Loaded "${template.name}".`;
    setTimeout(() => { note.textContent = ''; }, 2500);
  });

  document.getElementById('btnDeleteTemplate').addEventListener('click', () => {
    const id = document.getElementById('sessionTemplateSelect').value;
    if (!id) { alert('Select a session to delete.'); return; }
    const templates = getSessionTemplates();
    const template = templates.find(t => t.id === id);
    if (!template || !confirm(`Delete session "${template.name}"?`)) return;
    saveSessionTemplates(templates.filter(t => t.id !== id));
    renderSessionTemplateOptions();
  });
}

/* ---- Personal records board ---- */
function computePRBoard() {
  const logs = getLogs();
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const byExercise = {};
  Object.keys(logs).sort().forEach(date => {
    (logs[date].exercises || []).forEach(ex => {
      const key = ex.name.trim().toLowerCase();
      if (!byExercise[key]) byExercise[key] = { name: ex.name.trim(), entries: [] };
      (ex.sets || []).forEach(s => {
        if (!s.completed || s.weightKg == null || s.reps == null) return;
        byExercise[key].entries.push({ date, weightKg: s.weightKg, reps: s.reps, oneRM: estOneRM(s.weightKg, s.reps) });
      });
    });
  });
  const rows = Object.values(byExercise).map(ex => {
    if (!ex.entries.length) return null;
    let best = null, prevBest = null;
    ex.entries.forEach(e => {
      if (!best || e.oneRM > best.oneRM + 0.01) { prevBest = best; best = e; }
    });
    return { name: ex.name, current: best, previous: prevBest, wu };
  }).filter(Boolean);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function renderPRBoard() {
  const rows = computePRBoard();
  const board = document.getElementById('prBoard');
  const empty = document.getElementById('prBoardEmpty');
  board.innerHTML = '';
  if (!rows.length) { empty.hidden = false; return; }
  empty.hidden = true;
  const fmtCompact = (weightKg, reps) => `${round2(weightKg)}kg×${reps}`;
  rows.forEach(r => {
    const curText = fmtCompact(r.current.weightKg, r.current.reps);
    const prevText = r.previous ? fmtCompact(r.previous.weightKg, r.previous.reps) : '–';
    const deltaPct = r.previous ? round2(((r.current.oneRM - r.previous.oneRM) / r.previous.oneRM) * 100) : null;
    const row = document.createElement('div');
    row.className = 'pr-board-row';
    row.innerHTML = `
      <div class="pr-board-name">${escapeHtml(r.name)}</div>
      <div class="pr-board-compare">
        <span class="pr-board-value">${prevText}</span>
        <span class="pr-board-arrow">→</span>
        <span class="pr-board-value pr-board-value--current">${curText}</span>
      </div>
      ${deltaPct != null
        ? `<div class="pr-board-delta ${deltaPct >= 0 ? 'is-up' : 'is-down'}">${deltaPct >= 0 ? '+' : ''}${deltaPct}%</div>`
        : `<div class="pr-board-delta is-up">New PR!</div>`}
    `;
    board.appendChild(row);
  });
}

/* ---- Finish workout summary + PR detection ---- */
function computeWorkoutSummary(date) {
  return computeWorkoutSummaryFromExercises(currentExercises, date);
}

function computeWorkoutSummaryFromExercises(exercisesList, date) {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  let totalVolumeKg = 0, totalSets = 0;
  const exercises = (exercisesList || []).map(ex => {
    const completed = ex.sets.filter(s => s.completed && s.weightKg != null && s.reps != null);
    const volumeKg = completed.reduce((sum, s) => sum + s.weightKg * s.reps, 0);
    totalVolumeKg += volumeKg;
    totalSets += completed.length;
    const bestOneRM = completed.reduce((max, s) => Math.max(max, estOneRM(s.weightKg, s.reps)), 0);
    const historicalBest = bestHistoricalOneRM(ex.name, date);
    const isPR = completed.length > 0 && historicalBest > 0 && bestOneRM > historicalBest + 0.01;
    const topSet = completed.reduce((best, s) => (!best || s.weightKg > best.weightKg) ? s : best, null);
    return {
      name: ex.name,
      completedSets: completed.length,
      volumeKg,
      isPR,
      topWeightKg: topSet ? topSet.weightKg : null,
      topReps: topSet ? topSet.reps : null,
    };
  });
  return { exercises, totalVolumeKg, totalSets, wu };
}

function renderWorkoutSummary(summary) {
  const content = document.getElementById('summaryContent');
  const wu = summary.wu;
  const prCount = summary.exercises.filter(e => e.isPR).length;
  let html = `<div class="summary-stats">
    <div class="stat-tile"><div class="stat-tile-value">${summary.exercises.length}</div><div class="stat-tile-label">Exercises</div></div>
    <div class="stat-tile"><div class="stat-tile-value">${summary.totalSets}</div><div class="stat-tile-label">Sets</div></div>
    <div class="stat-tile"><div class="stat-tile-value">${round0(fromKg(summary.totalVolumeKg, wu))}</div><div class="stat-tile-label">Volume (${wu})</div></div>
  </div>`;
  if (prCount > 0) {
    html += `<p style="text-align:center;color:var(--warning);font-family:var(--font-mono);font-size:0.8rem;margin-bottom:10px;">🏆 ${prCount} new personal record${prCount > 1 ? 's' : ''}!</p>`;
  }
  if (!summary.exercises.length) {
    html += `<p class="empty-note">No exercises logged for this date.</p>`;
  }
  summary.exercises.forEach(ex => {
    html += `<div class="summary-ex-row">
      <div>
        <div class="summary-ex-name">${escapeHtml(ex.name)}</div>
        <div class="summary-ex-meta">${ex.completedSets} sets · ${round0(fromKg(ex.volumeKg, wu))} ${wu} volume${ex.topWeightKg != null ? ` · Top: ${round0(fromKg(ex.topWeightKg, wu))} ${wu} × ${ex.topReps} reps` : ''}</div>
      </div>
      ${ex.isPR ? '<span class="pr-pill">🏆 PR</span>' : ''}
    </div>`;
  });
  content.innerHTML = html;
}

/* ---- Per-exercise rest timers ---- */
let exTimerTickId = null;
let notifyPermissionAsked = false;

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getExTimers() {
  try { return JSON.parse(localStorage.getItem('wft_ex_timers')) || {}; } catch (e) { return {}; }
}
function saveExTimers(obj) { localStorage.setItem('wft_ex_timers', JSON.stringify(obj)); }

function exTimerDisplayFor(date, exIdx) {
  const day = getExTimers()[date];
  const t = day && day[exIdx];
  if (!t) return { text: '—', state: '' };
  const remaining = Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
  if (remaining <= 0) return { text: 'Done', state: 'is-done' };
  return { text: formatTime(remaining), state: 'is-active' };
}

function startExerciseTimer(exIdx, seconds) {
  const date = document.getElementById('trainDate').value;
  const all = getExTimers();
  if (!all[date]) all[date] = {};
  all[date][exIdx] = { endAt: Date.now() + seconds * 1000, duration: seconds, done: false, exName: (currentExercises[exIdx] || {}).name || '' };
  saveExTimers(all);
  if (window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
    notifyPermissionAsked = true;
    Notification.requestPermission().catch(() => {});
  }
  ensureExTimerTicking();
  renderExerciseTimerDisplays();
}

function ensureExTimerTicking() {
  if (exTimerTickId) return;
  exTimerTickId = setInterval(renderExerciseTimerDisplays, 1000);
}

function showRestToast(message) {
  const toast = document.getElementById('restToast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function showAppReminder(message) {
  const toast = document.getElementById('restToast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.hidden = true; }, 7000);
}

function checkDataReminder() {
  const profile = getProfile();
  if (!profile) return;
  if (sessionStorage.getItem('wft_data_reminder_shown')) return;

  const logs = getLogs();
  const completeDates = Object.keys(logs)
    .filter(d => logs[d].calories != null && logs[d].weightKg != null)
    .sort();
  const lastComplete = completeDates.length ? completeDates[completeDates.length - 1] : null;

  const today = parseISO(todayISO());
  let daysSince;
  if (lastComplete) {
    daysSince = Math.round((today - parseISO(lastComplete)) / 86400000);
  } else if (profile.startDate) {
    daysSince = Math.round((today - parseISO(profile.startDate)) / 86400000);
  } else {
    return;
  }

  if (daysSince > 3) {
    sessionStorage.setItem('wft_data_reminder_shown', '1');
    const message = 'Fill up the fuel datas and weigh ins at least completely to keep the app working, thank you.';
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    playBeep();
    showAppReminder(message);
    if (window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
      notifyPermissionAsked = true;
      Notification.requestPermission().then(() => fireSystemNotification('Winfinity Tracker', message)).catch(() => {});
    } else {
      fireSystemNotification('Winfinity Tracker', message);
    }
  }
}

/* Best-effort only: a PWA can't wake up in the background at an exact time,
   so this fires the first time the app happens to be opened on/after Sunday
   8am, once per week (not a guaranteed exact-8am alarm). */
function checkMeasurementReminder() {
  const profile = getProfile();
  if (!profile) return;
  const now = new Date();
  if (now.getDay() !== 0 || now.getHours() < 8) return;
  const weekKey = todayISO();
  if (localStorage.getItem('wft_measure_reminder_shown') === weekKey) return;
  localStorage.setItem('wft_measure_reminder_shown', weekKey);

  const message = 'Sunday check-in: update your body measurements today.';
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  playBeep();
  showAppReminder(message);
  if (window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
    notifyPermissionAsked = true;
    Notification.requestPermission().then(() => fireSystemNotification('Winfinity Tracker', message)).catch(() => {});
  } else {
    fireSystemNotification('Winfinity Tracker', message);
  }
}

/* Best-effort only, same caveat as the other periodic reminders — fires the
   first time the app is opened on a Saturday night (6pm-midnight local time),
   once per Saturday, showing a donation prompt after the splash screen. */
function isSaturdayNightNow() {
  const now = new Date();
  return now.getDay() === 6 && now.getHours() >= 18;
}

function checkDonationPrompt() {
  if (!isSaturdayNightNow()) return;
  const todayKey = todayISO();
  if (localStorage.getItem('wft_donation_shown') === todayKey) return;
  localStorage.setItem('wft_donation_shown', todayKey);
  document.getElementById('donationPromptView').hidden = false;
  document.getElementById('donationQrView').hidden = true;
  document.getElementById('donationOverlay').hidden = false;
}

function openDonationQr() {
  document.getElementById('donationPromptView').hidden = true;
  document.getElementById('donationQrView').hidden = false;
  document.getElementById('donationOverlay').hidden = false;
}

function initDonationPrompt() {
  const overlay = document.getElementById('donationOverlay');
  document.getElementById('btnDonationIgnore').addEventListener('click', () => { overlay.hidden = true; });
  document.getElementById('btnDonationSure').addEventListener('click', openDonationQr);
  document.getElementById('btnDonationQrClose').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

function fireSystemNotification(title, body) {
  if (!window.Notification || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => { n.close(); window.focus(); };
  } catch (e) { /* ignore */ }
}

/* ---------------------------------------------------------------- */
/* Hydration reminders                                                 */
/* Best-effort only (same caveat as checkMeasurementReminder): a PWA   */
/* can't wake up in the background at an exact time, so a clock-based  */
/* schedule is checked every few minutes while the app is open, plus   */
/* real-time nudges tied to actual cardio start/stop events.           */
/* ---------------------------------------------------------------- */
function isHydrationRemindersEnabled() {
  const profile = getProfile();
  return !!(profile && profile.hydrationReminders && profile.hydrationReminders.enabled);
}

function timeStrToMin(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
}
function minToTimeStr(min) {
  min = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

// Builds today's reminder slots from the hydration-schedule guidance:
// wake-up, 30 min before each meal, hourly through waking hours (skipping
// slots too close to another one), and a wind-down slot 2h before bed.
function getHydrationSchedule(profile) {
  const hr = (profile && profile.hydrationReminders) || {};
  if (!hr.enabled) return [];
  const wakeMin = timeStrToMin(hr.wakeTime || '07:00');
  const bedMin = timeStrToMin(hr.bedTime || '22:00');
  const meals = (hr.mealTimes && hr.mealTimes.length === 3) ? hr.mealTimes : ['07:00', '12:00', '19:00'];
  const mealLabels = ['Breakfast', 'Lunch', 'Dinner'];

  const slots = [{
    id: 'wake', time: minToTimeStr(wakeMin),
    message: 'Morning! Drink 1-2 glasses of water (~250-500 mL) to rehydrate after sleep.',
  }];

  meals.forEach((mt, i) => {
    slots.push({
      id: 'meal' + i, time: minToTimeStr(timeStrToMin(mt) - 30),
      message: `Drink a glass of water (~250 mL) before ${mealLabels[i].toLowerCase()} to prep digestion.`,
    });
  });

  if (hr.hourlyEnabled !== false) {
    const cutoff = bedMin - 120;
    for (let m = wakeMin + 60; m < cutoff; m += 60) {
      const tooClose = slots.some(s => Math.abs(timeStrToMin(s.time) - m) < 20);
      if (!tooClose) slots.push({ id: 'hourly' + m, time: minToTimeStr(m), message: 'Time for a cup of water (~250 mL).' });
    }
  }

  slots.push({
    id: 'bed', time: minToTimeStr(bedMin - 120),
    message: "If you're thirsty, a small glass now — then taper off fluids before bed so you're not up at night.",
  });

  return slots;
}

function fireHydrationReminder(message) {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  playBeep();
  showAppReminder('💧 ' + message);
  if (window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
    notifyPermissionAsked = true;
    Notification.requestPermission().then(() => fireSystemNotification('💧 Hydration reminder', message)).catch(() => {});
  } else {
    fireSystemNotification('💧 Hydration reminder', message);
  }
}

function checkHydrationReminders() {
  const profile = getProfile();
  if (!profile || !isHydrationRemindersEnabled()) return;
  const schedule = getHydrationSchedule(profile);
  if (!schedule.length) return;

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const firedKey = 'wft_hydration_fired_' + todayISO();
  let fired;
  try { fired = JSON.parse(localStorage.getItem(firedKey)) || []; } catch (e) { fired = []; }

  schedule.forEach(slot => {
    const slotMin = timeStrToMin(slot.time);
    if (nowMin >= slotMin && nowMin < slotMin + 10 && !fired.includes(slot.id)) {
      fired.push(slot.id);
      localStorage.setItem(firedKey, JSON.stringify(fired));
      fireHydrationReminder(slot.message);
    }
  });
}

function cleanupOldHydrationFiredKeys() {
  const todayKey = 'wft_hydration_fired_' + todayISO();
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith('wft_hydration_fired_') && k !== todayKey) localStorage.removeItem(k);
  });
}

let cardioHydrationIntervalId = null;

function startCardioHydrationReminders() {
  if (!isHydrationRemindersEnabled()) return;
  fireHydrationReminder('Sip some water before you start (~6-12 oz / 175-350 mL).');
  cardioHydrationIntervalId = setInterval(() => {
    fireHydrationReminder('Sip 6-12 oz (~175-350 mL) of water — stay ahead of sweat loss.');
  }, 12 * 60 * 1000);
}

function stopCardioHydrationReminders() {
  if (cardioHydrationIntervalId) { clearInterval(cardioHydrationIntervalId); cardioHydrationIntervalId = null; }
  if (!isHydrationRemindersEnabled()) return;
  fireHydrationReminder('Rehydrate! Drink 16-24 oz (~500-700 mL) to replenish sweat loss.');
}

function loadHydroReminderSettings() {
  const p = getProfile();
  const hr = (p && p.hydrationReminders) || {};
  document.getElementById('hydroRemindersEnabled').checked = !!hr.enabled;
  document.getElementById('hydroWakeTime').value = hr.wakeTime || '07:00';
  document.getElementById('hydroBedTime').value = hr.bedTime || '22:00';
  const meals = (hr.mealTimes && hr.mealTimes.length === 3) ? hr.mealTimes : ['07:00', '12:00', '19:00'];
  document.getElementById('hydroMeal0').value = meals[0];
  document.getElementById('hydroMeal1').value = meals[1];
  document.getElementById('hydroMeal2').value = meals[2];
  document.getElementById('hydroHourlyEnabled').checked = hr.hourlyEnabled !== false;
  document.getElementById('hydroReminderFields').style.display = hr.enabled ? '' : 'none';
}

function initHydrationReminderSettings() {
  loadHydroReminderSettings();
  const enabledToggle = document.getElementById('hydroRemindersEnabled');
  enabledToggle.addEventListener('change', () => {
    document.getElementById('hydroReminderFields').style.display = enabledToggle.checked ? '' : 'none';
  });
  document.getElementById('btnSaveHydroReminders').addEventListener('click', () => {
    const profile = getProfile();
    if (!profile) { document.getElementById('hydroSaveNote').textContent = 'Finish your Bio profile setup first.'; return; }
    profile.hydrationReminders = {
      enabled: document.getElementById('hydroRemindersEnabled').checked,
      wakeTime: document.getElementById('hydroWakeTime').value || '07:00',
      bedTime: document.getElementById('hydroBedTime').value || '22:00',
      mealTimes: [
        document.getElementById('hydroMeal0').value || '07:00',
        document.getElementById('hydroMeal1').value || '12:00',
        document.getElementById('hydroMeal2').value || '19:00',
      ],
      hourlyEnabled: document.getElementById('hydroHourlyEnabled').checked,
    };
    saveProfile(profile);
    document.getElementById('hydroSaveNote').textContent = 'Reminder schedule saved.';
    setTimeout(() => { document.getElementById('hydroSaveNote').textContent = ''; }, 2500);
    if (profile.hydrationReminders.enabled && window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
      notifyPermissionAsked = true;
      Notification.requestPermission().catch(() => {});
    }
    checkHydrationReminders();
  });
}

function fireRestComplete(exName) {
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  playBeep();
  showRestToast(`⏱ Rest complete — ${exName || 'back to it'}!`);
  fireSystemNotification('Rest complete', `${exName || 'Exercise'} — time to lift!`);
}

function renderExerciseTimerDisplays() {
  const date = document.getElementById('trainDate').value;
  const all = getExTimers();
  const day = all[date] || {};
  let anyActive = false;
  let changed = false;
  Object.keys(day).forEach(exIdx => {
    const t = day[exIdx];
    const remaining = Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
    const el = document.querySelector(`.ex-rest-timer[data-ex="${exIdx}"]`);
    if (remaining > 0) {
      anyActive = true;
      if (el) { el.textContent = formatTime(remaining); el.classList.add('is-active'); el.classList.remove('is-done'); }
    } else {
      if (el) { el.textContent = 'Done'; el.classList.remove('is-active'); el.classList.add('is-done'); }
      if (!t.done) {
        t.done = true;
        changed = true;
        fireRestComplete(t.exName);
      }
    }
  });
  if (changed) saveExTimers(all);
}

const ALARM_TONE_PRESETS = {
  chime: [{ freq: 880, t: 0 }, { freq: 880, t: 0.3 }, { freq: 880, t: 0.6 }],
  beep: [{ freq: 1000, t: 0 }],
  digital: [{ freq: 660, t: 0 }, { freq: 660, t: 0.12 }, { freq: 660, t: 0.24 }],
  bell: [{ freq: 1200, t: 0 }, { freq: 900, t: 0.35 }],
};

function getAlarmTone() {
  return localStorage.getItem('wft_alarm_tone') || 'chime';
}

function playAlarmTone(toneId) {
  const notes = ALARM_TONE_PRESETS[toneId] || ALARM_TONE_PRESETS.chime;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    notes.forEach(({ freq, t }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.32);
    });
  } catch (e) { /* Web Audio unavailable; vibration still fires */ }
}

function playBeep() { playAlarmTone(getAlarmTone()); }

/* ---------------------------------------------------------------- */
/* Nutrition                                                            */
/* ---------------------------------------------------------------- */
/* ---------------------------------------------------------------- */
/* Food Diary (meal-categorized food logging)                          */
/* ---------------------------------------------------------------- */
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snacks'];
const MEAL_LABELS = { breakfast: '🌅 Breakfast', lunch: '☀️ Lunch', dinner: '🌙 Dinner', snacks: '🍎 Snacks' };

function getMealsForDate(date) {
  const logs = getLogs();
  const stored = logs[date] && logs[date].meals;
  return {
    breakfast: (stored && stored.breakfast) || [],
    lunch: (stored && stored.lunch) || [],
    dinner: (stored && stored.dinner) || [],
    snacks: (stored && stored.snacks) || [],
  };
}

function computeMealsNutritionTotals(meals) {
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };
  MEAL_TYPES.forEach(mt => {
    (meals[mt] || []).forEach(item => {
      totals.calories += item.calories || 0;
      totals.protein += item.protein || 0;
      totals.carbs += item.carbs || 0;
      totals.fat += item.fat || 0;
      totals.fiber += item.fiber || 0;
      totals.sodium += item.sodium || 0;
    });
  });
  return totals;
}

// Once the Food Diary is used for a date, it owns that date's flat nutrition
// totals going forward (they're recomputed here) — the manual Today Intake
// Log Entry fields still work standalone for dates that never touch this.
function saveMealsForDate(date, meals) {
  const totals = computeMealsNutritionTotals(meals);
  updateLogFields(date, {
    meals,
    calories: round0(totals.calories),
    protein: round0(totals.protein),
    carbs: round0(totals.carbs),
    fat: round0(totals.fat),
    fiber: round0(totals.fiber),
    sodium: round0(totals.sodium),
  });
}

function refreshFuelViewsForDate(date) {
  loadNutritionForDate(date);
  renderNutritionTargets();
  renderNutritionAverages();
  updateTabDots();
}

let editingMealItem = null; // { meal, idx } while a meal-item row is in edit mode

function renderFoodDiary(date) {
  const meals = getMealsForDate(date);
  MEAL_TYPES.forEach(mt => {
    const container = document.getElementById(`mealItems_${mt}`);
    const totalEl = document.getElementById(`mealTotal_${mt}`);
    const items = meals[mt];
    container.innerHTML = items.length ? items.map((item, idx) => {
      if (editingMealItem && editingMealItem.meal === mt && editingMealItem.idx === idx) {
        return `
      <div class="meal-item-row meal-item-row--edit">
        <div class="meal-item-edit-form">
          <div>
            <span class="field-label">Food name</span>
            <input type="text" class="meal-edit-name" value="${escapeHtml(item.name)}">
          </div>
          <div class="field-row">
            <div><span class="field-label">Grams</span><input type="number" class="meal-edit-grams" value="${item.grams != null ? item.grams : ''}"></div>
            <div><span class="field-label">Calories</span><input type="number" class="meal-edit-calories" value="${round0(item.calories)}"></div>
          </div>
          <div class="field-row">
            <div><span class="field-label">Protein g</span><input type="number" class="meal-edit-protein" value="${round0(item.protein)}"></div>
            <div><span class="field-label">Carbs g</span><input type="number" class="meal-edit-carbs" value="${round0(item.carbs)}"></div>
            <div><span class="field-label">Fat g</span><input type="number" class="meal-edit-fat" value="${round0(item.fat)}"></div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn--primary btn--sm meal-item-save" data-meal="${mt}" data-idx="${idx}">Save</button>
            <button type="button" class="btn btn--sm meal-item-cancel-edit">Cancel</button>
          </div>
        </div>
      </div>
        `;
      }
      return `
      <div class="meal-item-row">
        <div class="meal-item-info">
          <div class="meal-item-name">${escapeHtml(item.name)}</div>
          <div class="meal-item-meta">${item.qty != null ? formatServingQty(item.qty, item.unit) + ' · ' : (item.grams ? round0(item.grams) + 'g · ' : '')}${round0(item.calories)} kcal</div>
        </div>
        <select class="meal-item-move" data-meal="${mt}" data-idx="${idx}">
          ${MEAL_TYPES.map(m2 => `<option value="${m2}" ${m2 === mt ? 'selected' : ''}>${m2.charAt(0).toUpperCase() + m2.slice(1)}</option>`).join('')}
        </select>
        <button type="button" class="meal-item-edit-btn" data-meal="${mt}" data-idx="${idx}" aria-label="Edit">✎</button>
        <button type="button" class="meal-item-remove" data-meal="${mt}" data-idx="${idx}" aria-label="Remove">✕</button>
      </div>
    `;
    }).join('') : '<p class="empty-note">No items yet.</p>';
    const mealTotalKcal = items.reduce((s, i) => s + (i.calories || 0), 0);
    totalEl.textContent = round0(mealTotalKcal) + ' kcal';
  });
}

function shiftFoodDiaryDate(deltaDays) {
  const dateInput = document.getElementById('foodDiaryDateInput');
  const current = dateInput.value || document.getElementById('nutDate').value || todayISO();
  const d = parseISO(current);
  d.setDate(d.getDate() + deltaDays);
  dateInput.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  dateInput.dispatchEvent(new Event('change'));
}

let currentAddFoodMeal = 'breakfast';
let selectedFoodData = null;
let foodSearchDebounceId = null;
// Per-100g baseline from the last AI estimate in the "Not finding it?"
// custom food form — lets serving size/unit changes auto-rescale the
// calorie/macro inputs instead of leaving them stuck at the 100g figures.
// Only set by the AI estimate; a from-scratch manual entry (no AI click)
// leaves this null, so grams/unit changes don't touch hand-typed values.
let customFoodAiPer100g = null;

// Directly overrides the day's flat nutrition totals (the same fields
// Daily Fuel Status reads), bypassing the Dietary Algorithm/meals entirely —
// for users transferring totals already computed by another app (e.g.
// MyFitnessPal) rather than logging individual food items here. Note the
// same caveat as any direct total-override: if the Dietary Algorithm is
// used for this date afterward, saving a meal there recomputes and
// overwrites these totals from the (possibly empty) meals list.
function loadManualIntakeFields(date) {
  const e = getLogs()[date] || {};
  document.getElementById('manualIntakeCalories').value = e.calories ?? '';
  document.getElementById('manualIntakeProtein').value = e.protein ?? '';
  document.getElementById('manualIntakeCarbs').value = e.carbs ?? '';
  document.getElementById('manualIntakeFat').value = e.fat ?? '';
  document.getElementById('manualIntakeFiber').value = e.fiber ?? '';
  document.getElementById('manualIntakeSodium').value = e.sodium ?? '';
  document.getElementById('manualIntakeNote').textContent = '';
}

function initManualIntake() {
  const overlay = document.getElementById('manualIntakeOverlay');

  document.getElementById('btnOpenManualIntake').addEventListener('click', () => {
    const date = document.getElementById('nutDate').value;
    document.getElementById('manualIntakeDate').value = date;
    loadManualIntakeFields(date);
    overlay.hidden = false;
  });
  document.getElementById('btnCloseManualIntake').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
  document.getElementById('manualIntakeDate').addEventListener('change', e => loadManualIntakeFields(e.target.value || todayISO()));

  document.getElementById('btnManualOverrideSubmit').addEventListener('click', () => {
    const date = document.getElementById('manualIntakeDate').value || todayISO();
    updateLogFields(date, {
      calories: parseFloat(document.getElementById('manualIntakeCalories').value) || 0,
      protein: parseFloat(document.getElementById('manualIntakeProtein').value) || 0,
      carbs: parseFloat(document.getElementById('manualIntakeCarbs').value) || 0,
      fat: parseFloat(document.getElementById('manualIntakeFat').value) || 0,
      fiber: parseFloat(document.getElementById('manualIntakeFiber').value) || 0,
      sodium: parseFloat(document.getElementById('manualIntakeSodium').value) || 0,
    });
    overlay.hidden = true;
    // Only re-point the Fuel tab's own date label if the override was for
    // the date it's already showing — otherwise just refresh the
    // date-agnostic parts (they read nutDate internally) so an edit to a
    // past day doesn't silently relabel the currently-viewed date.
    if (date === document.getElementById('nutDate').value) {
      refreshFuelViewsForDate(date);
    } else {
      renderNutritionTargets();
      renderNutritionAverages();
      updateTabDots();
    }
    showRestToast(`Manual override applied for ${fmtDate(parseISO(date))}.`);
  });
}

function initFoodDiary() {
  const overlay = document.getElementById('foodDiaryOverlay');
  const dateInput = document.getElementById('foodDiaryDateInput');

  document.getElementById('btnOpenFoodDiary').addEventListener('click', () => {
    const date = document.getElementById('nutDate').value;
    dateInput.value = date;
    editingMealItem = null;
    renderFoodDiary(date);
    overlay.hidden = false;
  });
  document.getElementById('btnCloseFoodDiary').addEventListener('click', () => { overlay.hidden = true; editingMealItem = null; });
  overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.hidden = true; editingMealItem = null; } });

  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    const nutDateEl = document.getElementById('nutDate');
    nutDateEl.value = dateInput.value;
    nutDateEl.dispatchEvent(new Event('change'));
    editingMealItem = null;
    renderFoodDiary(dateInput.value);
  });
  document.getElementById('btnFoodDiaryPrevDay').addEventListener('click', () => shiftFoodDiaryDate(-1));
  document.getElementById('btnFoodDiaryNextDay').addEventListener('click', () => shiftFoodDiaryDate(1));
  document.getElementById('btnShareFoodDiary').addEventListener('click', shareFoodDiary);

  overlay.addEventListener('click', e => {
    const removeBtn = e.target.closest('.meal-item-remove');
    if (removeBtn) {
      if (!confirm('Delete this logged food item? This cannot be undone.')) return;
      const date = document.getElementById('nutDate').value;
      const meals = getMealsForDate(date);
      meals[removeBtn.dataset.meal].splice(parseInt(removeBtn.dataset.idx, 10), 1);
      saveMealsForDate(date, meals);
      renderFoodDiary(date);
      refreshFuelViewsForDate(date);
      return;
    }
    const editBtn = e.target.closest('.meal-item-edit-btn');
    if (editBtn) {
      editingMealItem = { meal: editBtn.dataset.meal, idx: parseInt(editBtn.dataset.idx, 10) };
      renderFoodDiary(document.getElementById('nutDate').value);
      return;
    }
    const cancelEditBtn = e.target.closest('.meal-item-cancel-edit');
    if (cancelEditBtn) {
      editingMealItem = null;
      renderFoodDiary(document.getElementById('nutDate').value);
      return;
    }
    const saveBtn = e.target.closest('.meal-item-save');
    if (saveBtn) {
      const date = document.getElementById('nutDate').value;
      const meals = getMealsForDate(date);
      const mt = saveBtn.dataset.meal;
      const idx = parseInt(saveBtn.dataset.idx, 10);
      const form = saveBtn.closest('.meal-item-edit-form');
      const item = meals[mt][idx];
      const newName = form.querySelector('.meal-edit-name').value.trim();
      item.name = newName || item.name;
      const gramsVal = form.querySelector('.meal-edit-grams').value;
      item.grams = gramsVal === '' ? null : (parseFloat(gramsVal) || 0);
      item.calories = parseFloat(form.querySelector('.meal-edit-calories').value) || 0;
      item.protein = parseFloat(form.querySelector('.meal-edit-protein').value) || 0;
      item.carbs = parseFloat(form.querySelector('.meal-edit-carbs').value) || 0;
      item.fat = parseFloat(form.querySelector('.meal-edit-fat').value) || 0;
      editingMealItem = null;
      saveMealsForDate(date, meals);
      renderFoodDiary(date);
      refreshFuelViewsForDate(date);
      showRestToast('Saved changes.');
      return;
    }
    const addBtn = e.target.closest('.add-food-btn');
    if (addBtn) {
      currentAddFoodMeal = addBtn.dataset.meal;
      openAddFoodPanel();
      return;
    }

    const menuBtn = e.target.closest('.meal-menu-btn');
    if (menuBtn) {
      const mt = menuBtn.dataset.meal;
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = m.dataset.meal !== mt || !m.hidden; });
      return;
    }
    const shareMealBtn = e.target.closest('.meal-menu-share');
    if (shareMealBtn) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
      shareSingleMeal(shareMealBtn.dataset.meal);
      return;
    }
    const copyMealBtn = e.target.closest('.meal-menu-copy');
    if (copyMealBtn) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
      copyMealToClipboard(copyMealBtn.dataset.meal);
      return;
    }
    const pasteMealBtn = e.target.closest('.meal-menu-paste');
    if (pasteMealBtn) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
      pasteMealFromClipboard(pasteMealBtn.dataset.meal);
      return;
    }
    const clearMealBtn = e.target.closest('.meal-menu-clear');
    if (clearMealBtn) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
      clearMealData(clearMealBtn.dataset.meal);
      return;
    }
    if (!e.target.closest('.meal-menu-wrap')) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
    }
  });

  overlay.addEventListener('change', e => {
    const moveSel = e.target.closest('.meal-item-move');
    if (!moveSel || moveSel.value === moveSel.dataset.meal) return;
    const date = document.getElementById('nutDate').value;
    const meals = getMealsForDate(date);
    const fromMeal = moveSel.dataset.meal;
    const idx = parseInt(moveSel.dataset.idx, 10);
    const item = meals[fromMeal][idx];
    meals[fromMeal].splice(idx, 1);
    meals[moveSel.value].push(item);
    saveMealsForDate(date, meals);
    renderFoodDiary(date);
    refreshFuelViewsForDate(date);
  });
}

let pendingBarcodeCode = null;

// g/oz/ml convert exactly for any food. cup/bowl/piece/stick/pack are rough,
// general-purpose estimates (a "piece" of chicken vs. a "piece" of candy weigh
// nothing alike) — flagged with a visible warning wherever they're picked.
const SERVING_UNITS = {
  g: { label: 'g', gramsPerUnit: 1, precise: true },
  oz: { label: 'oz', gramsPerUnit: 28.3495, precise: true },
  ml: { label: 'ml', gramsPerUnit: 1, precise: true },
  cup: { label: 'cup', gramsPerUnit: 240, precise: false },
  bowl: { label: 'bowl', gramsPerUnit: 350, precise: false },
  piece: { label: 'piece', gramsPerUnit: 50, precise: false },
  stick: { label: 'stick', gramsPerUnit: 20, precise: false },
  pack: { label: 'pack', gramsPerUnit: 30, precise: false },
};

function servingUnitToGrams(qty, unit) {
  const u = SERVING_UNITS[unit] || SERVING_UNITS.g;
  return (qty || 0) * u.gramsPerUnit;
}

function isServingUnitPrecise(unit) {
  return (SERVING_UNITS[unit] || SERVING_UNITS.g).precise;
}

function formatServingQty(qty, unit) {
  if (qty == null) return '';
  const u = unit || 'g';
  const wordUnit = !['g', 'oz', 'ml'].includes(u);
  return round0(qty) + (wordUnit ? ' ' + u : u);
}

function openAddFoodPanel() {
  document.getElementById('foodSearchInput').value = '';
  document.getElementById('foodSearchResults').innerHTML = '';
  document.getElementById('foodSearchStatus').textContent = '';
  document.getElementById('selectedFoodCard').hidden = true;
  selectedFoodData = null;
  document.getElementById('customFoodName').value = '';
  document.getElementById('customFoodGrams').value = '100';
  document.getElementById('customFoodUnit').value = 'g';
  document.getElementById('customFoodUnitWarning').hidden = true;
  document.getElementById('customFoodCalories').value = '';
  document.getElementById('customFoodProtein').value = '';
  document.getElementById('customFoodCarbs').value = '';
  document.getElementById('customFoodFat').value = '';
  document.getElementById('customFoodTeachNote').hidden = true;
  document.getElementById('aiEstimateStatus').textContent = '';
  customFoodAiPer100g = null;
  pendingBarcodeCode = null;
  document.getElementById('addFoodOverlay').hidden = false;
}

// Deployed under the name "smooth-service" (Supabase's dashboard "Via
// Editor" quick-create flow auto-assigns a random slug and it's easy to
// miss renaming it before deploying — happened twice). The function's
// actual code/behavior is the food-nutrition estimator described in
// supabase/functions/estimate-food-nutrition/index.js; only the deployed
// name diverges from the source folder name.
async function estimateFoodNutritionWithAI(foodName) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/smooth-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ foodName }),
    });
  } catch (e) {
    throw new Error('AI estimate unavailable — check your connection.');
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('AI estimate unavailable — try again later.'); }
  if (!res.ok) throw new Error(data.error || 'AI estimate failed');
  return data;
}

// Shown when a scanned barcode isn't in our Supabase cache or on Open Food
// Facts — lets the user fill it in once via the existing custom-food form,
// then contributes it to barcode_products so future scans (by anyone) hit
// the cache first. Mainly closes the PH-local/imported product gap in OFF.
function offerBarcodeTeach(code) {
  openAddFoodPanel();
  pendingBarcodeCode = code;
  document.getElementById('customFoodTeachNote').hidden = false;
  document.getElementById('foodSearchStatus').textContent = '';
  document.getElementById('customFoodName').focus();
}

async function contributeBarcodeProduct(code, name, per100g) {
  if (!sbConfigured() || !code) return;
  try {
    await sb.rpc('contribute_barcode_product', {
      p_code: code,
      p_name: name,
      p_brands: null,
      p_calories: round0(per100g.calories),
      p_protein: round0(per100g.protein),
      p_carbs: round0(per100g.carbs),
      p_fat: round0(per100g.fat),
      p_fiber: 0,
      p_sodium: 0,
      p_contributed_by_name: (getProfile().name || 'Anonymous'),
    });
  } catch (e) { /* best-effort — app still works fully offline without this */ }
}

// Open Food Facts' search endpoints block cross-origin browser fetch (no
// CORS) — confirmed by direct testing, not just docs. Its single-product
// barcode lookup DOES allow it, so that's used for the barcode scanner only.
// Search-as-you-type instead uses USDA FoodData Central, which supports CORS
// and returns full nutrition inline with search results (no second fetch).
const USDA_NUTRIENT_IDS = { calories: 1008, protein: 1003, fat: 1004, carbs: 1005, fiber: 1079, sodium: 1093 };

function usdaNutrientValue(food, nutrientId) {
  const n = (food.foodNutrients || []).find(fn => fn.nutrientId === nutrientId);
  return n ? (n.value || 0) : 0;
}

async function searchUsdaFoods(query) {
  const key = (typeof USDA_API_KEY === 'string' && USDA_API_KEY) ? USDA_API_KEY : 'DEMO_KEY';
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=15&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (res.status === 429 || res.status === 403) throw new Error('Rate limited — get your own free key at api.data.gov/signup and add it to config.js.');
  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  return data.foods || [];
}

// Nutritionix is optional (blank App ID/Key in config.js = silently skipped)
// and scoped to *branded* results only — restaurant/fast-food items USDA and
// Open Food Facts don't cover, since generic foods already overlap with USDA.
async function searchNutritionixFoods(query) {
  if (!NUTRITIONIX_APP_ID || !NUTRITIONIX_APP_KEY) return [];
  try {
    const res = await fetch(`https://trackapi.nutritionix.com/v2/search/instant?query=${encodeURIComponent(query)}&common=false&branded=true`, {
      headers: { 'x-app-id': NUTRITIONIX_APP_ID, 'x-app-key': NUTRITIONIX_APP_KEY },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.branded || []).slice(0, 8);
  } catch (e) { return []; }
}

async function fetchNutritionixNutrients(foodName) {
  const res = await fetch('https://trackapi.nutritionix.com/v2/natural/nutrients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-id': NUTRITIONIX_APP_ID, 'x-app-key': NUTRITIONIX_APP_KEY },
    body: JSON.stringify({ query: foodName }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Nutritionix key invalid — check config.js.');
  if (!res.ok) throw new Error('Nutritionix lookup failed');
  const data = await res.json();
  const f = (data.foods || [])[0];
  if (!f) throw new Error('No nutrition data found for that item.');
  return f;
}

function renderFoodSearchResults(usdaFoods, nixBranded, query) {
  const container = document.getElementById('foodSearchResults');
  const usdaRows = (usdaFoods || []).map(f => ({
    name: f.description,
    meta: f.brandName || f.brandOwner || (f.dataType === 'Branded' ? 'Branded' : 'Generic'),
    kcalLabel: round0(usdaNutrientValue(f, USDA_NUTRIENT_IDS.calories)) + ' kcal/100g',
    onSelect: () => selectFoodProduct({ source: 'usda', food: f }),
  }));
  const nixRows = (nixBranded || []).map(f => ({
    name: f.food_name,
    meta: f.brand_name || 'Restaurant',
    kcalLabel: round0(f.nf_calories || 0) + ' kcal/serving',
    onSelect: () => selectFoodProduct({ source: 'nutritionix', foodName: f.food_name }),
  }));
  const rows = usdaRows.concat(nixRows);
  // The AI row is always appended (not just when the database search comes up
  // empty) — visually distinct (--ai modifier) so it never reads as a real
  // matched product, but always reachable in one tap instead of requiring a
  // detour through the separate "Add custom food" section below.
  const aiRow = query ? [{
    name: `✨ Estimate "${query}" with AI`,
    meta: 'Not an exact match — AI estimates per-100g nutrition, review before saving',
    kcalLabel: '',
    isAi: true,
    onSelect: () => selectFoodProduct({ source: 'ai', foodName: query }),
  }] : [];
  const allRows = rows.concat(aiRow);
  if (!allRows.length) { container.innerHTML = ''; return; }
  container.innerHTML = allRows.map((r, i) => `
    <button type="button" class="food-search-result-row${r.isAi ? ' food-search-result-row--ai' : ''}" data-idx="${i}">
      <div>
        <div class="food-result-name">${escapeHtml(r.name)}</div>
        <div class="food-result-meta">${escapeHtml(r.meta)}</div>
      </div>
      <span class="food-result-kcal">${r.kcalLabel}</span>
    </button>
  `).join('');
  container.querySelectorAll('.food-search-result-row').forEach((btn, i) => {
    btn.addEventListener('click', allRows[i].onSelect);
  });
}

async function fetchOffProductNutrition(code) {
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_en,brands,nutriments`);
  if (!res.ok) throw new Error('Lookup failed');
  const data = await res.json();
  if (data.status !== 1 || !data.product) throw new Error('Product not found');
  return data.product;
}

function offBrandsText(brands) {
  if (!brands) return 'Generic';
  return Array.isArray(brands) ? brands.join(', ') : brands;
}

// Accepts { source: 'usda', food } from search results, { source: 'local', product }
// from our own Supabase barcode cache, or { source: 'off', product } from the
// barcode scanner (product already has full nutriments attached).
async function selectFoodProduct(selection) {
  const status = document.getElementById('foodSearchStatus');
  let name, per100g, defaultGrams = 100;

  if (selection.source === 'usda') {
    const f = selection.food;
    name = f.description;
    per100g = {
      calories: usdaNutrientValue(f, USDA_NUTRIENT_IDS.calories),
      protein: usdaNutrientValue(f, USDA_NUTRIENT_IDS.protein),
      carbs: usdaNutrientValue(f, USDA_NUTRIENT_IDS.carbs),
      fat: usdaNutrientValue(f, USDA_NUTRIENT_IDS.fat),
      fiber: usdaNutrientValue(f, USDA_NUTRIENT_IDS.fiber),
      sodium: usdaNutrientValue(f, USDA_NUTRIENT_IDS.sodium), // USDA already reports sodium in mg
    };
  } else if (selection.source === 'local') {
    const p = selection.product;
    name = p.name;
    per100g = {
      calories: p.calories || 0,
      protein: p.protein || 0,
      carbs: p.carbs || 0,
      fat: p.fat || 0,
      fiber: p.fiber || 0,
      sodium: p.sodium || 0,
    };
  } else if (selection.source === 'nutritionix') {
    status.textContent = 'Loading nutrition info…';
    let f;
    try {
      f = await fetchNutritionixNutrients(selection.foodName);
    } catch (e) {
      status.textContent = e.message || 'Could not load nutrition info for that item — try another or add custom.';
      return;
    }
    // Branded/restaurant items are reported per labeled serving, not per 100g —
    // rescale to 100g so the existing grams-based scaling UI works unchanged,
    // defaulting the grams input to that item's real serving weight.
    const gramsPerServing = f.serving_weight_grams || 100;
    const scale = 100 / gramsPerServing;
    name = f.food_name;
    per100g = {
      calories: (f.nf_calories || 0) * scale,
      protein: (f.nf_protein || 0) * scale,
      carbs: (f.nf_total_carbohydrate || 0) * scale,
      fat: (f.nf_total_fat || 0) * scale,
      fiber: (f.nf_dietary_fiber || 0) * scale,
      sodium: (f.nf_sodium || 0) * scale,
    };
    defaultGrams = round0(gramsPerServing);
  } else if (selection.source === 'ai') {
    status.textContent = 'Estimating with AI…';
    let est;
    try {
      est = await estimateFoodNutritionWithAI(selection.foodName);
    } catch (e) {
      status.textContent = e.message || 'AI estimate unavailable — try again or add custom.';
      return;
    }
    name = selection.foodName;
    per100g = {
      calories: est.calories || 0,
      protein: est.protein || 0,
      carbs: est.carbs || 0,
      fat: est.fat || 0,
      fiber: est.fiber || 0,
      sodium: est.sodium || 0,
    };
  } else {
    let product = selection.product;
    if (!product.nutriments) {
      status.textContent = 'Loading nutrition info…';
      try {
        product = await fetchOffProductNutrition(product.code);
      } catch (e) {
        status.textContent = 'Could not load nutrition info for that item — try another or add custom.';
        return;
      }
    }
    const n = product.nutriments || {};
    name = product.product_name || product.product_name_en || 'Unknown item';
    per100g = {
      calories: n['energy-kcal_100g'] || 0,
      protein: n['proteins_100g'] || 0,
      carbs: n['carbohydrates_100g'] || 0,
      fat: n['fat_100g'] || 0,
      fiber: n['fiber_100g'] || 0,
      sodium: (n['sodium_100g'] || 0) * 1000, // OFF gives grams — this app tracks sodium in mg
    };
  }

  status.textContent = '';
  selectedFoodData = { name, per100g };
  document.getElementById('selectedFoodName').textContent = name;
  document.getElementById('selectedFoodGrams').value = defaultGrams;
  document.getElementById('selectedFoodUnit').value = 'g';
  document.getElementById('selectedFoodUnitWarning').hidden = true;
  document.getElementById('selectedFoodAiWarning').hidden = selection.source !== 'ai';
  updateSelectedFoodPreview();
  document.getElementById('selectedFoodCard').hidden = false;
  document.getElementById('selectedFoodCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateSelectedFoodPreview() {
  if (!selectedFoodData) return;
  const qty = parseFloat(document.getElementById('selectedFoodGrams').value) || 0;
  const unit = document.getElementById('selectedFoodUnit').value;
  document.getElementById('selectedFoodUnitWarning').hidden = isServingUnitPrecise(unit);
  const grams = servingUnitToGrams(qty, unit);
  const scale = grams / 100;
  const kcal = round0(selectedFoodData.per100g.calories * scale);
  const protein = round0(selectedFoodData.per100g.protein * scale);
  const carbs = round0(selectedFoodData.per100g.carbs * scale);
  const fat = round0(selectedFoodData.per100g.fat * scale);
  document.getElementById('selectedFoodPreview').textContent = `${kcal} kcal · ${protein}g protein · ${carbs}g carbs · ${fat}g fat`;
}

function addFoodItemToDiary(item) {
  const date = document.getElementById('nutDate').value;
  const meals = getMealsForDate(date);
  meals[currentAddFoodMeal].push(item);
  saveMealsForDate(date, meals);
  document.getElementById('addFoodOverlay').hidden = true;
  renderFoodDiary(date);
  refreshFuelViewsForDate(date);
  showRestToast(`Added "${item.name}" to ${currentAddFoodMeal}.`);
}

// Rescales the custom-food calorie/macro inputs from the last AI estimate's
// per-100g baseline whenever serving size or unit changes — only active
// after an AI estimate has actually been fetched (customFoodAiPer100g set);
// a fully manual entry (no AI click) is left alone. Only applies here, in
// the pre-add form — editing an already-logged diary entry is unaffected.
function recomputeCustomFoodFromAi() {
  if (!customFoodAiPer100g) return;
  const qty = parseFloat(document.getElementById('customFoodGrams').value) || 0;
  const unit = document.getElementById('customFoodUnit').value;
  const grams = servingUnitToGrams(qty, unit);
  const scale = grams / 100;
  document.getElementById('customFoodCalories').value = round0(customFoodAiPer100g.calories * scale);
  document.getElementById('customFoodProtein').value = round0(customFoodAiPer100g.protein * scale);
  document.getElementById('customFoodCarbs').value = round0(customFoodAiPer100g.carbs * scale);
  document.getElementById('customFoodFat').value = round0(customFoodAiPer100g.fat * scale);
}

function initAddFoodPanel() {
  const overlay = document.getElementById('addFoodOverlay');
  document.getElementById('btnCloseAddFood').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });

  const searchInput = document.getElementById('foodSearchInput');
  searchInput.addEventListener('input', () => {
    clearTimeout(foodSearchDebounceId);
    const q = searchInput.value.trim();
    document.getElementById('selectedFoodCard').hidden = true;
    if (q.length < 2) {
      document.getElementById('foodSearchResults').innerHTML = '';
      document.getElementById('foodSearchStatus').textContent = '';
      return;
    }
    document.getElementById('foodSearchStatus').textContent = 'Searching…';
    foodSearchDebounceId = setTimeout(async () => {
      const nixPromise = searchNutritionixFoods(q);
      try {
        const results = await searchUsdaFoods(q);
        const nixResults = await nixPromise;
        renderFoodSearchResults(results, nixResults, q);
        document.getElementById('foodSearchStatus').textContent = '';
      } catch (e) {
        // Even if USDA/Nutritionix search itself fails (rate limit, offline),
        // the AI fallback row still works — it's a separate request.
        renderFoodSearchResults([], [], q);
        document.getElementById('foodSearchStatus').textContent = e.message || 'Search unavailable — check your connection.';
      }
    }, 450);
  });

  document.getElementById('selectedFoodGrams').addEventListener('input', updateSelectedFoodPreview);
  document.getElementById('selectedFoodUnit').addEventListener('change', updateSelectedFoodPreview);

  const aiBtn = document.getElementById('btnEstimateAiNutrition');
  aiBtn.addEventListener('click', async () => {
    const name = document.getElementById('customFoodName').value.trim();
    const statusEl = document.getElementById('aiEstimateStatus');
    if (!name) { statusEl.textContent = 'Enter a food name first.'; return; }
    statusEl.textContent = 'Estimating with AI…';
    aiBtn.disabled = true;
    try {
      const est = await estimateFoodNutritionWithAI(name);
      customFoodAiPer100g = { calories: est.calories || 0, protein: est.protein || 0, carbs: est.carbs || 0, fat: est.fat || 0 };
      document.getElementById('customFoodGrams').value = 100;
      document.getElementById('customFoodUnit').value = 'g';
      document.getElementById('customFoodUnitWarning').hidden = true;
      recomputeCustomFoodFromAi();
      statusEl.textContent = '⚠️ AI estimate for 100g — low accuracy, review before saving. Change serving size/unit below and the values will rescale automatically.';
    } catch (e) {
      statusEl.textContent = e.message || 'AI estimate unavailable — check your connection or add manually.';
    } finally {
      aiBtn.disabled = false;
    }
  });

  document.getElementById('btnAddSelectedFood').addEventListener('click', () => {
    if (!selectedFoodData) return;
    const qty = parseFloat(document.getElementById('selectedFoodGrams').value) || 0;
    const unit = document.getElementById('selectedFoodUnit').value;
    const grams = servingUnitToGrams(qty, unit);
    const scale = grams / 100;
    addFoodItemToDiary({
      name: selectedFoodData.name,
      grams,
      qty,
      unit,
      calories: round0(selectedFoodData.per100g.calories * scale),
      protein: round0(selectedFoodData.per100g.protein * scale),
      carbs: round0(selectedFoodData.per100g.carbs * scale),
      fat: round0(selectedFoodData.per100g.fat * scale),
      fiber: round0(selectedFoodData.per100g.fiber * scale),
      sodium: round0(selectedFoodData.per100g.sodium * scale),
      source: 'off',
    });
  });

  document.getElementById('customFoodUnit').addEventListener('change', e => {
    document.getElementById('customFoodUnitWarning').hidden = isServingUnitPrecise(e.target.value);
    recomputeCustomFoodFromAi();
  });
  document.getElementById('customFoodGrams').addEventListener('input', recomputeCustomFoodFromAi);

  document.getElementById('btnAddCustomFood').addEventListener('click', () => {
    const name = document.getElementById('customFoodName').value.trim();
    if (!name) { alert('Enter a food name.'); return; }
    const qty = parseFloat(document.getElementById('customFoodGrams').value) || null;
    const unit = document.getElementById('customFoodUnit').value;
    const grams = qty != null ? servingUnitToGrams(qty, unit) : null;
    const calories = parseFloat(document.getElementById('customFoodCalories').value) || 0;
    const protein = parseFloat(document.getElementById('customFoodProtein').value) || 0;
    const carbs = parseFloat(document.getElementById('customFoodCarbs').value) || 0;
    const fat = parseFloat(document.getElementById('customFoodFat').value) || 0;
    if (pendingBarcodeCode && grams) {
      const scale = 100 / grams;
      contributeBarcodeProduct(pendingBarcodeCode, name, {
        calories: calories * scale, protein: protein * scale, carbs: carbs * scale, fat: fat * scale,
      });
    }
    pendingBarcodeCode = null;
    document.getElementById('customFoodTeachNote').hidden = true;
    addFoodItemToDiary({ name, grams, qty, unit, calories, protein, carbs, fat, fiber: 0, sodium: 0, source: 'custom' });
  });
}

let barcodeStream = null;
let barcodeDetectInterval = null;

function initBarcodeScanner() {
  document.getElementById('btnScanBarcode').addEventListener('click', startBarcodeScan);
  document.getElementById('btnCloseBarcodeScan').addEventListener('click', stopBarcodeScan);
  document.getElementById('barcodeScanOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('barcodeScanOverlay')) stopBarcodeScan();
  });
}

async function startBarcodeScan() {
  if (!('BarcodeDetector' in window)) {
    document.getElementById('foodSearchStatus').textContent = 'Barcode scanning needs Chrome/Edge on Android — not supported in this browser.';
    return;
  }
  const overlay = document.getElementById('barcodeScanOverlay');
  const video = document.getElementById('barcodeVideo');
  const status = document.getElementById('barcodeScanStatus');
  status.textContent = 'Point your camera at a product barcode.';
  overlay.hidden = false;
  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = barcodeStream;
    await video.play();
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    barcodeDetectInterval = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const code = codes[0].rawValue;
          stopBarcodeScan();
          await lookupBarcodeProduct(code);
        }
      } catch (e) { /* detection frame failed — try next tick */ }
    }, 400);
  } catch (e) {
    status.textContent = 'Camera access denied or unavailable.';
  }
}

function stopBarcodeScan() {
  document.getElementById('barcodeScanOverlay').hidden = true;
  if (barcodeDetectInterval) { clearInterval(barcodeDetectInterval); barcodeDetectInterval = null; }
  if (barcodeStream) { barcodeStream.getTracks().forEach(t => t.stop()); barcodeStream = null; }
}

// Checks our own Supabase-backed cache first (fed by contributeBarcodeProduct
// whenever a user teaches a barcode OFF doesn't have — mainly PH-local/imported
// goods), then falls back to Open Food Facts, then offers the teach form.
async function lookupLocalBarcodeProduct(code) {
  if (!sbConfigured()) return null;
  try {
    const { data, error } = await sb.from('barcode_products').select('*').eq('code', code).maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) { return null; }
}

async function lookupBarcodeProduct(code) {
  document.getElementById('foodSearchStatus').textContent = 'Looking up barcode…';
  const local = await lookupLocalBarcodeProduct(code);
  if (local) {
    selectFoodProduct({ source: 'local', product: local });
    document.getElementById('foodSearchStatus').textContent = '';
    return;
  }
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,nutriments,code`);
    const data = await res.json();
    if (data.status !== 1 || !data.product || !data.product.nutriments) {
      offerBarcodeTeach(code);
      return;
    }
    selectFoodProduct({ source: 'off', product: data.product });
    document.getElementById('foodSearchStatus').textContent = '';
  } catch (e) {
    document.getElementById('foodSearchStatus').textContent = 'Barcode lookup failed — check your connection.';
  }
}

function loadNutritionForDate(date) {
  document.getElementById('fuelDateLabel').textContent = fmtDate(parseISO(date));
}

const WATER_GLASS_ML = 250;

function renderFuelWaterOrb(date) {
  const profile = getProfile();
  const target = effectiveWaterTargetML(date);
  const now = (getLogs()[date] || {}).water || 0;
  const pct = Math.max(0, Math.min(100, (now / target) * 100));
  document.getElementById('fuelWaterOrbFill').style.height = pct + '%';
  document.getElementById('fuelWaterOrbAmount').textContent = now;
  document.getElementById('fuelWaterOrbTarget').textContent = target;
  document.getElementById('fuelWaterOrbAutoTag').hidden = !(profile && profile.autoWaterGoal);
  document.getElementById('btnWaterOrbDown').disabled = now <= 0;
}

function adjustFuelWaterOrb(deltaMl) {
  const date = document.getElementById('nutDate').value || todayISO();
  const current = (getLogs()[date] || {}).water || 0;
  const next = Math.max(0, current + deltaMl);
  updateLogFields(date, { water: next });
  renderFuelWaterOrb(date);
  renderNutritionTargets();
  renderNutritionAverages();
  updateTabDots();
}

function refreshFuelWaterViews(date) {
  renderFuelWaterOrb(date);
}

function initFuelWaterOrb() {
  document.getElementById('btnWaterOrbUp').addEventListener('click', () => adjustFuelWaterOrb(WATER_GLASS_ML));
  document.getElementById('btnWaterOrbDown').addEventListener('click', () => adjustFuelWaterOrb(-WATER_GLASS_ML));
  refreshFuelWaterViews(document.getElementById('nutDate').value || todayISO());
}

// Draws a ring/arc identical in spirit to renderRing() (gradient stroke,
// rounded cap) directly onto a canvas 2D context, for the share-card export.
function drawShareRing(ctx, cx, cy, r, stroke, pct, gradientColors) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = stroke;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  gradientColors.forEach((c, i) => grad.addColorStop(i / (gradientColors.length - 1), c));
  ctx.strokeStyle = grad;
  ctx.shadowColor = gradientColors[gradientColors.length - 1];
  ctx.shadowBlur = 14;
  const clamped = Math.max(0, Math.min(100, pct));
  const start = -Math.PI / 2;
  const end = start + (clamped / 100) * Math.PI * 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.stroke();
  ctx.restore();
}

// Draws the multi-slice macro pie matching the in-app conic-gradient pie.
function drawSharePie(ctx, cx, cy, r, slices) {
  ctx.save();
  const total = slices.reduce((s, m) => s + m.value, 0);
  if (total <= 0) {
    ctx.fillStyle = '#2a3238';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  let angle = -Math.PI / 2;
  slices.forEach(m => {
    const slice = (m.value / total) * Math.PI * 2;
    if (slice <= 0) return;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fill();
    angle += slice;
  });
  ctx.restore();
}

async function generateFuelStatusShareCard({ name, digitalId, date, caloriesNow, calorieTarget, macros }) {
  const canvas = document.createElement('canvas');
  canvas.width = 600; canvas.height = 760;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 600, 760);
  bg.addColorStop(0, '#171f24');
  bg.addColorStop(1, '#0a0e12');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 600, 760);
  ctx.strokeStyle = 'rgba(51,200,204,0.4)';
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, 584, 744);

  // Header: name upper-left, Digital ID upper-right.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#dde3e5';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(name || 'Operator', 40, 58);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#33c8cc';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(digitalId || '', 560, 56);

  // Date, centered.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#7e8e95';
  ctx.font = '15px monospace';
  ctx.fillText(date, 300, 92);

  // Title.
  ctx.fillStyle = '#33c8cc';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText('Daily Fuel Status', 300, 138);

  // Calorie ring.
  const caloriePct = calorieTarget > 0 ? (caloriesNow / calorieTarget) * 100 : 0;
  drawShareRing(ctx, 300, 300, 110, 20, caloriePct, ['#8b6bf2', '#3f8ff0', '#2de2e6']);
  ctx.fillStyle = '#dde3e5';
  ctx.font = 'bold 52px monospace';
  ctx.fillText(Math.round(Math.min(100, caloriePct)) + '%', 300, 318);
  ctx.fillStyle = '#7e8e95';
  ctx.font = '14px monospace';
  ctx.fillText('CALORIES', 300, 448);
  ctx.fillStyle = '#dde3e5';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(`${caloriesNow} / ${calorieTarget} kcal`, 300, 478);

  // Macro pie (left) + legend (right of the pie), matching the in-app row.
  const pieCx = 210, pieCy = 590, pieR = 58;
  drawSharePie(ctx, pieCx, pieCy, pieR, macros.map(m => ({ value: m.kcal, color: m.color })));
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(pieCx, pieCy, pieR, 0, Math.PI * 2);
  ctx.stroke();

  const legendX = 300;
  let legendY = pieCy - 34;
  ctx.textAlign = 'left';
  macros.forEach(m => {
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(legendX, legendY - 6, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#dde3e5';
    ctx.font = '17px sans-serif';
    ctx.fillText(`${m.label}  ${m.pct}% of intake`, legendX + 16, legendY);
    legendY += 34;
  });

  // Footer.
  ctx.textAlign = 'center';
  await drawShareWatermark(ctx, 600, 760);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareDailyFuelStatus() {
  const profile = getProfile();
  const date = document.getElementById('nutDate').value || todayISO();
  const entry = getLogs()[date] || {};
  const calorieTarget = getEffectiveCalorieTarget(profile, date) || 0;
  const caloriesNow = entry.calories ?? 0;
  const proteinNow = entry.protein ?? 0;
  const carbsNow = entry.carbs ?? 0;
  const fatNow = entry.fat ?? 0;

  const proteinKcal = proteinNow * 4;
  const carbKcal = carbsNow * 4;
  const fatKcal = fatNow * 9;
  const macros = [
    { label: 'Protein', kcal: proteinKcal, color: '#33c8cc', pct: caloriesNow > 0 ? Math.round((proteinKcal / caloriesNow) * 100) : 0 },
    { label: 'Carbs', kcal: carbKcal, color: '#8069d6', pct: caloriesNow > 0 ? Math.round((carbKcal / caloriesNow) * 100) : 0 },
    { label: 'Fat', kcal: fatKcal, color: '#dba52c', pct: caloriesNow > 0 ? Math.round((fatKcal / caloriesNow) * 100) : 0 },
  ];

  const text = `🔥 Daily Fuel Status — ${caloriesNow}/${calorieTarget} kcal logged with Winfinity Tracker!`;
  const blob = await generateFuelStatusShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(parseISO(date)),
    caloriesNow,
    calorieTarget,
    macros,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Daily Fuel', text }, blob);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function generateWorkoutSummaryShareCard({ name, digitalId, dateTime, summary }) {
  const wu = summary.wu;
  const prCount = summary.exercises.filter(e => e.isPR).length;
  const width = 600;
  const rowH = 106;
  const headerH = 158;
  const statsH = 92 + 26;
  const prBannerH = prCount > 0 ? 44 : 0;
  const exercisesH = summary.exercises.length
    ? summary.exercises.length * rowH
    : 50;
  const footerH = 46;
  const height = headerH + statsH + prBannerH + exercisesH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#171f24'); bg.addColorStop(1, '#0a0e12');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(51,200,204,0.4)'; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);

  ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px monospace';
  ctx.fillText(dateTime, width / 2, 74);

  ctx.textAlign = 'left'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 26px sans-serif';
  ctx.fillText('WORKOUT SUMMARY', 32, 116);

  let y = headerH;

  const tileGap = 14;
  const tileW = (width - 64 - tileGap * 2) / 3;
  const tiles = [
    { value: String(summary.exercises.length), label: 'EXERCISES' },
    { value: String(summary.totalSets), label: 'SETS' },
    { value: String(round0(fromKg(summary.totalVolumeKg, wu))), label: `VOLUME (${wu.toUpperCase()})` },
  ];
  tiles.forEach((t, i) => {
    const x = 32 + i * (tileW + tileGap);
    ctx.strokeStyle = 'rgba(51,200,204,0.35)'; ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, tileW, 92, 10);
    ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 32px sans-serif';
    ctx.fillText(t.value, x + tileW / 2, y + 48);
    ctx.fillStyle = '#7e8e95'; ctx.font = '11px monospace';
    ctx.fillText(t.label, x + tileW / 2, y + 74);
  });
  y += 92 + 26;

  if (prCount > 0) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#dba52c'; ctx.font = 'bold 18px monospace';
    ctx.fillText(`🏆 ${prCount} new personal record${prCount > 1 ? 's' : ''}!`, width / 2, y + 10);
    y += prBannerH;
  }

  if (!summary.exercises.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '15px sans-serif';
    ctx.fillText('No exercises logged for this date.', width / 2, y + 28);
    y += exercisesH;
  }
  summary.exercises.forEach(ex => {
    const rh = rowH - 14;
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
    roundRectPath(ctx, 32, y, width - 64, rh, 10);
    ctx.fill(); ctx.stroke();

    ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 20px sans-serif';
    ctx.fillText(ex.name, 52, y + 28);
    ctx.fillStyle = '#8a9aa0'; ctx.font = '15px monospace';
    ctx.fillText(`${ex.completedSets} sets · ${round0(fromKg(ex.volumeKg, wu))} ${wu} volume`, 52, y + 50);
    if (ex.topWeightKg != null) {
      ctx.fillStyle = '#7e8e95'; ctx.font = '14px monospace';
      ctx.fillText(`Top set: ${round0(fromKg(ex.topWeightKg, wu))} ${wu} × ${ex.topReps} reps`, 52, y + 72);
    }

    if (ex.isPR) {
      const badgeText = '🏆 PR';
      ctx.font = 'bold 15px sans-serif';
      const textW = ctx.measureText(badgeText).width;
      const badgeW = textW + 26;
      const badgeX = width - 52 - badgeW;
      const badgeY = y + rh / 2 - 16;
      ctx.strokeStyle = '#dba52c'; ctx.lineWidth = 1.5;
      roundRectPath(ctx, badgeX, badgeY, badgeW, 32, 8);
      ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = '#dba52c'; ctx.font = 'bold 15px sans-serif';
      ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + 21);
    }
    y += rowH;
  });

  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

const FOOD_DIARY_MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };

// Redraws the same glyphs used by the in-app meal-section headers (see the
// inline SVGs in index.html) so the share card's icons match exactly instead
// of substituting emoji.
function drawMealIcon(ctx, mealType, cx, cy, size) {
  const s = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = '#33c8cc';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (mealType === 'breakfast') {
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(12, 15, 6, 0, Math.PI, true);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(2, 15); ctx.lineTo(22, 15);
    ctx.moveTo(12, 4); ctx.lineTo(12, 7);
    ctx.moveTo(5.5, 7.5); ctx.lineTo(7.3, 9);
    ctx.moveTo(18.5, 7.5); ctx.lineTo(16.7, 9);
    ctx.stroke();
  } else if (mealType === 'lunch') {
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(12, 12, 4.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(12, 2); ctx.lineTo(12, 4.3);
    ctx.moveTo(12, 19.7); ctx.lineTo(12, 22);
    ctx.moveTo(2, 12); ctx.lineTo(4.3, 12);
    ctx.moveTo(19.7, 12); ctx.lineTo(22, 12);
    ctx.moveTo(4.9, 4.9); ctx.lineTo(6.4, 6.4);
    ctx.moveTo(17.6, 17.6); ctx.lineTo(19.1, 19.1);
    ctx.moveTo(4.9, 19.1); ctx.lineTo(6.4, 17.6);
    ctx.moveTo(17.6, 6.4); ctx.lineTo(19.1, 4.9);
    ctx.stroke();
  } else if (mealType === 'dinner') {
    ctx.lineWidth = 1.6;
    ctx.stroke(new Path2D('M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z'));
  } else if (mealType === 'snacks') {
    ctx.lineWidth = 1.5;
    ctx.stroke(new Path2D('M12 9c-3.5 0-6 2.6-6 6.2C6 19 8.4 21.5 11 21.5c.7 0 1-.3 1.5-.3.5 0 .8.3 1.5.3 2.6 0 5-2.5 5-6.3 0-3.6-2.5-6.2-6-6.2z'));
    ctx.stroke(new Path2D('M12 9c0-1.8.9-3 2.2-3.6'));
  }
  ctx.restore();
}

async function generateFoodDiaryShareCard({ name, digitalId, date, meals }) {
  const activeMeals = MEAL_TYPES.filter(mt => meals[mt] && meals[mt].length);
  const width = 600;
  const headerH = 116;
  const mealHeaderH = 40;
  const itemRowH = 64;
  const mealGap = 18;
  const footerH = 46;

  let contentH = activeMeals.length ? 0 : 60;
  activeMeals.forEach(mt => { contentH += mealHeaderH + meals[mt].length * itemRowH + mealGap; });
  const height = headerH + contentH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#171f24'); bg.addColorStop(1, '#0a0e12');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(51,200,204,0.4)'; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);

  ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px monospace';
  ctx.fillText(date, width / 2, 74);

  ctx.textAlign = 'left'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 24px sans-serif';
  ctx.fillText('DIETARY LOG', 32, 106);

  let y = headerH;

  if (!activeMeals.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '15px sans-serif';
    ctx.fillText('No food logged for this date.', width / 2, y + 30);
    y += contentH;
  }

  activeMeals.forEach(mt => {
    const items = meals[mt];
    const mealKcal = items.reduce((s, i) => s + (i.calories || 0), 0);

    drawMealIcon(ctx, mt, 42, y + 16, 22);
    ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 19px sans-serif';
    ctx.fillText(FOOD_DIARY_MEAL_LABELS[mt], 60, y + 22);
    ctx.textAlign = 'right'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 17px monospace';
    ctx.fillText(`${round0(mealKcal)} kcal`, width - 32, y + 22);
    y += mealHeaderH;

    items.forEach(item => {
      const rh = itemRowH - 12;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
      roundRectPath(ctx, 32, y, width - 64, rh, 8);
      ctx.fill(); ctx.stroke();

      ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 17px sans-serif';
      ctx.fillText(item.name, 48, y + 24);
      const qtyStr = item.qty != null ? formatServingQty(item.qty, item.unit) : (item.grams ? round0(item.grams) + 'g' : '');
      const metaStr = `${qtyStr ? qtyStr + ' · ' : ''}${round0(item.calories)} kcal · P${round0(item.protein)}g C${round0(item.carbs)}g F${round0(item.fat)}g`;
      ctx.fillStyle = '#8a9aa0'; ctx.font = '13px monospace';
      ctx.fillText(metaStr, 48, y + 44);
      y += itemRowH;
    });
    y += mealGap;
  });

  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareFoodDiary() {
  const profile = getProfile();
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  const totals = computeMealsNutritionTotals(meals);
  const text = `🍽️ Dietary log — ${round0(totals.calories)} kcal logged with Winfinity Tracker!`;
  const blob = await generateFoodDiaryShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(parseISO(date)),
    meals,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Dietary Log', text }, blob);
}

async function shareSingleMeal(mealType) {
  const profile = getProfile();
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  const items = meals[mealType] || [];
  if (!items.length) { showRestToast(`No items logged in ${FOOD_DIARY_MEAL_LABELS[mealType]} for this date.`); return; }
  const kcal = items.reduce((s, i) => s + (i.calories || 0), 0);
  const text = `🍽️ ${FOOD_DIARY_MEAL_LABELS[mealType]} — ${round0(kcal)} kcal logged with Winfinity Tracker!`;
  const singleMeal = { breakfast: [], lunch: [], dinner: [], snacks: [] };
  singleMeal[mealType] = items;
  const blob = await generateFoodDiaryShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(parseISO(date)),
    meals: singleMeal,
  });
  shareViaWebShare({ title: `Winfinity Tracker — ${FOOD_DIARY_MEAL_LABELS[mealType]}`, text }, blob);
}

function copyMealToClipboard(mealType) {
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  const items = meals[mealType] || [];
  if (!items.length) { showRestToast(`No items in ${FOOD_DIARY_MEAL_LABELS[mealType]} to copy.`); return; }
  localStorage.setItem('wft_meal_clipboard', JSON.stringify(items));
  localStorage.setItem('wft_meal_clipboard_source', `${FOOD_DIARY_MEAL_LABELS[mealType]} (${fmtDate(parseISO(date))})`);
  showRestToast(`Copied ${items.length} item${items.length > 1 ? 's' : ''} from ${FOOD_DIARY_MEAL_LABELS[mealType]}.`);
}

function pasteMealFromClipboard(mealType) {
  let clipboard = [];
  try { clipboard = JSON.parse(localStorage.getItem('wft_meal_clipboard')) || []; } catch (e) { clipboard = []; }
  if (!clipboard.length) { showRestToast('Nothing copied yet — copy a meal first.'); return; }
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  meals[mealType] = (meals[mealType] || []).concat(JSON.parse(JSON.stringify(clipboard)));
  saveMealsForDate(date, meals);
  renderFoodDiary(date);
  refreshFuelViewsForDate(date);
  const source = localStorage.getItem('wft_meal_clipboard_source');
  showRestToast(`Pasted ${clipboard.length} item${clipboard.length > 1 ? 's' : ''} into ${FOOD_DIARY_MEAL_LABELS[mealType]}${source ? ` from ${source}` : ''}.`);
}

function clearMealData(mealType) {
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  const items = meals[mealType] || [];
  if (!items.length) { showRestToast(`${FOOD_DIARY_MEAL_LABELS[mealType]} is already empty.`); return; }
  if (!confirm(`Clear all ${items.length} item${items.length > 1 ? 's' : ''} logged in ${FOOD_DIARY_MEAL_LABELS[mealType]} for this date? This cannot be undone.`)) return;
  meals[mealType] = [];
  saveMealsForDate(date, meals);
  renderFoodDiary(date);
  refreshFuelViewsForDate(date);
  showRestToast(`Cleared ${FOOD_DIARY_MEAL_LABELS[mealType]}.`);
}

async function generateLeaderboardShareCard({ name, digitalId, dateTime, title, rows, formatValue }) {
  const width = 600;
  const headerH = 158;
  const rowH = 52;
  const footerH = 46;
  const listRows = rows.slice(0, 10);
  const contentH = listRows.length ? listRows.length * rowH : 60;
  const height = headerH + contentH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#171f24'); bg.addColorStop(1, '#0a0e12');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(51,200,204,0.4)'; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);

  ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px monospace';
  ctx.fillText(dateTime, width / 2, 74);

  ctx.textAlign = 'left'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 24px sans-serif';
  ctx.fillText(title.toUpperCase(), 32, 116);

  let y = headerH;

  if (!listRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '15px sans-serif';
    ctx.fillText('No data yet.', width / 2, y + 30);
    y += contentH;
  }

  listRows.forEach((r, i) => {
    const rh = rowH - 10;
    ctx.fillStyle = i === 0 ? 'rgba(219,165,44,0.08)' : 'rgba(255,255,255,0.03)';
    ctx.strokeStyle = i === 0 ? 'rgba(219,165,44,0.4)' : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, 32, y, width - 64, rh, 8);
    ctx.fill(); ctx.stroke();

    const midY = y + rh / 2 + 5;
    ctx.textAlign = 'left'; ctx.fillStyle = i === 0 ? '#dba52c' : '#7e8e95'; ctx.font = 'bold 14px monospace';
    ctx.fillText(String(i + 1).padStart(2, '0'), 48, midY);

    ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 16px sans-serif';
    ctx.fillText(r.code_name, 88, midY);
    if (r.public_id) {
      const nameW = ctx.measureText(r.code_name).width;
      ctx.fillStyle = '#7e8e95'; ctx.font = '11px monospace';
      ctx.fillText(r.public_id, 88 + nameW + 8, midY);
    }

    ctx.textAlign = 'right'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 16px monospace';
    ctx.fillText(formatValue(r), width - 48, midY);
    y += rowH;
  });

  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareLeaderboardCard(containerId, title) {
  const cached = rankListDataCache[containerId];
  if (!cached || !cached.rows.length) { showRestToast('No ranking data to share yet.'); return; }
  const profile = getProfile();
  const now = new Date();
  const dateTime = `${fmtDate(now)} · ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const text = `🏆 ${title} — top ${Math.min(10, cached.rows.length)} on the Winfinity Nexus!`;
  const blob = await generateLeaderboardShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    dateTime,
    title,
    rows: cached.rows,
    formatValue: cached.opts.formatValue,
  });
  shareViaWebShare({ title: `Winfinity Tracker — ${title}`, text }, blob);
}

function drawShareWeightChart(ctx, x, y, w, h, series, wu) {
  const padL = 34, padR = 8, padT = 6, padB = 18;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const displayVals = series.map(p => fromKg(p.actualKg, wu));
  const trendVals = series.map(p => fromKg(p.trendKg, wu));
  const allVals = displayVals.concat(trendVals);
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }
  const rangePad = (max - min) * 0.1;
  min -= rangePad; max += rangePad;

  const xFor = i => x + padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const yFor = v => y + padT + plotH - ((v - min) / (max - min)) * plotH;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const v = min + (g / gridCount) * (max - min);
    const gy = yFor(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + padL, gy); ctx.lineTo(x + w - padR, gy); ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = '#7e8e95'; ctx.font = '9px monospace';
    ctx.fillText(String(round2(v)), x, gy + 3);
  }

  [0, Math.floor((series.length - 1) / 2), series.length - 1].forEach(i => {
    ctx.textAlign = i === 0 ? 'left' : i === series.length - 1 ? 'right' : 'center';
    ctx.fillStyle = '#7e8e95'; ctx.font = '9px monospace';
    ctx.fillText(fmtDate(series[i].dateObj), xFor(i), y + h - 4);
  });

  if (series.length > 1) {
    ctx.beginPath();
    trendVals.forEach((v, i) => { const px = xFor(i), py = yFor(v); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.strokeStyle = '#8069d6'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (series.length > 1) {
    ctx.beginPath();
    displayVals.forEach((v, i) => { const px = xFor(i), py = yFor(v); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.strokeStyle = '#2de2e6'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = '#2de2e6'; ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  const lowestIdx = displayVals.indexOf(Math.min(...displayVals));
  displayVals.forEach((v, i) => {
    const isLowest = i === lowestIdx;
    ctx.beginPath();
    ctx.arc(xFor(i), yFor(v), (isLowest ? 1.4 : 1) * (series.length > 40 ? 2 : 3.5), 0, Math.PI * 2);
    ctx.fillStyle = isLowest ? '#dba52c' : '#2de2e6';
    if (isLowest) { ctx.shadowColor = '#dba52c'; ctx.shadowBlur = 6; }
    ctx.fill();
    ctx.shadowBlur = 0;
  });
  ctx.restore();
}

function drawShareGoalTrack(ctx, x, y, w, profile, kgNow, wu, lowestKg7d) {
  const points = [
    { label: 'Start', kg: profile.startWeightKg },
    { label: 'Min goal', kg: profile.goalMinKg },
    { label: 'Target', kg: profile.goalTargetKg },
    { label: 'Dream', kg: profile.goalDreamKg },
  ].filter(p => p.kg != null);
  const allKg = points.map(p => p.kg).concat([kgNow]);
  if (lowestKg7d != null) allKg.push(lowestKg7d);
  let min = Math.min(...allKg), max = Math.max(...allKg);
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const pctFor = kg => (kg - min) / range;

  const trackY = y + 26;
  const trackH = 6;
  const startPct = points.length ? pctFor(points[0].kg) : 0;
  const nowPct = pctFor(kgNow);

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  points.forEach(p => {
    const px = x + pctFor(p.kg) * w;
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '11px monospace';
    ctx.fillText(`${p.label}: ${round2(fromKg(p.kg, wu))}${wu}`, Math.min(Math.max(px, x + 40), x + w - 40), trackY - 12);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, trackY + trackH + 2); ctx.lineTo(px, trackY + trackH + 10); ctx.stroke();
  });

  roundRectPath(ctx, x, trackY, w, trackH, trackH / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fill();

  const fillX = x + Math.min(startPct, nowPct) * w;
  const fillW = Math.abs(nowPct - startPct) * w;
  const grad = ctx.createLinearGradient(fillX, 0, fillX + fillW, 0);
  grad.addColorStop(0, '#8b6bf2'); grad.addColorStop(0.55, '#3f8ff0'); grad.addColorStop(1, '#2de2e6');
  ctx.save();
  roundRectPath(ctx, fillX, trackY, Math.max(fillW, 2), trackH, trackH / 2);
  ctx.clip();
  ctx.fillStyle = grad;
  ctx.fillRect(fillX, trackY, Math.max(fillW, 2), trackH);
  ctx.restore();

  if (lowestKg7d != null) {
    const lowestX = x + pctFor(lowestKg7d) * w;
    ctx.textAlign = 'center'; ctx.fillStyle = '#dba52c'; ctx.font = 'bold 13px monospace';
    ctx.fillText(`Lowest (7d): ${round2(fromKg(lowestKg7d, wu))}${wu}`, Math.min(Math.max(lowestX, x + 55), x + w - 55), trackY + 34);
  }

  const nowX = x + nowPct * w;
  ctx.textAlign = 'center'; ctx.fillStyle = '#2de2e6'; ctx.font = 'bold 13px monospace';
  ctx.fillText(`Now: ${round2(fromKg(kgNow, wu))}${wu}`, Math.min(Math.max(nowX, x + 40), x + w - 40), trackY + 52);
  ctx.restore();
}

async function generateWeightJourneyShareCard({ name, digitalId, date, series, wu, profile, kgNow, lowestKg7d }) {
  const width = 600;
  const headerH = 116;
  const chartCardH = series.length ? 300 : 80;
  const gap = 16;
  const goalCardH = 148;
  const footerH = 46;
  const height = headerH + chartCardH + gap + goalCardH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#171f24'); bg.addColorStop(1, '#0a0e12');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(51,200,204,0.4)'; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);

  ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px monospace';
  ctx.fillText(date, width / 2, 74);

  ctx.textAlign = 'left'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 22px sans-serif';
  ctx.fillText('ENTITY WEIGHT JOURNEY', 32, 106);

  let y = headerH;

  // Weight journey card
  roundRectPath(ctx, 24, y, width - 48, chartCardH, 12);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'right'; ctx.fillStyle = '#7e8e95'; ctx.font = '12px monospace';
  ctx.fillText(`${series.length} entries`, width - 44, y + 26);

  if (series.length) {
    drawShareWeightChart(ctx, 44, y + 36, width - 88, 190, series, wu);
    ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = '11px sans-serif';
    ctx.fillText('— Actual weight', 44, y + chartCardH - 14);
    ctx.fillStyle = '#7e8e95';
    ctx.fillText('- - Trend (7-day avg)', 190, y + chartCardH - 14);
  } else {
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px sans-serif';
    ctx.fillText('No weight entries logged yet.', width / 2, y + chartCardH / 2 + 5);
  }
  y += chartCardH + gap;

  // Goal progress card
  roundRectPath(ctx, 24, y, width - 48, goalCardH, 12);
  ctx.stroke();
  ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 16px sans-serif';
  ctx.fillText('Goal progress', 44, y + 30);

  if (profile && kgNow != null && profile.goalTargetKg != null) {
    drawShareGoalTrack(ctx, 64, y + 44, width - 176, profile, kgNow, wu, lowestKg7d);
  } else {
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '13px sans-serif';
    ctx.fillText('Set your weights in Bio to see progress.', width / 2, y + goalCardH / 2 + 10);
  }

  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareWeightJourney() {
  const profile = getProfile();
  const logsArr = sortedLogsArray();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const series = weightChartFullJourney ? computeTrendSeries(logsArr) : computeTrendSeries(logsArr).slice(-60);
  const kgNow = currentWeightKg(profile);
  const lowestKg7d = minOfLastNDays(logsArr, 'weightKg', 7);
  const blob = await generateWeightJourneyShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(new Date()),
    series, wu, profile, kgNow, lowestKg7d,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Weight Journey', text: '📈 My weight journey & goal progress, tracked with Winfinity Tracker!' }, blob);
}

function shareCardShell(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#171f24'); bg.addColorStop(1, '#0a0e12');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(51,200,204,0.4)'; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  return { canvas, ctx };
}

function drawShareCardHeader(ctx, width, { name, digitalId, date, title }) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);
  ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px monospace';
  ctx.fillText(date, width / 2, 74);
  ctx.textAlign = 'left'; ctx.fillStyle = '#33c8cc'; ctx.font = 'bold 22px sans-serif';
  ctx.fillText(title, 32, 106);
}

// Cached across calls within the session so only the first share pays the
// image-load cost — every card after that draws from the already-loaded img.
let cachedShareLogoImage = null;
function loadShareLogoImage() {
  if (cachedShareLogoImage) return Promise.resolve(cachedShareLogoImage);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { cachedShareLogoImage = img; resolve(img); };
    img.onerror = () => resolve(null);
    img.src = 'icons/icon-192.png';
  });
}

// Small brand mark in the lower-right corner of every share card: the app
// icon + "WINFINITY", each sized to 70% of how they appear in the app's own
// header (28px logo / 1.1rem≈17.6px text there).
async function drawShareWatermark(ctx, width, height) {
  const logoSize = Math.round(28 * 0.7);
  const fontSize = Math.round(17.6 * 0.7);
  const pad = 18;
  const img = await loadShareLogoImage();
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#33c8cc';
  ctx.font = `800 ${fontSize}px "Courier New", monospace`;
  const centerY = height - pad - logoSize / 2;
  ctx.fillText('WINFINITY', width - pad, centerY);
  if (img) {
    const textW = ctx.measureText('WINFINITY').width;
    const iconX = width - pad - textW - 8 - logoSize;
    const iconY = height - pad - logoSize;
    ctx.shadowColor = '#33c8cc';
    ctx.shadowBlur = 4;
    ctx.drawImage(img, iconX, iconY, logoSize, logoSize);
  }
  ctx.restore();
}

async function drawShareCardFooter(ctx, width, height) {
  await drawShareWatermark(ctx, width, height);
}

function drawShareTable(ctx, x, y, w, columns, rows) {
  const headerH = 22;
  const rowH = 22;
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 10px monospace'; ctx.fillStyle = '#33c8cc'; ctx.textAlign = 'left';
  let cx = x;
  columns.forEach(col => { ctx.fillText(col.label, cx + 4, y + 15); cx += col.width; });
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + headerH); ctx.lineTo(x + w, y + headerH); ctx.stroke();
  ctx.font = '10px monospace';
  rows.forEach((row, ri) => {
    const ry = y + headerH + ri * rowH;
    if (ri % 2 === 1) { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(x, ry, w, rowH); }
    ctx.fillStyle = '#dde3e5';
    let ccx = x;
    row.forEach((cell, ci) => {
      ctx.fillText(String(cell), ccx + 4, ry + 15);
      ccx += columns[ci].width;
    });
  });
  return headerH + Math.max(1, rows.length) * rowH;
}

async function generateHistoryLogShareCard({ name, digitalId, date, wu, rows }) {
  const width = 600;
  const headerH = 116;
  const columns = [
    { label: 'DATE', width: 78 }, { label: 'WT', width: 66 }, { label: 'STEPS', width: 76 },
    { label: 'CAL', width: 66 }, { label: 'PROT', width: 66 }, { label: 'SLEEP', width: 64 }, { label: 'EX', width: 56 },
  ];
  const tableRows = rows.map(l => [
    l.date.slice(5),
    l.weightKg != null ? round2(fromKg(l.weightKg, wu)) : '–',
    l.steps ?? '–',
    l.calories ?? '–',
    l.protein ?? '–',
    l.sleep ?? '–',
    (l.exercises && l.exercises.length) ? l.exercises.length : '–',
  ]);
  const tableH = 22 + Math.max(1, tableRows.length) * 22;
  const footerH = 46;
  const height = headerH + 20 + tableH + 24 + footerH;

  const { canvas, ctx } = shareCardShell(width, height);
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'ACCOMPLISHMENT LOG' });

  const y = headerH + 20;
  if (!tableRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px sans-serif';
    ctx.fillText('No logs yet.', width / 2, y + 20);
  } else {
    drawShareTable(ctx, 32, y, width - 64, columns, tableRows);
  }

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function generateMeasurementHistoryShareCard({ name, digitalId, date, rows }) {
  const width = 600;
  const headerH = 116;
  // Transposed: one row per measurement, one column per logged date (most
  // recent first, matching the incoming row order) — makes it easy to read
  // straight across and compare recent vs. previous for the same spot,
  // instead of having to scan down a column across separate date-rows.
  const measureDefs = [
    { key: 'chest', label: 'Chest' },
    { key: 'shoulder', label: 'Shoulder' },
    { key: 'lBicep', label: 'L. Bicep' },
    { key: 'rBicep', label: 'R. Bicep' },
    { key: 'abdSupra', label: 'Abd. Supra' },
    { key: 'stomach', label: 'Stomach' },
    { key: 'abdInfra', label: 'Abd. Infra' },
    { key: 'hips', label: 'Hips' },
    { key: 'lThigh', label: 'L. Thigh' },
    { key: 'rThigh', label: 'R. Thigh' },
    { key: 'lCalf', label: 'L. Calf' },
    { key: 'rCalf', label: 'R. Calf' },
  ];
  const labelColW = 92;
  const dateColW = rows.length ? Math.min(90, (width - 64 - labelColW) / rows.length) : 90;
  const columns = [{ label: 'MEASURE', width: labelColW }, ...rows.map(l => ({ label: l.date.slice(5), width: dateColW }))];
  const tableRows = measureDefs
    .map(def => [def.label, ...rows.map(l => (l.measurements || {})[def.key] ?? '–')])
    .filter(row => row.slice(1).some(v => v !== '–'));
  const tableH = 22 + Math.max(1, tableRows.length) * 22;
  const footerH = 46;
  const height = headerH + 20 + tableH + 24 + footerH;

  const { canvas, ctx } = shareCardShell(width, height);
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'MEASUREMENT HISTORY' });

  const y = headerH + 20;
  if (!rows.length || !tableRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px sans-serif';
    ctx.fillText('No measurements logged yet.', width / 2, y + 20);
  } else {
    drawShareTable(ctx, 32, y, width - 64, columns, tableRows);
    ctx.textAlign = 'left'; ctx.fillStyle = '#5a686e'; ctx.font = '10px monospace';
    ctx.fillText('Values in cm · left = most recent', 32, y + tableH + 16);
  }

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

function computeOutdoorActivitySummary(logsArr) {
  const sessions = [];
  logsArr.forEach(l => (l.cardioSessions || []).forEach(s => sessions.push({ date: l.date, ...s })));
  sessions.sort((a, b) => b.date.localeCompare(a.date));
  const totalDistanceKm = sessions.reduce((s, x) => s + (x.distanceKm || 0), 0);
  const totalDurationSec = sessions.reduce((s, x) => s + (x.durationSec || 0), 0);
  return { sessions, totalDistanceKm, totalDurationSec, count: sessions.length };
}

async function generateOutdoorActivityShareCard({ name, digitalId, date, summary, unit }) {
  const width = 600;
  const headerH = 116;
  const recent = summary.sessions.slice(0, 7);
  const columns = [
    { label: 'DATE', width: 90 }, { label: 'TYPE', width: 90 },
    { label: 'DIST', width: 120 }, { label: 'DURATION', width: 130 },
  ];
  const tableRows = recent.map(s => {
    const dist = unit === 'mi' ? kmToMi(s.distanceKm) : s.distanceKm;
    return [s.date.slice(5), s.type, dist.toFixed(2) + ' ' + unit, formatCardioDuration(s.durationSec)];
  });
  const tableH = tableRows.length ? 22 + tableRows.length * 22 : 30;
  const footerH = 46;
  const height = headerH + 92 + 26 + 20 + tableH + 24 + footerH;

  const { canvas, ctx } = shareCardShell(width, height);
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'OUTDOOR ACTIVITY SUMMARY' });

  let y = headerH;
  const tileGap = 14;
  const tileW = (width - 64 - tileGap * 2) / 3;
  const totalDist = unit === 'mi' ? kmToMi(summary.totalDistanceKm) : summary.totalDistanceKm;
  const tiles = [
    { value: String(summary.count), label: 'SESSIONS' },
    { value: totalDist.toFixed(1), label: `DISTANCE (${unit.toUpperCase()})` },
    { value: formatCardioDuration(summary.totalDurationSec), label: 'DURATION' },
  ];
  tiles.forEach((t, i) => {
    const x = 32 + i * (tileW + tileGap);
    ctx.strokeStyle = 'rgba(51,200,204,0.35)'; ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, tileW, 92, 10);
    ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 26px sans-serif';
    ctx.fillText(t.value, x + tileW / 2, y + 50);
    ctx.fillStyle = '#7e8e95'; ctx.font = '11px monospace';
    ctx.fillText(t.label, x + tileW / 2, y + 74);
  });
  y += 92 + 26 + 20;

  if (!tableRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '14px sans-serif';
    ctx.fillText('No outdoor activity logged yet.', width / 2, y + 15);
  } else {
    drawShareTable(ctx, 32, y, width - 64, columns, tableRows);
  }

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function generateRecentPerformanceShareCard({ name, digitalId, date, perfItems, days }) {
  const width = 600;
  const height = 560;
  const { canvas, ctx } = shareCardShell(width, height);
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'RECENT PERFORMANCE (7D AVG)' });

  const STATUS_COLORS = { good: '#34bd7c', warning: '#dba52c', serious: '#e6824b', critical: '#e6516a', muted: '#5a686e' };

  const tileRowH = 84;
  const tileGap = 12;
  const tileW = (width - 64 - tileGap) / 2;
  const tilesTop = 116;
  perfItems.forEach((p, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 32 + col * (tileW + tileGap);
    const ty = tilesTop + row * (tileRowH + tileGap);
    roundRectPath(ctx, x, ty, tileW, tileRowH, 10);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 14px sans-serif';
    ctx.fillText(p.label, x + 14, ty + 24);

    const dotColor = STATUS_COLORS[p.status] || STATUS_COLORS.muted;
    ctx.fillStyle = dotColor; ctx.beginPath(); ctx.arc(x + tileW - 66, ty + 20, 4, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'right'; ctx.fillStyle = dotColor; ctx.font = 'bold 13px monospace';
    ctx.fillText(p.statusLabel, x + tileW - 14, ty + 24);

    const barCount = p.sparkline.length;
    const barGap = 4;
    const barAreaW = tileW - 28;
    const barW = (barAreaW - barGap * (barCount - 1)) / barCount;
    const barBaseY = ty + tileRowH - 12;
    const barMaxH = 34;
    p.sparkline.forEach((v, bi) => {
      const h = v != null ? Math.max(4, (v / 5) * barMaxH) : 3;
      const bx = x + 14 + bi * (barW + barGap);
      const isToday = bi === barCount - 1;
      ctx.fillStyle = isToday ? dotColor : 'rgba(255,255,255,0.15)';
      ctx.fillRect(bx, barBaseY - h, barW, h);
    });
  });

  const chartTop = tilesTop + tileRowH * 2 + tileGap + 24;
  ctx.textAlign = 'left'; ctx.fillStyle = '#dde3e5'; ctx.font = 'bold 15px sans-serif';
  ctx.fillText('Steps vs Calories (7D)', 32, chartTop);

  const plotY = chartTop + 16;
  const chartX = 32, chartW = width - 64, chartPlotH = 110;
  const dayW = chartW / days.length;
  const barPairW = Math.min(20, dayW * 0.28);
  days.forEach((d, i) => {
    const cx = chartX + i * dayW + dayW / 2;
    const baseY = plotY + chartPlotH;
    const stepsH = Math.max(2, (Math.min(100, (d.stepsPct / 130) * 100) / 100) * chartPlotH);
    const calH = Math.max(2, (Math.min(100, (d.calPct / 130) * 100) / 100) * chartPlotH);
    ctx.fillStyle = '#2de2e6';
    ctx.fillRect(cx - barPairW - 2, baseY - stepsH, barPairW, stepsH);
    ctx.fillStyle = '#8069d6';
    ctx.fillRect(cx + 2, baseY - calH, barPairW, calH);
    ctx.textAlign = 'center'; ctx.fillStyle = '#7e8e95'; ctx.font = '10px monospace';
    ctx.fillText(d.weekday, cx, baseY + 16);
  });
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(chartX, plotY + chartPlotH); ctx.lineTo(chartX + chartW, plotY + chartPlotH); ctx.stroke();

  const legendY = plotY + chartPlotH + 36;
  ctx.textAlign = 'left'; ctx.font = '11px sans-serif';
  ctx.fillStyle = '#2de2e6'; ctx.fillRect(32, legendY - 9, 10, 10);
  ctx.fillStyle = '#dde3e5'; ctx.fillText('Steps', 48, legendY);
  ctx.fillStyle = '#8069d6'; ctx.fillRect(120, legendY - 9, 10, 10);
  ctx.fillStyle = '#dde3e5'; ctx.fillText('Calories', 136, legendY);

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareRecentPerformance() {
  const profile = getProfile();
  const logsArr = sortedLogsArray();
  const perfDefs = [
    ['Sleep quality', 'sleep'], ['Stress', 'stress'], ['Fatigue', 'fatigue'], ['Hunger', 'hunger'],
  ];
  const perfItems = perfDefs.map(([label, field]) => {
    const val = avgOfLastNDays(logsArr, field, 7);
    return {
      label, field,
      status: statusForLevel(field, val),
      statusLabel: labelForLevel(field, val),
      sparkline: last7DailyValues(field),
    };
  });

  const stepGoal = getEffectiveStepGoal(profile);
  const calorieTarget = getEffectiveCalorieTarget(profile) || 2000;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const entry = logsArr.find(l => l.date === iso);
    days.push({
      weekday: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
      stepsPct: entry && entry.steps != null ? (entry.steps / stepGoal) * 100 : 0,
      calPct: entry && entry.calories != null ? (entry.calories / calorieTarget) * 100 : 0,
    });
  }

  const blob = await generateRecentPerformanceShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(new Date()),
    perfItems, days,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Recent Performance', text: '📊 My 7-day performance, tracked with Winfinity Tracker!' }, blob);
}

function initNutrition() {
  document.getElementById('nutDate').value = todayISO();
  document.getElementById('nutDate').addEventListener('change', e => {
    loadNutritionForDate(e.target.value);
    renderNutritionTargets();
    refreshFuelWaterViews(e.target.value);
  });
  document.getElementById('btnGoToBioFromFuel').addEventListener('click', () => {
    document.querySelector('.tab-btn[data-target="bio"]').click();
  });
  document.getElementById('btnShareFuelStatus').addEventListener('click', shareDailyFuelStatus);
  const carryoverMenuBtn = document.getElementById('btnCarryoverMenu');
  const carryoverMenu = document.getElementById('carryoverMenu');
  carryoverMenuBtn.addEventListener('click', () => {
    if (carryoverMenu.hidden) document.getElementById('btnReturnOverflow').disabled = !hasCancelledOverflow();
    carryoverMenu.hidden = !carryoverMenu.hidden;
  });
  document.addEventListener('click', e => {
    if (!carryoverMenu.hidden && !e.target.closest('#carryoverMenu') && e.target !== carryoverMenuBtn && !carryoverMenuBtn.contains(e.target)) {
      carryoverMenu.hidden = true;
    }
  });
  document.getElementById('btnCancelOverflow').addEventListener('click', () => {
    carryoverMenu.hidden = true;
    resetCalorieCarryover();
  });
  document.getElementById('btnReturnOverflow').addEventListener('click', () => {
    carryoverMenu.hidden = true;
    returnCalorieOverflow();
  });

  initFuelWaterOrb();
  loadNutritionForDate(todayISO());
  renderNutritionTargets();
  renderNutritionAverages();
  initCoachAssignment();
  initRequestAssessment();
}

function loadCoachAssignment() {
  const profile = getProfile();
  document.getElementById('coachCalorieInput').value = (profile && profile.coachCalorieTarget) || '';
  document.getElementById('coachStepsInput').value = (profile && profile.coachStepGoal) || '';
  document.getElementById('coachWorkoutsInput').value = (profile && profile.coachWorkoutsPerWeek) || '';
  document.getElementById('coachRefeedCalories').value = (profile && profile.refeedCalories) || '';
  document.getElementById('coachRefeedStart').value = (profile && profile.refeedStart) || '';
  document.getElementById('coachRefeedEnd').value = (profile && profile.refeedEnd) || '';
}

async function refreshCoachAssignmentFromServer() {
  const note = document.getElementById('coachRefreshNote');
  const btn = document.getElementById('btnRefreshCoachAssignment');
  if (!sbConfigured()) { note.textContent = 'Not available offline.'; return; }
  const profile = getProfile();
  if (!profile) { note.textContent = 'Set up your profile in BIO first.'; return; }
  btn.disabled = true;
  note.textContent = 'Checking for a new assignment…';
  try {
    const shareKey = getOrCreateShareKey();
    const { data, error } = await sb.from('assigned_targets').select('*').eq('share_key', shareKey).maybeSingle();
    if (error) throw error;
    if (!data) {
      note.textContent = 'No assignment from your coach yet.';
      return;
    }
    profile.coachCalorieTarget = data.calorie_target;
    profile.coachStepGoal = data.step_goal;
    profile.coachWorkoutsPerWeek = data.workouts_per_week;
    profile.refeedCalories = data.refeed_calories;
    profile.refeedStart = data.refeed_start;
    profile.refeedEnd = data.refeed_end;
    saveProfile(profile);
    loadCoachAssignment();
    renderNutritionTargets();
    renderDashboard();
    renderTrainingStats();
    note.textContent = 'Refreshed — assignment updated ' + fmtDate(parseISO(data.updated_at.slice(0, 10))) + '.';
  } catch (e) {
    note.textContent = e.message || 'Could not check for an assignment — try again.';
  } finally {
    btn.disabled = false;
  }
}

function initCoachAssignment() {
  loadCoachAssignment();
  document.getElementById('btnRefreshCoachAssignment').addEventListener('click', refreshCoachAssignmentFromServer);
  document.getElementById('btnSaveCoachAssignment').addEventListener('click', () => {
    const profile = getProfile();
    const note = document.getElementById('coachAssignmentNote');
    if (!profile) {
      alert('Set up your profile in BIO first, then assign coach targets here.');
      return;
    }
    const refeedStart = document.getElementById('coachRefeedStart').value || null;
    const refeedEnd = document.getElementById('coachRefeedEnd').value || null;
    if (refeedStart && refeedEnd && refeedStart > refeedEnd) {
      note.textContent = 'Refeed start date must be on or before the end date.';
      return;
    }
    profile.coachCalorieTarget = parseIntOrNull(document.getElementById('coachCalorieInput').value);
    profile.coachStepGoal = parseIntOrNull(document.getElementById('coachStepsInput').value);
    profile.coachWorkoutsPerWeek = parseIntOrNull(document.getElementById('coachWorkoutsInput').value);
    profile.refeedCalories = parseIntOrNull(document.getElementById('coachRefeedCalories').value);
    profile.refeedStart = refeedStart;
    profile.refeedEnd = refeedEnd;
    saveProfile(profile);
    note.textContent = 'Assignment saved.';
    setTimeout(() => { note.textContent = ''; }, 2500);
    renderNutritionTargets();
    renderDashboard();
    renderTrainingStats();
  });
}

async function buildAssessmentBlobs() {
  const profile = getProfile();
  const name = (profile && profile.name) || 'Operator';
  const digitalId = getOrCreatePublicId();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray();
  const nowDate = fmtDate(new Date());
  // Kicked off together (not one-by-one with sequential awaits) to keep the
  // total wait as short as possible — a long delay here before the eventual
  // navigator.share() call risks the browser no longer treating it as
  // tied to the tap that started it, which some browsers silently reject.
  const jobs = [];

  if (document.getElementById('assessChkHistory').checked) {
    jobs.push(generateHistoryLogShareCard({
      name, digitalId, date: nowDate, wu, rows: logsArr.slice(-7).reverse(),
    }).then(blob => ({ name: 'accomplishment-log.png', blob })));
  }

  if (document.getElementById('assessChkMeasurements').checked) {
    jobs.push(generateMeasurementHistoryShareCard({
      name, digitalId, date: nowDate, rows: logsArr.filter(l => l.measurements).slice(-5).reverse(),
    }).then(blob => ({ name: 'measurement-history.png', blob })));
  }

  if (document.getElementById('assessChkWeight').checked) {
    const series = weightChartFullJourney ? computeTrendSeries(logsArr) : computeTrendSeries(logsArr).slice(-60);
    const kgNow = currentWeightKg(profile);
    const lowestKg7d = minOfLastNDays(logsArr, 'weightKg', 7);
    jobs.push(generateWeightJourneyShareCard({
      name, digitalId, date: nowDate, series, wu, profile, kgNow, lowestKg7d,
    }).then(blob => ({ name: 'weight-journey.png', blob })));
  }

  if (document.getElementById('assessChkPerformance').checked) {
    const perfDefs = [['Sleep quality', 'sleep'], ['Stress', 'stress'], ['Fatigue', 'fatigue'], ['Hunger', 'hunger']];
    const perfItems = perfDefs.map(([label, field]) => {
      const val = avgOfLastNDays(logsArr, field, 7);
      return { label, field, status: statusForLevel(field, val), statusLabel: labelForLevel(field, val), sparkline: last7DailyValues(field) };
    });
    const stepGoal = getEffectiveStepGoal(profile);
    const calorieTargetForChart = getEffectiveCalorieTarget(profile) || 2000;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const entry = logsArr.find(l => l.date === iso);
      days.push({
        weekday: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
        stepsPct: entry && entry.steps != null ? (entry.steps / stepGoal) * 100 : 0,
        calPct: entry && entry.calories != null ? (entry.calories / calorieTargetForChart) * 100 : 0,
      });
    }
    jobs.push(generateRecentPerformanceShareCard({ name, digitalId, date: nowDate, perfItems, days })
      .then(blob => ({ name: 'recent-performance.png', blob })));
  }

  if (document.getElementById('assessChkWorkout').checked) {
    const trainDate = getActiveTrainingDate();
    const exercisesForDate = (getLogs()[trainDate] && getLogs()[trainDate].exercises) || [];
    const summary = computeWorkoutSummaryFromExercises(exercisesForDate, trainDate);
    jobs.push(generateWorkoutSummaryShareCard({
      name, digitalId, dateTime: fmtDate(parseISO(trainDate)), summary,
    }).then(blob => ({ name: 'workout-summary.png', blob })));
  }

  if (document.getElementById('assessChkOutdoor').checked) {
    const summary = computeOutdoorActivitySummary(logsArr);
    jobs.push(generateOutdoorActivityShareCard({
      name, digitalId, date: nowDate, summary, unit: distUnitForProfile(profile),
    }).then(blob => ({ name: 'outdoor-activity.png', blob })));
  }

  if (document.getElementById('assessChkFuel').checked) {
    const date = todayISO();
    const entry = getLogs()[date] || {};
    const calorieTarget = getEffectiveCalorieTarget(profile, date) || 0;
    const caloriesNow = entry.calories ?? 0;
    const proteinNow = entry.protein ?? 0;
    const carbsNow = entry.carbs ?? 0;
    const fatNow = entry.fat ?? 0;
    const macros = [
      { label: 'Protein', kcal: proteinNow * 4, color: '#33c8cc', pct: caloriesNow > 0 ? Math.round((proteinNow * 4 / caloriesNow) * 100) : 0 },
      { label: 'Carbs', kcal: carbsNow * 4, color: '#8069d6', pct: caloriesNow > 0 ? Math.round((carbsNow * 4 / caloriesNow) * 100) : 0 },
      { label: 'Fat', kcal: fatNow * 9, color: '#dba52c', pct: caloriesNow > 0 ? Math.round((fatNow * 9 / caloriesNow) * 100) : 0 },
    ];
    jobs.push(generateFuelStatusShareCard({
      name, digitalId, date: fmtDate(parseISO(date)), caloriesNow, calorieTarget, macros,
    }).then(blob => ({ name: 'daily-fuel-status.png', blob })));
  }

  return Promise.all(jobs);
}

function openAssessmentOverlay() {
  document.getElementById('assessmentShareNote').textContent = '';
  document.getElementById('assessmentShareOverlay').hidden = false;
}

function initRequestAssessment() {
  const overlay = document.getElementById('assessmentShareOverlay');
  document.getElementById('btnRequestAssessment').addEventListener('click', openAssessmentOverlay);
  document.getElementById('btnCloseAssessmentShare').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });

  document.getElementById('btnAssessmentShareSubmit').addEventListener('click', async () => {
    const note = document.getElementById('assessmentShareNote');
    const btn = document.getElementById('btnAssessmentShareSubmit');
    btn.disabled = true;
    note.textContent = 'Preparing…';
    try {
      const blobs = await buildAssessmentBlobs();
      if (!blobs.length) {
        note.textContent = 'Check at least one item to share.';
        btn.disabled = false;
        return;
      }
      const result = await shareMultipleViaWebShare({
        title: 'Winfinity Tracker — Assessment',
        text: '📋 My fitness assessment, tracked with Winfinity Tracker!',
      }, blobs);
      if (result === 'shared') {
        overlay.hidden = true;
      } else if (result === 'cancelled') {
        note.textContent = 'Share cancelled — images were still saved to your device.';
      } else {
        note.textContent = "Direct sharing isn't available on this browser — images were saved to your device instead.";
      }
    } catch (e) {
      note.textContent = 'Could not prepare assessment: ' + (e.message || 'try again');
    }
    btn.disabled = false;
  });
}

function renderNutritionTargets() {
  const profile = getProfile();
  const emptyBox = document.getElementById('nutTargetsEmpty');
  const statRows = document.querySelectorAll('#fuelStatusCard .fuel-cal-row, #fuelStatusCard .gradient-stat-row');
  const kg = profile ? currentWeightKg(profile) : null;
  const targets = (profile && kg) ? computeTargets(profile, kg) : null;

  if (!targets) {
    emptyBox.hidden = false;
    statRows.forEach(el => el.style.display = 'none');
    return;
  }
  emptyBox.hidden = true;
  statRows.forEach(el => el.style.display = '');

  const date = document.getElementById('nutDate').value;
  const calorieTarget = getEffectiveCalorieTarget(profile, date);
  const proteinTarget = round0((targets.protein[0] + targets.protein[1]) / 2);
  const fatTarget = round0((calorieTarget * 0.3) / 9);
  const carbTarget = Math.max(0, round0((calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4));
  const fiberTarget = round0((calorieTarget / 1000) * 14);
  const sodiumTarget = 2300;

  const entry = getLogs()[date] || {};
  const caloriesNow = entry.calories ?? 0;
  const proteinNow = entry.protein ?? 0;
  const carbsNow = entry.carbs ?? 0;
  const fatNow = entry.fat ?? 0;
  const fiberNow = entry.fiber ?? 0;
  const sodiumNow = entry.sodium ?? 0;

  const carryover = getCalorieCarryover(date, profile);
  const effectiveCalorieTarget = Math.max(1, calorieTarget + carryover);
  const caloriePctRaw = (caloriesNow / effectiveCalorieTarget) * 100;
  const caloriePct = Math.min(100, caloriePctRaw);
  const calorieOverflowPct = Math.max(0, caloriePctRaw - 100);
  const isOverCalories = caloriePctRaw > 100;
  renderRing(document.getElementById('fuelCalorieRing'), caloriePct, {
    size: 120, stroke: 10, gradient: true, overflowPct: calorieOverflowPct,
    centerHtml: isOverCalories
      ? `<span style="font-size:${Math.round(120 * 0.22)}px;font-weight:800;font-family:var(--font-mono);color:var(--critical);">${Math.round(caloriePctRaw)}%</span>`
      : undefined,
    centerText: Math.round(caloriePctRaw) + '%',
    label: 'Calories',
    sub: `${caloriesNow} / ${effectiveCalorieTarget} kcal${carryover !== 0 ? ` (${carryover > 0 ? '+' : '−'}${round0(Math.abs(carryover))} carried over)` : ''}`,
  });

  const proteinKcal = proteinNow * 4;
  const carbKcal = carbsNow * 4;
  const fatKcal = fatNow * 9;
  const macroLegend = document.getElementById('fuelMacroLegend');
  const macros = [
    { label: 'Protein', kcal: proteinKcal, dot: 'macro-protein' },
    { label: 'Carbs', kcal: carbKcal, dot: 'macro-carbs' },
    { label: 'Fat', kcal: fatKcal, dot: 'macro-fat' },
  ];
  macroLegend.innerHTML = macros.map(m => {
    const pctOfIntake = caloriesNow > 0 ? Math.round((m.kcal / caloriesNow) * 100) : 0;
    return `<li><span class="macro-dot ${m.dot}"></span>${m.label} <strong>${pctOfIntake}%</strong> of intake</li>`;
  }).join('');

  document.getElementById('fuelProteinNow').textContent = proteinNow + 'g';
  document.getElementById('fuelProteinTarget').textContent = proteinTarget + 'g';
  document.getElementById('fuelProteinBar').style.width = Math.min(100, (proteinNow / proteinTarget) * 100) + '%';

  document.getElementById('fuelCarbsNow').textContent = carbsNow + 'g';
  document.getElementById('fuelCarbsTarget').textContent = carbTarget + 'g';
  document.getElementById('fuelCarbsBar').style.width = Math.min(100, (carbsNow / carbTarget) * 100) + '%';

  document.getElementById('fuelFatNow').textContent = fatNow + 'g';
  document.getElementById('fuelFatTarget').textContent = fatTarget + 'g';
  document.getElementById('fuelFatBar').style.width = Math.min(100, (fatNow / fatTarget) * 100) + '%';

  document.getElementById('fuelFiberNow').textContent = fiberNow + 'g';
  document.getElementById('fuelFiberTarget').textContent = fiberTarget + 'g';
  document.getElementById('fuelFiberBar').style.width = Math.min(100, (fiberNow / fiberTarget) * 100) + '%';

  document.getElementById('fuelSodiumNow').textContent = sodiumNow + 'mg';
  document.getElementById('fuelSodiumTarget').textContent = sodiumTarget + 'mg';
  document.getElementById('fuelSodiumBar').style.width = Math.min(100, (sodiumNow / sodiumTarget) * 100) + '%';
}

// Fuel Snapshot ring row: Calories stays a 7-day average (day-to-day intake
// is noisy, the trend is what matters); Protein and Water are today's
// values (they're things you act on today, not a trailing average).
function ringCurrentVsTarget(current, target, unitSuffix) {
  const pct = target ? Math.min(100, (current / target) * 100) : 0;
  const centerHtml = target != null
    ? `<div style="line-height:1.15;text-align:center;">
        <div style="font-size:15px;font-weight:800;font-family:var(--font-mono);color:var(--text-primary);">${round0(current)}${unitSuffix || ''}</div>
        <div style="font-size:9px;font-family:var(--font-mono);color:var(--text-muted);">/${round0(target)}${unitSuffix || ''}</div>
      </div>`
    : undefined;
  return { pct, centerHtml };
}

function renderNutritionAverages() {
  const profile = getProfile();
  const today = todayISO();
  const todayEntry = getLogs()[today] || {};
  const logsArr = sortedLogsArray();

  const avgCalories = avgOfLastNDays(logsArr, 'calories', 7);
  const calorieTarget = profile ? getEffectiveCalorieTarget(profile, today) : null;
  const calRing = ringCurrentVsTarget(avgCalories ?? 0, calorieTarget, '');
  renderRing(document.getElementById('avgCaloriesRing'), avgCalories != null ? calRing.pct : 0, {
    size: 96, stroke: 7, gradient: true,
    centerHtml: avgCalories != null ? calRing.centerHtml : undefined,
    label: 'Calories', sub: '7-day avg',
  });

  const kg = profile ? currentWeightKg(profile) : null;
  const targets = (profile && kg) ? computeTargets(profile, kg) : null;
  const proteinTarget = targets ? round0((targets.protein[0] + targets.protein[1]) / 2) : null;
  const protRing = ringCurrentVsTarget(todayEntry.protein ?? 0, proteinTarget, 'g');
  renderRing(document.getElementById('avgProteinRing'), protRing.pct, {
    size: 96, stroke: 7, gradient: true,
    centerHtml: protRing.centerHtml,
    label: 'Protein', sub: 'Today',
  });

  const waterTarget = effectiveWaterTargetML(today);
  const waterRing = ringCurrentVsTarget(todayEntry.water ?? 0, waterTarget, '');
  renderRing(document.getElementById('avgWaterRing'), waterRing.pct, {
    size: 96, stroke: 7, gradient: true,
    centerHtml: waterRing.centerHtml,
    label: 'Water', sub: 'Today',
  });
}

/* ---------------------------------------------------------------- */
/* Daily review                                                         */
/* ---------------------------------------------------------------- */
function computeDailyReviewChecklist(date) {
  const entry = getLogs()[date] || {};
  return {
    weight: entry.weightKg != null,
    sleep: entry.sleep != null,
    steps: entry.steps != null,
    levels: entry.stress != null && entry.fatigue != null && entry.hunger != null,
    water: !!entry.water,
    training: !!(entry.exercises && entry.exercises.length > 0),
    calories: entry.calories != null,
    protein: entry.protein != null,
    cardio: !!(entry.cardioSessions && entry.cardioSessions.length > 0),
  };
}

function renderDailyReviewChecklist(date) {
  const c = computeDailyReviewChecklist(date);
  document.getElementById('drCheckWeight').checked = c.weight;
  document.getElementById('drCheckSleep').checked = c.sleep;
  document.getElementById('drCheckSteps').checked = c.steps;
  document.getElementById('drCheckLevels').checked = c.levels;
  document.getElementById('drCheckWater').checked = c.water;
  document.getElementById('drCheckTraining').checked = c.training;
  document.getElementById('drCheckCalories').checked = c.calories;
  document.getElementById('drCheckProtein').checked = c.protein;
  document.getElementById('drCheckCardio').checked = c.cardio;
}

function loadDailyReviewForDate(date) {
  const reviews = getDailyReviews();
  const r = reviews[date] || {};
  document.getElementById('dailyReviewStruggle').value = r.struggle || '';
  document.getElementById('dailyReviewFix').value = r.fix || '';
  renderDailyReviewChecklist(date);
}

function initDailyReviewForm() {
  const form = document.getElementById('dailyReviewForm');
  const dateInput = document.getElementById('dailyReviewDate');
  dateInput.value = todayISO();

  dateInput.addEventListener('change', () => loadDailyReviewForDate(dateInput.value));

  form.addEventListener('submit', e => {
    e.preventDefault();
    const date = dateInput.value;
    const reviews = getDailyReviews();
    reviews[date] = {
      date,
      struggle: document.getElementById('dailyReviewStruggle').value,
      fix: document.getElementById('dailyReviewFix').value,
    };
    saveDailyReviews(reviews);
    document.getElementById('dailyReviewSaveNote').textContent = 'Saved daily review for ' + date;
    setTimeout(() => { document.getElementById('dailyReviewSaveNote').textContent = ''; }, 2000);
  });

  loadDailyReviewForDate(todayISO());
}

/* ---------------------------------------------------------------- */
/* Weekly review                                                        */
/* ---------------------------------------------------------------- */
function initReviewForm() {
  const form = document.getElementById('reviewForm');
  document.getElementById('reviewDate').value = todayISO();

  form.addEventListener('submit', e => {
    e.preventDefault();
    const date = document.getElementById('reviewDate').value;
    const reviews = getReviews();
    const focus = Array.from(document.querySelectorAll('.reviewFocus')).filter(c => c.checked).map(c => c.value);
    reviews[date] = {
      date,
      adjustments: document.getElementById('reviewAdjustments').value,
      wins: document.getElementById('reviewWins').value,
      improvements: document.getElementById('reviewImprovements').value,
      focus,
      other: document.getElementById('reviewOther').value,
    };
    saveReviews(reviews);
    document.getElementById('reviewSaveNote').textContent = 'Saved review for week ending ' + date;
    setTimeout(() => { document.getElementById('reviewSaveNote').textContent = ''; }, 2000);
    form.reset();
    document.getElementById('reviewDate').value = todayISO();
  });
}

/* ---------------------------------------------------------------- */
/* History                                                             */
/* ---------------------------------------------------------------- */
function renderHistory() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray().slice().reverse();
  const body = document.getElementById('historyBody');
  const emptyNote = document.getElementById('historyEmptyNote');
  body.innerHTML = '';
  if (!logsArr.length) { emptyNote.hidden = false; return; }
  emptyNote.hidden = true;
  logsArr.forEach(l => {
    const exCount = l.exercises ? l.exercises.length : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.date}</td>
      <td>${l.weightKg != null ? round2(fromKg(l.weightKg, wu)) : '–'}</td>
      <td>${l.steps ?? '–'}</td>
      <td>${l.calories ?? '–'}</td>
      <td>${l.protein ?? '–'}</td>
      <td>${l.sleep ?? '–'}</td>
      <td>${exCount > 0 ? exCount + ' ex' : '–'}</td>`;
    body.appendChild(tr);
  });
}

function renderMeasureHistory() {
  const logsArr = sortedLogsArray().slice().reverse().filter(l => l.measurements);
  const body = document.getElementById('measureHistoryBody');
  const emptyNote = document.getElementById('measureHistoryEmptyNote');
  body.innerHTML = '';
  if (!logsArr.length) { emptyNote.hidden = false; return; }
  emptyNote.hidden = true;
  logsArr.forEach(l => {
    const m = l.measurements || {};
    const c = v => v ?? '–';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.date}</td>
      <td>${c(m.chest)}</td>
      <td>${c(m.shoulder)}</td>
      <td>${c(m.lBicep)}</td>
      <td>${c(m.rBicep)}</td>
      <td>${c(m.abdSupra)}</td>
      <td>${c(m.stomach)}</td>
      <td>${c(m.abdInfra)}</td>
      <td>${c(m.hips)}</td>
      <td>${c(m.lThigh)}</td>
      <td>${c(m.rThigh)}</td>
      <td>${c(m.lCalf)}</td>
      <td>${c(m.rCalf)}</td>`;
    body.appendChild(tr);
  });
}

function renderBodyFatHistory() {
  const logsArr = sortedLogsArray().slice().reverse().filter(hasLoggedSkinfolds);
  const body = document.getElementById('bodyFatHistoryBody');
  const emptyNote = document.getElementById('bodyFatHistoryEmptyNote');
  body.innerHTML = '';
  if (!logsArr.length) { emptyNote.hidden = false; return; }
  emptyNote.hidden = true;
  const profile = getProfile();
  const age = profile ? profile.age : null;
  const gender = profile ? profile.gender : 'male';
  logsArr.forEach(l => {
    const sf = l.skinfolds || {};
    const c = v => v ?? '–';
    const pct = l.bodyFatPct ?? computeBodyFatJP7(sf, age, gender);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.date}</td>
      <td>${c(sf.chest)}</td>
      <td>${c(sf.abdomen)}</td>
      <td>${c(sf.thigh)}</td>
      <td>${c(sf.triceps)}</td>
      <td>${c(sf.suprailiac)}</td>
      <td>${c(sf.subscapular)}</td>
      <td>${c(sf.midaxillary)}</td>
      <td>${pct != null ? round2(pct) + '%' : '–'}</td>`;
    body.appendChild(tr);
  });
}

/* ---------------------------------------------------------------- */
/* CSV export + share                                                  */
/* ---------------------------------------------------------------- */
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function formatExercises(exercises, wu) {
  if (!exercises || !exercises.length) return '';
  return exercises.map(ex => {
    const setsText = (ex.sets || [])
      .filter(s => s.completed)
      .map(s => `${s.reps ?? '?'}x${s.weightKg != null ? round2(fromKg(s.weightKg, wu)) : '?'}${wu}`)
      .join('/');
    return `${ex.name} (${setsText || 'no completed sets'})`;
  }).join('; ');
}

function buildCSV(logsArr, profile) {
  const wu = profile ? profile.weightUnit || 'kg' : 'kg';
  const habitLabels = (profile ? profile.extraHabits || [] : []).map((l, i) => ({ label: l, idx: i })).filter(h => h.label);
  const headers = ['Date', `Weight (${wu})`, 'Sleep Quality (1-5)', 'Stress (1-5)', 'Fatigue (1-5)', 'Hunger (1-5)',
    'Steps', 'Calories', 'Protein (g)', 'Water (mL)', 'Workout Done', 'Exercises', 'Menstruating',
    ...habitLabels.map(h => h.label)];
  const rows = [headers];
  logsArr.forEach(l => {
    const row = [
      l.date,
      l.weightKg != null ? round2(fromKg(l.weightKg, wu)) : '',
      l.sleep ?? '', l.stress ?? '', l.fatigue ?? '', l.hunger ?? '',
      l.steps ?? '', l.calories ?? '', l.protein ?? '', l.water ?? '',
      l.workout ? 'Yes' : 'No',
      formatExercises(l.exercises, wu),
      l.menstruating ? 'Yes' : 'No',
      ...habitLabels.map(h => (l.extra && l.extra[h.idx]) ? 'Yes' : 'No'),
    ];
    rows.push(row);
  });
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}

async function exportCSV(logsArr, filenamePrefix) {
  const profile = getProfile();
  if (!logsArr.length) {
    alert('No log entries found for this range yet.');
    return;
  }
  const BOM = '﻿';
  const csv = BOM + buildCSV(logsArr, profile);
  const filename = `${filenamePrefix}-${todayISO()}.csv`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const file = new File([blob], filename, { type: 'text/csv' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename, text: 'Weekly fitness log' });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  alert('CSV downloaded: ' + filename + '\nOpen your email app, start a new message, and attach the file from Downloads.');
}

function downloadBackupJSON() {
  const data = { profile: getProfile(), logs: getLogs(), reviews: getReviews() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `fitness-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  localStorage.setItem('wft_drive_last_backup', todayISO());
  renderDashboard();
  autoSyncDriveBackupToNexus();
}

function getBackupMode() {
  return localStorage.getItem('wft_backup_mode') || 'manual';
}
function setBackupMode(mode) {
  localStorage.setItem('wft_backup_mode', mode);
}
let autoBackupTimerId = null;
function startAutoBackupTimer() {
  if (autoBackupTimerId) clearInterval(autoBackupTimerId);
  autoBackupTimerId = setInterval(() => {
    if (getBackupMode() === 'auto') downloadBackupJSON();
  }, 30 * 60 * 1000);
}

function initExport() {
  document.getElementById('btnExportWeek').addEventListener('click', () => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0,0,0,0);
    const arr = sortedLogsArray().filter(l => parseISO(l.date) >= cutoff);
    exportCSV(arr, 'fitness-log-week');
  });
  document.getElementById('btnExportAll').addEventListener('click', () => {
    exportCSV(sortedLogsArray(), 'fitness-log-all');
  });

  document.getElementById('btnBackup').addEventListener('click', downloadBackupJSON);

  const backupModeButtons = document.querySelectorAll('#backupModeSwitch .unit-switch-btn');
  const backupModeHint = document.getElementById('backupModeHint');
  const refreshBackupModeUI = () => {
    const mode = getBackupMode();
    backupModeButtons.forEach(btn => btn.classList.toggle('is-active', btn.dataset.mode === mode));
    backupModeHint.textContent = mode === 'auto'
      ? 'Auto — backs up automatically every 30 minutes while the app is open.'
      : 'Manual — tap "Back Up Now" whenever you want to save a JSON backup.';
  };
  backupModeButtons.forEach(btn => btn.addEventListener('click', () => {
    setBackupMode(btn.dataset.mode);
    refreshBackupModeUI();
  }));
  refreshBackupModeUI();
  startAutoBackupTimer();

  document.getElementById('fileRestore').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.profile) saveProfile(data.profile);
      if (data.logs) saveLogs(data.logs);
      if (data.reviews) saveReviews(data.reviews);
      alert('Backup restored.');
      loadSetupForm();
      loadCheckinForm();
      renderDashboard();
      renderHistory();
      renderMeasureHistory();
      renderBodyFatHistory();
    } catch (err) {
      alert('Could not read that backup file.');
    }
    e.target.value = '';
  });
}

/* ---------------------------------------------------------------- */
/* Google Drive backup                                                  */
/* ---------------------------------------------------------------- */
let driveTokenClient = null;
let driveAccessToken = null;

function setDriveStatus(text) {
  const el = document.getElementById('driveStatus');
  if (el) el.textContent = text;
}

function driveConfigured() {
  return typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('YOUR_CLIENT_ID');
}

function initDrive() {
  const connectBtn = document.getElementById('btnDriveConnect');
  const syncBtn = document.getElementById('btnDriveSyncNow');

  if (!driveConfigured()) {
    setDriveStatus('Not set up yet — add your Google Client ID in config.js to enable Drive backup.');
    connectBtn.disabled = true;
    return;
  }

  connectBtn.addEventListener('click', () => connectDrive());
  syncBtn.addEventListener('click', () => {
    saveToDrive(true);
    if (localStorage.getItem('wft_lb_optin') === '1' && sbConfigured()) updateLeaderboard();
  });

  const tryInit = () => {
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      setDriveStatus('Waiting for Google sign-in to load (requires internet)…');
      return false;
    }
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (resp) => {
        if (resp.error) { setDriveStatus('Sign-in failed: ' + resp.error); return; }
        driveAccessToken = resp.access_token;
        localStorage.setItem('wft_drive_connected', '1');
        connectBtn.hidden = true;
        syncBtn.hidden = false;
        setDriveStatus('Connected. Syncing…');
        saveToDrive();
      },
    });
    if (localStorage.getItem('wft_drive_connected')) {
      connectBtn.hidden = true;
      syncBtn.hidden = false;
      setDriveStatus('Connected. Tap Backup now to sync.');
    } else {
      setDriveStatus('Not connected.');
    }
    return true;
  };

  if (!tryInit()) {
    window.addEventListener('load', () => setTimeout(tryInit, 800));
  }
}

function connectDrive() {
  if (!driveTokenClient) {
    alert('Google sign-in isn\'t available right now. Check your internet connection and try again.');
    return;
  }
  driveTokenClient.requestAccessToken({ prompt: 'consent' });
}

async function saveToDrive(manual) {
  if (!driveAccessToken) {
    const wasConnected = localStorage.getItem('wft_drive_connected');
    if (!wasConnected) {
      if (manual) alert('Not connected to Google Drive yet.');
      return;
    }
    if (!driveTokenClient) {
      if (manual) alert('Google sign-in isn\'t available right now. Check your internet connection.');
      return;
    }
    // Only reached from an explicit backup action (button tap or finishing a workout),
    // never automatically on page load — so a sign-in prompt here is expected.
    setDriveStatus('Reconnecting…');
    driveTokenClient.requestAccessToken({ prompt: '' });
    return;
  }
  setDriveStatus('Syncing…');
  const data = { profile: getProfile(), logs: getLogs(), reviews: getReviews(), savedAt: new Date().toISOString() };
  const body = JSON.stringify(data, null, 2);
  const fileId = localStorage.getItem('wft_drive_file_id');
  try {
    if (fileId) {
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${driveAccessToken}`, 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) throw new Error('upload failed: ' + res.status);
    } else {
      const boundary = 'wft_boundary_' + Date.now();
      const metadata = { name: 'winfinity-fitness-backup.json', mimeType: 'application/json' };
      const multipartBody =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { Authorization: `Bearer ${driveAccessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody,
      });
      if (!res.ok) throw new Error('create failed: ' + res.status);
      const json = await res.json();
      if (json.id) localStorage.setItem('wft_drive_file_id', json.id);
    }
    localStorage.setItem('wft_drive_last_backup', todayISO());
    setDriveStatus('Last synced ' + new Date().toLocaleTimeString());
    renderDashboard();
    activateNexusFastChat();
    autoSyncDriveBackupToNexus();
  } catch (e) {
    setDriveStatus('Sync failed — will retry on next save.');
  }
}

/* ---------------------------------------------------------------- */
/* Leaderboard (anonymous opt-in, Supabase-backed)                      */
/* ---------------------------------------------------------------- */
let sb = null;
function sbConfigured() {
  const hasCreds = typeof SUPABASE_URL === 'string' && SUPABASE_URL && !SUPABASE_URL.startsWith('YOUR_') &&
    typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith('YOUR_');
  if (!hasCreds) return false;
  if (!sb && window.supabase) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return !!sb;
}

const LB_ADJECTIVES = ['Swift', 'Neon', 'Silent', 'Blazing', 'Iron', 'Crimson', 'Frost', 'Turbo', 'Cosmic', 'Rapid'];
const LB_NOUNS = ['Falcon', 'Tiger', 'Comet', 'Wolf', 'Phoenix', 'Panther', 'Rocket', 'Viper', 'Eagle', 'Storm'];

function generateCodeName() {
  const a = LB_ADJECTIVES[Math.floor(Math.random() * LB_ADJECTIVES.length)];
  const n = LB_NOUNS[Math.floor(Math.random() * LB_NOUNS.length)];
  const num = Math.floor(Math.random() * 90 + 10);
  return `${a} ${n} ${num}`;
}
function generateShareKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function computeLeaderboardStats() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray();
  const kgNow = currentWeightKg(profile);
  const startKg = profile ? profile.startWeightKg : null;
  const progressKg = (kgNow != null && startKg != null) ? (kgNow - startKg) : null;
  const progressPct = (progressKg != null && startKg) ? round2((progressKg / startKg) * 100) : null;
  const steps = avgOfLastNDays(logsArr, 'steps', 7);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0,0,0,0);
  const volumeKg = logsArr.filter(l => parseISO(l.date) >= cutoff).reduce((sum, l) =>
    sum + (l.exercises || []).reduce((s, ex) =>
      s + ex.sets.filter(st => st.completed && st.weightKg != null && st.reps != null).reduce((ss, st) => ss + st.weightKg * st.reps, 0), 0), 0);

  const allRuns = logsArr.reduce((acc, l) => acc.concat((l.cardioSessions || []).filter(s => s.type === 'run')), []);
  const furthestRunKm = allRuns.length ? Math.max(...allRuns.map(s => s.distanceKm)) : null;
  const pacedRuns = allRuns.filter(s => s.distanceKm >= 1 && s.durationSec > 0);
  const fastestRunPaceSec = pacedRuns.length ? Math.min(...pacedRuns.map(s => s.durationSec / s.distanceKm)) : null;

  return {
    weight: kgNow != null ? round2(fromKg(kgNow, wu)) : null,
    weightUnit: wu,
    progress: progressKg != null ? round2(fromKg(progressKg, wu)) : null,
    progressPct,
    steps: steps != null ? round0(steps) : null,
    volume: round0(fromKg(volumeKg, wu)),
    volumeUnit: wu,
    furthestRunKm: furthestRunKm != null ? round2(furthestRunKm) : null,
    fastestRunPaceSec: fastestRunPaceSec != null ? Math.round(fastestRunPaceSec) : null,
  };
}

function effectiveLeaderboardName() {
  const profile = getProfile();
  const bioName = profile && profile.name && profile.name.trim();
  if (bioName) return bioName;
  if (!localStorage.getItem('wft_lb_fallback_name')) localStorage.setItem('wft_lb_fallback_name', generateCodeName());
  return localStorage.getItem('wft_lb_fallback_name');
}

function updateCodeNameHint() {
  const hint = document.getElementById('lbCodeNameHint');
  const optedIn = localStorage.getItem('wft_lb_optin') === '1';
  hint.textContent = optedIn ? `Sharing as "${effectiveLeaderboardName()}"` : 'Not sharing. Turn on to join the Nexus.';
}

async function pushLeaderboardEntry() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  const stats = computeLeaderboardStats();
  const { error } = await sb.rpc('upsert_leaderboard_entry', {
    p_share_key: shareKey,
    p_code_name: effectiveLeaderboardName(),
    p_weight: stats.weight,
    p_weight_unit: stats.weightUnit,
    p_weight_progress: stats.progress,
    p_weight_progress_pct: stats.progressPct,
    p_steps: stats.steps,
    p_volume_lifted: stats.volume,
    p_volume_unit: stats.volumeUnit,
  });
  if (error) throw error;
  try { await sb.rpc('set_public_id', { p_share_key: shareKey, p_public_id: getOrCreatePublicId() }); }
  catch (e) { /* best effort — group-chat invites just won't resolve until this succeeds */ }
  try {
    await sb.rpc('set_run_records', {
      p_share_key: shareKey,
      p_furthest_run_km: stats.furthestRunKm,
      p_fastest_run_pace_sec: stats.fastestRunPaceSec,
    });
  } catch (e) { /* best effort — Furthest/Fastest Run rankings just won't update until this succeeds */ }
}

async function autoSyncLeaderboardIfOptedIn() {
  if (!sbConfigured() || localStorage.getItem('wft_lb_optin') !== '1') return;
  try {
    await pushLeaderboardEntry();
    document.getElementById('nexusTotalUsers') && pullLeaderboard().then(renderNexusRankings).catch(() => {});
  } catch (e) { /* best effort — don't block the training flow on Nexus sync failure */ }
}

async function autoSyncDriveBackupToNexus() {
  if (!sbConfigured()) return;
  getOrCreateShareKey();
  try {
    await pushLeaderboardEntry();
    document.getElementById('nexusTotalUsers') && pullLeaderboard().then(renderNexusRankings).catch(() => {});
  } catch (e) { /* best effort — don't block the backup flow on Nexus sync failure */ }
}

async function pullLeaderboard() {
  const { data, error } = await sb.from('leaderboard')
    .select('code_name, public_id, weight, weight_unit, weight_progress, weight_progress_pct, steps, volume_lifted, volume_unit, furthest_run_km, fastest_run_pace_sec, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function removeFromLeaderboard() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  if (!shareKey || !sbConfigured()) return;
  try { await sb.rpc('delete_leaderboard_entry', { p_share_key: shareKey }); }
  catch (e) { /* best effort */ }
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}

const rankListExpanded = {};

// Keeps only each person's best-scoring row — a name that shows up more than
// once (re-installs, case differences, etc.) shouldn't crowd out other people
// with duplicate entries of the same person's other records.
function dedupeRankRows(rows, isBetter) {
  const bestByName = new Map();
  rows.forEach(r => {
    const key = (r.code_name || '').trim().toLowerCase();
    const existing = bestByName.get(key);
    if (!existing || isBetter(r, existing)) bestByName.set(key, r);
  });
  return Array.from(bestByName.values());
}

const rankListDataCache = {};

function renderRankList(containerId, rows, opts) {
  const container = document.getElementById(containerId);
  const expandBtn = document.querySelector(`.rank-expand-btn[data-target="${containerId}"]`);
  rankListDataCache[containerId] = { rows, opts };
  container.innerHTML = '';
  if (!rows.length) {
    container.innerHTML = '<p class="empty-note">No data yet.</p>';
    if (expandBtn) expandBtn.hidden = true;
    return;
  }
  const top10 = rows.slice(0, 10);
  const expanded = !!rankListExpanded[containerId];
  const visible = expanded ? top10 : top10.slice(0, 3);
  visible.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'rank-row' + (i === 0 ? ' is-top' : '');
    row.innerHTML = `<span class="rank-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="rank-name">${escapeHtml(r.code_name)}${r.public_id ? `<span class="rank-digital-id">${escapeHtml(r.public_id)}</span>` : ''}</span>
      <span class="rank-value">${opts.formatValue(r)}</span>`;
    container.appendChild(row);
  });
  if (expandBtn) {
    expandBtn.hidden = top10.length <= 3;
    expandBtn.textContent = expanded ? '⤡' : '⤢';
    expandBtn.title = expanded ? 'Show top 3' : `Show top ${top10.length}`;
    expandBtn.onclick = () => {
      rankListExpanded[containerId] = !expanded;
      renderRankList(containerId, rows, opts);
    };
  }
}

function renderNexusRankings(rows) {
  document.getElementById('lbEmptyNote').hidden = rows.length > 0;

  const ONLINE_WINDOW_MS = 5 * 60 * 1000;
  const onlineNow = rows.filter(r => r.updated_at && (Date.now() - new Date(r.updated_at).getTime()) < ONLINE_WINDOW_MS).length;
  document.getElementById('nexusTotalUsers').textContent = rows.length;
  document.getElementById('nexusOnlineUsers').textContent = onlineNow;

  const bySteps = dedupeRankRows(rows.filter(r => r.steps != null), (a, b) => a.steps > b.steps).sort((a, b) => b.steps - a.steps);
  renderRankList('lbStepsRanking', bySteps, { formatValue: r => r.steps >= 1000 ? (r.steps / 1000).toFixed(1) + 'k' : String(r.steps) });

  const byVolume = dedupeRankRows(rows.filter(r => r.volume_lifted != null), (a, b) => a.volume_lifted > b.volume_lifted).sort((a, b) => b.volume_lifted - a.volume_lifted);
  renderRankList('lbVolumeRanking', byVolume, { formatValue: r => round0(r.volume_lifted) + ' ' + (r.volume_unit || 'kg') });

  const byProgress = dedupeRankRows(rows.filter(r => r.weight_progress_pct != null), (a, b) => a.weight_progress_pct < b.weight_progress_pct).sort((a, b) => a.weight_progress_pct - b.weight_progress_pct);
  renderRankList('lbBioRanking', byProgress, { formatValue: r => (r.weight_progress_pct > 0 ? '+' : '') + r.weight_progress_pct + '%' });

  const byFurthestRun = dedupeRankRows(rows.filter(r => r.furthest_run_km != null), (a, b) => a.furthest_run_km > b.furthest_run_km).sort((a, b) => b.furthest_run_km - a.furthest_run_km);
  renderRankList('lbFurthestRunRanking', byFurthestRun, { formatValue: r => round2(r.furthest_run_km) + ' km' });

  const byFastestRun = dedupeRankRows(rows.filter(r => r.fastest_run_pace_sec != null), (a, b) => a.fastest_run_pace_sec < b.fastest_run_pace_sec).sort((a, b) => a.fastest_run_pace_sec - b.fastest_run_pace_sec);
  renderRankList('lbFastestRunRanking', byFastestRun, { formatValue: r => formatPaceSecPerUnit(r.fastest_run_pace_sec) + ' /km' });
}

let currentChatRoomId = localStorage.getItem('wft_chat_room') || null;

async function fetchChatMessages() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let q = sb.from('chat_messages').select('code_name, message, created_at').gte('created_at', cutoff);
  q = currentChatRoomId ? q.eq('room_id', currentChatRoomId) : q.is('room_id', null);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data || []).slice().reverse();
}

async function postChatMessage(text) {
  const trimmed = text.trim().slice(0, 280);
  if (!trimmed) return;
  const { error } = await sb.from('chat_messages').insert({
    code_name: effectiveLeaderboardName(),
    message: trimmed,
    room_id: currentChatRoomId || null,
  });
  if (error) throw error;
}

function getOrCreateShareKey() {
  if (!localStorage.getItem('wft_lb_share_key')) localStorage.setItem('wft_lb_share_key', generateShareKey());
  return localStorage.getItem('wft_lb_share_key');
}

const ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids look-alike mistakes
function generatePublicId() {
  let code = '';
  for (let i = 0; i < 6; i++) code += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return `WF-${code}`;
}
function getOrCreatePublicId() {
  if (!localStorage.getItem('wft_public_id')) localStorage.setItem('wft_public_id', generatePublicId());
  return localStorage.getItem('wft_public_id');
}

function initDigitalId() {
  document.getElementById('digitalIdValue').textContent = getOrCreatePublicId();
  document.getElementById('btnCopyDigitalId').addEventListener('click', async function () {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(getOrCreatePublicId());
      this.classList.add('is-copied');
      showRestToast('Digital ID copied!');
      setTimeout(() => this.classList.remove('is-copied'), 1500);
    } catch (e) { /* ignore */ }
  });
}

let chatRoomMeta = {}; // roomId -> { name, isDm, createdByKey, otherName }
let chatLastRead = {}; // roomId (or 'public') -> ISO timestamp
try { chatLastRead = JSON.parse(localStorage.getItem('wft_chat_last_read')) || {}; } catch (e) { chatLastRead = {}; }

async function refreshChatRooms() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  if (!shareKey || !sbConfigured()) { chatRoomMeta = {}; renderChatRoomOptions(); renderInvitesPopover([]); return; }
  try { await sb.rpc('cleanup_stale_solo_rooms'); } catch (e) { /* best effort, opportunistic */ }

  // Two plain queries instead of one embedded (chat_room_members -> chat_rooms)
  // select: the embedded/nested form can silently resolve a row's chat_rooms
  // to null (dropped with no error) right after a room is created, which was
  // making brand-new groups vanish from the room list. Plain .in() filtering
  // has no such failure mode.
  const { data: memberRows, error: memberErr } = await sb.from('chat_room_members')
    .select('status, room_id')
    .eq('share_key', shareKey);
  if (memberErr) { showRestToast('Could not load chat rooms: ' + memberErr.message); return; }
  const rows = memberRows || [];
  const roomIds = [...new Set(rows.map(r => r.room_id))];

  let roomsById = {};
  if (roomIds.length) {
    const { data: roomRows, error: roomErr } = await sb.from('chat_rooms')
      .select('id, name, is_dm, created_by_key')
      .in('id', roomIds);
    if (roomErr) { showRestToast('Could not load chat rooms: ' + roomErr.message); return; }
    (roomRows || []).forEach(r => { roomsById[r.id] = r; });
  }

  const joined = rows.filter(r => r.status === 'joined' && roomsById[r.room_id]);

  const dmRoomIds = joined.filter(r => roomsById[r.room_id].is_dm).map(r => r.room_id);
  const otherNameByRoom = {};
  if (dmRoomIds.length) {
    const { data: members } = await sb.from('chat_room_members')
      .select('room_id, share_key, code_name')
      .in('room_id', dmRoomIds);
    (members || []).forEach(m => {
      if (m.share_key !== shareKey) otherNameByRoom[m.room_id] = m.code_name;
    });
  }

  chatRoomMeta = {};
  joined.forEach(r => {
    const room = roomsById[r.room_id];
    chatRoomMeta[r.room_id] = {
      name: room.is_dm ? (otherNameByRoom[r.room_id] || room.name) : room.name,
      isDm: room.is_dm,
      createdByKey: room.created_by_key,
      joinedByMe: true,
    };
  });

  // Admin gets every group (never DMs) added to the room list even if they
  // never joined, so they can freely enter any group chat. Membership-only
  // actions (Leave/Invite/Members) stay gated on actually being a member —
  // see updateRoomActionButtons — this just makes the room selectable.
  if (isAdminLoggedIn()) {
    try {
      const { data: allGroups } = await sb.from('chat_rooms').select('id, name, created_by_key').eq('is_dm', false);
      (allGroups || []).forEach(g => {
        if (!chatRoomMeta[g.id]) {
          chatRoomMeta[g.id] = { name: g.name, isDm: false, createdByKey: g.created_by_key, joinedByMe: false };
        }
      });
    } catch (e) { /* best effort */ }
  }

  try { await checkUnreadMessages(dmRoomIds); } catch (e) { /* best effort — room list still renders without unread flags */ }
  renderChatRoomOptions();
  const invited = rows
    .filter(r => r.status === 'invited' && roomsById[r.room_id])
    .map(r => ({ roomId: r.room_id, roomName: roomsById[r.room_id].name }));
  renderInvitesPopover(invited);
}

function isNexusTabActive() {
  const btn = document.querySelector('.tab-btn[data-target="leaderboard"]');
  return !!(btn && btn.classList.contains('is-active'));
}

async function checkUnreadMessages(dmRoomIds) {
  const myName = effectiveLeaderboardName();
  const nexusActive = isNexusTabActive();
  let anyDmUnread = false;

  if (dmRoomIds.length) {
    const { data: msgs } = await sb.from('chat_messages')
      .select('room_id, code_name, created_at')
      .in('room_id', dmRoomIds)
      .order('created_at', { ascending: false });
    const latestByRoom = {};
    (msgs || []).forEach(m => { if (!latestByRoom[m.room_id]) latestByRoom[m.room_id] = m; });
    Object.keys(latestByRoom).forEach(roomId => {
      const m = latestByRoom[roomId];
      if (m.code_name === myName) return;
      // Currently-open DM while Nexus is on-screen counts as read immediately,
      // rather than flagging it and racing with a separate mark-read call.
      if (nexusActive && roomId === currentChatRoomId) {
        chatLastRead[roomId] = m.created_at;
        if (chatRoomMeta[roomId]) chatRoomMeta[roomId].unread = false;
        return;
      }
      const lastRead = chatLastRead[roomId];
      if (!lastRead || new Date(m.created_at) > new Date(lastRead)) {
        anyDmUnread = true;
        if (chatRoomMeta[roomId]) chatRoomMeta[roomId].unread = true;
      }
    });
    if (anyDmUnread) fireSystemNotification('Winfinity Tracker', 'You have a new direct message.');
  }

  let publicUnread = false;
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: publicMsgs } = await sb.from('chat_messages')
    .select('code_name, created_at')
    .is('room_id', null)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1);
  const latestPublic = (publicMsgs || [])[0];
  if (latestPublic && latestPublic.code_name !== myName) {
    if (nexusActive && !currentChatRoomId) {
      chatLastRead.public = latestPublic.created_at;
    } else {
      const lastRead = chatLastRead.public;
      if (!lastRead || new Date(latestPublic.created_at) > new Date(lastRead)) publicUnread = true;
    }
  }

  localStorage.setItem('wft_chat_last_read', JSON.stringify(chatLastRead));
  document.getElementById('tabDotDm').hidden = !anyDmUnread;
  document.getElementById('tabDotPublic').hidden = !publicUnread;
}

function markRoomRead(roomId) {
  chatLastRead[roomId] = new Date().toISOString();
  localStorage.setItem('wft_chat_last_read', JSON.stringify(chatLastRead));
  if (roomId === 'public') document.getElementById('tabDotPublic').hidden = true;
  else {
    if (chatRoomMeta[roomId]) chatRoomMeta[roomId].unread = false;
    const stillAnyDmUnread = Object.values(chatRoomMeta).some(m => m.isDm && m.unread);
    document.getElementById('tabDotDm').hidden = !stillAnyDmUnread;
  }
}

function updateRoomActionButtons(roomId) {
  const meta = roomId ? chatRoomMeta[roomId] : null;
  const shareKey = localStorage.getItem('wft_lb_share_key');
  document.getElementById('btnLeaveGroup').hidden = !(meta && meta.joinedByMe);
  document.getElementById('btnDeleteGroup').hidden = !(meta && !meta.isDm && meta.createdByKey === shareKey);
  document.getElementById('btnInviteGroup').hidden = !(meta && !meta.isDm);
  document.getElementById('btnRoomMembers').hidden = !(meta && !meta.isDm);
}

function renderChatRoomOptions() {
  const select = document.getElementById('chatRoomSelect');
  select.innerHTML = '<option value="">🌐 Public Chat</option>';
  Object.entries(chatRoomMeta)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([id, meta]) => {
      const opt = document.createElement('option');
      opt.value = id;
      const icon = meta.isDm ? '💬' : (meta.joinedByMe ? '👥' : '🛡️');
      const label = meta.isDm ? `DM: ${meta.name}` : meta.name;
      opt.textContent = `${icon} ${label}${meta.unread ? ' 🔴' : ''}`;
      select.appendChild(opt);
    });
  const stillJoined = currentChatRoomId && !!chatRoomMeta[currentChatRoomId];
  select.value = stillJoined ? currentChatRoomId : '';
  // Always resync the underlying JS variable to whatever the dropdown can
  // actually show — not just when the dropdown's *visible* value changes.
  // If a brand-new room wasn't found in this refresh (the exact bug this
  // was catching), the <select> falls back to the already-selected "Public
  // Chat" option, so its value never visibly changes even though
  // currentChatRoomId is still pointing at a room nothing can render —
  // silently redirecting every later message fetch to that dead room
  // while the UI still reads "Public Chat".
  if (!stillJoined) {
    currentChatRoomId = null;
    localStorage.removeItem('wft_chat_room');
  }
  updateRoomActionButtons(stillJoined ? currentChatRoomId : null);
}

function renderInvitesPopover(invitedRows) {
  const popover = document.getElementById('chatInvitesPopover');
  const badge = document.getElementById('chatBellBadge');
  badge.hidden = !invitedRows.length;
  badge.textContent = String(invitedRows.length);
  // Never force-close/blank the popover here — a background refresh (e.g. Sync to
  // Nexus) can call this while the user has it open, and yanking it away mid-tap
  // is exactly what made Accept/Decline feel broken. Only the bell button toggles
  // popover.hidden.
  popover.innerHTML = invitedRows.length
    ? invitedRows.map(r => `
      <div class="chat-invite-row">
        <span>🔔 Invited to "${escapeHtml(r.roomName)}"</span>
        <button type="button" class="btn btn--primary" data-accept-room="${r.roomId}">Accept</button>
        <button type="button" class="btn" data-decline-room="${r.roomId}">Decline</button>
      </div>
    `).join('')
    : '<p class="empty-note">No pending invites.</p>';
  popover.querySelectorAll('[data-accept-room]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const shareKey = localStorage.getItem('wft_lb_share_key');
      // .select() after the update so we get back the rows that were
      // actually changed — a plain update() reports "success" with zero
      // error even if the filter matched nothing, which would otherwise
      // look exactly like a stuck/unresponsive button.
      const roomId = btn.dataset.acceptRoom;
      const { data, error } = await sb.from('chat_room_members')
        .update({ status: 'joined' }).eq('room_id', roomId).eq('share_key', shareKey).select();
      if (error) { showRestToast('Could not accept invite: ' + error.message); btn.disabled = false; return; }
      if (!data || !data.length) {
        // Diagnostic: is there a row for this room at all (any share_key/status)?
        const { data: anyRows } = await sb.from('chat_room_members').select('share_key, status').eq('room_id', roomId);
        const detail = (anyRows && anyRows.length)
          ? `room has ${anyRows.length} member row(s), none for this share_key`
          : 'room has zero member rows';
        showRestToast(`Accept failed — room ${roomId.slice(0, 8)}…, key ${(shareKey || 'none').slice(0, 8)}…: ${detail}.`);
        btn.disabled = false;
        return;
      }
      showRestToast('Joined the group!');
      refreshChatRooms();
    });
  });
  popover.querySelectorAll('[data-decline-room]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const shareKey = localStorage.getItem('wft_lb_share_key');
      const { data, error } = await sb.from('chat_room_members')
        .delete().eq('room_id', btn.dataset.declineRoom).eq('share_key', shareKey).select();
      if (error) { showRestToast('Could not decline invite: ' + error.message); btn.disabled = false; return; }
      if (!data || !data.length) {
        showRestToast('Could not decline — no matching invite found. Try Refresh first.');
        btn.disabled = false;
        return;
      }
      showRestToast('Invite declined.');
      refreshChatRooms();
    });
  });
}

function renderChatMessages(messages) {
  const list = document.getElementById('lbChatList');
  list.innerHTML = '';
  if (!messages.length) {
    list.innerHTML = '<p class="empty-note">No messages yet. Say hi!</p>';
    return;
  }
  const myName = effectiveLeaderboardName();
  const inDm = currentChatRoomId && chatRoomMeta[currentChatRoomId] && chatRoomMeta[currentChatRoomId].isDm;
  messages.forEach(m => {
    const row = document.createElement('div');
    row.className = 'chat-row';
    const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const nameHtml = (!inDm && m.code_name !== myName)
      ? `<span class="chat-name chat-name-link" data-dm-name="${escapeHtml(m.code_name)}">${escapeHtml(m.code_name)}</span>`
      : `<span class="chat-name">${escapeHtml(m.code_name)}</span>`;
    row.innerHTML = `<span class="chat-time">[${time}]</span> ${nameHtml}: <span class="chat-msg">${escapeHtml(m.message)}</span>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-dm-name]').forEach(el => {
    el.addEventListener('click', e => openChatUserMenu(el.dataset.dmName, e.clientX, e.clientY));
  });
  list.scrollTop = list.scrollHeight;
}

async function startDM(otherName) {
  if (!sbConfigured()) return;
  const shareKey = getOrCreateShareKey();
  try {
    const { data, error } = await sb.rpc('start_dm_by_name', {
      p_my_key: shareKey,
      p_my_name: effectiveLeaderboardName(),
      p_other_name: otherName,
    });
    if (error) throw error;
    if (!data) { showRestToast(`Couldn't find "${otherName}" — they may not be synced to Nexus.`); return; }
    currentChatRoomId = data;
    localStorage.setItem('wft_chat_room', data);
    await refreshChatRooms();
    document.getElementById('chatRoomSelect').value = data;
    markRoomRead(data);
    updateRoomActionButtons(data);
    const messages = await fetchChatMessages();
    renderChatMessages(messages);
  } catch (e) { showRestToast('Could not start DM: ' + (e.message || 'check your connection')); }
}

/* ---- Tapping a name in chat: DM or invite to a group I created ---- */
let chatUserMenuTarget = null;

function closeChatUserMenu() {
  document.getElementById('chatUserMenu').hidden = true;
  document.getElementById('chatUserMenuGroups').hidden = true;
  document.getElementById('chatUserMenuMain').hidden = false;
}

function openChatUserMenu(name, x, y) {
  chatUserMenuTarget = name;
  const menu = document.getElementById('chatUserMenu');
  document.getElementById('chatUserMenuName').textContent = name;
  document.getElementById('chatUserMenuGroups').hidden = true;
  document.getElementById('chatUserMenuMain').hidden = false;
  menu.hidden = false;
  const menuWidth = 220;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 12)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 160)) + 'px';
}

function renderChatUserMenuGroups() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  const myGroups = Object.entries(chatRoomMeta).filter(([id, m]) => !m.isDm && m.createdByKey === shareKey);
  const container = document.getElementById('chatUserMenuGroups');
  container.innerHTML = myGroups.length
    ? myGroups.map(([id, m]) => `<button type="button" class="chat-room-menu-item" data-invite-room="${id}">${escapeHtml(m.name)}</button>`).join('')
    : '<p class="empty-note">You haven\'t created a group yet.</p>';
  container.querySelectorAll('[data-invite-room]').forEach(btn => {
    btn.addEventListener('click', () => inviteUserToRoom(chatUserMenuTarget, btn.dataset.inviteRoom));
  });
}

async function inviteUserToRoom(name, roomId) {
  closeChatUserMenu();
  if (!sbConfigured()) return;
  try {
    const { data: row, error: lookupErr } = await sb.from('leaderboard').select('public_id').eq('code_name', name).maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row || !row.public_id) { showRestToast(`Couldn't find a Digital ID for "${name}".`); return; }
    const shareKey = getOrCreateShareKey();
    const roomName = chatRoomMeta[roomId] ? chatRoomMeta[roomId].name : 'the group';
    const { error } = await sb.rpc('invite_to_chat_room', {
      p_room_id: roomId, p_inviter_key: shareKey, p_invitee_ids: [row.public_id],
    });
    if (error) throw error;
    showRestToast(`Invited ${name} to "${roomName}".`);
  } catch (e) { showRestToast('Could not send invite: ' + (e.message || 'check your connection')); }
}

async function copyChatUserDigitalId(name) {
  if (!sbConfigured()) return;
  try {
    const { data: row, error } = await sb.from('leaderboard').select('public_id').eq('code_name', name).maybeSingle();
    if (error) throw error;
    if (!row || !row.public_id) { showRestToast(`"${name}" doesn't have a Digital ID synced yet.`); return; }
    if (!navigator.clipboard) { showRestToast(`Digital ID: ${row.public_id}`); return; }
    await navigator.clipboard.writeText(row.public_id);
    showRestToast(`Copied ${name}'s Digital ID!`);
  } catch (e) { showRestToast('Could not copy Digital ID: ' + (e.message || 'check your connection')); }
}

function initChatUserMenu() {
  document.getElementById('btnChatUserDm').addEventListener('click', () => {
    const name = chatUserMenuTarget;
    closeChatUserMenu();
    startDM(name);
  });
  document.getElementById('btnChatUserInvite').addEventListener('click', () => {
    document.getElementById('chatUserMenuMain').hidden = true;
    renderChatUserMenuGroups();
    document.getElementById('chatUserMenuGroups').hidden = false;
  });
  document.getElementById('btnChatUserCopyId').addEventListener('click', () => {
    const name = chatUserMenuTarget;
    closeChatUserMenu();
    copyChatUserDigitalId(name);
  });
  document.addEventListener('click', e => {
    const menu = document.getElementById('chatUserMenu');
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-dm-name]')) closeChatUserMenu();
  });
}

/* ---- Group members panel (creator can kick) ---- */
async function renderRoomMembers() {
  const list = document.getElementById('roomMembersList');
  if (!currentChatRoomId || !sbConfigured()) { list.innerHTML = ''; return; }
  const shareKey = localStorage.getItem('wft_lb_share_key');
  const meta = chatRoomMeta[currentChatRoomId];
  const isCreator = !!(meta && meta.createdByKey === shareKey);
  list.innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    const { data, error } = await sb.from('chat_room_members')
      .select('share_key, code_name')
      .eq('room_id', currentChatRoomId)
      .eq('status', 'joined');
    if (error) throw error;
    const members = data || [];
    list.innerHTML = members.length
      ? members.map(m => `
        <div class="chat-invite-row">
          <span>${escapeHtml(m.code_name)}${m.share_key === shareKey ? ' (you)' : ''}</span>
          ${isCreator && m.share_key !== shareKey ? `<button type="button" class="btn" data-kick-key="${m.share_key}">Kick</button>` : ''}
        </div>
      `).join('')
      : '<p class="empty-note">No members yet.</p>';
    list.querySelectorAll('[data-kick-key]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this member from the group?')) return;
        btn.disabled = true;
        try {
          const { error: kickErr } = await sb.rpc('kick_chat_room_member', {
            p_room_id: currentChatRoomId, p_requester_key: shareKey, p_target_share_key: btn.dataset.kickKey,
          });
          if (kickErr) throw kickErr;
          showRestToast('Member removed.');
          renderRoomMembers();
        } catch (e) { showRestToast('Could not remove member: ' + (e.message || '')); btn.disabled = false; }
      });
    });
  } catch (e) { list.innerHTML = '<p class="empty-note">Could not load members.</p>'; }
}

async function updateLeaderboard() {
  const note = document.getElementById('lbSaveNote');
  note.textContent = 'Syncing…';
  try {
    if (localStorage.getItem('wft_lb_optin') === '1') await pushLeaderboardEntry();
    const rows = await pullLeaderboard();
    renderNexusRankings(rows);
    await refreshChatRooms();
    const messages = await fetchChatMessages();
    renderChatMessages(messages);
    note.textContent = 'Synced ' + new Date().toLocaleTimeString();
  } catch (e) {
    note.textContent = 'Sync failed: ' + (e.message || 'check your connection');
  }
}

/* ---------------------------------------------------------------- */
/* Nexus announcement (single admin, verified entirely server-side —    */
/* the credentials never ship in this file or config.js)               */
/* ---------------------------------------------------------------- */
// Kept in localStorage on this device only, so the admin stays logged in
// across reloads/updates until they explicitly log out — never shipped in
// app.js/index.html/config.js, so it's still invisible to anyone just
// viewing page source. Every write is still re-verified server-side by the
// verify_admin_login / set_announcement Supabase RPCs regardless.
let adminSession = { digitalId: null, password: null };
try {
  const savedAdmin = JSON.parse(localStorage.getItem('wft_admin_session'));
  if (savedAdmin && savedAdmin.digitalId && savedAdmin.password) adminSession = savedAdmin;
} catch (e) { /* ignore malformed/missing saved session */ }
let currentAnnouncementText = '';

function isAdminLoggedIn() { return !!adminSession.password; }

// Two identical copies laid out side by side, animated -50% and looped —
// speed is set from the measured text width so it always scrolls at a
// constant pace instead of a fixed duration that would race short messages
// and crawl through long ones.
function setMarqueeText(trackId, text) {
  const track = document.getElementById(trackId);
  if (!track) return;
  track.querySelectorAll('.announcement-marquee-text').forEach(span => { span.textContent = text; });
  const singleWidth = track.children[0] ? track.children[0].getBoundingClientRect().width : 0;
  const pxPerSecond = 55;
  track.style.animationDuration = Math.max(6, singleWidth / pxPerSecond) + 's';
}

function renderAnnouncement(message) {
  currentAnnouncementText = message || '';
  setMarqueeText('announcementMarquee', currentAnnouncementText || 'No announcements yet.');

  // Top-of-page strip (under the header, above every tab): only exists at
  // all when there's a real announcement — no placeholder text, no empty
  // strip taking up space when there's nothing to show.
  const globalStrip = document.getElementById('globalAnnouncementStrip');
  if (globalStrip) {
    globalStrip.hidden = !currentAnnouncementText;
    if (currentAnnouncementText) setMarqueeText('globalAnnouncementMarquee', currentAnnouncementText);
  }
}

async function loadAnnouncement() {
  if (!sbConfigured()) return;
  try {
    const { data, error } = await sb.from('announcements').select('message').eq('id', 1).maybeSingle();
    if (error) throw error;
    renderAnnouncement(data && data.message);
  } catch (e) { showRestToast('Could not load announcement: ' + (e.message || 'check your connection')); }
}

function refreshAnnouncementMenuState() {
  const loggedIn = isAdminLoggedIn();
  document.getElementById('btnAdminLogin').hidden = loggedIn;
  document.getElementById('btnAdminPost').hidden = !loggedIn;
  document.getElementById('btnAdminAssignTargets').hidden = !loggedIn;
  document.getElementById('btnAdminLogout').hidden = !loggedIn;
}

function initAnnouncementWidget() {
  const menuBtn = document.getElementById('btnAnnouncementMenu');
  const menu = document.getElementById('announcementMenu');
  refreshAnnouncementMenuState();

  menuBtn.addEventListener('click', () => { menu.hidden = !menu.hidden; });
  document.addEventListener('click', e => {
    if (!menu.hidden && !e.target.closest('.announcement-menu-wrap')) menu.hidden = true;
  });

  document.getElementById('btnAdminLogin').addEventListener('click', () => {
    menu.hidden = true;
    document.getElementById('adminLoginNote').textContent = '';
    document.getElementById('adminLoginId').value = '';
    document.getElementById('adminLoginPassword').value = '';
    document.getElementById('adminLoginOverlay').hidden = false;
  });
  document.getElementById('btnAdminLogout').addEventListener('click', () => {
    adminSession = { digitalId: null, password: null };
    localStorage.removeItem('wft_admin_session');
    menu.hidden = true;
    refreshAnnouncementMenuState();
    refreshChatRooms();
    showRestToast('Logged out of admin.');
  });
  document.getElementById('btnAdminPost').addEventListener('click', () => {
    menu.hidden = true;
    document.getElementById('adminPostText').value = currentAnnouncementText;
    document.getElementById('adminPostNote').textContent = '';
    document.getElementById('adminPostOverlay').hidden = false;
  });
  document.getElementById('btnAdminAssignTargets').addEventListener('click', () => {
    menu.hidden = true;
    ['adminAssignTargetId', 'adminAssignCalorie', 'adminAssignSteps', 'adminAssignWorkouts', 'adminAssignRefeedCalories', 'adminAssignRefeedStart', 'adminAssignRefeedEnd'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('adminAssignTargetsNote').textContent = '';
    document.getElementById('adminAssignTargetsOverlay').hidden = false;
  });

  const loginOverlay = document.getElementById('adminLoginOverlay');
  document.getElementById('btnCloseAdminLogin').addEventListener('click', () => { loginOverlay.hidden = true; });
  loginOverlay.addEventListener('click', e => { if (e.target === loginOverlay) loginOverlay.hidden = true; });

  document.getElementById('btnAdminLoginSubmit').addEventListener('click', async () => {
    const id = document.getElementById('adminLoginId').value.trim();
    const pw = document.getElementById('adminLoginPassword').value;
    const noteEl = document.getElementById('adminLoginNote');
    if (!id || !pw) { noteEl.textContent = 'Enter both Digital ID and password.'; return; }
    if (!sbConfigured()) { noteEl.textContent = 'Not available offline.'; return; }
    noteEl.textContent = 'Checking…';
    try {
      const { data, error } = await sb.rpc('verify_admin_login', { p_digital_id: id, p_password: pw });
      if (error) throw error;
      if (data === true) {
        adminSession = { digitalId: id, password: pw };
        localStorage.setItem('wft_admin_session', JSON.stringify(adminSession));
        loginOverlay.hidden = true;
        refreshAnnouncementMenuState();
        refreshChatRooms();
        showRestToast('Admin unlocked.');
      } else {
        noteEl.textContent = 'Incorrect Digital ID or password.';
      }
    } catch (e) {
      noteEl.textContent = 'Login failed — try again.';
    }
  });

  const postOverlay = document.getElementById('adminPostOverlay');
  document.getElementById('btnCloseAdminPost').addEventListener('click', () => { postOverlay.hidden = true; });
  postOverlay.addEventListener('click', e => { if (e.target === postOverlay) postOverlay.hidden = true; });

  document.getElementById('btnAdminPostSubmit').addEventListener('click', async () => {
    const noteEl = document.getElementById('adminPostNote');
    if (!isAdminLoggedIn()) { noteEl.textContent = 'Not logged in.'; return; }
    const message = document.getElementById('adminPostText').value.trim();
    noteEl.textContent = 'Posting…';
    try {
      const { error } = await sb.rpc('set_announcement', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_message: message,
      });
      if (error) throw error;
      renderAnnouncement(message);
      postOverlay.hidden = true;
      showRestToast('Announcement posted.');
    } catch (e) {
      noteEl.textContent = 'Failed to post — try again.';
    }
  });

  const assignOverlay = document.getElementById('adminAssignTargetsOverlay');
  document.getElementById('btnCloseAdminAssignTargets').addEventListener('click', () => { assignOverlay.hidden = true; });
  assignOverlay.addEventListener('click', e => { if (e.target === assignOverlay) assignOverlay.hidden = true; });

  document.getElementById('btnAdminAssignTargetsSubmit').addEventListener('click', async () => {
    const noteEl = document.getElementById('adminAssignTargetsNote');
    if (!isAdminLoggedIn()) { noteEl.textContent = 'Not logged in.'; return; }
    const targetId = document.getElementById('adminAssignTargetId').value.trim();
    if (!targetId) { noteEl.textContent = "Enter the user's Digital ID."; return; }
    const refeedStart = document.getElementById('adminAssignRefeedStart').value || null;
    const refeedEnd = document.getElementById('adminAssignRefeedEnd').value || null;
    if (refeedStart && refeedEnd && refeedStart > refeedEnd) {
      noteEl.textContent = 'Refeed start date must be on or before the end date.';
      return;
    }
    noteEl.textContent = 'Assigning…';
    try {
      const { error } = await sb.rpc('assign_targets', {
        p_admin_digital_id: adminSession.digitalId,
        p_admin_password: adminSession.password,
        p_target_digital_id: targetId,
        p_calorie_target: parseIntOrNull(document.getElementById('adminAssignCalorie').value),
        p_step_goal: parseIntOrNull(document.getElementById('adminAssignSteps').value),
        p_workouts_per_week: parseIntOrNull(document.getElementById('adminAssignWorkouts').value),
        p_refeed_calories: parseIntOrNull(document.getElementById('adminAssignRefeedCalories').value),
        p_refeed_start: refeedStart,
        p_refeed_end: refeedEnd,
      });
      if (error) throw error;
      assignOverlay.hidden = true;
      showRestToast(`Targets assigned to ${targetId}.`);
    } catch (e) {
      noteEl.textContent = (e.message && e.message.includes('No user found'))
        ? 'No user found with that Digital ID.'
        : 'Failed to assign — try again.';
    }
  });

  loadAnnouncement();
}

function initLeaderboard() {
  const optInEl = document.getElementById('lbOptIn');
  optInEl.checked = localStorage.getItem('wft_lb_optin') === '1';
  updateCodeNameHint();

  document.querySelectorAll('.rank-share-btn').forEach(btn => {
    btn.addEventListener('click', () => shareLeaderboardCard(btn.dataset.target, btn.dataset.title));
  });

  optInEl.addEventListener('change', () => {
    if (optInEl.checked) {
      getOrCreateShareKey();
      localStorage.setItem('wft_lb_optin', '1');
    } else {
      localStorage.setItem('wft_lb_optin', '0');
      removeFromLeaderboard();
    }
    updateCodeNameHint();
  });

  document.getElementById('btnLbUpdate').addEventListener('click', () => {
    updateLeaderboard();
    if (localStorage.getItem('wft_drive_connected') && driveConfigured()) saveToDrive(false);
  });

  document.getElementById('btnLbChatSend').addEventListener('click', async () => {
    const input = document.getElementById('lbChatInput');
    if (!input.value.trim() || !sbConfigured()) return;
    try {
      await postChatMessage(input.value);
      input.value = '';
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { /* best effort */ }
  });
  document.getElementById('lbChatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnLbChatSend').click();
  });

  document.getElementById('btnChatRefresh').addEventListener('click', async () => {
    const refreshBtn = document.getElementById('btnChatRefresh');
    refreshBtn.disabled = true;
    try {
      // refreshChatRooms() always rebuilds chatRoomMeta and the invites
      // popover from a fresh query — nothing is patched in place — so a
      // room that got deleted (or an invite that got accepted/declined,
      // here or on another device) since the last refresh is dropped
      // automatically, and anything newly joined/created appears. This
      // just makes that visible with a concrete summary instead of the
      // button appearing to silently do nothing.
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
      const roomCount = Object.keys(chatRoomMeta).length;
      const inviteCount = parseInt(document.getElementById('chatBellBadge').textContent, 10) || 0;
      showRestToast(`Refreshed — ${roomCount} room${roomCount !== 1 ? 's' : ''}, ${inviteCount} pending invite${inviteCount !== 1 ? 's' : ''}.`);
    } catch (e) { showRestToast('Refresh failed: ' + (e.message || 'check your connection')); }
    refreshBtn.disabled = false;
  });

  document.getElementById('btnChatExpand').addEventListener('click', () => {
    const card = document.getElementById('chatCard');
    const btn = document.getElementById('btnChatExpand');
    const expanded = card.classList.toggle('is-expanded');
    btn.textContent = expanded ? '⤡' : '⤢';
    btn.title = expanded ? 'Minimize' : 'Expand';
    btn.setAttribute('aria-label', expanded ? 'Minimize chat' : 'Expand chat');
    if (expanded) document.getElementById('lbChatList').scrollTop = document.getElementById('lbChatList').scrollHeight;
  });

  if (!sbConfigured()) {
    document.getElementById('lbSaveNote').textContent = 'Nexus not set up yet.';
    optInEl.disabled = true;
    document.getElementById('btnLbUpdate').disabled = true;
    document.getElementById('btnLbChatSend').disabled = true;
  }

  initGroupChat();
}

let pendingInviteIds = [];
let pendingInviteToGroupIds = [];

function initGroupChat() {
  const select = document.getElementById('chatRoomSelect');
  select.addEventListener('change', async () => {
    currentChatRoomId = select.value || null;
    if (currentChatRoomId) {
      localStorage.setItem('wft_chat_room', currentChatRoomId);
      if (chatRoomMeta[currentChatRoomId] && chatRoomMeta[currentChatRoomId].isDm) markRoomRead(currentChatRoomId);
    } else {
      localStorage.removeItem('wft_chat_room');
      markRoomRead('public');
    }
    updateRoomActionButtons(currentChatRoomId);
    if (!sbConfigured()) return;
    try {
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { /* best effort */ }
  });

  document.getElementById('btnLeaveGroup').addEventListener('click', async () => {
    if (!currentChatRoomId || !sbConfigured()) return;
    if (!confirm('Leave this chat?')) return;
    const shareKey = localStorage.getItem('wft_lb_share_key');
    try {
      const { error } = await sb.rpc('leave_chat_room', { p_room_id: currentChatRoomId, p_share_key: shareKey });
      if (error) { showRestToast('Could not leave: ' + error.message); return; }
      currentChatRoomId = null;
      localStorage.removeItem('wft_chat_room');
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { showRestToast('Could not leave: ' + (e.message || 'check your connection')); }
  });

  document.getElementById('btnDeleteGroup').addEventListener('click', async () => {
    if (!currentChatRoomId || !sbConfigured()) return;
    if (!confirm('Delete this group for everyone? This cannot be undone.')) return;
    const shareKey = localStorage.getItem('wft_lb_share_key');
    try {
      const { error } = await sb.rpc('delete_chat_room', { p_room_id: currentChatRoomId, p_requester_key: shareKey });
      if (error) { showRestToast('Could not delete group: ' + error.message); return; }
      currentChatRoomId = null;
      localStorage.removeItem('wft_chat_room');
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { showRestToast('Could not delete group.'); }
  });

  const invitePanel = document.getElementById('inviteGroupPanel');
  document.getElementById('btnInviteGroup').addEventListener('click', () => {
    invitePanel.hidden = !invitePanel.hidden;
    if (!invitePanel.hidden) { pendingInviteToGroupIds = []; renderInviteToGroupChips(); }
  });
  document.getElementById('btnCancelInviteGroup').addEventListener('click', () => {
    invitePanel.hidden = true;
    document.getElementById('inviteGroupInput').value = '';
    pendingInviteToGroupIds = [];
    renderInviteToGroupChips();
  });

  const membersPanel = document.getElementById('roomMembersPanel');
  document.getElementById('btnRoomMembers').addEventListener('click', () => {
    membersPanel.hidden = !membersPanel.hidden;
    if (!membersPanel.hidden) renderRoomMembers();
  });
  document.getElementById('btnCloseRoomMembers').addEventListener('click', () => { membersPanel.hidden = true; });

  initChatUserMenu();

  const addInviteeToGroup = () => {
    const input = document.getElementById('inviteGroupInput');
    const id = input.value.trim().toUpperCase();
    if (id && !pendingInviteToGroupIds.includes(id)) pendingInviteToGroupIds.push(id);
    input.value = '';
    renderInviteToGroupChips();
  };
  document.getElementById('btnAddInviteGroup').addEventListener('click', addInviteeToGroup);
  document.getElementById('inviteGroupInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addInviteeToGroup(); }
  });

  document.getElementById('btnSendInvites').addEventListener('click', async () => {
    const note = document.getElementById('inviteGroupNote');
    if (!currentChatRoomId) return;
    if (!pendingInviteToGroupIds.length) { note.textContent = 'Add at least one Digital ID.'; return; }
    if (!sbConfigured()) { note.textContent = 'Nexus not set up yet.'; return; }
    const shareKey = getOrCreateShareKey();
    note.textContent = 'Sending…';
    try {
      const { error } = await sb.rpc('invite_to_chat_room', {
        p_room_id: currentChatRoomId,
        p_inviter_key: shareKey,
        p_invitee_ids: pendingInviteToGroupIds,
      });
      if (error) throw error;
      invitePanel.hidden = true;
      pendingInviteToGroupIds = [];
      renderInviteToGroupChips();
      note.textContent = '';
      showRestToast('Invites sent!');
    } catch (e) { note.textContent = 'Could not send invites: ' + (e.message || 'check your connection'); }
  });

  const bellBtn = document.getElementById('btnChatInvites');
  const popover = document.getElementById('chatInvitesPopover');
  bellBtn.addEventListener('click', () => { popover.hidden = !popover.hidden; });
  document.addEventListener('click', e => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== bellBtn && !bellBtn.contains(e.target)) popover.hidden = true;
  });

  const roomMenuBtn = document.getElementById('btnChatRoomMenu');
  const roomMenu = document.getElementById('chatRoomMenu');
  roomMenuBtn.addEventListener('click', () => { roomMenu.hidden = !roomMenu.hidden; });
  roomMenu.querySelectorAll('.chat-room-menu-item').forEach(item => {
    item.addEventListener('click', () => { roomMenu.hidden = true; });
  });
  document.addEventListener('click', e => {
    if (!roomMenu.hidden && !roomMenu.contains(e.target) && e.target !== roomMenuBtn && !roomMenuBtn.contains(e.target)) roomMenu.hidden = true;
  });

  const panel = document.getElementById('chatNewGroupPanel');
  document.getElementById('btnNewGroup').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { pendingInviteIds = []; renderInviteChips(); }
  });
  document.getElementById('btnCancelGroup').addEventListener('click', () => {
    panel.hidden = true;
    document.getElementById('newGroupName').value = '';
    document.getElementById('newGroupInviteInput').value = '';
    pendingInviteIds = [];
    renderInviteChips();
  });

  const addInvitee = () => {
    const input = document.getElementById('newGroupInviteInput');
    const id = input.value.trim().toUpperCase();
    if (id && !pendingInviteIds.includes(id)) pendingInviteIds.push(id);
    input.value = '';
    renderInviteChips();
  };
  document.getElementById('btnAddInvitee').addEventListener('click', addInvitee);
  document.getElementById('newGroupInviteInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addInvitee(); }
  });

  document.getElementById('btnCreateGroup').addEventListener('click', async () => {
    const name = document.getElementById('newGroupName').value.trim();
    const note = document.getElementById('newGroupNote');
    if (!name) { note.textContent = 'Enter a group name.'; return; }
    if (!sbConfigured()) { note.textContent = 'Nexus not set up yet.'; return; }
    const shareKey = getOrCreateShareKey();
    note.textContent = 'Creating…';
    try {
      const { data, error } = await sb.rpc('create_chat_room', {
        p_name: name,
        p_creator_key: shareKey,
        p_creator_name: effectiveLeaderboardName(),
        p_invitee_ids: pendingInviteIds,
      });
      if (error) throw error;
      panel.hidden = true;
      document.getElementById('newGroupName').value = '';
      pendingInviteIds = [];
      renderInviteChips();
      note.textContent = '';
      currentChatRoomId = data;
      localStorage.setItem('wft_chat_room', data);
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { note.textContent = 'Could not create group: ' + (e.message || 'check your connection'); }
  });
}

function renderInviteChips() {
  const container = document.getElementById('newGroupInviteChips');
  container.innerHTML = pendingInviteIds.map(id => `
    <span class="invite-chip">${escapeHtml(id)}<button type="button" data-remove-id="${escapeHtml(id)}" aria-label="Remove">✕</button></span>
  `).join('');
  container.querySelectorAll('[data-remove-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingInviteIds = pendingInviteIds.filter(id => id !== btn.dataset.removeId);
      renderInviteChips();
    });
  });
}

function renderInviteToGroupChips() {
  const container = document.getElementById('inviteGroupChips');
  container.innerHTML = pendingInviteToGroupIds.map(id => `
    <span class="invite-chip">${escapeHtml(id)}<button type="button" data-remove-id="${escapeHtml(id)}" aria-label="Remove">✕</button></span>
  `).join('');
  container.querySelectorAll('[data-remove-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingInviteToGroupIds = pendingInviteToGroupIds.filter(id => id !== btn.dataset.removeId);
      renderInviteToGroupChips();
    });
  });
}

/* ---------------------------------------------------------------- */
/* Onboarding (first run — borrows the real Bio/DNA profile form)      */
/* ---------------------------------------------------------------- */
function initOnboarding(onComplete) {
  if (getProfile()) { if (onComplete) onComplete(); return; }

  const overlay = document.getElementById('onboardingOverlay');
  const mount = document.getElementById('onboardingFormMount');
  const form = document.getElementById('setupForm');
  const originalParent = form.parentElement;
  const originalNextSibling = form.nextSibling;

  mount.appendChild(form);
  overlay.hidden = false;

  form.addEventListener('submit', () => {
    setTimeout(() => {
      const name = document.getElementById('setupName').value.trim();
      const age = document.getElementById('setupAge').value;
      const startWeight = document.getElementById('setupStartWeight').value;
      const heightOk = document.getElementById('heightCmField').hidden
        ? document.getElementById('setupHeightFt').value
        : document.getElementById('setupHeightCm').value;
      if (!name || !age || !startWeight || !heightOk) {
        alert('Please fill in at least your name, age, height, and starting weight to continue.');
        return;
      }
      if (originalNextSibling) originalParent.insertBefore(form, originalNextSibling);
      else originalParent.appendChild(form);
      overlay.hidden = true;
      if (onComplete) onComplete();
    }, 0);
  });
}

/* ---------------------------------------------------------------- */
/* Beta lock                                                            */
/* ---------------------------------------------------------------- */
const BETA_END_DATE = new Date(2026, 6, 31, 23, 59, 59); // end of day, July 31, 2026

function initBetaLock() {
  if (Date.now() < BETA_END_DATE.getTime()) return;

  document.getElementById('lockOverlay').hidden = false;
  document.getElementById('btnLockExportCSV').addEventListener('click', () => exportCSV(sortedLogsArray(), 'fitness-log-all'));
  document.getElementById('btnLockExportBackup').addEventListener('click', downloadBackupJSON);
}

/* ---------------------------------------------------------------- */
/* Review gate (honor system, unverified — see conversation notes)     */
/* ---------------------------------------------------------------- */
function initReviewGate(onComplete) {
  if (!document.getElementById('lockOverlay').hidden) return; // beta already ended, skip

  if (localStorage.getItem('wft_review_confirmed')) {
    if (onComplete) onComplete();
    return;
  }

  const overlay = document.getElementById('reviewGateOverlay');
  overlay.hidden = false;
  document.getElementById('btnReviewConfirm').addEventListener('click', () => {
    localStorage.setItem('wft_review_confirmed', '1');
    overlay.hidden = true;
    if (onComplete) onComplete();
  });
}

/* ---------------------------------------------------------------- */
/* Consent gate (Privacy Policy + Terms of Service clickwrap)         */
/* ---------------------------------------------------------------- */
function initConsentGate() {
  if (localStorage.getItem('wft_consent_agreed')) return;
  if (!document.getElementById('lockOverlay').hidden) return; // beta already ended, skip

  const overlay = document.getElementById('consentGateOverlay');
  const checkbox = document.getElementById('consentCheckbox');
  const agreeBtn = document.getElementById('btnConsentAgree');
  overlay.hidden = false;

  checkbox.addEventListener('change', () => { agreeBtn.disabled = !checkbox.checked; });
  document.getElementById('btnConsentViewPrivacy').addEventListener('click', () => { document.getElementById('privacyOverlay').hidden = false; });
  document.getElementById('btnConsentViewTerms').addEventListener('click', () => { document.getElementById('termsOverlay').hidden = false; });
  agreeBtn.addEventListener('click', () => {
    if (!checkbox.checked) return;
    localStorage.setItem('wft_consent_agreed', '1');
    localStorage.setItem('wft_consent_agreed_at', new Date().toISOString());
    overlay.hidden = true;
  });
}

/* ---------------------------------------------------------------- */
/* Theme toggle                                                         */
/* ---------------------------------------------------------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeIcon').textContent = theme === 'light' ? '☀️' : '🌙';
  document.getElementById('themeToggle').checked = theme === 'light';
  localStorage.setItem('wft_theme', theme);
}

function initThemeToggle() {
  applyTheme(localStorage.getItem('wft_theme') || 'dark');
  document.getElementById('themeToggle').addEventListener('change', e => {
    applyTheme(e.target.checked ? 'light' : 'dark');
  });
}
initThemeToggle();

/* ---------------------------------------------------------------- */
/* Skin (theme pack) selector — layered on top of the dark/light toggle */
/* above via a separate [data-skin] attribute, so any skin can still be */
/* viewed in either light or dark mode.                                 */
/* ---------------------------------------------------------------- */
function applySkin(skin) {
  document.documentElement.setAttribute('data-skin', skin);
  document.getElementById('skinSelect').value = skin;
  localStorage.setItem('wft_skin', skin);
}

function initSkinSelector() {
  applySkin(localStorage.getItem('wft_skin') || 'default');
  document.getElementById('skinSelect').addEventListener('change', e => {
    applySkin(e.target.value);
  });
}
initSkinSelector();

/* ---------------------------------------------------------------- */
/* Custom background image (Settings)                                  */
/* ---------------------------------------------------------------- */
const BG_SETTINGS_DEFAULT = { mode: 'cover', blur: 0, dim: 0, transparency: 0, widgetFill: 0, cropX: 50, cropY: 50 };

function getBgImageData() {
  try { return JSON.parse(localStorage.getItem('wft_bg_image')); } catch (e) { return null; }
}
function getBgSettings() {
  try { return Object.assign({}, BG_SETTINGS_DEFAULT, JSON.parse(localStorage.getItem('wft_bg_settings')) || {}); }
  catch (e) { return Object.assign({}, BG_SETTINGS_DEFAULT); }
}
function saveBgSettings(s) { localStorage.setItem('wft_bg_settings', JSON.stringify(s)); }

// Resizes to a size that's plenty sharp for a phone screen (no point storing
// a 12MP photo when the display it's shown on is a few hundred px wide) and
// compresses to JPEG, keeping localStorage usage reasonable. Also samples a
// 1x1 downscale of the result to get an average color — used to tint the
// layer behind the image so it "blends" instead of sitting on a mismatched
// flat background when blur/transparency/tiling reveal the edges.
function resizeAndCompressImage(file) {
  return new Promise((resolve, reject) => {
    const MAX_DIM = 1440;
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);

        const swatch = document.createElement('canvas');
        swatch.width = 1; swatch.height = 1;
        const swatchCtx = swatch.getContext('2d');
        swatchCtx.drawImage(canvas, 0, 0, 1, 1);
        const [r, g, b] = swatchCtx.getImageData(0, 0, 1, 1).data;

        resolve({ dataUrl, dominantColor: `rgb(${r}, ${g}, ${b})` });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function applyCustomBg() {
  const imgData = getBgImageData();
  const layer = document.getElementById('customBgLayer');
  const imageEl = document.getElementById('customBgImage');
  const overlayEl = document.getElementById('customBgOverlay');

  // Widget Box Fill Transparency applies regardless of whether a background
  // photo is set — it's a general "let widgets go see-through" control, not
  // strictly tied to having an image (works fine over the plain page
  // pattern too). Slider convention matches Blur/Dim/Transparency above:
  // 0 = no effect (fully opaque, unchanged), 100 = fully transparent —
  // color-mix() wants the OPPOSITE (how much fill to keep), hence 100-x.
  const widgetFill = getBgSettings().widgetFill;
  document.documentElement.style.setProperty('--widget-fill-pct', (100 - widgetFill) + '%');

  if (!imgData || !imgData.dataUrl) {
    layer.hidden = true;
    document.body.classList.remove('has-custom-bg');
    return;
  }
  const s = getBgSettings();
  layer.hidden = false;
  document.body.classList.add('has-custom-bg');
  layer.style.backgroundColor = imgData.dominantColor || '';
  imageEl.style.backgroundImage = `url(${imgData.dataUrl})`;
  if (s.mode === 'tile') {
    imageEl.style.backgroundSize = 'auto';
    imageEl.style.backgroundRepeat = 'repeat';
    imageEl.style.backgroundPosition = '0 0';
  } else if (s.mode === 'contain') {
    imageEl.style.backgroundSize = 'contain';
    imageEl.style.backgroundRepeat = 'no-repeat';
    imageEl.style.backgroundPosition = 'center';
  } else if (s.mode === 'center') {
    imageEl.style.backgroundSize = 'auto';
    imageEl.style.backgroundRepeat = 'no-repeat';
    imageEl.style.backgroundPosition = 'center';
  } else if (s.mode === 'crop') {
    imageEl.style.backgroundSize = 'cover';
    imageEl.style.backgroundRepeat = 'no-repeat';
    imageEl.style.backgroundPosition = `${s.cropX}% ${s.cropY}%`;
  } else {
    imageEl.style.backgroundSize = 'cover';
    imageEl.style.backgroundRepeat = 'no-repeat';
    imageEl.style.backgroundPosition = 'center';
  }
  imageEl.style.filter = s.blur > 0 ? `blur(${s.blur}px)` : 'none';
  imageEl.style.opacity = String(1 - (s.transparency / 100));
  overlayEl.style.opacity = String(s.dim / 100);
}
applyCustomBg();

function updateCropPreviewBg() {
  const imgData = getBgImageData();
  const preview = document.getElementById('bgCropPreview');
  if (!imgData) return;
  const s = getBgSettings();
  preview.style.backgroundImage = `url(${imgData.dataUrl})`;
  preview.style.backgroundPosition = `${s.cropX}% ${s.cropY}%`;
}

function loadBgSettingsIntoUI() {
  const s = getBgSettings();
  document.getElementById('bgModeSelect').value = s.mode;
  document.getElementById('bgBlurSlider').value = s.blur;
  document.getElementById('bgBlurOut').textContent = s.blur;
  document.getElementById('bgDimSlider').value = s.dim;
  document.getElementById('bgDimOut').textContent = s.dim;
  document.getElementById('bgTransparencySlider').value = s.transparency;
  document.getElementById('bgTransparencyOut').textContent = s.transparency;
  document.getElementById('bgWidgetFillSlider').value = s.widgetFill;
  document.getElementById('bgWidgetFillOut').textContent = s.widgetFill;
  document.getElementById('bgCropWrap').hidden = s.mode !== 'crop';
  updateCropPreviewBg();
}

function initCustomBackground() {
  const fileInput = document.getElementById('bgImageInput');
  const statusEl = document.getElementById('bgImageStatus');
  const settingsGroup = document.getElementById('bgSettingsGroup');
  const removeBtn = document.getElementById('btnRemoveBgImage');

  function refreshUploadUiState() {
    const has = !!(getBgImageData() && getBgImageData().dataUrl);
    settingsGroup.hidden = !has;
    removeBtn.hidden = !has;
    statusEl.textContent = has ? 'Background image set.' : 'No background image set.';
  }

  document.getElementById('btnChooseBgImage').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { statusEl.textContent = 'Please choose an image file.'; return; }
    statusEl.textContent = 'Processing image…';
    try {
      const { dataUrl, dominantColor } = await resizeAndCompressImage(file);
      // Resize/compress above already keeps normal photos well under this —
      // this only catches pathological cases (e.g. a giant single-color PNG
      // that doesn't compress well as JPEG source).
      if (dataUrl.length > 2000000) {
        statusEl.textContent = 'That image is too large even after compressing — try a smaller photo.';
        return;
      }
      localStorage.setItem('wft_bg_image', JSON.stringify({ dataUrl, dominantColor }));
      refreshUploadUiState();
      loadBgSettingsIntoUI();
      applyCustomBg();
      statusEl.textContent = 'Background image set.';
    } catch (e) {
      statusEl.textContent = e.message || 'Could not process that image — try another.';
    }
  });

  removeBtn.addEventListener('click', () => {
    localStorage.removeItem('wft_bg_image');
    refreshUploadUiState();
    applyCustomBg();
  });

  document.getElementById('bgModeSelect').addEventListener('change', e => {
    const s = getBgSettings();
    s.mode = e.target.value;
    saveBgSettings(s);
    document.getElementById('bgCropWrap').hidden = s.mode !== 'crop';
    if (s.mode === 'crop') updateCropPreviewBg();
    applyCustomBg();
  });

  [['bgBlurSlider', 'blur'], ['bgDimSlider', 'dim'], ['bgTransparencySlider', 'transparency'], ['bgWidgetFillSlider', 'widgetFill']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('input', e => {
      const s = getBgSettings();
      s[key] = parseInt(e.target.value, 10);
      saveBgSettings(s);
      document.getElementById(id.replace('Slider', 'Out')).textContent = e.target.value;
      applyCustomBg();
    });
  });

  // Drag-to-reposition on the crop preview box — only relevant in Crop &
  // Position mode, but harmless to leave wired otherwise (box is hidden).
  const cropPreview = document.getElementById('bgCropPreview');
  let dragging = false, startX = 0, startY = 0, startCropX = 50, startCropY = 50;
  cropPreview.addEventListener('pointerdown', e => {
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const s = getBgSettings();
    startCropX = s.cropX; startCropY = s.cropY;
    cropPreview.setPointerCapture(e.pointerId);
  });
  cropPreview.addEventListener('pointermove', e => {
    if (!dragging) return;
    const rect = cropPreview.getBoundingClientRect();
    const dxPct = ((e.clientX - startX) / rect.width) * 100;
    const dyPct = ((e.clientY - startY) / rect.height) * 100;
    const s = getBgSettings();
    s.cropX = Math.max(0, Math.min(100, startCropX - dxPct));
    s.cropY = Math.max(0, Math.min(100, startCropY - dyPct));
    saveBgSettings(s);
    cropPreview.style.backgroundPosition = `${s.cropX}% ${s.cropY}%`;
    applyCustomBg();
  });
  cropPreview.addEventListener('pointerup', () => { dragging = false; });
  cropPreview.addEventListener('pointercancel', () => { dragging = false; });

  refreshUploadUiState();
  loadBgSettingsIntoUI();
}

/* ---------------------------------------------------------------- */
/* Init                                                                 */
/* ---------------------------------------------------------------- */
document.getElementById('headerToday').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

// Each init step runs in its own try/catch: a bug in one feature (e.g. a
// stray cached-asset mismatch after an update) must not silently cancel
// every init step listed after it — that's what let a single early failure
// take out unrelated late-registered features (like the chat refresh
// button) with zero visible symptom. Failures are collected and, if any
// happened, surfaced as a toast so they're actually reportable instead of
// invisible in a console nobody's looking at.
const initFailures = [];
function safeInit(fn, label) {
  try { fn(); } catch (err) {
    console.error(`Init failed: ${label}`, err);
    initFailures.push(label + ': ' + (err && err.message ? err.message : String(err)));
  }
}

safeInit(migrateWaterUnitsIfNeeded, 'migrateWaterUnitsIfNeeded');
safeInit(initTabs, 'initTabs');
safeInit(initSwipeNavigation, 'initSwipeNavigation');
safeInit(initBackButtonNav, 'initBackButtonNav');
safeInit(() => {
  document.getElementById('btnGoToBioFromChart').addEventListener('click', () => {
    document.querySelector('.tab-btn[data-target="bio"]').click();
  });
}, 'btnGoToBioFromChart');
safeInit(initSettingsOverlay, 'initSettingsOverlay');
safeInit(initAppUpdateButton, 'initAppUpdateButton');
safeInit(initDonationPrompt, 'initDonationPrompt');
safeInit(initLastStateRestore, 'initLastStateRestore');
safeInit(initDigitalId, 'initDigitalId');
safeInit(initContact, 'initContact');
safeInit(initFooterShare, 'initFooterShare');
safeInit(initFooterTagline, 'initFooterTagline');
safeInit(initPrivacyPolicy, 'initPrivacyPolicy');
safeInit(initTermsOfService, 'initTermsOfService');
safeInit(initPRBoardOverlay, 'initPRBoardOverlay');
safeInit(initMeasureEntryOverlay, 'initMeasureEntryOverlay');
safeInit(initEntityIdentityOverlay, 'initEntityIdentityOverlay');
safeInit(initDateTimeWidget, 'initDateTimeWidget');
safeInit(initTimezonePicker, 'initTimezonePicker');
safeInit(initWeatherWidget, 'initWeatherWidget');
safeInit(initWeatherLocationPicker, 'initWeatherLocationPicker');
safeInit(initSetupForm, 'initSetupForm');
safeInit(initCheckin, 'initCheckin');
safeInit(initQuickLogLaunchers, 'initQuickLogLaunchers');
safeInit(initMeasurements, 'initMeasurements');
safeInit(initTraining, 'initTraining');
safeInit(initCardioTracker, 'initCardioTracker');
safeInit(initMissionLog, 'initMissionLog');
safeInit(initDatePicker, 'initDatePicker');
safeInit(initWeightChartToggle, 'initWeightChartToggle');
safeInit(initNutrition, 'initNutrition');
safeInit(initFoodDiary, 'initFoodDiary');
safeInit(initAddFoodPanel, 'initAddFoodPanel');
safeInit(initManualIntake, 'initManualIntake');
safeInit(initBarcodeScanner, 'initBarcodeScanner');
safeInit(initBioLog, 'initBioLog');
safeInit(initDailyReviewForm, 'initDailyReviewForm');
safeInit(initReviewForm, 'initReviewForm');
safeInit(initExport, 'initExport');
safeInit(initDrive, 'initDrive');
safeInit(initCustomBackground, 'initCustomBackground');
safeInit(initLeaderboard, 'initLeaderboard');
safeInit(initAnnouncementWidget, 'initAnnouncementWidget');
safeInit(loadSetupForm, 'loadSetupForm');
safeInit(loadCheckinForm, 'loadCheckinForm');
safeInit(() => { document.getElementById('sysVersion').textContent = APP_VERSION; }, 'sysVersion');
safeInit(renderDashboard, 'renderDashboard');
safeInit(updateTabDots, 'updateTabDots');
safeInit(initBetaLock, 'initBetaLock');
safeInit(() => {
  if (document.getElementById('lockOverlay').hidden) {
    initOnboarding(() => initReviewGate(() => initConsentGate()));
  }
}, 'initOnboarding');

if (initFailures.length) {
  setTimeout(() => {
    showRestToast(`${initFailures.length} feature(s) failed to load: ${initFailures[0]}${initFailures.length > 1 ? ` (+${initFailures.length - 1} more, see console)` : ''}`);
  }, 2200);
}

setTimeout(() => {
  const splash = document.getElementById('splashScreen');
  if (!splash) return;
  splash.classList.add('splash-hide');
  setTimeout(() => { splash.hidden = true; }, 400);
  checkDataReminder();
  setTimeout(checkMeasurementReminder, 6000);
  cleanupOldHydrationFiredKeys();
  setTimeout(checkHydrationReminders, 8000);
  setTimeout(checkDonationPrompt, 500);
  restoreLastState();
}, 2000);

setInterval(checkHydrationReminders, 5 * 60 * 1000);

// Background unread-message check so the Nexus tab dot can light up even while
// the user is elsewhere — the Nexus tab's own polling only runs while it's active.
function checkUnreadMessagesBackground() {
  if (!sbConfigured() || !localStorage.getItem('wft_lb_share_key')) return Promise.resolve();
  return refreshChatRooms().catch(() => {});
}
setTimeout(checkUnreadMessagesBackground, 5000);
setInterval(checkUnreadMessagesBackground, 60000);


let swRegistration = null;
let swReloadedOnce = false;
let updateAvailable = false;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache: 'none' stops the browser from ever serving sw.js (or
    // anything it imports) from HTTP cache during an update check — without
    // this, a stale cached copy of sw.js can make every check falsely
    // report "already latest" until the HTTP cache entry happens to expire.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      swRegistration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) markUpdateAvailable();
      // Background auto-check: silently looks for updates every 15 minutes
      // while the app is open, and again shortly after boot. It only ever
      // downloads/installs the new worker — it never applies it on its own,
      // so nothing reloads or interrupts you until you tap Update Now.
      setTimeout(() => checkForUpdate(), 5000);
      setInterval(() => checkForUpdate(), 15 * 60 * 1000);
    }).catch(() => {});
  });
  // Fires once the new worker actually takes control (after SKIP_WAITING) —
  // this is the one-and-only reload the "Update Now" flow needs.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloadedOnce) return;
    swReloadedOnce = true;
    location.reload();
  });
}

async function fetchLatestVersionLabel() {
  try {
    const res = await fetch('app.js?_=' + Date.now(), { cache: 'no-store' });
    const text = await res.text();
    const m = text.match(/APP_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

async function markUpdateAvailable() {
  updateAvailable = true;
  const note = document.getElementById('updateAvailableNote');
  const versionEl = document.getElementById('updateAvailableVersion');
  if (!note || !versionEl) return;
  note.hidden = false;
  versionEl.textContent = 'checking version…';
  const label = await fetchLatestVersionLabel();
  versionEl.textContent = label || 'ready to install';
}

function clearUpdateAvailable() {
  updateAvailable = false;
  const note = document.getElementById('updateAvailableNote');
  if (note) note.hidden = true;
}

// Event-driven: waits for the actual 'installed' state instead of guessing
// with a fixed delay, so it isn't a race against slow networks. Resolves
// true if a new version ended up waiting to activate.
function checkForUpdate() {
  if (!swRegistration) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = found => {
      if (settled) return;
      settled = true;
      swRegistration.removeEventListener('updatefound', onUpdateFound);
      clearTimeout(fallbackTimer);
      if (found) markUpdateAvailable();
      resolve(found);
    };
    const onUpdateFound = () => {
      const installing = swRegistration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') finish(!!swRegistration.waiting);
        else if (installing.state === 'redundant') finish(false);
      });
    };
    swRegistration.addEventListener('updatefound', onUpdateFound);
    const fallbackTimer = setTimeout(() => finish(!!swRegistration.waiting), 8000);
    swRegistration.update().catch(() => finish(!!swRegistration.waiting));
  });
}

async function checkAndApplyAppUpdate() {
  const overlay = document.getElementById('appUpdateOverlay');
  const statusEl = document.getElementById('appUpdateStatus');
  overlay.hidden = false;
  statusEl.textContent = 'Checking for updates…';

  if (!swRegistration) {
    statusEl.textContent = 'Update system unavailable — try closing and reopening the app.';
    setTimeout(() => { overlay.hidden = true; }, 2200);
    return;
  }

  // Already found one in the background — apply immediately, no re-check needed.
  const found = swRegistration.waiting ? true : await checkForUpdate();

  if (found && swRegistration.waiting) {
    statusEl.textContent = 'Updating…';
    clearUpdateAvailable();
    swRegistration.waiting.postMessage('SKIP_WAITING');
    // Safety net in case controllerchange never fires for some reason.
    setTimeout(() => { if (!swReloadedOnce) location.reload(); }, 4000);
  } else {
    statusEl.textContent = "You're already on the latest version.";
    setTimeout(() => { overlay.hidden = true; }, 1800);
  }
}

function initAppUpdateButton() {
  document.getElementById('settingsAppVersion').textContent = APP_VERSION;
  document.getElementById('btnCheckUpdate').addEventListener('click', checkAndApplyAppUpdate);
}


