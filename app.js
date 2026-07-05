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
    !!(entry && entry.struggles && entry.struggles.trim() !== ''), // struggles today
    !!(entry && entry.improveTomorrow && entry.improveTomorrow.trim() !== ''), // how to do better tomorrow
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
  const glow = opts.gradient ? `filter: drop-shadow(0 0 6px var(--gradient-glow));` : '';
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
function initTabs() {
  const btns = document.querySelectorAll('.tab-btn[data-target]');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      document.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.tab !== target);
      btns.forEach(b => b.classList.toggle('is-active', b === btn));
      if (target === 'status') { loadCheckinForm(); renderDashboard(); }
      if (target === 'training') {
        loadTrainingForDate(document.getElementById('trainDate').value);
        renderTrainingStats();
        renderTimerRing();
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
      }
      if (target === 'leaderboard' && sbConfigured()) {
        pullLeaderboard().then(renderNexusRankings).catch(() => {});
        fetchChatMessages().then(renderChatMessages).catch(() => {});
        startNexusPolling();
      } else {
        stopNexusPolling();
      }
    });
  });
}

let nexusPollId = null;
function startNexusPolling() {
  stopNexusPolling();
  nexusPollId = setInterval(() => {
    fetchChatMessages().then(renderChatMessages).catch(() => {});
  }, 5000);
}
function stopNexusPolling() {
  if (nexusPollId) { clearInterval(nexusPollId); nexusPollId = null; }
}

function initSheet() {
  const overlay = document.getElementById('sheetOverlay');
  document.getElementById('btnOpenMore').addEventListener('click', () => {
    overlay.hidden = false;
    renderHistory();
    renderMeasureHistory();
  });
  document.getElementById('btnCloseSheet').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

function initContact() {
  const overlay = document.getElementById('contactOverlay');
  document.getElementById('btnFooterContact').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseContact').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
}

/* ---------------------------------------------------------------- */
/* Bio: profile form                                                   */
/* ---------------------------------------------------------------- */
function initSetupForm() {
  const form = document.getElementById('setupForm');
  const heightUnitSel = document.getElementById('setupHeightUnit');
  const cmField = document.getElementById('heightCmField');
  const ftInField = document.getElementById('heightFtInField');

  heightUnitSel.addEventListener('change', () => {
    cmField.hidden = heightUnitSel.value !== 'cm';
    ftInField.hidden = heightUnitSel.value !== 'ftin';
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
      waterGoal: parseInt(document.getElementById('setupWaterGoal').value, 10) || 8,
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
  });
}

function loadSetupForm() {
  const p = getProfile();
  if (!p) { renderExtraHabitFields({ extraHabits: [] }); return; }
  document.getElementById('setupName').value = p.name || '';
  document.getElementById('setupWeightUnit').value = p.weightUnit || 'kg';
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
  document.getElementById('setupWaterGoal').value = p.waterGoal || 8;
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
  });

  loadBioForDate(todayISO());
  renderSleepBarChart();
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
    updateLogFields(date, {
      extra,
      reviewedGoals: document.getElementById('statusReviewedGoals').checked,
      plannedTomorrow: document.getElementById('statusPlannedTomorrow').checked,
      struggles: document.getElementById('statusStruggles').value,
      improveTomorrow: document.getElementById('statusImprove').value,
    });
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
  document.getElementById('statusReviewedGoals').checked = !!e.reviewedGoals;
  document.getElementById('statusPlannedTomorrow').checked = !!e.plannedTomorrow;
  document.getElementById('statusStruggles').value = e.struggles || '';
  document.getElementById('statusImprove').value = e.improveTomorrow || '';
  (profile ? profile.extraHabits || [] : []).forEach((label, i) => {
    if (!label) return;
    const el = document.getElementById('checkinExtra' + i);
    if (el) el.checked = !!(e.extra && e.extra[i]);
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
    setTimeout(() => { note.textContent = ''; }, 2500);
  });

  loadMeasurementsForDate(todayISO());
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
  const container = document.getElementById('pulseSparkline');
  container.innerHTML = '';
  days.forEach(v => {
    const col = document.createElement('div');
    col.className = 'bar-chart-col' + (v > 0 ? ' has-value' : '');
    col.style.height = v > 0 ? `${Math.max(6, (v / max) * 100)}%` : '4%';
    container.appendChild(col);
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

  const waterGoal = (profile && profile.waterGoal) || 8;
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
function renderWeightChart(series, wu) {
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
    const pctX = (x / W) * 100;
    tooltip.style.left = `calc(${pctX}% + 8px)`;
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
    <span><span class="legend-dash"></span>Trend (7-day avg)</span>`;
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

function renderExerciseCards() {
  const container = document.getElementById('exerciseCards');
  const emptyNote = document.getElementById('exerciseEmptyNote');
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const date = document.getElementById('trainDate').value;
  container.innerHTML = '';

  if (!currentExercises.length) { emptyNote.hidden = false; return; }
  emptyNote.hidden = true;

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

    card.innerHTML = `
      <p class="mod-tag">MOD_P_${String(exIdx + 1).padStart(2, '0')}</p>
      <div class="ex-card-head">
        <div class="ex-card-title">${escapeHtml(ex.name)}</div>
        <div class="ex-card-rest">⏱ <select class="ex-rest-select" data-ex="${exIdx}">${restOptions}</select></div>
        <button type="button" class="ex-card-remove" data-ex="${exIdx}">⋮</button>
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

function initTraining() {
  document.getElementById('trainDate').value = todayISO();
  document.getElementById('trainDate').addEventListener('change', e => loadTrainingForDate(e.target.value));

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
    nameInput.value = '';
    nameInput.focus();
  });

  const cards = document.getElementById('exerciseCards');

  cards.addEventListener('click', e => {
    const wu = (getProfile() || {}).weightUnit || 'kg';

    const removeExBtn = e.target.closest('.ex-card-remove');
    if (removeExBtn) {
      currentExercises.splice(parseInt(removeExBtn.dataset.ex, 10), 1);
      persistExercises(); renderExerciseCards(); return;
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
      if (set.completed) autoStartRestTimer(currentExercises[exIdx].restSeconds || 180);
      return;
    }
  });

  cards.addEventListener('change', e => {
    const wu = (getProfile() || {}).weightUnit || 'kg';
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

  document.getElementById('btnFinishWorkout').addEventListener('click', () => {
    persistExercises();
    const date = document.getElementById('trainDate').value;
    const summary = computeWorkoutSummary(date);
    renderWorkoutSummary(summary);
    document.getElementById('summaryOverlay').hidden = false;
    renderTrainingStats();
    saveToDrive();
  });

  document.getElementById('btnCloseSummary').addEventListener('click', () => { document.getElementById('summaryOverlay').hidden = true; });
  document.getElementById('btnDoneSummary').addEventListener('click', () => { document.getElementById('summaryOverlay').hidden = true; });

  loadTrainingForDate(todayISO());
  renderTrainingStats();
  initTimer();
  initSessionTemplates();
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
  rows.forEach(r => {
    const wu = r.wu;
    const curText = `${round2(fromKg(r.current.weightKg, wu))}${wu} × ${r.current.reps}`;
    const prevText = r.previous ? `${round2(fromKg(r.previous.weightKg, wu))}${wu} × ${r.previous.reps}` : '–';
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

/* ---- Rest timer ---- */
const timerState = { remaining: 180, duration: 180, running: false, endAt: null };
let timerTickId = null;

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function saveTimerState() {
  localStorage.setItem('wft_timer_state', JSON.stringify({
    duration: timerState.duration, running: timerState.running, endAt: timerState.endAt, remaining: timerState.remaining,
  }));
}

function loadTimerState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('wft_timer_state')); } catch (e) { /* ignore */ }
  if (!saved) return;
  timerState.duration = saved.duration || 180;
  if (saved.running && saved.endAt) {
    const remaining = Math.round((saved.endAt - Date.now()) / 1000);
    if (remaining > 0) {
      timerState.running = true;
      timerState.endAt = saved.endAt;
      timerState.remaining = remaining;
    } else {
      timerState.running = false;
      timerState.endAt = null;
      timerState.remaining = 0;
    }
  } else {
    timerState.running = false;
    timerState.endAt = null;
    timerState.remaining = saved.remaining != null ? saved.remaining : timerState.duration;
  }
}

function ensureTicking() {
  if (timerTickId) return;
  timerTickId = setInterval(() => {
    if (timerState.running) {
      timerState.remaining = Math.max(0, Math.round((timerState.endAt - Date.now()) / 1000));
      if (timerState.remaining <= 0) {
        timerState.running = false;
        timerState.endAt = null;
        document.getElementById('btnTimerStart').textContent = 'Start';
        saveTimerState();
        onTimerComplete();
      }
    }
    renderTimerRing();
  }, 1000);
}

function renderTimerRing() {
  const pct = timerState.duration > 0 ? ((timerState.duration - timerState.remaining) / timerState.duration) * 100 : 0;
  const statusText = timerState.remaining === 0 ? 'Done' : (timerState.running ? 'Resting' : 'Ready');
  const centerHtml = `<div><div class="timer-time${timerState.remaining === 0 ? ' is-done' : ''}">${formatTime(timerState.remaining)}</div><div class="timer-status">${statusText}</div></div>`;
  renderRing(document.getElementById('timerRingWrap'), pct, { size: 192, stroke: 9, gradient: true, centerHtml });
}

function initTimer() {
  const durationInput = document.getElementById('timerDuration');
  const label = document.getElementById('timerDurationLabel');

  loadTimerState();
  const restoredMins = Math.max(1, Math.min(15, Math.round(timerState.duration / 60)));
  durationInput.value = restoredMins;
  label.textContent = `${restoredMins}:00 min`;
  document.getElementById('btnTimerStart').textContent = timerState.running
    ? 'Pause'
    : (timerState.remaining > 0 && timerState.remaining < timerState.duration ? 'Resume' : 'Start');

  durationInput.addEventListener('input', () => {
    const mins = parseInt(durationInput.value, 10);
    label.textContent = `${mins}:00 min`;
    if (!timerState.running) {
      timerState.duration = mins * 60;
      timerState.remaining = mins * 60;
      saveTimerState();
      renderTimerRing();
    }
  });

  document.getElementById('btnTimerStart').addEventListener('click', toggleTimer);
  document.getElementById('btnTimerReset').addEventListener('click', resetTimer);

  if (timerState.running) ensureTicking();
  renderTimerRing();
}

function toggleTimer() {
  const btn = document.getElementById('btnTimerStart');
  if (timerState.running) {
    timerState.remaining = Math.max(0, Math.round((timerState.endAt - Date.now()) / 1000));
    timerState.running = false;
    timerState.endAt = null;
    btn.textContent = 'Resume';
  } else {
    if (timerState.remaining <= 0) timerState.remaining = timerState.duration;
    timerState.running = true;
    timerState.endAt = Date.now() + timerState.remaining * 1000;
    btn.textContent = 'Pause';
    ensureTicking();
  }
  saveTimerState();
  renderTimerRing();
}

function resetTimer() {
  timerState.running = false;
  timerState.endAt = null;
  timerState.remaining = timerState.duration;
  document.getElementById('btnTimerStart').textContent = 'Start';
  saveTimerState();
  renderTimerRing();
}

function onTimerComplete() {
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  playBeep();
}

function autoStartRestTimer(seconds) {
  timerState.duration = seconds;
  timerState.remaining = seconds;
  timerState.running = true;
  timerState.endAt = Date.now() + seconds * 1000;
  const mins = Math.max(1, Math.min(15, Math.round(seconds / 60)));
  document.getElementById('timerDuration').value = mins;
  document.getElementById('timerDurationLabel').textContent = `${mins}:00 min`;
  document.getElementById('btnTimerStart').textContent = 'Pause';
  ensureTicking();
  saveTimerState();
  renderTimerRing();
}

function playBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.3, 0.6].forEach(t => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.22);
    });
  } catch (e) { /* Web Audio unavailable; vibration still fires */ }
}

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
      water: parseIntOrNull(document.getElementById('nutWater').value),
      steps: parseIntOrNull(document.getElementById('nutSteps').value),
    });
    document.getElementById('nutSaveNote').textContent = 'Saved intake for ' + date;
    setTimeout(() => { document.getElementById('nutSaveNote').textContent = ''; }, 2000);
    renderNutritionAverages();
    renderNutritionTargets();
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
  const waterTarget = profile.waterGoal || 8;

  const date = document.getElementById('nutDate').value;
  const entry = getLogs()[date] || {};
  const caloriesNow = entry.calories ?? 0;
  const proteinNow = entry.protein ?? 0;
  const carbsNow = entry.carbs ?? 0;
  const fatNow = entry.fat ?? 0;
  const fiberNow = entry.fiber ?? 0;
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
    'Steps', 'Calories', 'Protein (g)', 'Water (16oz cups)', 'Workout Done', 'Exercises', 'Menstruating',
    'Reviewed Goals', 'Planned Tomorrow', ...habitLabels.map(h => h.label), 'Struggles', 'Improve Tomorrow'];
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
      l.reviewedGoals ? 'Yes' : 'No', l.plannedTomorrow ? 'Yes' : 'No',
      ...habitLabels.map(h => (l.extra && l.extra[h.idx]) ? 'Yes' : 'No'),
      l.struggles || '', l.improveTomorrow || '',
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
  const csv = buildCSV(logsArr, profile);
  const filename = `${filenamePrefix}-${todayISO()}.csv`;
  const blob = new Blob([csv], { type: 'text/csv' });
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
  rows.slice(0, 5).forEach((r, i) => {
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

async function fetchChatMessages() {
  const { data, error } = await sb.from('chat_messages')
    .select('code_name, message, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data || []).slice().reverse();
}

async function postChatMessage(text) {
  const trimmed = text.trim().slice(0, 280);
  if (!trimmed) return;
  const { error } = await sb.from('chat_messages').insert({
    code_name: effectiveLeaderboardName(),
    message: trimmed,
  });
  if (error) throw error;
}

function renderChatMessages(messages) {
  const list = document.getElementById('lbChatList');
  list.innerHTML = '';
  if (!messages.length) {
    list.innerHTML = '<p class="empty-note">No messages yet. Say hi!</p>';
    return;
  }
  messages.forEach(m => {
    const row = document.createElement('div');
    row.className = 'chat-row';
    const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `<span class="chat-time">[${time}]</span> <span class="chat-name">${escapeHtml(m.code_name)}:</span> <span class="chat-msg">${escapeHtml(m.message)}</span>`;
    list.appendChild(row);
  });
  list.scrollTop = list.scrollHeight;
}

async function updateLeaderboard() {
  const note = document.getElementById('lbSaveNote');
  note.textContent = 'Syncing…';
  try {
    if (localStorage.getItem('wft_lb_optin') === '1') await pushLeaderboardEntry();
    const rows = await pullLeaderboard();
    renderNexusRankings(rows);
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
      if (!localStorage.getItem('wft_lb_share_key')) localStorage.setItem('wft_lb_share_key', generateShareKey());
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

  if (!sbConfigured()) {
    document.getElementById('lbSaveNote').textContent = 'Nexus not set up yet.';
    optInEl.disabled = true;
    document.getElementById('btnLbUpdate').disabled = true;
    document.getElementById('btnLbChatSend').disabled = true;
  }
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
function initReviewGate() {
  if (localStorage.getItem('wft_review_confirmed')) return;
  if (!document.getElementById('lockOverlay').hidden) return; // beta already ended, skip

  const overlay = document.getElementById('reviewGateOverlay');
  overlay.hidden = false;
  document.getElementById('btnReviewConfirm').addEventListener('click', () => {
    localStorage.setItem('wft_review_confirmed', '1');
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

initTabs();
document.getElementById('btnGoToBioFromChart').addEventListener('click', () => {
  document.querySelector('.tab-btn[data-target="bio"]').click();
});
initSheet();
initContact();
initSetupForm();
initCheckin();
initMeasurements();
initTraining();
initNutrition();
initBioLog();
initReviewForm();
initExport();
initDrive();
initLeaderboard();
loadSetupForm();
loadCheckinForm();
renderDashboard();
initBetaLock();
if (document.getElementById('lockOverlay').hidden) {
  initOnboarding(() => initReviewGate());
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

