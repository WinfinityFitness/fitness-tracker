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

function computeHabitCompletion(profile, entry) {
  let total = 3; // reviewed goals, planned tomorrow, workout done
  let done = 0;
  if (entry) {
    if (entry.reviewedGoals) done++;
    if (entry.plannedTomorrow) done++;
    if (entry.exercises && entry.exercises.length > 0) done++;
  }
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
function renderRing(container, pct, opts) {
  opts = opts || {};
  const size = opts.size || 120;
  const stroke = opts.stroke || 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, pct));
  const offset = c - (clamped / 100) * c;
  const center = opts.centerHtml || `<span style="font-size:${Math.round(size * 0.22)}px;font-weight:800;font-family:var(--font-mono);color:var(--text-primary);">${opts.centerText || ''}</span>`;
  container.innerHTML = `
    <div style="position:relative;width:${size}px;height:${size}px;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"></circle>
        <circle class="ring-fill${opts.violet ? ' violet' : ''}" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
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
    });
  });
}

function initSheet() {
  const overlay = document.getElementById('sheetOverlay');
  document.getElementById('btnOpenMore').addEventListener('click', () => {
    overlay.hidden = false;
    renderHistory();
  });
  document.getElementById('btnCloseSheet').addEventListener('click', () => { overlay.hidden = true; });
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
/* Status: dashboard rendering                                         */
/* ---------------------------------------------------------------- */
function renderDashboard() {
  const profile = getProfile();
  const logsArr = sortedLogsArray();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';

  document.getElementById('heroName').textContent = (profile && profile.name) ? profile.name : 'Operator';

  if (profile && profile.startDate) {
    const start = parseISO(profile.startDate);
    const elapsed = daysBetween(new Date(start), new Date());
    const left = Math.max(0, (profile.programDays || 100) - elapsed);
    document.getElementById('daysLeftValue').textContent = left;
  } else {
    document.getElementById('daysLeftValue').textContent = '–';
  }

  const today = todayISO();
  const todayEntry = getLogs()[today];

  const habit = computeHabitCompletion(profile, todayEntry);
  renderRing(document.getElementById('ringHabitCard'), habit.pct, {
    size: 128, centerText: habit.pct + '%', label: 'Habit completion', sub: `${habit.done}/${habit.total} today`,
  });

  const waterGoal = (profile && profile.waterGoal) || 8;
  const waterToday = (todayEntry && todayEntry.water != null) ? todayEntry.water : 0;
  const waterPct = waterGoal > 0 ? (waterToday / waterGoal) * 100 : 0;
  renderRing(document.getElementById('ringHydrationCard'), waterPct, {
    size: 128, violet: true, centerText: Math.round(Math.min(100, waterPct)) + '%', label: 'Hydration', sub: `${waterToday} / ${waterGoal} cups`,
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
    const tile = document.createElement('div');
    tile.className = 'perf-tile';
    tile.innerHTML = `<span class="perf-tile-label">${label}</span>
      <span class="perf-tile-value"><span class="status-dot status-${status}"></span>${val != null ? val.toFixed(1) + ' / 5' : 'N/A'}</span>`;
    perfGrid.appendChild(tile);
  });

  renderWeightChart(trendSeries, wu);
  renderGoalProgress(profile, kgNow, wu);
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
      <div class="ex-card-head">
        <div class="ex-card-title">${escapeHtml(ex.name)}</div>
        <div class="ex-card-rest">⏱ <select class="ex-rest-select" data-ex="${exIdx}">${restOptions}</select></div>
        <button type="button" class="ex-card-remove" data-ex="${exIdx}">✕</button>
      </div>
      <input type="text" class="ex-card-notes" data-ex="${exIdx}" placeholder="Add notes here…" value="${escapeHtml(ex.notes || '')}">
      <table class="ex-sets-table">
        <thead><tr><th>Set</th><th>Previous</th><th>Reps</th><th>${wu}</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button type="button" class="btn btn--sm ex-add-set" data-ex="${exIdx}">+ Add Set</button>
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
    if (driveAccessToken) saveToDrive();
  });

  document.getElementById('btnCloseSummary').addEventListener('click', () => { document.getElementById('summaryOverlay').hidden = true; });
  document.getElementById('btnDoneSummary').addEventListener('click', () => { document.getElementById('summaryOverlay').hidden = true; });

  loadTrainingForDate(todayISO());
  renderTrainingStats();
  initTimer();
}

function renderTrainingStats() {
  const logsArr = sortedLogsArray();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0,0,0,0);
  const recent = logsArr.filter(l => parseISO(l.date) >= cutoff);
  const workouts = recent.filter(l => l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))).length;
  const sets = recent.reduce((sum, l) => sum + (l.exercises || []).reduce((s, ex) => s + ex.sets.filter(st => st.completed).length, 0), 0);
  document.getElementById('statWorkoutsWeek').textContent = workouts;
  document.getElementById('statSetsWeek').textContent = sets;
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
const timerState = { remaining: 180, duration: 180, running: false, intervalId: null };

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderTimerRing() {
  const pct = timerState.duration > 0 ? ((timerState.duration - timerState.remaining) / timerState.duration) * 100 : 0;
  const statusText = timerState.remaining === 0 ? 'Done' : (timerState.running ? 'Resting' : 'Ready');
  const centerHtml = `<div><div class="timer-time${timerState.remaining === 0 ? ' is-done' : ''}">${formatTime(timerState.remaining)}</div><div class="timer-status">${statusText}</div></div>`;
  renderRing(document.getElementById('timerRingWrap'), pct, { size: 180, stroke: 12, centerHtml });
}

function initTimer() {
  const durationInput = document.getElementById('timerDuration');
  const label = document.getElementById('timerDurationLabel');

  durationInput.addEventListener('input', () => {
    const mins = parseInt(durationInput.value, 10);
    label.textContent = `${mins}:00 min`;
    if (!timerState.running) {
      timerState.duration = mins * 60;
      timerState.remaining = mins * 60;
      renderTimerRing();
    }
  });

  document.getElementById('btnTimerStart').addEventListener('click', toggleTimer);
  document.getElementById('btnTimerReset').addEventListener('click', resetTimer);

  const initMins = parseInt(durationInput.value, 10);
  timerState.duration = initMins * 60;
  timerState.remaining = initMins * 60;
  renderTimerRing();
}

function toggleTimer() {
  const btn = document.getElementById('btnTimerStart');
  if (timerState.running) {
    clearInterval(timerState.intervalId);
    timerState.running = false;
    btn.textContent = 'Resume';
  } else {
    if (timerState.remaining <= 0) {
      timerState.remaining = timerState.duration;
    }
    timerState.running = true;
    btn.textContent = 'Pause';
    timerState.intervalId = setInterval(() => {
      timerState.remaining -= 1;
      if (timerState.remaining <= 0) {
        timerState.remaining = 0;
        clearInterval(timerState.intervalId);
        timerState.running = false;
        btn.textContent = 'Start';
        onTimerComplete();
      }
      renderTimerRing();
    }, 1000);
  }
  renderTimerRing();
}

function resetTimer() {
  clearInterval(timerState.intervalId);
  timerState.running = false;
  timerState.remaining = timerState.duration;
  document.getElementById('btnTimerStart').textContent = 'Start';
  renderTimerRing();
}

function onTimerComplete() {
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  playBeep();
}

function autoStartRestTimer(seconds) {
  clearInterval(timerState.intervalId);
  timerState.duration = seconds;
  timerState.remaining = seconds;
  const mins = Math.max(1, Math.min(15, Math.round(seconds / 60)));
  document.getElementById('timerDuration').value = mins;
  document.getElementById('timerDurationLabel').textContent = `${mins}:00 min`;
  timerState.running = true;
  document.getElementById('btnTimerStart').textContent = 'Pause';
  timerState.intervalId = setInterval(() => {
    timerState.remaining -= 1;
    if (timerState.remaining <= 0) {
      timerState.remaining = 0;
      clearInterval(timerState.intervalId);
      timerState.running = false;
      document.getElementById('btnTimerStart').textContent = 'Start';
      onTimerComplete();
    }
    renderTimerRing();
  }, 1000);
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
  document.getElementById('nutWater').value = e.water ?? '';
  document.getElementById('nutSteps').value = e.steps ?? '';
}

function initNutrition() {
  document.getElementById('nutDate').value = todayISO();
  document.getElementById('nutDate').addEventListener('change', e => loadNutritionForDate(e.target.value));

  document.getElementById('btnSaveNutrition').addEventListener('click', () => {
    const date = document.getElementById('nutDate').value;
    updateLogFields(date, {
      calories: parseIntOrNull(document.getElementById('nutCalories').value),
      protein: parseIntOrNull(document.getElementById('nutProtein').value),
      water: parseIntOrNull(document.getElementById('nutWater').value),
      steps: parseIntOrNull(document.getElementById('nutSteps').value),
    });
    document.getElementById('nutSaveNote').textContent = 'Saved intake for ' + date;
    setTimeout(() => { document.getElementById('nutSaveNote').textContent = ''; }, 2000);
    renderNutritionAverages();
  });

  loadNutritionForDate(todayISO());
  renderNutritionTargets();
  renderNutritionAverages();
}

function renderNutritionTargets() {
  const profile = getProfile();
  const list = document.getElementById('nutTargetsList');
  list.innerHTML = '';
  if (!profile) {
    list.innerHTML = '<p class="empty-note">Fill in your profile in Bio to see targets.</p>';
    return;
  }
  const kg = currentWeightKg(profile);
  const targets = kg ? computeTargets(profile, kg) : null;
  const rows = [];
  if (targets) {
    const range = profile.goalMode === 'bulk' ? targets.bulking : targets.cutting;
    rows.push(['Calorie target', `${round0(range[0])}–${round0(range[1])} kcal`]);
    rows.push(['Protein target', `${round0(targets.protein[0])}–${round0(targets.protein[1])} g`]);
  }
  rows.push(['Water goal', `${profile.waterGoal || 8} cups`]);
  rows.forEach(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    list.appendChild(dt); list.appendChild(dd);
  });
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

function initExport() {
  document.getElementById('btnExportWeek').addEventListener('click', () => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0,0,0,0);
    const arr = sortedLogsArray().filter(l => parseISO(l.date) >= cutoff);
    exportCSV(arr, 'fitness-log-week');
  });
  document.getElementById('btnExportAll').addEventListener('click', () => {
    exportCSV(sortedLogsArray(), 'fitness-log-all');
  });

  document.getElementById('btnBackup').addEventListener('click', () => {
    const data = { profile: getProfile(), logs: getLogs(), reviews: getReviews() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `fitness-backup-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

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
    setDriveStatus(localStorage.getItem('wft_drive_connected') ? 'Reconnecting…' : 'Not connected.');
    if (localStorage.getItem('wft_drive_connected')) {
      driveTokenClient.requestAccessToken({ prompt: '' });
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
    if (manual) alert('Not connected to Google Drive yet.');
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
    setDriveStatus('Last synced ' + new Date().toLocaleTimeString());
  } catch (e) {
    setDriveStatus('Sync failed — will retry on next save.');
  }
}

/* ---------------------------------------------------------------- */
/* Init                                                                 */
/* ---------------------------------------------------------------- */
document.getElementById('headerToday').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

initTabs();
initSheet();
initSetupForm();
initCheckin();
initTraining();
initNutrition();
initBioLog();
initReviewForm();
initExport();
initDrive();
loadSetupForm();
loadCheckinForm();
renderDashboard();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

