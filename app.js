'use strict';

/* ---------------------------------------------------------------- */
/* Storage                                                           */
/* ---------------------------------------------------------------- */
const KEYS = { profile: 'wft_profile', logs: 'wft_logs', reviews: 'wft_reviews' };

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
function setTrainUnit(u) { localStorage.setItem('wft_train_unit', u); }

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

/* A coach-assigned value (set on the Fuel page) overrides the computed default
   wherever a single-number target is needed, until the coach updates it again. */
function getEffectiveCalorieTarget(profile) {
  if (!profile) return null;
  if (profile.coachCalorieTarget) return profile.coachCalorieTarget;
  const kg = currentWeightKg(profile);
  const targets = kg ? computeTargets(profile, kg) : null;
  if (!targets) return null;
  const range = profile.goalMode === 'bulk' ? targets.bulking : targets.cutting;
  return round0((range[0] + range[1]) / 2);
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

function initTabs() {
  const btns = document.querySelectorAll('.tab-btn[data-target]');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      document.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.tab !== target);
      btns.forEach(b => b.classList.toggle('is-active', b === btn));
      if (target === 'status') { loadCheckinForm(); loadQuickLog(); renderDashboard(); }
      if (target === 'training') {
        loadTrainingForDate(document.getElementById('trainDate').value);
        renderTrainingStats();
        renderExerciseTimerDisplays();
        checkTrainingIdle();
      }
      if (target === 'nutrition') {
        loadNutritionForDate(document.getElementById('nutDate').value);
        renderNutritionTargets();
        renderNutritionAverages();
      }
      if (target === 'bio') {
        loadBioForDate(document.getElementById('bioDate').value);
        const p = getProfile();
        if (p) renderComputedTargets(p);
        renderSleepBarChart();
        renderWaterRetentionOrb();
      }
      if (target === 'leaderboard' && sbConfigured()) {
        pullLeaderboard().then(renderNexusRankings).catch(() => {});
        fetchChatMessages().then(renderChatMessages).catch(() => {});
        refreshChatRooms();
        startNexusPolling();
      } else {
        stopNexusPolling();
      }
      if (target === 'menu') {
        renderHistory();
        renderMeasureHistory();
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

  const saved = localStorage.getItem('wft_alarm_tone') || 'chime';
  document.querySelectorAll('input[name="alarmTone"]').forEach(radio => {
    radio.checked = radio.value === saved;
    radio.addEventListener('change', () => {
      if (radio.checked) localStorage.setItem('wft_alarm_tone', radio.value);
    });
  });
  document.querySelectorAll('.tone-preview-btn').forEach(btn => {
    btn.addEventListener('click', () => playAlarmTone(btn.dataset.tone));
  });
}

function initContact() {
  const overlay = document.getElementById('contactOverlay');
  document.getElementById('btnFooterContact').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseContact').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

function generateShareCardBlob({ emoji, title, stats }) {
  return new Promise(resolve => {
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
    ctx.fillStyle = '#5a686e';
    ctx.font = '15px monospace';
    ctx.fillText('WINFINITY TRACKER', 300, 240);

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

    canvas.toBlob(blob => resolve(blob), 'image/png');
  });
}

async function shareViaWebShare(shareData, imageBlob) {
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

function initFooterShare() {
  const shareUrl = 'https://winfinityfitness.github.io/fitness-tracker';
  document.getElementById('btnFooterShare').addEventListener('click', () => {
    shareViaWebShare({
      title: 'Winfinity Tracker',
      text: 'Check out Winfinity Tracker — my fitness tracking app:',
      url: shareUrl,
    });
  });
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

function initPRBoardOverlay() {
  const overlay = document.getElementById('prBoardOverlay');
  document.getElementById('btnOpenPRBoard').addEventListener('click', () => {
    renderPRBoard();
    overlay.hidden = false;
  });
  document.getElementById('btnClosePRBoard').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

function initIntakeLogOverlay() {
  const overlay = document.getElementById('intakeLogOverlay');
  document.getElementById('btnOpenIntakeLog').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseIntakeLog').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
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
function weatherIconFor(code) {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  return '⛈️';
}

async function fetchWeather(lat, lon) {
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`);
  if (!res.ok) throw new Error('weather fetch failed');
  const data = await res.json();
  return { tempC: data.current.temperature_2m, code: data.current.weather_code };
}

function renderWeather(w) {
  document.getElementById('weatherIcon').textContent = weatherIconFor(w.code);
  document.getElementById('weatherTemp').textContent = Math.round(w.tempC) + '°C';
}

function getManualWeatherLocation() {
  try { return JSON.parse(localStorage.getItem('wft_weather_location')); } catch (e) { return null; }
}

function initWeatherWidget() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('wft_weather_cache')); } catch (e) { /* ignore */ }
  if (cached && Date.now() - cached.time < 30 * 60 * 1000) renderWeather(cached);

  const manualLoc = getManualWeatherLocation();
  if (manualLoc) {
    fetchWeather(manualLoc.lat, manualLoc.lon).then(w => {
      renderWeather(w);
      localStorage.setItem('wft_weather_cache', JSON.stringify({ ...w, time: Date.now() }));
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
      fetchWeather(pos.coords.latitude, pos.coords.longitude).then(w => {
        renderWeather(w);
        localStorage.setItem('wft_weather_cache', JSON.stringify({ ...w, time: Date.now() }));
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
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';

  document.getElementById('bioWeight').value = e.weightKg != null ? round2(fromKg(e.weightKg, wu)) : '';
  document.getElementById('bioMenstruating').checked = !!e.menstruating;
  document.getElementById('bioSleep').value = e.sleep ?? 3;
  document.getElementById('bioSleepOut').textContent = e.sleep ?? 3;
  document.getElementById('bioStress').value = e.stress ?? 3;
  document.getElementById('bioStressOut').textContent = e.stress ?? 3;
  document.getElementById('bioFatigue').value = e.fatigue ?? 3;
  document.getElementById('bioFatigueOut').textContent = e.fatigue ?? 3;
  document.getElementById('bioHunger').value = e.hunger ?? 3;
  document.getElementById('bioHungerOut').textContent = e.hunger ?? 3;
  document.getElementById('bioMenstruatingField').hidden = !profile || profile.gender !== 'female';
  document.getElementById('bioWeightUnitLabel').textContent = wu;
}

function initBioLog() {
  document.getElementById('bioDate').value = todayISO();
  document.getElementById('bioDate').addEventListener('change', e => loadBioForDate(e.target.value));

  ['bioSleep', 'bioStress', 'bioFatigue', 'bioHunger'].forEach(id => {
    const input = document.getElementById(id);
    const out = document.getElementById(id + 'Out');
    input.addEventListener('input', () => { out.textContent = input.value; });
  });

  document.getElementById('btnSaveBio').addEventListener('click', () => {
    const profile = getProfile();
    const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
    const date = document.getElementById('bioDate').value;
    const weightRaw = parseFloat(document.getElementById('bioWeight').value);
    updateLogFields(date, {
      weightKg: isNaN(weightRaw) ? null : toKg(weightRaw, wu),
      menstruating: document.getElementById('bioMenstruating').checked,
      sleep: parseInt(document.getElementById('bioSleep').value, 10),
      stress: parseInt(document.getElementById('bioStress').value, 10),
      fatigue: parseInt(document.getElementById('bioFatigue').value, 10),
      hunger: parseInt(document.getElementById('bioHunger').value, 10),
    });
    document.getElementById('bioSaveNote').textContent = 'Saved biometrics for ' + date;
    setTimeout(() => { document.getElementById('bioSaveNote').textContent = ''; }, 2000);
    if (profile) renderComputedTargets(profile);
    renderSleepBarChart();
    renderWaterRetentionOrb();
    if (date === todayISO()) { loadQuickLog(); renderDashboard(); }
    updateTabDots();
  });

  loadBioForDate(todayISO());
  renderSleepBarChart();
  renderWaterRetentionOrb();
}

function renderSleepBarChart() {
  const logsArr = sortedLogsArray();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const entry = logsArr.find(l => l.date === iso);
    days.push({ dateObj: d, sleep: entry ? entry.sleep : null });
  }
  const chart = document.getElementById('sleepBarChart');
  const labels = document.getElementById('sleepBarLabels');
  chart.innerHTML = ''; labels.innerHTML = '';
  days.forEach(d => {
    const col = document.createElement('div');
    col.className = 'bar-chart-col' + (d.sleep != null ? ' has-value' : '');
    col.style.height = d.sleep != null ? `${(d.sleep / 5) * 100}%` : '4%';
    col.title = d.sleep != null ? `${d.sleep}/5` : 'No data';
    chart.appendChild(col);
    const lbl = document.createElement('span');
    lbl.textContent = d.dateObj.toLocaleDateString(undefined, { weekday: 'narrow' });
    labels.appendChild(lbl);
  });

  const logged = days.filter(d => d.sleep != null);
  const avgQuality = logged.length ? logged.reduce((s, d) => s + d.sleep, 0) / logged.length : null;
  document.getElementById('sleepAvgQuality').textContent = avgQuality != null ? `${avgQuality.toFixed(1)}/5.0` : '–';
  document.getElementById('sleepConsistency').textContent = `${round0((logged.length / 7) * 100)}%`;
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
      size: 130, stroke: 9, magenta: true, modTag: 'MOD_WATER_04',
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

  const periodBonusG = (profile.gender === 'female' && entry.menstruating) ? 1750 : 0; // +1.5kg-2kg, midpoint

  const totalG = glycogenWaterG + stateWaterG + periodBonusG;
  const gaugePct = Math.min(100, (totalG / 3500) * 100);

  renderRing(container, gaugePct, {
    size: 130, stroke: 9, magenta: true, modTag: 'MOD_WATER_04',
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
/* Status: quick log (morning weight + sleep quality)                  */
/* ---------------------------------------------------------------- */
function loadQuickLog() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const e = getLogs()[todayISO()] || {};
  document.getElementById('statusWeight').value = e.weightKg != null ? round2(fromKg(e.weightKg, wu)) : '';
  document.getElementById('statusWeightUnitLabel').textContent = wu;
  document.getElementById('statusSleep').value = e.sleep ?? 3;
  document.getElementById('statusSleepOut').textContent = e.sleep ?? 3;
}

function initQuickLog() {
  const sleepInput = document.getElementById('statusSleep');
  const sleepOut = document.getElementById('statusSleepOut');
  sleepInput.addEventListener('input', () => { sleepOut.textContent = sleepInput.value; });

  document.getElementById('btnSaveQuickLog').addEventListener('click', () => {
    const profile = getProfile();
    const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
    const date = todayISO();
    const weightRaw = parseFloat(document.getElementById('statusWeight').value);
    updateLogFields(date, {
      weightKg: isNaN(weightRaw) ? null : toKg(weightRaw, wu),
      sleep: parseInt(sleepInput.value, 10),
    });
    document.getElementById('quickLogSaveNote').textContent = 'Saved.';
    setTimeout(() => { document.getElementById('quickLogSaveNote').textContent = ''; }, 2000);
    renderDashboard();
    if (profile) renderComputedTargets(profile);
    renderSleepBarChart();
    if (document.getElementById('bioDate').value === date) loadBioForDate(date);
    updateTabDots();
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

function renderPulseSparkline() {
  const logsArr = sortedLogsArray();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const entry = logsArr.find(l => l.date === iso);
    days.push(entry && entry.steps != null ? entry.steps : 0);
  }
  const max = Math.max(...days, 1);
  const w = 280, h = 50, pad = 4;
  const stepX = w / (days.length - 1);
  const points = days.map((v, i) => ({
    x: i * stepX,
    y: h - pad - (v / max) * (h - pad * 2),
  }));
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `M${points[0].x.toFixed(1)},${h} ${linePath.replace(/^M/, 'L')} L${points[points.length - 1].x.toFixed(1)},${h} Z`;
  const last = points[points.length - 1];

  const svg = document.getElementById('pulseSparkline');
  svg.innerHTML = `
    <path d="${areaPath}" fill="var(--cyan)" opacity="0.12"></path>
    <path d="${linePath}" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.2" fill="var(--cyan)"></circle>
  `;
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
  renderGoalProgress(profile, kgNow, wu);
  renderPulseSparkline();
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

  displayVals.forEach((v, i) => {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', xFor(i)); c.setAttribute('cy', yFor(v));
    c.setAttribute('r', series.length > 40 ? 2 : 3.5);
    c.setAttribute('fill', 'var(--series-1)');
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
  svg.addEventListener('pointermove', evt => showAt(pointerToIndex(evt)));
  svg.addEventListener('pointerleave', () => { crosshair.setAttribute('visibility', 'hidden'); tooltip.style.display = 'none'; });
  showAt(series.length - 1);

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
}

/* ---- Goal progress bar ---- */
function renderGoalProgress(profile, kgNow, wu) {
  const card = document.getElementById('goalProgressCard');
  const emptyNote = document.getElementById('goalEmptyNote');
  card.querySelectorAll('.goal-track').forEach(el => el.remove());

  if (!profile || kgNow == null || profile.goalTargetKg == null) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  const points = [
    { label: 'Start', kg: profile.startWeightKg },
    { label: 'Min goal', kg: profile.goalMinKg },
    { label: 'Target', kg: profile.goalTargetKg },
    { label: 'Dream', kg: profile.goalDreamKg },
  ].filter(p => p.kg != null);

  const allKg = points.map(p => p.kg).concat([kgNow]);
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

function initExerciseNameAutocomplete() {
  renderExerciseNameOptions();
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
  const names = Array.from(seen.values()).sort((a, b) => b.lastDate.localeCompare(a.lastDate)).map(v => v.name);
  const datalist = document.getElementById('exerciseNameList');
  if (datalist) datalist.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
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
    const prevSets = findPreviousSets(ex.name, date);
    const card = document.createElement('div');
    card.className = 'ex-card';
    const restMins = Math.round((ex.restSeconds || 180) / 60);
    const restOptions = Array.from({ length: 15 }, (_, i) => i + 1)
      .map(m => `<option value="${m}"${m === restMins ? ' selected' : ''}>${m}m</option>`).join('');

    const rows = ex.sets.map((s, setIdx) => {
      const prev = prevSets && prevSets[setIdx] ? `${prevSets[setIdx].reps} × ${round2(fromKg(prevSets[setIdx].weightKg, wu))}${wu}` : '–';
      const weightDisplay = s.weightKg != null ? round2(fromKg(s.weightKg, wu)) : '';
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
        <thead><tr><th>Set</th><th>Previous</th><th>Reps</th><th>Load (${wu})</th><th></th><th></th></tr></thead>
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
  const w = 300, h = 160, pad = 12;
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
}

let lastCardioSession = null;

function stopCardioTracking() {
  if (cardioWatchId != null) navigator.geolocation.clearWatch(cardioWatchId);
  if (cardioTickId) clearInterval(cardioTickId);
  cardioWatchId = null;
  cardioTickId = null;

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
}

let cardioMapInstance = null;

function renderCardioMap(track) {
  const sketch = document.getElementById('cardioRouteSketch');
  const mapEl = document.getElementById('cardioMapView');
  if (!window.L || track.length < 2) return; // no internet/Leaflet, or nothing to plot — keep the offline sketch visible
  sketch.hidden = true;
  mapEl.hidden = false;

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
  ctx.fillStyle = '#5a686e';
  ctx.font = '12px monospace';
  ctx.fillText('WINFINITY TRACKER', 76, bannerTop + 70);

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
  renderCardioHistory();
}

function getActiveTrainingDate() {
  const stored = localStorage.getItem('wft_active_train_date');
  if (!stored) return todayISO();
  const logs = getLogs();
  const hasData = logs[stored] && logs[stored].exercises && logs[stored].exercises.length > 0;
  return (hasData && !isSessionFinished(stored)) ? stored : todayISO();
}

function initTrainUnitToggle() {
  const btnKg = document.getElementById('btnUnitKg');
  const btnLb = document.getElementById('btnUnitLb');
  const sync = () => {
    const u = getTrainUnit();
    btnKg.classList.toggle('is-active', u === 'kg');
    btnLb.classList.toggle('is-active', u === 'lb');
  };
  btnKg.addEventListener('click', () => { setTrainUnit('kg'); sync(); renderExerciseCards(); });
  btnLb.addEventListener('click', () => { setTrainUnit('lb'); sync(); renderExerciseCards(); });
  sync();
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
    cells.push({ day: d, iso, isToday: iso === todayIso, isWorkout: workoutDays.has(iso), isPeriod: periodDays.has(iso) });
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
    const dot = c.isPeriod ? '<span class="mission-log-period-dot"></span>' : '';
    return `<div class="${classes.join(' ')}">${c.day}${dot}</div>`;
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
    currentExercises.push({ name, restSeconds: 180, notes: '', sets: [firstSet] });
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
    const wu = getTrainUnit();
    if (e.target.classList.contains('ex-set-reps')) {
      const exIdx = parseInt(e.target.dataset.ex, 10), setIdx = parseInt(e.target.dataset.set, 10);
      currentExercises[exIdx].sets[setIdx].reps = parseIntOrNull(e.target.value);
      persistExercises();
    } else if (e.target.classList.contains('ex-set-weight')) {
      const exIdx = parseInt(e.target.dataset.ex, 10), setIdx = parseInt(e.target.dataset.set, 10);
      const val = parseFloat(e.target.value);
      currentExercises[exIdx].sets[setIdx].weightKg = isNaN(val) ? null : toKg(val, wu);
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
    const blob = await generateShareCardBlob({
      emoji: prCount > 0 ? '🏆' : '💪',
      title: 'Workout complete!',
      stats: [
        { label: 'Exercises', value: String(lastWorkoutSummary.exercises.length) },
        { label: 'Sets', value: String(lastWorkoutSummary.totalSets) },
        { label: `Volume (${wu})`, value: String(vol) },
        { label: 'New PRs', value: String(prCount) },
      ],
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
  chart.innerHTML = ''; labels.innerHTML = '';
  if (!gymDays.length) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;
  const volumes = gymDays.map(l => fromKg(computeDayVolumeKg(l), wu));
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
  const fmtBoth = (weightKg, reps) => `${round2(weightKg)}kg / ${round2(kgToLb(weightKg))}lb × ${reps}`;
  rows.forEach(r => {
    const curText = fmtBoth(r.current.weightKg, r.current.reps);
    const prevText = r.previous ? fmtBoth(r.previous.weightKg, r.previous.reps) : '–';
    const deltaPct = r.previous ? round2(((r.current.oneRM - r.previous.oneRM) / r.previous.oneRM) * 100) : null;
    const row = document.createElement('div');
    row.className = 'pr-board-row';
    row.innerHTML = `
      <div class="pr-board-name">${escapeHtml(r.name)}</div>
      <div class="pr-board-compare">
        <div class="pr-board-col"><span class="pr-board-label">Previous</span><span class="pr-board-value">${prevText}</span></div>
        <div class="pr-board-arrow">→</div>
        <div class="pr-board-col"><span class="pr-board-label">Current</span><span class="pr-board-value pr-board-value--current">${curText}</span></div>
      </div>
      ${deltaPct != null
        ? `<div class="pr-board-delta ${deltaPct >= 0 ? 'is-up' : 'is-down'}">${deltaPct >= 0 ? '+' : ''}${deltaPct}% est. 1RM</div>`
        : `<div class="pr-board-delta is-up">New PR!</div>`}
    `;
    board.appendChild(row);
  });
}

/* ---- Finish workout summary + PR detection ---- */
function computeWorkoutSummary(date) {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  let totalVolumeKg = 0, totalSets = 0;
  const exercises = currentExercises.map(ex => {
    const completed = ex.sets.filter(s => s.completed && s.weightKg != null && s.reps != null);
    const volumeKg = completed.reduce((sum, s) => sum + s.weightKg * s.reps, 0);
    totalVolumeKg += volumeKg;
    totalSets += completed.length;
    const bestOneRM = completed.reduce((max, s) => Math.max(max, estOneRM(s.weightKg, s.reps)), 0);
    const historicalBest = bestHistoricalOneRM(ex.name, date);
    const isPR = completed.length > 0 && historicalBest > 0 && bestOneRM > historicalBest + 0.01;
    return { name: ex.name, completedSets: completed.length, volumeKg, isPR };
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
        <div class="summary-ex-meta">${ex.completedSets} sets · ${round0(fromKg(ex.volumeKg, wu))} ${wu} volume</div>
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

function fireSystemNotification(title, body) {
  if (!window.Notification || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => { n.close(); window.focus(); };
  } catch (e) { /* ignore */ }
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
function loadNutritionForDate(date) {
  const logs = getLogs();
  const e = logs[date] || {};
  document.getElementById('nutCalories').value = e.calories ?? '';
  document.getElementById('nutProtein').value = e.protein ?? '';
  document.getElementById('nutCarbs').value = e.carbs ?? '';
  document.getElementById('nutFat').value = e.fat ?? '';
  document.getElementById('nutFiber').value = e.fiber ?? '';
  document.getElementById('nutSodium').value = e.sodium ?? '';
  document.getElementById('nutWater').value = e.water ?? '';
  document.getElementById('nutSteps').value = e.steps ?? '';
  document.getElementById('fuelDateLabel').textContent = fmtDate(parseISO(date));
}

function initNutrition() {
  document.getElementById('nutDate').value = todayISO();
  document.getElementById('nutDate').addEventListener('change', e => { loadNutritionForDate(e.target.value); renderNutritionTargets(); });
  document.getElementById('btnGoToBioFromFuel').addEventListener('click', () => {
    document.querySelector('.tab-btn[data-target="bio"]').click();
  });

  document.getElementById('btnSaveNutrition').addEventListener('click', () => {
    const date = document.getElementById('nutDate').value;
    updateLogFields(date, {
      calories: parseIntOrNull(document.getElementById('nutCalories').value),
      protein: parseIntOrNull(document.getElementById('nutProtein').value),
      carbs: parseIntOrNull(document.getElementById('nutCarbs').value),
      fat: parseIntOrNull(document.getElementById('nutFat').value),
      fiber: parseIntOrNull(document.getElementById('nutFiber').value),
      sodium: parseIntOrNull(document.getElementById('nutSodium').value),
      water: parseIntOrNull(document.getElementById('nutWater').value),
      steps: parseIntOrNull(document.getElementById('nutSteps').value),
    });
    document.getElementById('nutSaveNote').textContent = 'Saved intake for ' + date;
    setTimeout(() => { document.getElementById('nutSaveNote').textContent = ''; }, 2000);
    renderNutritionAverages();
    renderNutritionTargets();
    renderWaterRetentionOrb();
    updateTabDots();
  });

  loadNutritionForDate(todayISO());
  renderNutritionTargets();
  renderNutritionAverages();
  initCoachAssignment();
}

function loadCoachAssignment() {
  const profile = getProfile();
  document.getElementById('coachCalorieInput').value = (profile && profile.coachCalorieTarget) || '';
  document.getElementById('coachStepsInput').value = (profile && profile.coachStepGoal) || '';
  document.getElementById('coachWorkoutsInput').value = (profile && profile.coachWorkoutsPerWeek) || '';
}

function initCoachAssignment() {
  loadCoachAssignment();
  document.getElementById('btnSaveCoachAssignment').addEventListener('click', () => {
    const profile = getProfile();
    const note = document.getElementById('coachAssignmentNote');
    if (!profile) {
      alert('Set up your profile in DNA first, then assign coach targets here.');
      return;
    }
    profile.coachCalorieTarget = parseIntOrNull(document.getElementById('coachCalorieInput').value);
    profile.coachStepGoal = parseIntOrNull(document.getElementById('coachStepsInput').value);
    profile.coachWorkoutsPerWeek = parseIntOrNull(document.getElementById('coachWorkoutsInput').value);
    saveProfile(profile);
    note.textContent = 'Assignment saved.';
    setTimeout(() => { note.textContent = ''; }, 2500);
    renderNutritionTargets();
    renderDashboard();
    renderTrainingStats();
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

  const calorieTarget = getEffectiveCalorieTarget(profile);
  const proteinTarget = round0((targets.protein[0] + targets.protein[1]) / 2);
  const fatTarget = round0((calorieTarget * 0.3) / 9);
  const carbTarget = Math.max(0, round0((calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4));
  const fiberTarget = round0((calorieTarget / 1000) * 14);
  const sodiumTarget = 2300;
  const waterTarget = profile.waterGoal || 3000;

  const date = document.getElementById('nutDate').value;
  const entry = getLogs()[date] || {};
  const caloriesNow = entry.calories ?? 0;
  const proteinNow = entry.protein ?? 0;
  const carbsNow = entry.carbs ?? 0;
  const fatNow = entry.fat ?? 0;
  const fiberNow = entry.fiber ?? 0;
  const sodiumNow = entry.sodium ?? 0;
  const waterNow = entry.water ?? 0;

  const caloriePct = Math.min(100, (caloriesNow / calorieTarget) * 100);
  renderRing(document.getElementById('fuelCalorieRing'), caloriePct, {
    size: 120, stroke: 10, gradient: true, centerText: Math.round(caloriePct) + '%', label: 'Calories', sub: `${caloriesNow} / ${calorieTarget} kcal`,
  });

  const proteinKcal = proteinNow * 4;
  const carbKcal = carbsNow * 4;
  const fatKcal = fatNow * 9;
  const macroKcalTotal = proteinKcal + carbKcal + fatKcal;
  const macroPie = document.getElementById('fuelMacroPie');
  const macroLegend = document.getElementById('fuelMacroLegend');
  const macros = [
    { label: 'Protein', kcal: proteinKcal, colorVar: '--cyan', dot: 'macro-protein' },
    { label: 'Carbs', kcal: carbKcal, colorVar: '--violet', dot: 'macro-carbs' },
    { label: 'Fat', kcal: fatKcal, colorVar: '--warning', dot: 'macro-fat' },
  ];
  if (macroKcalTotal > 0) {
    let acc = 0;
    const stops = macros.map(m => {
      const start = (acc / macroKcalTotal) * 100;
      acc += m.kcal;
      const end = (acc / macroKcalTotal) * 100;
      return `var(${m.colorVar}) ${start}% ${end}%`;
    }).join(', ');
    macroPie.style.background = `conic-gradient(${stops})`;
  } else {
    macroPie.style.background = 'var(--gridline)';
  }
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

  document.getElementById('fuelWaterNow').textContent = waterNow;
  document.getElementById('fuelWaterTarget').textContent = waterTarget;
  document.getElementById('fuelWaterBar').style.width = Math.min(100, (waterNow / waterTarget) * 100) + '%';
}

function renderNutritionAverages() {
  const logsArr = sortedLogsArray();
  document.getElementById('avgCalories').textContent = fmtOrDash(avgOfLastNDays(logsArr, 'calories', 7), v => round0(v));
  document.getElementById('avgProtein').textContent = fmtOrDash(avgOfLastNDays(logsArr, 'protein', 7), v => round0(v) + ' g');
  document.getElementById('avgWater').textContent = fmtOrDash(avgOfLastNDays(logsArr, 'water', 7), v => round2(v));
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
  syncBtn.addEventListener('click', () => saveToDrive(true));

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
  return {
    weight: kgNow != null ? round2(fromKg(kgNow, wu)) : null,
    weightUnit: wu,
    progress: progressKg != null ? round2(fromKg(progressKg, wu)) : null,
    progressPct,
    steps: steps != null ? round0(steps) : null,
    volume: round0(fromKg(volumeKg, wu)),
    volumeUnit: wu,
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
    .select('code_name, weight, weight_unit, weight_progress, weight_progress_pct, steps, volume_lifted, volume_unit, updated_at')
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

function renderRankList(containerId, rows, opts) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!rows.length) {
    container.innerHTML = '<p class="empty-note">No data yet.</p>';
    return;
  }
  rows.slice(0, 10).forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'rank-row' + (i === 0 ? ' is-top' : '');
    row.innerHTML = `<span class="rank-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="rank-name">${escapeHtml(r.code_name)}</span>
      <span class="rank-value">${opts.formatValue(r)}</span>`;
    container.appendChild(row);
  });
}

function renderNexusRankings(rows) {
  document.getElementById('lbEmptyNote').hidden = rows.length > 0;

  const ONLINE_WINDOW_MS = 5 * 60 * 1000;
  const onlineNow = rows.filter(r => r.updated_at && (Date.now() - new Date(r.updated_at).getTime()) < ONLINE_WINDOW_MS).length;
  document.getElementById('nexusTotalUsers').textContent = rows.length;
  document.getElementById('nexusOnlineUsers').textContent = onlineNow;

  const bySteps = rows.filter(r => r.steps != null).sort((a, b) => b.steps - a.steps);
  renderRankList('lbStepsRanking', bySteps, { formatValue: r => r.steps >= 1000 ? (r.steps / 1000).toFixed(1) + 'k' : String(r.steps) });

  const byVolume = rows.filter(r => r.volume_lifted != null).sort((a, b) => b.volume_lifted - a.volume_lifted);
  renderRankList('lbVolumeRanking', byVolume, { formatValue: r => round0(r.volume_lifted) + ' ' + (r.volume_unit || 'kg') });

  const byProgress = rows.filter(r => r.weight_progress_pct != null).sort((a, b) => a.weight_progress_pct - b.weight_progress_pct);
  renderRankList('lbBioRanking', byProgress, { formatValue: r => (r.weight_progress_pct > 0 ? '+' : '') + r.weight_progress_pct + '%' });

  const avgPct = byProgress.length ? byProgress.reduce((s, r) => s + r.weight_progress_pct, 0) / byProgress.length : null;
  renderRing(document.getElementById('lbBioRing'), avgPct != null ? Math.min(100, Math.abs(avgPct) * 5) : 0, {
    size: 96, stroke: 8, centerText: avgPct != null ? round2(avgPct) + '%' : '–', sub: '',
  });
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
let dmLastRead = {};
try { dmLastRead = JSON.parse(localStorage.getItem('wft_dm_last_read')) || {}; } catch (e) { dmLastRead = {}; }

async function refreshChatRooms() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  if (!shareKey || !sbConfigured()) { renderChatRoomOptions([]); renderInvitesPopover([]); return; }
  try { await sb.rpc('cleanup_stale_solo_rooms'); } catch (e) { /* best effort, opportunistic */ }
  const { data, error } = await sb.from('chat_room_members')
    .select('status, room_id, chat_rooms(id, name, is_dm, created_by_key)')
    .eq('share_key', shareKey);
  if (error) return;
  const rows = data || [];
  const joined = rows.filter(r => r.status === 'joined' && r.chat_rooms);

  const dmRoomIds = joined.filter(r => r.chat_rooms.is_dm).map(r => r.chat_rooms.id);
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
    chatRoomMeta[r.chat_rooms.id] = {
      name: r.chat_rooms.is_dm ? (otherNameByRoom[r.chat_rooms.id] || r.chat_rooms.name) : r.chat_rooms.name,
      isDm: r.chat_rooms.is_dm,
      createdByKey: r.chat_rooms.created_by_key,
    };
  });

  if (dmRoomIds.length) { try { await checkUnreadDms(dmRoomIds); } catch (e) { /* best effort — room list still renders without unread flags */ } }
  renderChatRoomOptions(joined);
  renderInvitesPopover(rows.filter(r => r.status === 'invited' && r.chat_rooms));
}

async function checkUnreadDms(dmRoomIds) {
  const { data: msgs } = await sb.from('chat_messages')
    .select('room_id, code_name, created_at')
    .in('room_id', dmRoomIds)
    .order('created_at', { ascending: false });
  const myName = effectiveLeaderboardName();
  const latestByRoom = {};
  (msgs || []).forEach(m => { if (!latestByRoom[m.room_id]) latestByRoom[m.room_id] = m; });
  let anyUnread = false;
  Object.keys(latestByRoom).forEach(roomId => {
    const m = latestByRoom[roomId];
    if (m.code_name === myName) return;
    const lastRead = dmLastRead[roomId];
    if (!lastRead || new Date(m.created_at) > new Date(lastRead)) {
      anyUnread = true;
      if (chatRoomMeta[roomId]) chatRoomMeta[roomId].unread = true;
    }
  });
  if (anyUnread) fireSystemNotification('Winfinity Tracker', 'You have a new direct message.');
}

function markDmRead(roomId) {
  dmLastRead[roomId] = new Date().toISOString();
  localStorage.setItem('wft_dm_last_read', JSON.stringify(dmLastRead));
  if (chatRoomMeta[roomId]) chatRoomMeta[roomId].unread = false;
}

function updateRoomActionButtons(roomId) {
  const meta = roomId ? chatRoomMeta[roomId] : null;
  const shareKey = localStorage.getItem('wft_lb_share_key');
  document.getElementById('btnLeaveGroup').hidden = !roomId;
  document.getElementById('btnDeleteGroup').hidden = !(meta && !meta.isDm && meta.createdByKey === shareKey);
  document.getElementById('btnInviteGroup').hidden = !(meta && !meta.isDm);
}

function renderChatRoomOptions(joinedRows) {
  const select = document.getElementById('chatRoomSelect');
  const prevValue = select.value;
  select.innerHTML = '<option value="">🌐 Public Chat</option>';
  joinedRows
    .slice()
    .sort((a, b) => chatRoomMeta[a.chat_rooms.id].name.localeCompare(chatRoomMeta[b.chat_rooms.id].name))
    .forEach(r => {
      const meta = chatRoomMeta[r.chat_rooms.id];
      const opt = document.createElement('option');
      opt.value = r.chat_rooms.id;
      const icon = meta.isDm ? '💬' : '👥';
      const label = meta.isDm ? `DM: ${meta.name}` : meta.name;
      opt.textContent = `${icon} ${label}${meta.unread ? ' 🔴' : ''}`;
      select.appendChild(opt);
    });
  const stillJoined = currentChatRoomId && joinedRows.some(r => r.chat_rooms.id === currentChatRoomId);
  select.value = stillJoined ? currentChatRoomId : '';
  if (select.value !== prevValue && !stillJoined) {
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
        <span>🔔 Invited to "${escapeHtml(r.chat_rooms.name)}"</span>
        <button type="button" class="btn btn--primary" data-accept-room="${r.chat_rooms.id}">Accept</button>
        <button type="button" class="btn" data-decline-room="${r.chat_rooms.id}">Decline</button>
      </div>
    `).join('')
    : '<p class="empty-note">No pending invites.</p>';
  popover.querySelectorAll('[data-accept-room]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const shareKey = localStorage.getItem('wft_lb_share_key');
      const { error } = await sb.from('chat_room_members').update({ status: 'joined' }).eq('room_id', btn.dataset.acceptRoom).eq('share_key', shareKey);
      if (error) { showRestToast('Could not accept invite: ' + error.message); btn.disabled = false; return; }
      refreshChatRooms();
    });
  });
  popover.querySelectorAll('[data-decline-room]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const shareKey = localStorage.getItem('wft_lb_share_key');
      const { error } = await sb.from('chat_room_members').delete().eq('room_id', btn.dataset.declineRoom).eq('share_key', shareKey);
      if (error) { showRestToast('Could not decline invite: ' + error.message); btn.disabled = false; return; }
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
    el.addEventListener('click', () => startDM(el.dataset.dmName));
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
    markDmRead(data);
    updateRoomActionButtons(data);
    const messages = await fetchChatMessages();
    renderChatMessages(messages);
  } catch (e) { showRestToast('Could not start DM: ' + (e.message || 'check your connection')); }
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

function initLeaderboard() {
  const optInEl = document.getElementById('lbOptIn');
  optInEl.checked = localStorage.getItem('wft_lb_optin') === '1';
  updateCodeNameHint();

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

  document.getElementById('btnLbUpdate').addEventListener('click', updateLeaderboard);

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
      if (chatRoomMeta[currentChatRoomId] && chatRoomMeta[currentChatRoomId].isDm) markDmRead(currentChatRoomId);
    } else {
      localStorage.removeItem('wft_chat_room');
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
      await sb.rpc('leave_chat_room', { p_room_id: currentChatRoomId, p_share_key: shareKey });
      currentChatRoomId = null;
      localStorage.removeItem('wft_chat_room');
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { /* best effort */ }
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
/* Init                                                                 */
/* ---------------------------------------------------------------- */
document.getElementById('headerToday').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

migrateWaterUnitsIfNeeded();
initTabs();
initSwipeNavigation();
document.getElementById('btnGoToBioFromChart').addEventListener('click', () => {
  document.querySelector('.tab-btn[data-target="bio"]').click();
});
initSettingsOverlay();
initDigitalId();
initContact();
initFooterShare();
initPrivacyPolicy();
initTermsOfService();
initPRBoardOverlay();
initIntakeLogOverlay();
initMeasureEntryOverlay();
initEntityIdentityOverlay();
initDateTimeWidget();
initTimezonePicker();
initWeatherWidget();
initWeatherLocationPicker();
initSetupForm();
initCheckin();
initQuickLog();
initMeasurements();
initTraining();
initTrainUnitToggle();
initCardioTracker();
initMissionLog();
initWeightChartToggle();
initNutrition();
initBioLog();
initReviewForm();
initExport();
initDrive();
initLeaderboard();
loadSetupForm();
loadCheckinForm();
loadQuickLog();
renderDashboard();
updateTabDots();
initBetaLock();
if (document.getElementById('lockOverlay').hidden) {
  initOnboarding(() => initReviewGate(() => initConsentGate()));
}

setTimeout(() => {
  const splash = document.getElementById('splashScreen');
  if (!splash) return;
  splash.classList.add('splash-hide');
  setTimeout(() => { splash.hidden = true; }, 400);
  checkDataReminder();
  setTimeout(checkMeasurementReminder, 6000);
}, 2000);


if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

