import { createStore, getPushToken } from './store.js';
import { csvToCourses, coursesToCsv, mergeImport, normalizeCourse, newId } from './csv.js';
import {
  DEFAULT_SETTINGS, computeAlerts, courseStatus, daysLeft, upcomingSessions,
  formatSession, taipeiToday, idleDays
} from './reminders.js';
import {
  AUTO_LOCK_CHOICES, lockSettings, needsUnlock, markUnlocked, markLocked, watchVisibility,
  verifyPin, setPin, clearPin, setAutoLock, isValidPin
} from './lock.js';
import { normalizeNote, isNoteEmpty, parseTags, setupRichEditor } from './notes.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const CATEGORY_EMOJI = {
  心靈成長: '🧘', 理財投資: '💰', 程式設計: '💻', 平面創作: '🎨', 語言學習: '🗣️',
  生活技能: '🏠', 學術報告: '📊', 健康運動: '🏃', 親子教育: '👶', 聲音藝術: '🎤'
};
const DEFAULT_CATEGORIES = Object.keys(CATEGORY_EMOJI);
const STATUS_LABEL = { notStarted: '未開始', inProgress: '學習中', done: '已完成', expired: '已過期' };

const state = {
  store: null,
  courses: [],
  settings: { ...DEFAULT_SETTINGS },
  tab: 'courses',
  editingId: null,
  installPrompt: null,
  locked: false,
  pinEntry: '',
  pinFails: 0,
  pinWaitUntil: 0,
  pinMode: 'set',
  notes: [],
  noteCourse: '',     // 筆記頁的課程篩選：'' 全部、'__none' 未連結課程、或課程 id
  noteDraft: null,    // 編輯中的筆記
  noteDirty: false,
  noteTimer: null,
  rich: null
};

// ---------- 小工具 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = n => 'NT$ ' + Math.round(n || 0).toLocaleString('en-US');
const fmtDate = d => (d ? d.replace(/-/g, '/') : '');
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const linkify = text => esc(text).replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
const icon = name => `<svg class="i"><use href="#i-${name}"/></svg>`;
const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);
const emojiOf = cat => CATEGORY_EMOJI[cat] || '📚';

function hueOf(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------- 啟動 ----------
async function boot() {
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(reg => {
      // APP 常駐在背景時，每次切回來都檢查一次有沒有新版
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(err => console.warn('Service worker 註冊失敗', err));
    // 新版接手後自動重新整理一次，直接換成新畫面
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      try { saveCurrentNote(); } catch { /* 忽略 */ }
      setTimeout(() => location.reload(), 300);
    });
  }
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); state.installPrompt = e; if (state.tab === 'settings') renderSettings(); });

  try { state.tab = localStorage.getItem('lc.tab') || 'courses'; } catch { /* 忽略 */ }

  state.locked = needsUnlock();
  bindLock();
  updateScreens();

  // 回呼可能在 createStore 完成前就被呼叫，所以先等 store 就緒
  const storeReady = createStore({
    onAuth: async user => {
      state.store = await storeReady;
      state.user = user;
      updateScreens();
      if (user) {
        state.settings = await state.store.getSettings().catch(() => ({ ...DEFAULT_SETTINGS }));
        render();
      }
    },
    onCourses: async courses => {
      state.store = await storeReady;
      state.courses = courses.map(normalizeCourse);
      render();
    },
    onNotes: async notes => {
      state.store = await storeReady;
      state.notes = notes.map(normalizeNote);
      render();
    }
  });
  state.store = await storeReady;
  bindEvents();
  switchTab(state.tab);
}

// 依狀態決定顯示：密碼鎖 > 登入 > 主畫面
function updateScreens() {
  $('#lock').hidden = !state.locked;
  $('#login').hidden = state.locked || !!state.user || state.user === undefined;
  $('#app').hidden = state.locked || !state.user;
  $('#btn-lock').hidden = !lockSettings().enabled;
  if (state.locked) renderPinDots();
}

// ---------- 密碼鎖 ----------
function bindLock() {
  watchVisibility(() => {
    if (state.locked) return;
    state.locked = true;
    state.pinEntry = '';
    closeNote();
    $$('dialog[open]').forEach(d => d.close());
    updateScreens();
  });
  $('#keypad').addEventListener('click', e => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (key) pressKey(key);
  });
  addEventListener('keydown', e => {
    if (!state.locked) return;
    if (/^\d$/.test(e.key)) pressKey(e.key);
    else if (e.key === 'Backspace') pressKey('back');
  });
  $('#lock-forgot').addEventListener('click', forgotPin);
}

function renderPinDots(error = false) {
  const len = lockSettings().length;
  $('#pin-dots').innerHTML = Array.from({ length: len }, (_, i) => `<i class="${i < state.pinEntry.length ? 'on' : ''}"></i>`).join('');
  $('#pin-dots').classList.toggle('shake', error);
}

async function pressKey(key) {
  if (state.pinChecking) return;
  const wait = Math.ceil((state.pinWaitUntil - Date.now()) / 1000);
  if (wait > 0) { $('#lock-hint').textContent = `請等 ${wait} 秒後再試`; return; }
  if (key === 'back') state.pinEntry = state.pinEntry.slice(0, -1);
  else if (state.pinEntry.length < 6) state.pinEntry += key;
  renderPinDots();
  if (state.pinEntry.length < lockSettings().length) return;

  state.pinChecking = true;
  const ok = await verifyPin(state.pinEntry).finally(() => { state.pinChecking = false; });
  state.pinEntry = '';
  if (ok) {
    state.pinFails = 0;
    state.locked = false;
    markUnlocked();
    $('#lock-hint').textContent = '輸入密碼解鎖';
    updateScreens();
    render();
    return;
  }
  state.pinFails++;
  if (state.pinFails % 5 === 0) state.pinWaitUntil = Date.now() + 30000;
  $('#lock-hint').textContent = state.pinFails % 5 === 0 ? '錯誤太多次，請等 30 秒' : `密碼錯誤（${state.pinFails} 次）`;
  renderPinDots(true);
  setTimeout(() => $('#pin-dots').classList.remove('shake'), 500);
}

async function forgotPin() {
  if (state.store?.mode === 'cloud') {
    if (!confirm('忘記密碼？\n將會登出並清除這台裝置的密碼，重新用 Google 登入即可繼續使用。課程資料在雲端，不會遺失。')) return;
    clearPin();
    state.locked = false;
    await state.store.signOut();
    updateScreens();
  } else {
    alert('本機模式的密碼無法重設。\n若真的忘記，只能清除瀏覽器中這個網站的資料（課程資料也會一起清除，請先確認有備份）。\n建議完成雲端設定，忘記密碼時可用 Google 帳號重設。');
  }
}

function openPinDialog(mode) {
  state.pinMode = mode;
  const form = $('#pin-form');
  form.reset();
  $('#pin-error').textContent = '';
  const titles = { set: '設定密碼', change: '變更密碼', remove: '取消密碼' };
  $('#pin-title').textContent = titles[mode];
  $('#pin-current-field').hidden = mode === 'set';
  $('#pin-new-field').hidden = mode === 'remove';
  $('#pin-confirm-field').hidden = mode === 'remove';
  $('#pin-desc').textContent = mode === 'remove'
    ? '輸入目前的密碼，之後打開 APP 就不需要密碼。'
    : '密碼只存在這台裝置，用來防止別人打開 APP 看到你的課程。每台手機、電腦可以各自設定。';
  $('#pin-dialog').showModal();
  form.querySelector(mode === 'set' ? '[name=pin]' : '[name=current]').focus();
}

async function submitPin(e) {
  e.preventDefault();
  const form = e.target;
  const { current, pin, confirm: again } = Object.fromEntries(new FormData(form));
  const fail = msg => { $('#pin-error').textContent = msg; };
  if (state.pinMode !== 'set' && !(await verifyPin(current))) return fail('目前的密碼不正確');
  if (state.pinMode === 'remove') {
    clearPin();
    $('#pin-dialog').close();
    toast('已取消密碼');
  } else {
    if (!isValidPin(pin)) return fail('密碼需為 4～6 位數字');
    if (pin !== again) return fail('兩次輸入的密碼不一樣');
    await setPin(pin);
    $('#pin-dialog').close();
    toast(state.pinMode === 'set' ? '🔒 密碼已設定' : '密碼已變更');
  }
  updateScreens();
  renderSettings();
}

// ---------- 事件 ----------
function bindEvents() {
  $('#btn-login').addEventListener('click', async () => {
    $('#login-error').textContent = '';
    try { await state.store.signIn(); } catch (e) { $('#login-error').textContent = '登入失敗：' + (e.message || e.code); }
  });

  $$('.tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  ['#q', '#f-category', '#f-status', '#f-sort'].forEach(sel => $(sel).addEventListener('input', renderCourses));

  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]');
    if (!el) {
      if (!e.target.closest('.menu')) $$('details.menu[open]').forEach(d => d.open = false);
      return;
    }
    const { action, id } = el.dataset;
    if (action !== 'go') e.preventDefault();
    if (el.closest('details.menu')) el.closest('details.menu').open = false;
    switch (action) {
      case 'new': openEditor(null); break;
      case 'edit': openEditor(id); break;
      case 'delete': deleteCourse(id); break;
      case 'go': break;
      case 'import': $('#file-import').click(); break;
      case 'export-csv': download(`學習羅盤_${taipeiToday()}.csv`, coursesToCsv(sortedForExport()), 'text/csv;charset=utf-8'); break;
      case 'export-json': download(`學習羅盤備份_${taipeiToday()}.json`, JSON.stringify({ version: 2, courses: state.courses, notes: state.notes, settings: state.settings }, null, 2), 'application/json'); break;
      case 'logout': if (confirm('確定要登出嗎？')) state.store.signOut(); break;
      case 'tab': switchTab(el.dataset.tab); break;
      case 'filter-status': $('#f-status').value = el.dataset.value; $('#f-category').value = ''; switchTab('courses'); renderCourses(); break;
      case 'enable-push': enablePush(el); break;
      case 'test-notify': testNotify(); break;
      case 'install': state.installPrompt?.prompt(); break;
      case 'clear-all': clearAll(); break;
      case 'pin': openPinDialog(el.dataset.mode); break;
      case 'lock-now': closeNote(); markLocked(); state.locked = true; state.pinEntry = ''; updateScreens(); break;
      case 'new-note': openNote(null, { courseId: el.dataset.course ?? (state.noteCourse !== '__none' ? state.noteCourse : '') }); break;
      case 'open-note': openNote(id); break;
      case 'course-notes': state.noteCourse = id; $('#nq').value = ''; switchTab('notes'); break;
      case 'note-tag': $('#nq').value = el.dataset.tag; renderNotes(); break;
    }
  });

  // 筆記
  $('#nq').addEventListener('input', renderNotes);
  $('#n-course').addEventListener('change', e => { state.noteCourse = e.target.value; renderNotes(); });
  $('#note-grid').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.note-card')) { e.preventDefault(); openNote(e.target.dataset.id); }
  });
  bindNoteEditor();

  // 卡片上的學習能量滑桿：拖動時即時顯示，放開時儲存
  $('#grid').addEventListener('input', e => {
    if (!e.target.matches('.energy input')) return;
    const card = e.target.closest('.card');
    card.querySelector('.energy output').textContent = e.target.value + '%';
    card.querySelector('.energy').style.setProperty('--p', e.target.value + '%');
  });
  $('#grid').addEventListener('change', async e => {
    if (!e.target.matches('.energy input')) return;
    const course = state.courses.find(c => c.id === e.target.closest('.card').dataset.id);
    if (!course) return;
    const energy = Number(e.target.value);
    const now = new Date().toISOString();
    await saveCourse({ ...course, energy, lastStudiedAt: energy > course.energy ? now : course.lastStudiedAt, updatedAt: now });
    if (energy === 100 && course.energy < 100) toast(`🎉 恭喜完成《${course.name}》！`);
  });
  $('#grid').addEventListener('click', e => {
    const note = e.target.closest('.note');
    if (note && !e.target.closest('a')) note.classList.toggle('open');
  });

  $('#file-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });

  // 編輯視窗
  const form = $('#editor-form');
  form.energy.addEventListener('input', () => { $('#energy-out').textContent = form.energy.value + '%'; });
  $('#btn-add-session').addEventListener('click', () => addSessionRow({ at: '', label: '' }, true));
  $('#sessions').addEventListener('click', e => { if (e.target.closest('[data-remove]')) e.target.closest('.session-row').remove(); });
  $$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  form.addEventListener('submit', submitEditor);
  $('#pin-form').addEventListener('submit', submitPin);

  $('#view-settings').addEventListener('change', e => {
    if (e.target.name === 'autoLock') { setAutoLock(Number(e.target.value)); toast('自動上鎖已更新'); return; }
    if (e.target.closest('[data-setting]')) saveSettingsFromForm();
  });
}

function switchTab(tab) {
  state.tab = tab;
  try { localStorage.setItem('lc.tab', tab); } catch { /* 忽略 */ }
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + tab; });
  $('#hero').hidden = tab !== 'courses';
  render();
  scrollTo({ top: 0 });
}

// ---------- 資料操作 ----------
async function saveCourse(course) {
  try { await state.store.save(normalizeCourse(course)); }
  catch (e) { toast('儲存失敗：' + e.message); }
}

async function deleteCourse(id) {
  const course = state.courses.find(c => c.id === id);
  if (!course || !confirm(`確定要刪除《${course.name}》嗎？\n刪除後無法復原（建議先備份）。`)) return;
  await state.store.remove(id);
  toast('已刪除');
}

async function clearAll() {
  if (!confirm(`確定要刪除全部 ${state.courses.length} 門課嗎？\n請先下載備份，刪除後無法復原。`)) return;
  if (prompt('請輸入「刪除」二字確認') !== '刪除') return;
  await state.store.removeAll();
  toast('已清空全部課程');
}

async function importFile(file) {
  try {
    const text = await file.text();
    let incoming;
    let notes = [];
    let settings = null;
    if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
      const data = JSON.parse(text);
      incoming = (Array.isArray(data) ? data : data.courses || []).map(normalizeCourse);
      notes = (data.notes || []).map(normalizeNote);
      settings = data.settings || null;
    } else {
      incoming = csvToCourses(text);
    }
    if (!incoming.length && !notes.length) { toast('檔案裡沒有找到課程或筆記'); return; }
    const { courses, added, updated } = mergeImport(state.courses, incoming);
    const sessions = sum(courses, c => c.sessions.length);
    const noteNew = notes.filter(n => !state.notes.some(o => o.id === n.id)).length;
    const lines = [];
    if (courses.length) lines.push(`・課程 ${courses.length} 門：新增 ${added}、更新 ${updated}（以課程名稱＋購買日期比對），共 ${sessions} 個上課場次`);
    if (notes.length) lines.push(`・筆記 ${notes.length} 篇：新增 ${noteNew}、更新 ${notes.length - noteNew}`);
    if (!confirm(`即將匯入：\n${lines.join('\n')}\n\n確定匯入？`)) return;
    if (courses.length) await state.store.saveMany(courses);
    if (notes.length) await state.store.saveNotes(notes);
    if (settings) {
      state.settings = { ...DEFAULT_SETTINGS, ...settings };
      await state.store.saveSettings(state.settings);
    }
    toast(`匯入完成${courses.length ? `：課程新增 ${added}、更新 ${updated}` : ''}${notes.length ? `；筆記 ${notes.length} 篇` : ''}`);
  } catch (e) {
    toast('匯入失敗：' + e.message);
  }
}

function sortedForExport() {
  return [...state.courses].sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''));
}

// ---------- 畫面 ----------
function render() {
  if (!state.user) return;
  renderHero();
  renderFilters();
  const alerts = computeAlerts(state.courses, state.settings);
  const urgent = alerts.expiring.filter(a => a.daysLeft <= 7).length + alerts.sessions.filter(a => a.daysUntil <= 1).length;
  $('#alert-count').hidden = !urgent;
  $('#alert-count').textContent = urgent;
  if (state.tab === 'courses') renderCourses();
  if (state.tab === 'notes') renderNotes();
  if (state.tab === 'alerts') renderAlerts(alerts);
  if (state.tab === 'stats') renderStats();
  if (state.tab === 'settings') renderSettings();
}

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (hour < 5) return ['夜深了，領航者', '🌙'];
  if (hour < 11) return ['早安，領航者', '🌤️'];
  if (hour < 14) return ['午安，領航者', '☀️'];
  if (hour < 18) return ['下午好，領航者', '🍵'];
  return ['晚安，領航者', '🌙'];
}

function energyRing(percent) {
  const r = 34, c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="${r}" class="ring-track"/>
    <circle cx="40" cy="40" r="${r}" class="ring-bar" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - percent / 100)}"/>
  </svg>`;
}

function renderHero() {
  const list = state.courses;
  const total = sum(list, c => c.price);
  const learned = sum(list, c => c.price * c.energy / 100);
  const avg = list.length ? Math.round(sum(list, c => c.energy) / list.length) : 0;
  const today = taipeiToday();
  const done = list.filter(c => courseStatus(c, today) === 'done').length;
  const alerts = computeAlerts(list, state.settings);
  const [hello, emoji] = greeting();
  const dateText = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());

  let next;
  const s = alerts.sessions[0];
  const x = alerts.expiring[0];
  if (s) {
    next = `<small>下一站・${s.daysUntil === 0 ? '今天' : s.daysUntil === 1 ? '明天' : `${s.daysUntil} 天後`}</small>
      <strong>${esc(s.course.name)}</strong><span>${icon('cal')}${formatSession(s.session.at)} ${esc(s.session.label)}</span>`;
  } else if (x) {
    next = `<small>記得看完・剩 ${x.daysLeft} 天</small><strong>${esc(x.course.name)}</strong><span>${icon('clock')}${fmtDate(x.course.accessUntil)} 到期</span>`;
  } else {
    next = `<small>下一站</small><strong>近期沒有行程</strong><span>${icon('heart')}挑一門喜歡的課，繼續前進吧</span>`;
  }

  $('#hero').innerHTML = `
    <div class="greeting">
      <p class="eyebrow">${dateText}</p>
      <h1>${hello} <span class="wave">${emoji}</span></h1>
      <p>每一份投入，都會在未來某個時刻化作陽光。今天也往前走一小步吧。</p>
    </div>
    <div class="bento">
      <div class="tile-invest">
        <small>${icon('coins')}學習投資總額</small>
        <strong>${money(total)}</strong>
        <span>${list.length} 門課・已吸收 ${money(learned)}</span>
      </div>
      <div class="tile-ring">
        <div class="ring-wrap">${energyRing(avg)}<b>${avg}<em>%</em></b></div>
        <div><small>平均學習能量</small><span>已完成 ${done} 門</span></div>
      </div>
      <button type="button" class="tile-next" data-action="tab" data-tab="alerts">${next}</button>
    </div>`;
}

function uniqueValues(key, defaults = []) {
  const counts = new Map(defaults.map(v => [v, 0]));
  state.courses.forEach(c => c[key] && counts.set(c[key], (counts.get(c[key]) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

function renderFilters() {
  const sel = $('#f-category');
  const current = sel.value;
  const cats = uniqueValues('category');
  sel.innerHTML = `<option value="">全部分類</option>` + cats.map(c => `<option value="${esc(c)}">${emojiOf(c)} ${esc(c)}</option>`).join('');
  sel.value = cats.includes(current) ? current : '';
  $('#dl-category').innerHTML = uniqueValues('category', DEFAULT_CATEGORIES).map(v => `<option value="${esc(v)}">`).join('');
  $('#dl-platform').innerHTML = uniqueValues('platform').map(v => `<option value="${esc(v)}">`).join('');
  $('#dl-teacher').innerHTML = uniqueValues('teacher').map(v => `<option value="${esc(v)}">`).join('');
}

function filteredCourses() {
  const today = taipeiToday();
  const q = $('#q').value.trim().toLowerCase();
  const cat = $('#f-category').value;
  const status = $('#f-status').value;
  const list = state.courses.filter(c =>
    (!cat || c.category === cat) &&
    (!status || courseStatus(c, today) === status) &&
    (!q || [c.name, c.teacher, c.platform, c.note, c.category].join(' ').toLowerCase().includes(q)));
  const far = '9999-12-31';
  const sorters = {
    purchaseDesc: (a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''),
    purchaseAsc: (a, b) => (a.purchaseDate || far).localeCompare(b.purchaseDate || far),
    expiry: (a, b) => {
      const ka = a.accessUntil && a.accessUntil >= today ? a.accessUntil : far;
      const kb = b.accessUntil && b.accessUntil >= today ? b.accessUntil : far;
      return ka.localeCompare(kb);
    },
    priceDesc: (a, b) => b.price - a.price,
    energyAsc: (a, b) => a.energy - b.energy || b.price - a.price,
    energyDesc: (a, b) => b.energy - a.energy
  };
  return list.sort(sorters[$('#f-sort').value] || sorters.purchaseDesc);
}

function expiryBadge(course, today) {
  const left = daysLeft(course, today);
  if (left === null) return `<span class="badge">${icon('clock')}無期限觀看</span>`;
  if (left < 0) return `<span class="badge muted">${icon('clock')}已過期</span>`;
  const cls = left <= 7 ? 'danger' : left <= 30 ? 'warn' : '';
  return `<span class="badge ${cls}" title="到期日 ${fmtDate(course.accessUntil)}">${icon('clock')}${left === 0 ? '今天到期' : `剩餘 ${left} 天`}</span>`;
}

function courseCard(c, today, noteCount = 0) {
  const next = upcomingSessions(c, today)[0];
  const status = courseStatus(c, today);
  const link = safeUrl(c.link);
  const h = hueOf(c.category || '其他');
  return `
  <article class="card ${status}" data-id="${esc(c.id)}" style="--h:${h}">
    <div class="card-top">
      <span class="pill">${emojiOf(c.category)} ${esc(c.category || '未分類')}</span>
      ${expiryBadge(c, today)}
    </div>
    <h3>${esc(c.name)}</h3>
    ${c.note ? `<p class="note" title="點一下展開">${linkify(c.note)}</p>` : ''}
    ${next ? `<p class="next-session">${icon('cal')}<span>下次上課 <b>${formatSession(next.at)}</b> ${esc(next.label)}</span></p>` : ''}
    <div class="meta">
      <span>${icon('user')}${esc(c.teacher || '—')}</span>
      <span>${icon('globe')}${esc(c.platform || '—')}</span>
    </div>
    <div class="price-row">
      <strong>${money(c.price)}</strong>
      ${c.purchaseDate ? `<small>${fmtDate(c.purchaseDate)} 購入</small>` : ''}
    </div>
    <label class="energy" style="--p:${c.energy}%">
      <span>學習能量</span><output>${c.energy}%</output>
      <input type="range" min="0" max="100" step="1" value="${c.energy}" aria-label="《${esc(c.name)}》學習能量">
    </label>
    <div class="card-actions">
      ${link ? `<a class="btn dark" data-action="go" href="${esc(link)}" target="_blank" rel="noopener">前往課程${icon('arrow')}</a>`
             : `<span class="btn dark disabled">尚無連結</span>`}
      <button class="btn soft notes-btn ${noteCount ? 'has' : ''}" type="button" data-action="course-notes" data-id="${esc(c.id)}" aria-label="筆記 ${noteCount} 篇" title="筆記">${icon('note')}${noteCount ? `<b>${noteCount}</b>` : ''}</button>
      <button class="btn soft icon-only" type="button" data-action="edit" data-id="${esc(c.id)}" aria-label="編輯">${icon('edit')}</button>
      <button class="btn plain icon-only" type="button" data-action="delete" data-id="${esc(c.id)}" aria-label="刪除">${icon('trash')}</button>
    </div>
  </article>`;
}

function renderCourses() {
  const today = taipeiToday();
  const list = filteredCourses();
  $('#result-count').textContent = state.courses.length
    ? `共 ${list.length} 門課・${money(sum(list, c => c.price))}` : '';
  const counts = noteCounts();
  $('#grid').innerHTML = list.length ? list.map(c => courseCard(c, today, counts.get(c.id) || 0)).join('') : emptyState();
}

// ---------- 筆記 ----------
function noteCounts() {
  const counts = new Map();
  for (const n of state.notes) if (n.courseId) counts.set(n.courseId, (counts.get(n.courseId) || 0) + 1);
  return counts;
}

const courseById = id => state.courses.find(c => c.id === id);

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const day = taipeiToday(d);
  const today = taipeiToday();
  const time = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  if (day === today) return `今天 ${time}`;
  if (day === taipeiToday(new Date(Date.now() - 86400000))) return `昨天 ${time}`;
  return day.slice(0, 4) === today.slice(0, 4) ? `${day.slice(5, 7)}/${day.slice(8, 10)}` : fmtDate(day);
}

function renderNoteFilters() {
  const sel = $('#n-course');
  const counts = noteCounts();
  const unlinked = state.notes.filter(n => !n.courseId || !courseById(n.courseId)).length;
  const courses = state.courses.filter(c => counts.has(c.id) || c.id === state.noteCourse)
    .sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.name.localeCompare(b.name, 'zh-Hant'));
  sel.innerHTML = `<option value="">全部筆記（${state.notes.length}）</option>`
    + `<option value="__none">未連結課程（${unlinked}）</option>`
    + courses.map(c => `<option value="${esc(c.id)}">${emojiOf(c.category)} ${esc(c.name.length > 24 ? c.name.slice(0, 24) + '…' : c.name)}（${counts.get(c.id) || 0}）</option>`).join('');
  sel.value = state.noteCourse;
  if (sel.value !== state.noteCourse) { state.noteCourse = ''; sel.value = ''; }
}

function filteredNotes() {
  const q = $('#nq').value.trim().toLowerCase().replace(/^#/, '');
  const f = state.noteCourse;
  return state.notes.filter(n => {
    const course = courseById(n.courseId);
    if (f === '__none' && course) return false;
    if (f && f !== '__none' && n.courseId !== f) return false;
    if (!q) return true;
    return [n.title, n.text, n.tags.join(' '), course?.name || ''].join(' ').toLowerCase().includes(q);
  }).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

function noteCard(n) {
  const course = courseById(n.courseId);
  const h = hueOf(course?.category || '筆記');
  const preview = n.text.slice(0, 220);
  return `
  <article class="note-card ${n.pinned ? 'pinned' : ''}" data-action="open-note" data-id="${esc(n.id)}" tabindex="0" role="button" style="--h:${h}">
    <div class="note-card-top">
      ${course ? `<span class="pill">${emojiOf(course.category)} ${esc(course.name.length > 18 ? course.name.slice(0, 18) + '…' : course.name)}</span>`
               : '<span class="pill plain">✏️ 隨手記</span>'}
      ${n.pinned ? `<span class="pin-mark" title="已置頂">${icon('pin')}</span>` : ''}
    </div>
    <h3>${esc(n.title || '無標題筆記')}</h3>
    ${preview ? `<p class="note-preview">${esc(preview)}</p>` : ''}
    ${n.tags.length ? `<div class="tag-row">${n.tags.map(t => `<button type="button" class="tag" data-action="note-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    <footer>
      <span>${relTime(n.updatedAt)}</span>
      ${n.todo.total ? `<span class="todo ${n.todo.done === n.todo.total ? 'done' : ''}">${icon('checklist')}${n.todo.done}/${n.todo.total}</span>` : ''}
    </footer>
  </article>`;
}

function renderNotes() {
  renderNoteFilters();
  const list = filteredNotes();
  const course = courseById(state.noteCourse);
  $('#note-count').textContent = state.notes.length ? `共 ${list.length} 篇筆記${course ? `・${course.name}` : ''}` : '';
  if (list.length) {
    $('#note-grid').innerHTML = list.map(noteCard).join('');
  } else if (course) {
    $('#note-grid').innerHTML = `<div class="empty-state">
      <p>《${esc(course.name)}》還沒有筆記 📝</p>
      <p>把上課的重點、心得或待辦記下來吧。</p>
      <button class="btn primary" type="button" data-action="new-note" data-course="${esc(course.id)}">${icon('plus')}為這門課寫第一篇筆記</button>
    </div>`;
  } else {
    $('#note-grid').innerHTML = `<div class="empty-state">
      ${state.notes.length ? '<p>找不到符合條件的筆記</p>' : `<p>還沒有任何筆記 📝</p>
      <p>可以從課程卡片上的 ${icon('note')} 為某門課寫筆記，或在這裡寫一篇隨手記。</p>
      <button class="btn primary" type="button" data-action="new-note">${icon('plus')}新增筆記</button>`}
    </div>`;
  }
}

// ---------- 筆記編輯器 ----------
function bindNoteEditor() {
  const dialog = $('#note-editor');
  state.rich = setupRichEditor({
    body: $('#note-body'),
    toolbar: $('#note-toolbar'),
    linkPop: $('#link-pop'),
    onChange: markNoteDirty,
    onNotice: toast
  });
  ['#note-title', '#note-tags'].forEach(sel => $(sel).addEventListener('input', markNoteDirty));
  $('#note-course').addEventListener('change', markNoteDirty);
  $('#note-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#note-body').focus(); }
  });
  $('#note-pin').addEventListener('click', () => {
    if (!state.noteDraft) return;
    state.noteDraft.pinned = !state.noteDraft.pinned;
    $('#note-pin').setAttribute('aria-pressed', String(state.noteDraft.pinned));
    markNoteDirty();
  });
  $('#note-delete').addEventListener('click', deleteCurrentNote);
  // 先存檔再關閉；dialog 的 close 事件可能延遲觸發，只當作 Esc 等情況的備援
  $$('[data-note-close]').forEach(b => b.addEventListener('click', () => { closeNote(); dialog.close(); }));
  dialog.addEventListener('close', closeNote);
  // 切到背景（換 APP、鎖螢幕）時立刻存檔，避免手機把 APP 關掉時遺失內容
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveCurrentNote();
  });
}

function openNote(id, preset = {}) {
  const existing = id ? state.notes.find(n => n.id === id) : null;
  state.noteDraft = existing ? { ...existing } : normalizeNote({ courseId: preset.courseId || '' });
  state.noteDirty = false;
  const courses = [...state.courses].sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''));
  $('#note-course').innerHTML = '<option value="">不連結課程（隨手記）</option>'
    + courses.map(c => `<option value="${esc(c.id)}">${emojiOf(c.category)} ${esc(c.name)}</option>`).join('');
  $('#note-course').value = courseById(state.noteDraft.courseId) ? state.noteDraft.courseId : '';
  $('#note-title').value = state.noteDraft.title;
  $('#note-tags').value = state.noteDraft.tags.join(', ');
  $('#note-pin').setAttribute('aria-pressed', String(state.noteDraft.pinned));
  state.rich.setHtml(state.noteDraft.html);
  setSaveState(existing ? `上次編輯 ${relTime(existing.updatedAt)}` : '新筆記');
  $('#note-editor').showModal();
  $('#note-editor .note-scroll').scrollTop = 0;
  if (!existing) $('#note-title').focus();
  else $('#note-title').blur();
}

function setSaveState(text) {
  $('#note-save-state').textContent = text;
}

function markNoteDirty() {
  if (!state.noteDraft) return;
  state.noteDirty = true;
  setSaveState('編輯中…');
  clearTimeout(state.noteTimer);
  state.noteTimer = setTimeout(saveCurrentNote, 900);
}

function currentNote() {
  return normalizeNote({
    ...state.noteDraft,
    title: $('#note-title').value,
    html: state.rich.getHtml(),
    tags: parseTags($('#note-tags').value),
    courseId: $('#note-course').value,
    updatedAt: new Date().toISOString()
  });
}

function saveCurrentNote() {
  clearTimeout(state.noteTimer);
  if (!state.noteDraft || !state.noteDirty) return;
  const note = currentNote();
  state.noteDirty = false;
  if (isNoteEmpty(note)) { setSaveState('空白筆記不會儲存'); return; }
  state.noteDraft = note;
  state.store.saveNote(note).catch(e => { toast('筆記儲存失敗：' + e.message); setSaveState('儲存失敗'); });
  setSaveState(navigator.onLine ? '已儲存' : '已存在這台裝置，連線後同步');
  touchCourseStudied(note.courseId);
}

// 寫筆記也算一次學習：每門課每天最多更新一次「最近學習」
function touchCourseStudied(courseId) {
  const course = courseById(courseId);
  if (!course) return;
  const today = taipeiToday();
  if (course.lastStudiedAt && taipeiToday(new Date(course.lastStudiedAt)) === today) return;
  const now = new Date().toISOString();
  saveCourse({ ...course, lastStudiedAt: now, updatedAt: now });
}

function closeNote() {
  if (!state.noteDraft) return;
  saveCurrentNote();
  const draft = state.noteDraft;
  const stored = state.notes.some(n => n.id === draft.id);
  if (stored && isNoteEmpty(currentNote())) {
    state.store.removeNote(draft.id);
    toast('空白筆記已刪除');
  }
  state.noteDraft = null;
  $('#link-pop').hidden = true;
}

async function deleteCurrentNote() {
  const draft = state.noteDraft;
  if (!draft) return;
  const stored = state.notes.some(n => n.id === draft.id);
  if (stored && !confirm(`確定要刪除「${draft.title || '無標題筆記'}」嗎？\n刪除後無法復原。`)) return;
  clearTimeout(state.noteTimer);
  state.noteDraft = null;
  $('#note-editor').close();
  if (stored) {
    await state.store.removeNote(draft.id);
    toast('筆記已刪除');
  }
}

function emptyState() {
  if (state.courses.length) return `<div class="empty-state">找不到符合條件的課程</div>`;
  return `<div class="empty-state">
    <p>還沒有任何課程 🌱</p>
    <p>可以匯入夢想地圖的 CSV 檔，或按「新增課程」手動新增。</p>
    <button class="btn primary" type="button" data-action="import">${icon('upload')}匯入 CSV</button>
  </div>`;
}

function alertItem(c, sideHtml, extra = '') {
  const link = safeUrl(c.link);
  return `<li class="alert-item">
    <div class="alert-main">
      <strong>${esc(c.name)}</strong>
      <small>${emojiOf(c.category)} ${esc(c.category || '未分類')}・${esc(c.platform || '—')}・能量 ${c.energy}%${extra}</small>
    </div>
    <div class="alert-side">${sideHtml}</div>
    <div class="alert-actions">
      ${link ? `<a class="btn dark small" data-action="go" href="${esc(link)}" target="_blank" rel="noopener">前往${icon('arrow')}</a>` : ''}
      <button class="btn soft small icon-only" type="button" data-action="edit" data-id="${esc(c.id)}" aria-label="編輯">${icon('edit')}</button>
    </div>
  </li>`;
}

function renderAlerts(alerts) {
  const { sessions, expiring, stale } = alerts;
  const pushOn = (() => { try { return localStorage.getItem('lc.push') === 'on'; } catch { return false; } })();
  const dayText = d => (d === 0 ? '今天' : d === 1 ? '明天' : `${d} 天後`);
  $('#view-alerts').innerHTML = `
    ${pushOn ? '' : `<div class="callout">${icon('bell')}<div><strong>想在手機收到提醒嗎？</strong><p>到「設定」開啟推播通知，APP 沒打開也會提醒你。</p></div><button class="btn primary small" type="button" data-action="tab" data-tab="settings">前往設定</button></div>`}
    <div class="panel">
      <h2>${icon('cal')}即將上課 <small>未來 14 天</small></h2>
      ${sessions.length ? `<ul class="alert-list">${sessions.map(({ course, session, daysUntil }) =>
        alertItem(course, `<span class="when ${daysUntil <= 1 ? 'danger' : ''}">${dayText(daysUntil)}</span><small>${formatSession(session.at)}</small>`,
          session.label ? `・${esc(session.label)}` : '')).join('')}</ul>`
        : '<p class="muted-text">近期沒有直播或實體課。可在課程的「編輯」中新增上課場次。</p>'}
    </div>
    <div class="panel">
      <h2>${icon('clock')}觀看權限快到期 <small>30 天內・尚未完成</small></h2>
      ${expiring.length ? `<ul class="alert-list">${expiring.map(({ course, daysLeft: left }) =>
        alertItem(course, `<span class="when ${left <= 7 ? 'danger' : 'warn'}">${left === 0 ? '今天' : `剩 ${left} 天`}</span><small>${fmtDate(course.accessUntil)}</small>`)).join('')}</ul>`
        : '<p class="muted-text">沒有快到期的課程 👍</p>'}
    </div>
    <div class="panel">
      <h2>${icon('bell')}好久沒學習 <small>超過 ${state.settings.staleDays} 天・依金額排序</small></h2>
      ${stale.length ? `<ul class="alert-list">${stale.slice(0, 30).map(({ course, idleDays: idle }) =>
        alertItem(course, `<span class="when">${idle} 天</span><small>${course.lastStudiedAt ? '上次學習' : '購入至今'}</small>`)).join('')}</ul>
        ${stale.length > 30 ? `<p class="muted-text">還有 ${stale.length - 30} 門，可在「課程」頁用「能量低到高」排序查看。</p>` : ''}`
        : '<p class="muted-text">每門課都有在前進，太棒了 ☀️</p>'}
    </div>`;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const c of list) {
    const k = keyFn(c) || '未填寫';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  return [...map.entries()].map(([key, items]) => ({
    key, items, count: items.length,
    spend: sum(items, c => c.price),
    energy: Math.round(sum(items, c => c.energy) / items.length)
  }));
}

function barChart(groups, { limit = 12, label = g => esc(g.key) } = {}) {
  const rows = groups.sort((a, b) => b.spend - a.spend || b.count - a.count).slice(0, limit);
  const max = Math.max(1, ...rows.map(g => g.spend));
  return `<div class="bars">${rows.map(g => `
    <div class="bar-row">
      <div class="bar-label">${label(g)}<small>${g.count} 門・能量 ${g.energy}%</small></div>
      <div class="bar-track"><div class="bar" style="width:${(g.spend / max) * 100}%"></div></div>
      <div class="bar-value">${money(g.spend)}</div>
    </div>`).join('')}</div>`;
}

function renderStats() {
  const today = taipeiToday();
  const list = state.courses;
  if (!list.length) { $('#view-stats').innerHTML = emptyState(); return; }
  const total = sum(list, c => c.price);
  const learned = sum(list, c => c.price * c.energy / 100);
  const sleeping = total - learned;
  const byStatus = groupBy(list, c => courseStatus(c, today));
  const statusOrder = ['done', 'inProgress', 'notStarted', 'expired'];
  const statusOf = k => byStatus.find(g => g.key === k) || { count: 0, spend: 0 };
  const paid = list.filter(c => c.price > 0);
  const free = list.length - paid.length;
  const wake = list.filter(c => courseStatus(c, today) !== 'expired' && c.energy < 100)
    .map(c => ({ c, idle: c.price * (100 - c.energy) / 100 }))
    .sort((a, b) => b.idle - a.idle).slice(0, 10);

  $('#view-stats').innerHTML = `
    <div class="stat-tiles">
      <div class="tile"><small>學習投資總額</small><strong>${money(total)}</strong><span>付費 ${paid.length} 門・免費 ${free} 門</span></div>
      <div class="tile"><small>已吸收的價值</small><strong class="ok">${money(learned)}</strong><span>金額 × 學習能量</span></div>
      <div class="tile"><small>沉睡中的資金</small><strong class="warn">${money(sleeping)}</strong><span>還沒學到的部分</span></div>
      <div class="tile"><small>每元學習效益</small><strong>${total ? Math.round(learned / total * 100) : 0}%</strong><span>已吸收 ÷ 總投資</span></div>
    </div>

    <div class="panel">
      <h2>學習進度</h2>
      <div class="stack">${statusOrder.map(k => statusOf(k).count
        ? `<div class="seg ${k}" style="flex:${statusOf(k).count}" title="${STATUS_LABEL[k]} ${statusOf(k).count} 門"></div>` : '').join('')}</div>
      <div class="legend">${statusOrder.map(k => `
        <button type="button" class="legend-item" data-action="filter-status" data-value="${k}">
          <i class="dot ${k}"></i>${STATUS_LABEL[k]}<b>${statusOf(k).count}</b><small>${money(statusOf(k).spend)}</small>
        </button>`).join('')}</div>
    </div>

    <div class="panel">
      <h2>最值得喚醒的課程 <small>依「沉睡金額」排序</small></h2>
      <ul class="alert-list">${wake.map(({ c, idle }) =>
        alertItem(c, `<span class="when warn">${money(idle)}</span><small>沉睡中</small>`, `・閒置 ${idleDays(c, today) ?? '—'} 天`)).join('')}</ul>
    </div>

    <div class="two-col">
      <div class="panel"><h2>依分類</h2>${barChart(groupBy(list, c => c.category), { label: g => `${emojiOf(g.key)} ${esc(g.key)}` })}</div>
      <div class="panel"><h2>依平台</h2>${barChart(groupBy(list, c => c.platform))}</div>
      <div class="panel"><h2>依老師 <small>前 10 名</small></h2>${barChart(groupBy(list, c => c.teacher), { limit: 10 })}</div>
      <div class="panel"><h2>依購買年份</h2>${barChart(groupBy(list, c => (c.purchaseDate || '').slice(0, 4)).sort((a, b) => b.key.localeCompare(a.key)), { label: g => esc(g.key) + ' 年' })}</div>
    </div>`;
}

function renderSettings() {
  const s = state.settings;
  const lock = lockSettings();
  const cloud = state.store.mode === 'cloud';
  const pushOn = (() => { try { return localStorage.getItem('lc.push') === 'on'; } catch { return false; } })();
  const notifPerm = 'Notification' in window ? Notification.permission : 'unsupported';
  const dayChoices = [60, 30, 14, 7, 3, 1, 0];
  const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

  let installHtml;
  if (isStandalone()) installHtml = '<p class="ok-text">✅ 已經以 APP 模式開啟</p>';
  else if (state.installPrompt) installHtml = `<button class="btn primary" type="button" data-action="install">${icon('download')}安裝成 APP</button>`;
  else if (isIos()) installHtml = '<ol class="steps"><li>用 <b>Safari</b> 打開這個網址</li><li>點下方的「分享」按鈕 <span class="kbd">⬆︎</span></li><li>選「加入主畫面」</li><li>之後從主畫面的「學習羅盤」圖示打開</li></ol>';
  else installHtml = '<ol class="steps"><li>Android：用 <b>Chrome</b> 打開，點右上角「⋮」→「安裝應用程式」或「加到主畫面」</li><li>電腦：Chrome／Edge 網址列右側的「安裝」圖示</li></ol>';

  $('#view-settings').innerHTML = `
    <div class="panel">
      <h2>${icon('user')}帳號與同步</h2>
      ${cloud
        ? `<p>已登入 <b>${esc(state.user?.email || '')}</b>，資料會自動同步到所有登入同一帳號的裝置；沒有網路時也能使用，連線後再上傳。</p>
           <button class="btn ghost" type="button" data-action="logout">${icon('logout')}登出</button>`
        : `<p class="warn-text">目前是<b>本機模式</b>：資料只存在這台裝置的瀏覽器裡。完成 SETUP.md 的 Firebase 設定後，就能手機、電腦同步並開啟推播。</p>`}
    </div>

    <div class="panel">
      <h2>${icon('lock')}密碼鎖 <small>只在這台裝置有效</small></h2>
      ${lock.enabled
        ? `<p>🔒 已開啟。打開 APP 時需要輸入 ${lock.length} 位數密碼。</p>
           <div class="settings-grid">
             <fieldset>
               <legend>自動上鎖</legend>
               <select name="autoLock" aria-label="自動上鎖">${AUTO_LOCK_CHOICES.map(([v, label]) => `<option value="${v}" ${lock.autoLockMin === v ? 'selected' : ''}>${label}</option>`).join('')}</select>
             </fieldset>
           </div>
           <div class="row wrap gap-top">
             <button class="btn ghost" type="button" data-action="pin" data-mode="change">${icon('edit')}變更密碼</button>
             <button class="btn danger" type="button" data-action="pin" data-mode="remove">取消密碼</button>
           </div>`
        : `<p class="muted-text">目前沒有密碼，任何人拿到這台裝置都能打開。想保護隱私可以設定 4～6 位數字密碼，隨時可以取消。</p>
           <button class="btn primary" type="button" data-action="pin" data-mode="set">${icon('lock')}設定密碼</button>`}
    </div>

    <div class="panel">
      <h2>${icon('download')}安裝到手機</h2>
      ${installHtml}
    </div>

    <div class="panel">
      <h2>${icon('bell')}推播通知</h2>
      ${isIos() && !isStandalone() ? '<p class="warn-text">iPhone 必須先「加入主畫面」，並從主畫面打開後才能開啟推播（需要 iOS 16.4 以上）。</p>' : ''}
      <p>每天早上 8 點（台灣時間）檢查一次，有需要才會通知：</p>
      <div class="row wrap">
        <button class="btn primary" type="button" data-action="enable-push" ${cloud ? '' : 'disabled'}>${icon('bell')}${pushOn ? '重新註冊這台裝置' : '在這台裝置開啟推播'}</button>
        <button class="btn ghost" type="button" data-action="test-notify">送一則測試通知</button>
      </div>
      <p class="muted-text">通知權限：${{ granted: '已允許', denied: '已封鎖（請到系統設定開啟）', default: '尚未詢問', unsupported: '此瀏覽器不支援' }[notifPerm]}${pushOn ? '・這台裝置已註冊推播' : ''}</p>

      <div class="settings-grid">
        <fieldset data-setting>
          <legend>觀看權限到期前，第幾天提醒</legend>
          <div class="chips">${dayChoices.map(d => `
            <label class="chip"><input type="checkbox" name="expiryNotifyDays" value="${d}" ${s.expiryNotifyDays.includes(d) ? 'checked' : ''}><span>${d === 0 ? '當天' : `${d} 天前`}</span></label>`).join('')}</div>
        </fieldset>
        <fieldset data-setting>
          <legend>直播／實體課</legend>
          <label class="chip"><input type="checkbox" name="sessionNotify" ${s.sessionNotify ? 'checked' : ''}><span>上課前一天與當天提醒</span></label>
        </fieldset>
        <fieldset data-setting>
          <legend>久未學習提醒</legend>
          <label class="inline">超過 <input type="number" name="staleDays" min="3" max="365" value="${s.staleDays}"> 天沒學習，於
            <select name="staleDigestWeekday">${weekdays.map((w, i) => `<option value="${i}" ${Number(s.staleDigestWeekday) === i ? 'selected' : ''}>${w}</option>`).join('')}</select>
            推播一次摘要</label>
          <p class="muted-text">移動課程卡片上的「學習能量」就會記錄為最近一次學習。</p>
        </fieldset>
      </div>
    </div>

    <div class="panel">
      <h2>${icon('upload')}資料</h2>
      <div class="row wrap">
        <button class="btn ghost" type="button" data-action="import">${icon('upload')}匯入 CSV／備份檔</button>
        <button class="btn ghost" type="button" data-action="export-csv">${icon('download')}匯出 CSV</button>
        <button class="btn ghost" type="button" data-action="export-json">${icon('download')}下載完整備份</button>
        <button class="btn danger" type="button" data-action="clear-all">${icon('trash')}清空全部課程</button>
      </div>
    </div>`;
}

async function saveSettingsFromForm() {
  const root = $('#view-settings');
  const s = {
    expiryNotifyDays: [...root.querySelectorAll('[name=expiryNotifyDays]:checked')].map(i => Number(i.value)),
    sessionNotify: root.querySelector('[name=sessionNotify]').checked,
    staleDays: Math.max(3, Number(root.querySelector('[name=staleDays]').value) || DEFAULT_SETTINGS.staleDays),
    staleDigestWeekday: Number(root.querySelector('[name=staleDigestWeekday]').value)
  };
  state.settings = s;
  try { await state.store.saveSettings(s); toast('提醒設定已儲存'); }
  catch (e) { toast('儲存失敗：' + e.message); }
}

async function enablePush(button) {
  button.disabled = true;
  try {
    await getPushToken(state.store);
    try { localStorage.setItem('lc.push', 'on'); } catch { /* 忽略 */ }
    toast('✅ 推播已開啟，之後會在這台裝置收到提醒');
    renderSettings();
  } catch (e) {
    toast(e.message);
    button.disabled = false;
  }
}

async function testNotify() {
  if (!('Notification' in window)) { toast('這個瀏覽器不支援通知'); return; }
  if (await Notification.requestPermission() !== 'granted') { toast('通知權限未開啟'); return; }
  const reg = await navigator.serviceWorker?.ready;
  const alerts = computeAlerts(state.courses, state.settings);
  const body = `即將上課 ${alerts.sessions.length} 堂・快到期 ${alerts.expiring.length} 門・久未學習 ${alerts.stale.length} 門`;
  if (reg) reg.showNotification('🧭 學習羅盤', { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './' } });
  else new Notification('🧭 學習羅盤', { body });
  renderSettings();
}

// ---------- 編輯視窗 ----------
function addSessionRow(session, focus = false) {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.innerHTML = `
    <input type="datetime-local" value="${esc(session.at.length === 10 ? session.at + 'T00:00' : session.at)}" aria-label="上課時間">
    <input type="text" value="${esc(session.label)}" placeholder="說明（例如：第一週）" aria-label="場次說明">
    <button type="button" class="btn plain icon-only" data-remove aria-label="移除場次">${icon('x')}</button>`;
  $('#sessions').append(row);
  if (focus) row.querySelector('input').focus();
}

function openEditor(id) {
  const course = id ? state.courses.find(c => c.id === id) : null;
  state.editingId = course ? course.id : null;
  const form = $('#editor-form');
  form.reset();
  const c = course || { energy: 0, purchaseDate: taipeiToday(), sessions: [] };
  for (const key of ['name', 'teacher', 'category', 'platform', 'price', 'purchaseDate', 'accessUntil', 'energy', 'link', 'note']) {
    form[key].value = c[key] ?? '';
  }
  $('#energy-out').textContent = (c.energy || 0) + '%';
  $('#sessions').innerHTML = '';
  (c.sessions || []).forEach(s => addSessionRow(s));
  $('#editor-title').textContent = course ? '編輯課程' : '新增課程';
  $('#editor').showModal();
}

async function submitEditor(e) {
  e.preventDefault();
  const form = e.target;
  const old = state.courses.find(c => c.id === state.editingId);
  const now = new Date().toISOString();
  const energy = Number(form.energy.value);
  const sessions = $$('#sessions .session-row').map(r => {
    const [at, label] = r.querySelectorAll('input');
    return { at: at.value, label: label.value.trim() };
  }).filter(s => s.at).sort((a, b) => a.at.localeCompare(b.at));
  const course = {
    ...(old || { id: newId(), createdAt: now }),
    name: form.name.value, teacher: form.teacher.value, category: form.category.value,
    platform: form.platform.value, price: form.price.value, purchaseDate: form.purchaseDate.value,
    accessUntil: form.accessUntil.value, energy, link: form.link.value, note: form.note.value,
    sessions, updatedAt: now,
    lastStudiedAt: old && energy > old.energy ? now : old?.lastStudiedAt || null
  };
  $('#editor').close();
  await saveCourse(course);
  toast(old ? '已更新' : '已新增課程 🌱');
}

boot().catch(e => {
  console.error(e);
  document.body.innerHTML = `<p style="padding:24px">啟動失敗：${esc(e.message)}</p>`;
});
