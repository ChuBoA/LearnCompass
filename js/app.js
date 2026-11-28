import { createStore, getPushToken } from './store.js';
import { csvToCourses, coursesToCsv, mergeImport, normalizeCourse, newId, sessionLink } from './csv.js';
import {
  DEFAULT_SETTINGS, computeAlerts, courseStatus, daysLeft, upcomingSessions,
  formatSession, taipeiToday, idleDays, dayDiff,
  TRAVEL_MODES, isOnsite, sessionPlace, mapsDirUrl, mapsSearchUrl
} from './reminders.js';
import {
  AUTO_LOCK_CHOICES, lockSettings, needsUnlock, markUnlocked, markLocked, watchVisibility,
  verifyPin, setPin, clearPin, setAutoLock, isValidPin
} from './lock.js';
import { normalizeNote, normalizeAttachment, isNoteEmpty, parseTags, setupRichEditor } from './notes.js';
import {
  CURRENCIES, SUB_CATEGORIES, normalizeSub, isActive, nextCharge, paidCount, rateOf, toTwd, monthlyTwd,
  cycleLabel, priceText, computeSubAlerts, estimateTwd, chargeTwd, usesActual, chargeHistory, paidSummary, defaultFeePct,
  subStatus, isPaused, periodStats, computeResumeAlerts, validatePeriods, accessEnd, willRenew, isEnding,
  extSpans, addCycles
} from './subs.js';
import { fetchTwdRates, RATE_REFRESH_MS } from './rates.js';
import {
  MAX_FILE_BYTES, MAX_ATTACHMENTS, NeedAuthError, driveConfigured, driveConnected, driveTokenExpiry,
  setDriveAccount, preloadDrive, connectDrive, disconnectDrive, processQueue, prepareImage,
  enqueueUpload, enqueueTrash, dropUpload, queueAll, localBlob, fetchDriveFile
} from './drive.js';

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
  rich: null,
  notesLoaded: false,
  subs: [],
  subFilter: 'active',  // active | month | year | cancelled | all
  editingSubId: null,
  subPeriods: [],       // 編輯視窗裡的訂閱期間（草稿）
  localPending: new Set(), // 這台裝置還沒上傳到雲端硬碟的附件 id
  uploadingId: null,
  driveError: ''
};

// ---------- 小工具 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = n => 'NT$ ' + Math.round(n || 0).toLocaleString('en-US');
const fmtDate = d => (d ? d.replace(/-/g, '/') : '');
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const linkify = text => esc(text).replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
const icon = name => `<svg class="i"><use href="#i-${name}"/></svg>`;
// 場次的「上課連結」按鈕
const sessionLinkBtn = (session, cls = 'btn dark small') => {
  const link = safeUrl(session?.link);
  return link ? `<a class="${cls}" data-action="go" href="${esc(link)}" target="_blank" rel="noopener">上課連結${icon('arrow')}</a>` : '';
};
// 場次的主要按鈕：實體課「導航」（可加「看地圖」），直播課「上課連結」
function sessionActions(course, session, cls = 'btn dark small', withMap = false) {
  if (!isOnsite(session)) return sessionLinkBtn(session, cls);
  const place = sessionPlace(course, session);
  if (!place) return '';
  const nav = `<a class="${cls}" data-action="go" href="${esc(mapsDirUrl(place, state.settings.travelMode))}" target="_blank" rel="noopener">${icon('nav')}導航</a>`;
  const map = withMap ? `<a class="btn ghost small" data-action="go" href="${esc(mapsSearchUrl(place))}" target="_blank" rel="noopener">${icon('place')}看地圖</a>` : '';
  return nav + map;
}
// 實體課的地點文字（直播課回傳空字串）
const placeText = (course, session) => {
  if (!isOnsite(session)) return '';
  const place = sessionPlace(course, session);
  return place ? `📍 ${esc(place)}` : '📍 實體課（還沒填地點）';
};
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
      setDriveAccount(user?.email);
      updateScreens();
      if (user) {
        state.settings = await state.store.getSettings().catch(() => ({ ...DEFAULT_SETTINGS }));
        updateRates(false);
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
      if (!state.notesLoaded) { state.notesLoaded = true; syncDrive(false); }
    },
    onSubs: async subs => {
      state.store = await storeReady;
      state.subs = subs.map(normalizeSub);
      render();
    }
  });
  state.store = await storeReady;
  bindEvents();
  switchTab(state.tab);
  preloadDrive()?.catch(() => {});
  addEventListener('online', () => syncDrive(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    syncDrive(false);
    if (state.user) updateRates(false);
  });
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
      case 'new': if (state.tab === 'subs') openSubEditor(null); else openEditor(null); break;
      case 'edit-sub': openSubEditor(id); break;
      case 'sub-filter': state.subFilter = el.dataset.value; renderSubs(); break;
      case 'update-rates': updateRates(true); break;
      case 'record-charge': recordCharge(el); break;
      case 'confirm-resume': confirmResume(id); break;
      case 'edit': openEditor(id); break;
      case 'delete': deleteCourse(id); break;
      case 'go': break;
      case 'import': $('#file-import').click(); break;
      case 'export-csv': download(`學習羅盤_${taipeiToday()}.csv`, coursesToCsv(sortedForExport()), 'text/csv;charset=utf-8'); break;
      case 'export-json': download(`學習羅盤備份_${taipeiToday()}.json`, JSON.stringify({ version: 3, courses: state.courses, notes: state.notes, subs: state.subs, settings: state.settings }, null, 2), 'application/json'); break;
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
      case 'drive-connect': syncDrive(true).then(renderSettingsIfOpen); break;
      case 'drive-disconnect':
        if (confirm('中斷與 Google 雲端硬碟的連結？\n已上傳的檔案會留在你的雲端硬碟；之後要看原圖或上傳新附件時再連結即可。')) {
          disconnectDrive(); renderSettingsIfOpen(); toast('已中斷雲端硬碟連結');
        }
        break;
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
  $('#btn-add-session').addEventListener('click', () => {
    // 新場次沿用上一堂的類型；第一堂則看課程有沒有填上課地點
    const rows = $$('#sessions .session-row');
    const mode = rows.length ? rows[rows.length - 1].querySelector('.session-mode').value : (form.location.value.trim() ? 'onsite' : 'online');
    addSessionRow({ at: '', label: '', mode }, true);
  });
  $('#sessions').addEventListener('click', e => { if (e.target.closest('[data-remove]')) e.target.closest('.session-row').remove(); });
  $('#sessions').addEventListener('change', e => {
    if (e.target.matches('.session-mode')) syncSessionRow(e.target.closest('.session-row'));
    if (e.target.matches('.session-place')) showMapPreview(e.target.value.trim() || form.location.value.trim());
  });
  form.location.addEventListener('change', () => {
    $$('#sessions .session-place').forEach(i => { i.placeholder = placePlaceholder(); });
    showMapPreview(form.location.value.trim());
  });
  $$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  form.addEventListener('submit', submitEditor);
  $('#pin-form').addEventListener('submit', submitPin);
  bindSubEditor();

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
  // 右上角的新增按鈕：在訂閱頁就是「新增訂閱」
  $('.top-actions [data-action="new"] span').textContent = tab === 'subs' ? '新增訂閱' : '新增課程';
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
    let subs = [];
    let settings = null;
    if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
      const data = JSON.parse(text);
      incoming = (Array.isArray(data) ? data : data.courses || []).map(normalizeCourse);
      notes = (data.notes || []).map(normalizeNote);
      subs = (data.subs || []).map(normalizeSub);
      settings = data.settings || null;
    } else {
      incoming = csvToCourses(text);
    }
    if (!incoming.length && !notes.length && !subs.length) { toast('檔案裡沒有找到課程、筆記或訂閱'); return; }
    const { courses, added, updated } = mergeImport(state.courses, incoming);
    const sessions = sum(courses, c => c.sessions.length);
    const noteNew = notes.filter(n => !state.notes.some(o => o.id === n.id)).length;
    const lines = [];
    if (courses.length) lines.push(`・課程 ${courses.length} 門：新增 ${added}、更新 ${updated}（以課程名稱＋購買日期比對），共 ${sessions} 個上課場次`);
    if (notes.length) lines.push(`・筆記 ${notes.length} 篇：新增 ${noteNew}、更新 ${notes.length - noteNew}`);
    if (subs.length) lines.push(`・訂閱 ${subs.length} 項`);
    if (!confirm(`即將匯入：\n${lines.join('\n')}\n\n確定匯入？`)) return;
    if (courses.length) await state.store.saveMany(courses);
    if (notes.length) await state.store.saveNotes(notes);
    if (subs.length) await state.store.saveSubs(subs);
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
  const urgent = alerts.expiring.filter(a => a.daysLeft <= 7).length + alerts.sessions.filter(a => a.daysUntil <= 1).length
    + computeSubAlerts(state.subs, new Date(), 3).length + computeResumeAlerts(state.subs, new Date(), 3).length;
  $('#alert-count').hidden = !urgent;
  $('#alert-count').textContent = urgent;
  if (state.tab === 'courses') renderCourses();
  if (state.tab === 'notes') renderNotes();
  if (state.tab === 'subs') renderSubs();
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
      <strong>${esc(s.course.name)}</strong><span>${icon('cal')}${formatSession(s.session.at)} ${esc(s.session.label)}</span>${isOnsite(s.session) ? `<small class="hero-place">${placeText(s.course, s.session)}</small>` : ''}`;
  } else if (x) {
    next = `<small>記得看完・剩 ${x.daysLeft} 天</small><strong>${esc(x.course.name)}</strong><span>${icon('clock')}${fmtDate(x.course.accessUntil)} 到期</span>`;
  } else {
    next = `<small>下一站</small><strong>近期沒有行程</strong><span>${icon('heart')}挑一門喜歡的課，繼續前進吧</span>`;
  }

  $('#hero').innerHTML = `
    <div class="greeting">
      <p class="eyebrow">${dateText}</p>
      <h1>${hello} <span class="wave">${emoji}</span></h1>
      <p class="motto">每一份投入，都會在未來某個時刻化作陽光。<br>今天也往前走一小步吧。</p>
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
      <div class="tile-next-wrap">
        <button type="button" class="tile-next" data-action="tab" data-tab="alerts">${next}</button>
        ${s ? sessionActions(s.course, s.session, 'btn dark small hero-link') : ''}
      </div>
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
    ${next ? `<p class="next-session ${isOnsite(next) ? 'onsite' : ''}">${icon('cal')}<span>下次上課 <b>${formatSession(next.at)}</b> ${esc(next.label)}${isOnsite(next) ? `<small class="ns-place">${placeText(c, next)}</small>` : ''}</span>${sessionActions(c, next, 'ns-link')}</p>` : ''}
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
  const imgs = n.attachments.filter(a => a.kind === 'image' && a.thumb);
  const cover = imgs[0];
  const imgCount = imgs.length;
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
    ${cover ? `<div class="note-cover"><img src="${cover.thumb}" alt="" loading="lazy">${imgCount > 1 ? `<span>+${imgCount - 1}</span>` : ''}</div>` : ''}
    <footer>
      <span>${relTime(n.updatedAt)}</span>
      ${n.attachments.length ? `<span class="todo">${icon('clip')}${n.attachments.length}</span>` : ''}
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
    onNotice: toast,
    onFiles: addFiles
  });
  bindAttachments(dialog);
  bindPhoneEditor();
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
  renderAttachments();
  setSaveState(existing ? `上次編輯 ${relTime(existing.updatedAt)}` : '新筆記');
  $('#note-editor').showModal();
  syncNoteViewport();
  $('#note-editor .note-scroll').scrollTop = 0;
  if (!existing) $('#note-title').focus();
  else $('#note-title').blur();
}

// ---------- 手機編輯器：工具列固定在鍵盤正上方 ----------
const phoneLayout = matchMedia('(max-width: 720px)');

// 手機鍵盤跳出時，版面高度不會變，畫面還會被往上推，工具列就跑到看不到的地方。
// 這裡讓編輯器的位置與高度，永遠貼齊「鍵盤以外實際看得到的範圍」。
function syncNoteViewport() {
  const dialog = $('#note-editor');
  const vv = window.visualViewport;
  if (!phoneLayout.matches || !vv || !dialog.open) {
    dialog.style.removeProperty('--vv-top');
    dialog.style.removeProperty('--vv-h');
    dialog.classList.remove('keyboard-open');
    return;
  }
  dialog.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
  dialog.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
  dialog.classList.toggle('keyboard-open', document.documentElement.clientHeight - vv.height > 120);
  updateToolbarHint();
  revealCaret();
}

// 工具列可以左右滑：右邊還有按鈕時顯示淡出提示
function updateToolbarHint() {
  const toolbar = $('#note-toolbar');
  toolbar.classList.toggle('has-more', toolbar.scrollLeft + toolbar.clientWidth < toolbar.scrollWidth - 4);
}

// 打字的位置不要被工具列或鍵盤蓋住
function revealCaret() {
  const body = $('#note-body');
  const sel = getSelection();
  if (document.activeElement !== body || !sel.rangeCount) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect.top && !rect.bottom) return;
  const scroller = $('#note-editor .note-scroll');
  const box = scroller.getBoundingClientRect();
  if (rect.bottom > box.bottom - 12) scroller.scrollTop += rect.bottom - box.bottom + 12;
  else if (rect.top < box.top + 12) scroller.scrollTop -= box.top + 12 - rect.top;
}

function bindPhoneEditor() {
  const toolbar = $('#note-toolbar');
  const body = $('#note-body');
  const scroller = $('#note-editor .note-scroll');
  const place = () => {
    if (phoneLayout.matches) scroller.after(toolbar);
    else scroller.insertBefore(toolbar, body);
    syncNoteViewport();
  };
  toolbar.addEventListener('scroll', updateToolbarHint, { passive: true });
  phoneLayout.addEventListener('change', place);
  window.visualViewport?.addEventListener('resize', syncNoteViewport);
  window.visualViewport?.addEventListener('scroll', syncNoteViewport);
  $('#note-editor').addEventListener('focusin', syncNoteViewport);
  body.addEventListener('input', revealCaret);
  place();
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
  // 附件：還沒上傳的直接丟掉，已上傳的移到雲端硬碟的垃圾桶
  for (const a of draft.attachments) await forgetAttachmentFile(a);
  if (stored) {
    await state.store.removeNote(draft.id);
    toast(draft.attachments.length ? '筆記已刪除，附件已移到雲端硬碟的垃圾桶' : '筆記已刪除');
  }
  syncDrive(false);
}

// ---------- 附件（Google 雲端硬碟） ----------
const fmtSize = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const driveLink = a => a.link || (a.driveId ? `https://drive.google.com/file/d/${encodeURIComponent(a.driveId)}/view` : '');

function bindAttachments(dialog) {
  $('#note-toolbar').addEventListener('click', e => {
    const btn = e.target.closest('[data-attach]');
    if (!btn) return;
    if (!driveConfigured()) { toast('尚未設定 Google 雲端硬碟，請依 SETUP.md 第 9 步完成設定'); return; }
    $(btn.dataset.attach === 'image' ? '#attach-image' : '#attach-file').click();
  });
  ['#attach-image', '#attach-file'].forEach(sel => $(sel).addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) addFiles(files);
  }));

  // 拖曳檔案到筆記上（電腦）
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  dialog.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('#drop-hint').hidden = false; });
  dialog.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  dialog.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) $('#drop-hint').hidden = true; });
  dialog.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('#drop-hint').hidden = true;
    addFiles([...e.dataTransfer.files]);
  });

  $('#note-attachments').addEventListener('click', e => {
    const el = e.target.closest('[data-att-act]');
    if (!el || !state.noteDraft) return;
    const att = state.noteDraft.attachments.find(a => a.id === el.dataset.att);
    switch (el.dataset.attAct) {
      case 'sync': syncDrive(true); break;
      case 'remove': if (att) removeAttachment(att); break;
      case 'view': if (att) openAttachment(att); break;
    }
  });

  $('#viewer-close').addEventListener('click', () => $('#viewer').close());
  $('#viewer').addEventListener('click', e => { if (e.target.id === 'viewer' || e.target.id === 'viewer-stage') $('#viewer').close(); });
  $('#viewer').addEventListener('close', () => {
    const img = $('#viewer-img');
    if (img.dataset.blobUrl) URL.revokeObjectURL(img.dataset.blobUrl);
    img.removeAttribute('src');
    delete img.dataset.blobUrl;
  });
}

async function refreshLocalPending() {
  try { state.localPending = new Set((await queueAll()).filter(i => i.op === 'upload').map(i => i.attId)); }
  catch { state.localPending = new Set(); }
}

async function addFiles(files) {
  if (!state.noteDraft) return;
  if (!driveConfigured()) { toast('尚未設定 Google 雲端硬碟，請依 SETUP.md 第 9 步完成設定'); return; }
  const noteId = state.noteDraft.id;
  const room = MAX_ATTACHMENTS - state.noteDraft.attachments.length;
  if (room <= 0) { toast(`每篇筆記最多 ${MAX_ATTACHMENTS} 個附件`); return; }
  if (files.length > room) toast(`每篇筆記最多 ${MAX_ATTACHMENTS} 個附件，只加入前 ${room} 個`);
  setSaveState('處理附件中…');
  let added = 0;
  for (const file of files.slice(0, room)) {
    try {
      let item = null;
      if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
        item = await prepareImage(file).then(p => ({ ...p, kind: 'image' })).catch(() => null);
      }
      if (!item) item = { blob: file, mime: file.type || 'application/octet-stream', name: file.name || '檔案', kind: 'file', thumb: '', w: 0, h: 0 };
      if (item.blob.size > MAX_FILE_BYTES) { toast(`「${file.name}」超過 20 MB，無法加入`); continue; }
      const att = normalizeAttachment({
        id: newId(), kind: item.kind, name: item.name, mime: item.mime, size: item.blob.size,
        w: item.w, h: item.h, thumb: item.thumb, addedAt: new Date().toISOString()
      });
      await enqueueUpload(noteId, att.id, item.blob, att.name, att.mime);
      state.localPending.add(att.id);
      if (!updateNoteAttachments(noteId, list => [...list, att])) { await dropUpload(att.id); break; }
      added++;
    } catch (e) {
      toast(`無法加入「${file.name}」：${e.message}`);
    }
  }
  if (added) syncDrive(false);
  else if (state.noteDraft?.id === noteId) setSaveState('');
}

// 更新某篇筆記的附件清單；筆記正開著就同步更新編輯器
function updateNoteAttachments(noteId, fn) {
  if (state.noteDraft?.id === noteId) {
    state.noteDraft.attachments = fn(state.noteDraft.attachments);
    state.noteDirty = true;
    saveCurrentNote();
    renderAttachments();
    return true;
  }
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return false;
  state.store.saveNote(normalizeNote({ ...note, attachments: fn(note.attachments), updatedAt: new Date().toISOString() }))
    .catch(e => toast('筆記儲存失敗：' + e.message));
  return true;
}

async function onUploaded(noteId, attId, { driveId, link }) {
  state.localPending.delete(attId);
  const note = state.noteDraft?.id === noteId ? state.noteDraft : state.notes.find(n => n.id === noteId);
  // 上傳途中附件或筆記被刪掉了：把剛上傳的檔案移到垃圾桶
  if (!note || !note.attachments.some(a => a.id === attId)) { await enqueueTrash(driveId); return; }
  updateNoteAttachments(noteId, list => list.map(a => (a.id === attId ? normalizeAttachment({ ...a, driveId, link }) : a)));
}

async function forgetAttachmentFile(att) {
  try {
    if (att.driveId) await enqueueTrash(att.driveId);
    else await dropUpload(att.id);
  } catch { /* 忽略 */ }
  state.localPending.delete(att.id);
}

async function removeAttachment(att) {
  if (!confirm(`移除附件「${att.name}」？${att.driveId ? '\n檔案會移到你雲端硬碟的垃圾桶（30 天內可救回）。' : ''}`)) return;
  const noteId = state.noteDraft.id;
  await forgetAttachmentFile(att);
  updateNoteAttachments(noteId, list => list.filter(a => a.id !== att.id));
  syncDrive(false);
}

// interactive = 使用者按了按鈕：沒授權時跳出 Google 授權視窗（必須在點擊當下同步呼叫）
async function syncDrive(interactive) {
  if (!driveConfigured()) return;
  try {
    if (interactive && !driveConnected()) {
      await connectDrive();
      toast('已連結 Google 雲端硬碟');
    }
    state.driveError = '';
    await refreshLocalPending();
    if (driveConnected()) {
      const result = await processQueue(onUploaded, item => {
        state.uploadingId = item.attId || null;
        if (item.attId) renderAttachments();
      });
      if (result.failed) state.driveError = `有 ${result.failed} 個項目同步失敗，稍後會再試`;
      if (interactive && result.done) toast('附件已上傳到雲端硬碟');
    }
  } catch (e) {
    state.driveError = e instanceof NeedAuthError ? '' : e.message;
    if (interactive && !(e instanceof NeedAuthError)) toast(e.message);
  }
  state.uploadingId = null;
  await refreshLocalPending();
  renderAttachments();
  renderSettingsIfOpen();
}

function attStatus(a) {
  if (a.driveId) return { cls: 'done', text: '' };
  if (state.uploadingId === a.id) return { cls: 'busy', text: '上傳中…' };
  if (state.localPending.has(a.id)) return { cls: 'wait', text: driveConnected() && navigator.onLine ? '等待上傳' : '尚未上傳' };
  return { cls: 'remote', text: '在另一台裝置等待上傳' };
}

function renderAttachments() {
  const box = $('#note-attachments');
  const draft = state.noteDraft;
  if (!box || !draft) return;
  const list = draft.attachments;
  box.hidden = !list.length;
  if (!list.length) { box.innerHTML = ''; return; }
  const waiting = list.filter(a => !a.driveId && state.localPending.has(a.id) && state.uploadingId !== a.id).length;
  const images = list.filter(a => a.kind === 'image');
  const files = list.filter(a => a.kind !== 'image');
  const removeBtn = a => `<button type="button" class="att-x" data-att-act="remove" data-att="${esc(a.id)}" aria-label="移除 ${esc(a.name)}" title="移除">${icon('x')}</button>`;
  box.innerHTML = `
    ${waiting && !driveConnected() ? `<div class="attach-banner">${icon('cloud')}<span>${waiting} 個附件還沒上傳到 Google 雲端硬碟（已先存在這台裝置）</span><button type="button" class="btn primary small" data-att-act="sync">連結並上傳</button></div>` : ''}
    ${state.driveError ? `<p class="attach-error">${esc(state.driveError)}</p>` : ''}
    ${images.length ? `<div class="attach-grid">${images.map(a => {
      const st = attStatus(a);
      return `<figure class="att-img ${st.cls}">
        <button type="button" class="att-open" data-att-act="view" data-att="${esc(a.id)}" aria-label="檢視 ${esc(a.name)}">
          ${a.thumb ? `<img src="${a.thumb}" alt="" loading="lazy">` : icon('image')}
        </button>
        ${st.text ? `<span class="att-badge">${st.text}</span>` : ''}
        ${removeBtn(a)}
      </figure>`;
    }).join('')}</div>` : ''}
    ${files.length ? `<ul class="attach-files">${files.map(a => {
      const st = attStatus(a);
      return `<li class="att-file ${st.cls}">
        <button type="button" class="att-open" data-att-act="view" data-att="${esc(a.id)}">
          <span class="att-icon">${icon('file')}</span>
          <span class="att-info"><b>${esc(a.name)}</b><small>${fmtSize(a.size)}${st.text ? `・${st.text}` : '・雲端硬碟'}</small></span>
        </button>
        ${removeBtn(a)}
      </li>`;
    }).join('')}</ul>` : ''}`;
}

async function openAttachment(att) {
  if (att.kind !== 'image') {
    if (att.driveId) { window.open(driveLink(att), '_blank', 'noopener'); return; }
    const blob = await localBlob(att.id);
    if (blob) { const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    else toast('這個檔案還在另一台裝置等待上傳');
    return;
  }
  const dlg = $('#viewer');
  const img = $('#viewer-img');
  const note = $('#viewer-note');
  $('#viewer-name').textContent = att.name;
  const link = driveLink(att);
  $('#viewer-drive').hidden = !link;
  if (link) $('#viewer-drive').href = link;
  img.src = att.thumb || '';
  img.classList.add('loading');
  note.hidden = true;
  dlg.showModal();
  const show = blob => {
    if (!dlg.open) return;
    const url = URL.createObjectURL(blob);
    img.dataset.blobUrl = url;
    img.src = url;
    img.classList.remove('loading');
  };
  try {
    const local = await localBlob(att.id);
    if (local) { show(local); return; }
    if (!att.driveId) { note.textContent = '原圖還在另一台裝置等待上傳，目前顯示縮圖。'; note.hidden = false; img.classList.remove('loading'); return; }
    if (!driveConnected()) {
      note.innerHTML = `目前顯示縮圖。<button type="button" class="btn ghost small" id="viewer-auth">連結雲端硬碟看原圖</button>`;
      note.hidden = false;
      $('#viewer-auth').addEventListener('click', () => {
        syncDrive(true).then(() => { if (driveConnected() && dlg.open) { note.hidden = true; fetchDriveFile(att.driveId).then(show).catch(e => toast(e.message)); } });
      }, { once: true });
      img.classList.remove('loading');
      return;
    }
    show(await fetchDriveFile(att.driveId));
  } catch (e) {
    img.classList.remove('loading');
    if (e instanceof NeedAuthError) { note.textContent = '雲端硬碟授權已過期，請關閉後重新開啟圖片並連結。'; note.hidden = false; }
    else { note.textContent = e.message; note.hidden = false; }
  }
}

function renderSettingsIfOpen() {
  if (state.tab === 'settings' && state.store) renderSettings();
}

function emptyState() {
  if (state.courses.length) return `<div class="empty-state">找不到符合條件的課程</div>`;
  return `<div class="empty-state">
    <p>還沒有任何課程 🌱</p>
    <p>可以匯入夢想地圖的 CSV 檔，或按「新增課程」手動新增。</p>
    <button class="btn primary" type="button" data-action="import">${icon('upload')}匯入 CSV</button>
  </div>`;
}

function alertItem(c, sideHtml, extra = '', session = null) {
  const link = safeUrl(c.link);
  // 場次有自己的連結就優先顯示「上課連結」，課程網址改成次要按鈕
  const sLink = session ? sessionActions(c, session, 'btn dark small', true) : '';
  return `<li class="alert-item">
    <div class="alert-main">
      <strong>${esc(c.name)}</strong>
      <small>${emojiOf(c.category)} ${esc(c.category || '未分類')}・${esc(c.platform || '—')}・能量 ${c.energy}%${extra}</small>
    </div>
    <div class="alert-side">${sideHtml}</div>
    <div class="alert-actions">
      ${sLink}
      ${link && !sLink ? `<a class="btn dark small" data-action="go" href="${esc(link)}" target="_blank" rel="noopener">前往${icon('arrow')}</a>` : ''}
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
    ${subAlertPanel()}
    <div class="panel">
      <h2>${icon('cal')}即將上課 <small>未來 14 天</small></h2>
      ${sessions.length ? `<ul class="alert-list">${sessions.map(({ course, session, daysUntil }) =>
        alertItem(course, `<span class="when ${daysUntil <= 1 ? 'danger' : ''}">${dayText(daysUntil)}</span><small>${formatSession(session.at)}</small>`,
          `${session.label ? `・${esc(session.label)}` : ''}${isOnsite(session) ? `<br>${placeText(course, session)}` : ''}`, session)).join('')}</ul>`
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
  const allSessions = list.flatMap(c => c.sessions || []);
  const onsiteCount = allSessions.filter(isOnsite).length;
  const upcomingOnsite = allSessions.filter(s => isOnsite(s) && s.at.slice(0, 10) >= today).length;
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
      ${allSessions.length ? `<p class="muted-text session-split">上課場次：📍 實體課 <b>${onsiteCount}</b> 堂／💻 直播 <b>${allSessions.length - onsiteCount}</b> 堂${upcomingOnsite ? `・之後還有 ${upcomingOnsite} 堂實體課` : ''}</p>` : ''}
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
      <h2>${icon('cloud')}Google 雲端硬碟 <small>筆記的圖片與檔案</small></h2>
      ${!driveConfigured()
        ? '<p class="warn-text">尚未設定。依 SETUP.md 第 9 步取得「用戶端 ID」並填入 config.js 的 googleClientId，就能在筆記加入圖片與檔案。</p>'
        : `<p>附件會存到你雲端硬碟的「<b>學習羅盤</b>」資料夾。APP 只能存取它自己上傳的檔案，看不到你雲端硬碟裡的其他東西。</p>
           <p class="muted-text">${driveConnected()
             ? `✅ 已連結（授權到 ${new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(driveTokenExpiry())}，之後需要時會再請你按一次連結）`
             : '尚未連結，或授權已過期（Google 的授權每次約 1 小時）。'}
             ${state.localPending.size ? `・這台裝置有 <b>${state.localPending.size}</b> 個附件等待上傳` : ''}</p>
           ${state.driveError ? `<p class="warn-text">${esc(state.driveError)}</p>` : ''}
           <div class="row wrap">
             <button class="btn primary" type="button" data-action="drive-connect">${icon('cloud')}${driveConnected() ? (state.localPending.size ? '立即上傳' : '重新整理') : (state.localPending.size ? '連結並上傳' : '連結雲端硬碟')}</button>
             ${driveConnected() ? `<button class="btn ghost" type="button" data-action="drive-disconnect">中斷連結</button>` : ''}
           </div>`}
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
          <label class="inline">實體課導航的交通方式
            <select name="travelMode">${TRAVEL_MODES.map(([v, label]) => `<option value="${v}" ${(s.travelMode || '') === v ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
          <p class="muted-text">選「Google 預設」時由 Google 地圖決定；騎機車可在 Google 地圖 APP 裡切換。</p>
        </fieldset>
        <fieldset data-setting>
          <legend>久未學習提醒</legend>
          <label class="inline">超過 <input type="number" name="staleDays" min="3" max="365" value="${s.staleDays}"> 天沒學習，於
            <select name="staleDigestWeekday">${weekdays.map((w, i) => `<option value="${i}" ${Number(s.staleDigestWeekday) === i ? 'selected' : ''}>${w}</option>`).join('')}</select>
            推播一次摘要</label>
          <p class="muted-text">移動課程卡片上的「學習能量」就會記錄為最近一次學習。</p>
        </fieldset>
        <fieldset data-setting>
          <legend>訂閱扣款前，第幾天提醒</legend>
          <div class="chips">${[7, 3, 1, 0].map(d => `
            <label class="chip"><input type="checkbox" name="subNotifyDays" value="${d}" ${subNotifyDays().includes(d) ? 'checked' : ''}><span>${d === 0 ? '當天' : `${d} 天前`}</span></label>`).join('')}</div>
        </fieldset>
      </div>
    </div>

    <div class="panel">
      <h2>${icon('card')}外幣匯率 <small>訂閱統計換算成新台幣用</small></h2>
      <div class="rate-head" data-setting>
        <label class="chip"><input type="checkbox" name="ratesAuto" ${state.settings.ratesAuto !== false ? 'checked' : ''}><span>自動更新匯率</span></label>
        <button class="btn ghost small" type="button" data-action="update-rates">${icon('repeat')}立即更新</button>
      </div>
      <p class="muted-text">${state.settings.ratesAuto !== false
        ? `每 12 小時自動抓一次最新匯率${state.settings.ratesUpdatedAt ? `，上次更新：${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(state.settings.ratesUpdatedAt))}${state.settings.ratesSource ? `（${esc(state.settings.ratesSource)}）` : ''}` : '（尚未更新）'}。這是市場匯率，銀行入帳匯率會略有不同，所以搭配手續費％估算；想要精準可在訂閱裡填實際扣款金額。`
        : '已改為手動：1 單位外幣等於多少新台幣，自己對照銀行或信用卡帳單調整。'}</p>
      <div class="rate-grid" data-setting>${Object.entries(CURRENCIES).filter(([k]) => k !== 'TWD').map(([k, c]) => `
        <label class="rate-field"><span>1 ${esc(c.label)}（${esc(c.symbol)}）=</span>
          <input type="number" name="rate-${k}" min="0" step="0.0001" inputmode="decimal" value="${rateOf(k, state.settings.rates)}" ${state.settings.ratesAuto !== false ? 'readonly' : ''}><span>NT$</span></label>`).join('')}
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
    travelMode: root.querySelector('[name=travelMode]')?.value || '',
    staleDays: Math.max(3, Number(root.querySelector('[name=staleDays]').value) || DEFAULT_SETTINGS.staleDays),
    staleDigestWeekday: Number(root.querySelector('[name=staleDigestWeekday]').value),
    subNotifyDays: [...root.querySelectorAll('[name=subNotifyDays]:checked')].map(i => Number(i.value)),
    rates: Object.fromEntries(Object.keys(CURRENCIES).filter(k => k !== 'TWD').map(k => {
      const v = Number(root.querySelector(`[name=rate-${k}]`)?.value);
      return [k, v > 0 ? v : rateOf(k, state.settings.rates)];
    })),
    ratesAuto: !!root.querySelector('[name=ratesAuto]')?.checked
  };
  const turnedOn = s.ratesAuto && state.settings.ratesAuto === false;
  const autoChanged = s.ratesAuto !== (state.settings.ratesAuto !== false);
  state.settings = { ...state.settings, ...s };
  try { await state.store.saveSettings(state.settings); toast('設定已儲存'); }
  catch (e) { toast('儲存失敗：' + e.message); }
  if (autoChanged) renderSettings();
  if (turnedOn) updateRates(true);
}

// 自動更新匯率（每 12 小時一次；force = 使用者按「立即更新」）
let ratesBusy = false;
async function updateRates(force) {
  const s = state.settings;
  if (!force && (s.ratesAuto === false || !navigator.onLine)) return;
  if (!force && s.ratesUpdatedAt && Date.now() - Date.parse(s.ratesUpdatedAt) < RATE_REFRESH_MS) return;
  if (ratesBusy) return;
  ratesBusy = true;
  try {
    const { rates, source } = await fetchTwdRates(Object.keys(CURRENCIES).filter(k => k !== 'TWD'));
    state.settings = { ...state.settings, rates: { ...state.settings.rates, ...rates }, ratesUpdatedAt: new Date().toISOString(), ratesSource: source };
    await state.store.saveSettings(state.settings);
    render();
    if (force) toast(`匯率已更新：1 美元 = ${rates.USD} 元`);
  } catch (e) {
    if (force) toast(e.message);
  } finally {
    ratesBusy = false;
  }
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
function placePlaceholder() {
  const loc = $('#editor-form').location.value.trim();
  return loc ? `同課程地點：${loc}` : '這堂的地點（地址或地點名稱）';
}

function addSessionRow(session, focus = false) {
  const row = document.createElement('div');
  row.className = 'session-row';
  const onsite = session.mode === 'onsite';
  row.innerHTML = `
    <input type="datetime-local" class="session-at" value="${esc(session.at.length === 10 ? session.at + 'T00:00' : session.at)}" aria-label="上課時間">
    <input type="text" class="session-label" value="${esc(session.label)}" placeholder="說明（例如：第一週）" aria-label="場次說明">
    <button type="button" class="btn plain icon-only" data-remove aria-label="移除場次">${icon('x')}</button>
    <div class="session-where">
      <select class="session-mode" aria-label="上課方式">
        <option value="online" ${onsite ? '' : 'selected'}>💻 直播</option>
        <option value="onsite" ${onsite ? 'selected' : ''}>📍 實體</option>
      </select>
      <input type="text" class="session-link" inputmode="url" value="${esc(session.link || '')}" placeholder="直播連結（選填）" aria-label="直播連結">
      <input type="text" class="session-place" maxlength="200" value="${esc(session.place || '')}" placeholder="${esc(placePlaceholder())}" aria-label="這堂的地點">
    </div>`;
  $('#sessions').append(row);
  syncSessionRow(row);
  if (focus) row.querySelector('input').focus();
}

// 直播顯示連結欄位，實體顯示地點欄位
function syncSessionRow(row) {
  const onsite = row.querySelector('.session-mode').value === 'onsite';
  row.querySelector('.session-link').hidden = onsite;
  row.querySelector('.session-place').hidden = !onsite;
}

// 編輯視窗裡的地圖預覽（Google 地圖內嵌，不需要 API 金鑰）
function showMapPreview(place) {
  const box = $('#map-preview');
  if (!place) { box.hidden = true; box.querySelector('iframe').src = 'about:blank'; return; }
  const src = `https://maps.google.com/maps?q=${encodeURIComponent(place)}&z=16&hl=zh-TW&output=embed`;
  $('#map-preview-name').textContent = place;
  if (box.querySelector('iframe').src !== src) box.querySelector('iframe').src = src;
  box.hidden = false;
}

function openEditor(id) {
  const course = id ? state.courses.find(c => c.id === id) : null;
  state.editingId = course ? course.id : null;
  const form = $('#editor-form');
  form.reset();
  const c = course || { energy: 0, purchaseDate: taipeiToday(), sessions: [] };
  for (const key of ['name', 'teacher', 'category', 'platform', 'price', 'purchaseDate', 'accessUntil', 'energy', 'link', 'location', 'note']) {
    form[key].value = c[key] ?? '';
  }
  $('#energy-out').textContent = (c.energy || 0) + '%';
  $('#sessions').innerHTML = '';
  (c.sessions || []).forEach(s => addSessionRow(s));
  showMapPreview((c.location || '').trim());
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
    const val = sel => r.querySelector(sel).value.trim();
    const mode = val('.session-mode') === 'onsite' ? 'onsite' : 'online';
    // 實體課的地點跟課程地點一樣就不另外存，之後改課程地點會一起更新
    const place = mode === 'onsite' && val('.session-place') !== form.location.value.trim() ? val('.session-place') : '';
    return { at: val('.session-at'), label: val('.session-label'), link: mode === 'online' ? sessionLink(val('.session-link')) : '', mode, place };
  }).filter(s => s.at).sort((a, b) => a.at.localeCompare(b.at));
  const course = {
    ...(old || { id: newId(), createdAt: now }),
    name: form.name.value, teacher: form.teacher.value, category: form.category.value,
    platform: form.platform.value, price: form.price.value, purchaseDate: form.purchaseDate.value,
    accessUntil: form.accessUntil.value, energy, link: form.link.value, location: form.location.value.trim(), note: form.note.value,
    sessions, updatedAt: now,
    lastStudiedAt: old && energy > old.energy ? now : old?.lastStudiedAt || null
  };
  $('#editor').close();
  await saveCourse(course);
  toast(old ? '已更新' : '已新增課程 🌱');
}

// ---------- 訂閱 ----------
const subNotifyDays = () => (Array.isArray(state.settings.subNotifyDays) ? state.settings.subNotifyDays : DEFAULT_SETTINGS.subNotifyDays);
const subRates = () => state.settings.rates;
const whenText = d => (d === 0 ? '今天' : d === 1 ? '明天' : `${d} 天後`);
const SUB_FILTERS = [['active', '使用中'], ['month', '月繳'], ['year', '年繳'], ['paused', '暫停中'], ['cancelled', '已取消'], ['all', '全部']];
const lastOf = sub => sub.periods[sub.periods.length - 1];
const fmtMonths = m => (m >= 11.5 ? `${(m / 12).toFixed(m >= 23.5 ? 0 : 1).replace(/\.0$/, '')} 年` : `${Math.max(1, Math.round(m))} 個月`);
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function subMatches(sub, filter, today) {
  const status = subStatus(sub, today);
  if (filter === 'active' || filter === 'paused' || filter === 'cancelled') return status === filter;
  if (filter === 'month') return status === 'active' && sub.cycle === 'month';
  if (filter === 'year') return status === 'active' && sub.cycle === 'year';
  return true;
}

function subPriceHtml(sub) {
  const main = `${priceText(sub.price, sub.currency)}<small>／${cycleLabel(sub)}</small>`;
  const perMonth = monthlyTwd(sub, subRates());
  const showTwd = sub.currency !== 'TWD' || sub.feePct > 0 || usesActual(sub) || sub.cycle !== 'month' || sub.every !== 1;
  return `<b>${main}</b>${showTwd ? `<small>≈ ${money(perMonth)}／月 ${amountTag(sub)}</small>` : ''}`;
}

// 金額是「估算」還是「實際（最近幾次平均）」
const amountTag = sub => (usesActual(sub)
  ? '<i class="amt-tag actual" title="最近 3 次實際扣款的平均">實際</i>'
  : (sub.currency !== 'TWD' || sub.feePct > 0 ? `<i class="amt-tag" title="匯率 × (1 + 手續費 ${sub.feePct}%)">估算</i>` : ''));

// 需要對帳的訂閱：外幣或有手續費
const needsReconcile = sub => sub.currency !== 'TWD' || sub.feePct > 0;

// 最近 45 天內已扣款、還沒填實際金額的期數
function pendingCharges(today) {
  const out = [];
  for (const sub of state.subs) {
    if (!needsReconcile(sub)) continue;
    const hist = chargeHistory(sub, today, subRates());
    for (const h of hist.slice(-2)) {
      if (h.actual === null && dayDiff(h.date, today) <= 45) out.push({ sub, ...h });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

async function saveSubQuiet(sub, message) {
  try {
    await state.store.saveSub(normalizeSub({ ...sub, updatedAt: new Date().toISOString() }));
    if (message) toast(message);
  } catch (e) {
    toast('儲存失敗：' + e.message);
  }
}

async function recordCharge(button) {
  const row = button.closest('[data-charge]');
  const sub = state.subs.find(s => s.id === row.dataset.id);
  const twd = Number(row.querySelector('input').value);
  if (!sub) return;
  if (!(twd > 0)) { toast('請輸入帳單上的新台幣金額'); row.querySelector('input').focus(); return; }
  const charges = [...sub.charges.filter(c => c.date !== row.dataset.date), { date: row.dataset.date, twd }];
  await saveSubQuiet({ ...sub, charges }, `已記錄 ${sub.name} ${fmtDate(row.dataset.date)} 實際扣款 ${money(twd)}`);
}

// 預計恢復日已過：一鍵記錄「已恢復」
async function confirmResume(id) {
  const sub = state.subs.find(s => s.id === id);
  if (!sub) return;
  const cur = lastOf(sub);
  const start = cur.resumeAt || taipeiToday();
  const periods = [...sub.periods.map(p => ({ ...p })), { start, end: '', endType: '', resumeAt: '', price: cur.price, currency: cur.currency, feePct: cur.feePct }];
  periods[periods.length - 2].resumeAt = '';
  await saveSubQuiet({ ...sub, periods }, `已記錄 ${sub.name} 從 ${fmtDate(start)} 恢復訂閱`);
}

function subSide(sub, today) {
  const status = subStatus(sub, today);
  const cur = lastOf(sub);
  const until = accessEnd(sub, cur);
  const what = cur.endType === 'pause' ? '暫停' : '取消';
  if (status === 'active') {
    // 已申請取消／暫停，但已付的效期還沒到
    if (isEnding(sub, today)) {
      const left = dayDiff(today, until);
      const short = until.slice(0, 4) === today.slice(0, 4) ? until.slice(5).replace('-', '/') : fmtDate(until);
      return `<span class="when ending">效期到 ${short}</span><small>已${what}續訂・還能用 ${left} 天</small>`;
    }
    const next = nextCharge(sub, today);
    if (!next) return '<span class="when muted">—</span>';
    const days = dayDiff(today, next);
    const note = cur.end && cur.end > today ? `<small>${fmtDate(cur.end)} 起${what}續訂</small>` : `<small>${fmtDate(next)} 扣款</small>`;
    return `<span class="when ${days <= 3 ? 'danger' : days <= 7 ? 'warn' : ''}">${whenText(days)}</span>${note}`;
  }
  if (status === 'paused') {
    if (cur.resumeAt) {
      const d = dayDiff(today, cur.resumeAt);
      return `<span class="when paused">⏸ 暫停中</span><small>${d >= 0 ? `預計 ${fmtDate(cur.resumeAt)} 恢復` : `預計恢復日已過 ${-d} 天`}</small>`;
    }
    return `<span class="when paused">⏸ 暫停中</span><small>效期 ${fmtDate(until)} 結束</small>`;
  }
  return `<span class="when muted">已取消</span><small>效期 ${fmtDate(until)} 結束</small>`;
}

function subRow(sub, today) {
  const status = subStatus(sub, today);
  const h = hueOf(sub.category || sub.name);
  const stats = periodStats(sub, today, subRates());
  const extra = [`累計 ${paidCount(sub, today)} 次`];
  if (stats.pauses) extra.push(`暫停 ${stats.pauses} 次`);
  if (stats.giftDays) extra.push(`贈送 ${stats.giftDays} 天`);
  if (sub.feePct > 0) extra.push(`手續費 ${sub.feePct}%`);
  return `<li>
    <button type="button" class="sub-row ${status}" data-action="edit-sub" data-id="${esc(sub.id)}" style="--h:${h}">
      <span class="sub-avatar" aria-hidden="true">${esc([...sub.name][0] || '?')}</span>
      <span class="sub-main"><strong>${esc(sub.name)}</strong><small>${esc(sub.category || '未分類')}・${extra.join('・')}</small></span>
      <span class="sub-price">${subPriceHtml(sub)}</span>
      <span class="sub-next">${subSide(sub, today)}</span>
    </button>
  </li>`;
}

function subBars(groups) {
  const max = Math.max(1, ...groups.map(g => g.monthly));
  return `<div class="bars">${groups.map(g => `
    <div class="bar-row">
      <div class="bar-label">${esc(g.key)}<small>${g.count} 項</small></div>
      <div class="bar-track"><div class="bar" style="width:${(g.monthly / max) * 100}%"></div></div>
      <div class="bar-value">${money(g.monthly)}<small>／月</small></div>
    </div>`).join('')}</div>`;
}

// 未來 30 天的扣款與預計恢復，合併成一條時間軸
function upcomingEvents(rates) {
  const charges = computeSubAlerts(state.subs, new Date(), 30).map(x => ({ ...x, kind: 'charge', amount: chargeTwd(x.sub, rates) }));
  const resumes = computeResumeAlerts(state.subs, new Date(), 30).filter(x => x.daysUntil >= 0)
    .map(x => ({ ...x, kind: 'resume', amount: chargeTwd(x.sub, rates) }));
  return [...charges, ...resumes].sort((a, b) => a.date.localeCompare(b.date));
}

function renderSubs() {
  const view = $('#view-subs');
  const today = taipeiToday();
  const all = state.subs;
  if (!all.length) {
    view.innerHTML = `<div class="empty-state">
      <p>還沒有訂閱紀錄 💳</p>
      <p>把每月、每年自動扣款的軟體或服務記下來，就能看到每個月實際花多少，並在扣款前收到提醒。</p>
      <button class="btn primary" type="button" data-action="new">${icon('plus')}新增訂閱</button>
    </div>`;
    return;
  }
  const rates = subRates();
  const active = all.filter(s => isActive(s, today));
  const paused = all.filter(s => isPaused(s, today));
  const cancelled = all.length - active.length - paused.length;
  // 每月花費只算之後還會續訂扣款的；已取消續訂（效期內仍可用）與暫停中的都算「少付」
  const renewing = active.filter(s => willRenew(s, today));
  const ending = active.length - renewing.length;
  const monthly = sum(renewing, s => monthlyTwd(s, rates));
  const pausedMonthly = sum([...paused, ...active.filter(s => !willRenew(s, today) && lastOf(s).endType === 'pause')], s => monthlyTwd(s, rates));
  const events = upcomingEvents(rates);
  const upcomingTotal = sum(events, e => e.amount);
  const soon = events.filter(x => x.daysUntil <= 7).length;
  const paid = all.map(s => paidSummary(s, today, rates));
  const paidTotal = sum(paid, p => p.total);
  const paidCountAll = sum(paid, p => p.count);
  const actualCountAll = sum(paid, p => p.actualCount);
  const allStats = all.map(s => periodStats(s, today, rates));
  const pauseSaved = sum(allStats, st => st.saved);
  const giftValue = sum(allStats, st => st.giftValue);
  const giftDays = sum(allStats, st => st.giftDays);
  const pending = pendingCharges(today);
  const overdue = computeResumeAlerts(all, new Date(), 0).filter(x => x.daysUntil < 0 || x.daysUntil === 0);

  const byCat = new Map();
  for (const s of renewing) {
    const k = s.category || '未分類';
    const g = byCat.get(k) || { key: k, count: 0, monthly: 0 };
    g.count++;
    g.monthly += monthlyTwd(s, rates);
    byCat.set(k, g);
  }
  const cats = [...byCat.values()].sort((a, b) => b.monthly - a.monthly);

  const order = { active: 0, paused: 1, cancelled: 2 };
  const list = all.filter(s => subMatches(s, state.subFilter, today)).sort((a, b) => {
    const sa = subStatus(a, today);
    const sb = subStatus(b, today);
    if (sa !== sb) return order[sa] - order[sb];
    if (sa === 'active') {
      // 會續訂的依下次扣款日，已停止續訂的排後面、依效期結束日
      const ra = willRenew(a, today);
      const rb = willRenew(b, today);
      if (ra !== rb) return ra ? -1 : 1;
      return ra ? (nextCharge(a, today) || '').localeCompare(nextCharge(b, today) || '') : accessEnd(a).localeCompare(accessEnd(b));
    }
    return (lastOf(b).end || '').localeCompare(lastOf(a).end || '');
  });

  view.innerHTML = `
    <div class="stat-tiles">
      <div class="tile"><small>每月約</small><strong>${money(monthly)}</strong><span>使用中 ${active.length} 項${ending ? `（${ending} 項已停止續訂，效期內仍可用）` : ''}${paused.length || pausedMonthly ? `・暫停${paused.length ? `中 ${paused.length} 項` : ''}，每月少付約 ${money(pausedMonthly)}` : (ending ? '' : '（年繳已平均到每月）')}</span></div>
      <div class="tile"><small>每年約</small><strong>${money(monthly * 12)}</strong><span>照目前使用中的訂閱持續一整年</span></div>
      <div class="tile"><small>未來 30 天將扣款</small><strong class="${soon ? 'warn' : ''}">${money(upcomingTotal)}</strong><span>${events.length} 筆${soon ? `・7 天內 ${soon} 筆` : ''}</span></div>
      <div class="tile"><small>累計已付</small><strong>${money(paidTotal)}</strong><span>${paidCountAll} 期中 ${actualCountAll} 期為實際金額${pauseSaved >= 1 ? `・暫停期間約省下 ${money(pauseSaved)}` : ''}${giftDays ? `・序號贈送 ${giftDays} 天，約值 ${money(giftValue)}` : ''}${cancelled ? `・已取消 ${cancelled} 項` : ''}</span></div>
    </div>

    ${overdue.length ? `<div class="panel pending-panel">
      <h2>${icon('repeat')}預計恢復日到了 <small>有恢復的話記錄一下，統計才會準確</small></h2>
      <ul class="charge-pending">${overdue.map(x => `
        <li>
          <span class="cp-main"><strong>${esc(x.sub.name)}</strong><small>預計 ${fmtDate(x.date)} 恢復・${priceText(x.sub.price, x.sub.currency)}／${cycleLabel(x.sub)}</small></span>
          <button type="button" class="btn ghost small" data-action="edit-sub" data-id="${esc(x.sub.id)}">還沒／改日期</button>
          <button type="button" class="btn primary small" data-action="confirm-resume" data-id="${esc(x.sub.id)}">已恢復</button>
        </li>`).join('')}</ul>
    </div>` : ''}

    ${pending.length ? `<div class="panel pending-panel">
      <h2>${icon('edit')}最近扣款，填上實際金額 <small>選填・照信用卡帳單（含手續費）</small></h2>
      <ul class="charge-pending">${pending.map(p => `
        <li data-charge data-id="${esc(p.sub.id)}" data-date="${p.date}">
          <span class="cp-main"><strong>${esc(p.sub.name)}</strong><small>${fmtDate(p.date)} ${p.kind === 'buy' ? '疊加下訂' : '扣款'}・估算 ${money(p.estimate)}</small></span>
          <label class="cp-input"><span>NT$</span><input type="number" min="0" step="1" inputmode="decimal" placeholder="${Math.round(p.estimate)}" aria-label="${esc(p.sub.name)} 實際扣款金額"></label>
          <button type="button" class="btn primary small" data-action="record-charge">記錄</button>
        </li>`).join('')}</ul>
    </div>` : ''}

    <div class="sub-columns">
      <div class="panel">
        <h2>${icon('cal')}即將續訂 <small>未來 30 天</small></h2>
        ${events.length ? `<ol class="timeline">${events.map(({ sub, date, daysUntil, kind, amount }) => `
          <li class="${kind === 'resume' ? 'resume' : ''} ${daysUntil <= 3 ? 'danger' : daysUntil <= 7 ? 'warn' : ''}">
            <span class="tl-date"><b>${date.slice(5).replace('-', '/')}</b><small>${whenText(daysUntil)}</small></span>
            <button type="button" class="tl-main" data-action="edit-sub" data-id="${esc(sub.id)}">
              <strong>${kind === 'resume' ? '⏯ ' : ''}${esc(sub.name)}${kind === 'resume' ? '<i class="amt-tag resume">預計恢復</i>' : ''}</strong>
              <small>${priceText(sub.price, sub.currency)}${needsReconcile(sub) ? ` ≈ ${money(amount)} ${amountTag(sub)}` : ''}</small>
            </button>
          </li>`).join('')}</ol>`
          : '<p class="muted-text">未來 30 天沒有扣款 🎉</p>'}
      </div>
      <div class="panel">
        <h2>${icon('chart')}依類別 <small>每月花費・會續訂的</small></h2>
        ${cats.length ? subBars(cats) : '<p class="muted-text">目前沒有使用中的訂閱</p>'}
      </div>
    </div>

    <div class="panel">
      <div class="sub-list-head">
        <h2>${icon('card')}訂閱清單</h2>
        <div class="seg-filter" role="group" aria-label="篩選訂閱">${SUB_FILTERS.map(([v, label]) => {
          const n = all.filter(s => subMatches(s, v, today)).length;
          return `<button type="button" data-action="sub-filter" data-value="${v}" aria-pressed="${state.subFilter === v}">${label}<b>${n}</b></button>`;
        }).join('')}</div>
      </div>
      ${list.length ? `<ul class="sub-list">${list.map(s => subRow(s, today)).join('')}</ul>` : '<p class="muted-text">這個分類沒有訂閱</p>'}
    </div>`;
}

// 「提醒」頁最上方：30 天內要扣款或預計恢復的訂閱
function subAlertPanel() {
  if (!state.subs.length) return '';
  const rates = subRates();
  const list = [
    ...computeSubAlerts(state.subs, new Date(), 30).map(x => ({ ...x, kind: 'charge' })),
    ...computeResumeAlerts(state.subs, new Date(), 30).map(x => ({ ...x, kind: 'resume' }))
  ].sort((a, b) => a.date.localeCompare(b.date));
  return `<div class="panel">
    <h2>${icon('card')}即將扣款的訂閱 <small>未來 30 天</small></h2>
    ${list.length ? `<ul class="alert-list">${list.map(({ sub, date, daysUntil, kind }) => {
      const link = safeUrl(sub.link);
      const resume = kind === 'resume';
      return `<li class="alert-item">
        <div class="alert-main">
          <strong>${resume ? '⏯ ' : ''}${esc(sub.name)}${resume ? '（預計恢復扣款）' : ''}</strong>
          <small>${priceText(sub.price, sub.currency)}／${cycleLabel(sub)}${needsReconcile(sub) ? `・約 ${money(chargeTwd(sub, rates))}（${usesActual(sub) ? '依實際' : `含 ${sub.feePct}% 手續費`}）` : ''}・${esc(sub.category || '未分類')}</small>
        </div>
        <div class="alert-side"><span class="when ${daysUntil <= 3 ? 'danger' : daysUntil <= 7 ? 'warn' : ''}">${daysUntil < 0 ? `已過 ${-daysUntil} 天` : whenText(daysUntil)}</span><small>${fmtDate(date)}</small></div>
        <div class="alert-actions">
          ${link ? `<a class="btn dark small" data-action="go" href="${esc(link)}" target="_blank" rel="noopener">管理${icon('arrow')}</a>` : ''}
          <button class="btn soft small icon-only" type="button" data-action="edit-sub" data-id="${esc(sub.id)}" aria-label="編輯">${icon('edit')}</button>
        </div>
      </li>`;
    }).join('')}</ul>` : '<p class="muted-text">未來 30 天沒有訂閱要扣款 🎉</p>'}
  </div>`;
}

// ---------- 訂閱編輯視窗 ----------
function bindSubEditor() {
  const form = $('#sub-form');
  form.currency.innerHTML = Object.entries(CURRENCIES).map(([k, c]) => `<option value="${k}">${esc(c.symbol)} ${esc(c.label)}</option>`).join('');
  form.every.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">每 ${i + 1}</option>`).join('');
  form.addEventListener('input', e => {
    if (e.target.closest('#sub-charges')) return;
    if (e.target.closest('#sub-periods')) collectPeriods();
    updateSubPreview();
  });
  form.addEventListener('change', e => {
    if (e.target.closest('#sub-charges')) { updateSubPreview(); return; }
    if (e.target.closest('#sub-periods')) {
      collectPeriods();
      if (e.target.name === 'p-type') {
        // 改成暫停／取消但還沒填日期：預設今天
        const p = state.subPeriods[Number(e.target.closest('[data-pi]').dataset.pi)];
        const today = taipeiToday();
        if (p.endType && !p.end) p.end = today > p.start ? today : addDays(p.start, 1);
        renderPeriods();
      } else {
        renderPeriodBar();
        // 只更新「效期到哪天」說明，不重畫欄位（避免打字時失去焦點）
        $$('#sub-periods [data-pi]').forEach(row => {
          const note = row.querySelector(':scope > .pr-note');
          if (note) note.innerHTML = paidThroughText(Number(row.dataset.pi));
          row.querySelectorAll('[data-ei]').forEach(er => {
            er.querySelector('.ext-note').innerHTML = extNoteText(Number(row.dataset.pi), Number(er.dataset.ei));
          });
        });
        renderPeriodActions();
      }
      renderChargeRows();
      updateSubPreview();
      return;
    }
    // 換幣別時，如果手續費還是預設值，就跟著換成新幣別的預設
    if (e.target === form.currency) {
      const prev = form.currency.dataset.prev || 'TWD';
      if (Number(form.feePct.value) === defaultFeePct(prev) || form.feePct.value === '') form.feePct.value = defaultFeePct(form.currency.value);
      form.currency.dataset.prev = form.currency.value;
    }
    if (['currency', 'price', 'feePct', 'cycle', 'every'].includes(e.target.name)) { renderPeriods(); renderChargeRows(); }
    updateSubPreview();
  });
  $('#sub-period-actions').addEventListener('click', e => {
    const btn = e.target.closest('[data-pact]');
    if (btn) periodAction(btn.dataset.pact);
  });
  $('#sub-periods').addEventListener('click', e => {
    const ebtn = e.target.closest('[data-eremove]');
    if (ebtn) {
      collectPeriods();
      const [pi, ei] = ebtn.dataset.eremove.split(':').map(Number);
      const ext = state.subPeriods[pi]?.ext;
      if (!ext?.[ei] || !confirm(`刪除這筆${ext[ei].type === 'gift' ? '序號贈送' : '疊加下訂'}？`)) return;
      ext.splice(ei, 1);
      refreshPeriodsUi();
      return;
    }
    const btn = e.target.closest('[data-premove]');
    if (!btn) return;
    collectPeriods();
    const i = Number(btn.dataset.premove);
    if (state.subPeriods.length <= 1 || !confirm(`刪除第 ${i + 1} 段期間？`)) return;
    state.subPeriods.splice(i, 1);
    refreshPeriodsUi();
  });
  form.addEventListener('submit', submitSubEditor);
  $('#sub-delete').addEventListener('click', deleteCurrentSub);
}

// 幣別、手續費整個訂閱共用（上方欄位）；金額每段各自填
function mainPricing() {
  const form = $('#sub-form');
  return { currency: form.currency.value, feePct: form.feePct.value };
}
const lastPrice = () => state.subPeriods[state.subPeriods.length - 1]?.price ?? '';

// 從畫面讀回期間（存在 state.subPeriods）
function collectPeriods() {
  const rows = $$('#sub-periods [data-pi]');
  rows.forEach(row => {
    const p = state.subPeriods[Number(row.dataset.pi)];
    if (!p) return;
    const type = row.querySelector('[name=p-type]').value;
    p.start = row.querySelector('[name=p-start]').value;
    p.endType = type === 'active' ? '' : type;
    p.end = type === 'active' ? '' : (row.querySelector('[name=p-end]')?.value || '');
    p.resumeAt = type === 'pause' ? (row.querySelector('[name=p-resume]')?.value || '') : '';
    const price = row.querySelector('[name=p-price]');
    if (price) p.price = price.value;
    row.querySelectorAll('[data-ei]').forEach(er => {
      const e = (p.ext || [])[Number(er.dataset.ei)];
      if (!e) return;
      const val = n => er.querySelector(`[name=${n}]`)?.value ?? '';
      e.date = val('e-date');
      e.note = val('e-note');
      if (e.type === 'gift') e.days = val('e-days');
      else { e.until = val('e-until'); e.amount = val('e-amount'); }
    });
  });
  return state.subPeriods;
}

// 某筆延長實際延了多久（用正規化後的草稿算）
function extNoteText(pi, ei) {
  const sub = draftSub();
  const p = state.subPeriods[pi];
  const e = p?.ext?.[ei];
  if (!sub || !e) return '';
  const np = sub.periods.find(x => x.start === p.start);
  const span = np ? extSpans(sub, np).find(s => s.ext.date === e.date && s.ext.type === e.type) : null;
  if (!span) return '日期在這段期間的效期之後，不會影響扣款';
  if (e.type === 'gift') return `${fmtDate(span.from)} 的扣款延到 <b>${fmtDate(span.to)}</b>`;
  return `原本 ${fmtDate(span.from)} 的扣款延到 <b>${fmtDate(span.to)}</b>，多 ${dayDiff(span.from, span.to)} 天`;
}

function extRowHtml(p, pi, e, ei) {
  const sym = (CURRENCIES[$('#sub-form').currency.value] || CURRENCIES.TWD).symbol;
  const gift = e.type === 'gift';
  return `<li class="ext-row ${gift ? 'gift' : 'buy'}" data-ei="${ei}">
    <div class="er-head"><b>${gift ? '🎁 序號贈送' : '➕ 疊加下訂'}</b>
      <button type="button" class="btn quiet small icon-only" data-eremove="${pi}:${ei}" aria-label="刪除這筆" title="刪除這筆">${icon('trash')}</button></div>
    <div class="pr-fields">
      <label><span>${gift ? '兌換日' : '下訂日'}</span><input type="date" name="e-date" value="${esc(e.date)}" required></label>
      ${gift
        ? `<label><span>贈送天數</span><input type="number" name="e-days" min="1" max="3650" step="1" inputmode="numeric" value="${esc(e.days)}" required></label>`
        : `<label><span>實付金額</span><span class="money-mini"><em>${esc(sym)}</em><input type="number" name="e-amount" min="0" step="0.01" inputmode="decimal" value="${esc(e.amount)}"></span></label>
           <label><span>延長到<small>新的到期日</small></span><input type="date" name="e-until" value="${esc(e.until)}" required></label>`}
      <label class="er-note-field"><span>備註<small>選填</small></span><input type="text" name="e-note" maxlength="200" value="${esc(e.note || '')}" placeholder="${gift ? '例如：序號來源' : '例如：年度優惠'}"></label>
    </div>
    <p class="pr-note ext-note">${extNoteText(pi, ei)}</p>
  </li>`;
}

// 疊加下訂／序號贈送：加在最後一段
function addExt(type) {
  collectPeriods();
  const list = state.subPeriods;
  const last = list[list.length - 1];
  const today = taipeiToday();
  const sub = draftSub();
  last.ext = last.ext || [];
  if (type === 'gift') {
    last.ext.push({ type: 'gift', date: today, days: 30, note: '' });
  } else {
    // 預設延長一期：從目前的到期日（下一次扣款日）再往後一期
    const base = (sub && (nextCharge(sub, today) || accessEnd(sub))) || today;
    last.ext.push({ type: 'buy', date: today, until: sub ? addCycles(sub, base) : base, amount: lastPrice(), note: '' });
  }
  refreshPeriodsUi();
  const rows = $$(`#sub-periods [data-pi="${list.length - 1}"] [data-ei]`);
  rows[rows.length - 1]?.querySelector(type === 'gift' ? '[name=e-days]' : '[name=e-until]')?.focus();
  toast(type === 'gift' ? '請確認兌換日與贈送天數' : '請確認下訂日、實付金額與新的到期日');
}

function draftPeriods() {
  const shared = mainPricing();
  return state.subPeriods.map(p => ({ ...p, ...shared }));
}

function refreshPeriodsUi() {
  renderPeriods();
  renderChargeRows();
  updateSubPreview();
}

function renderPeriods() {
  const box = $('#sub-periods');
  const list = state.subPeriods;
  const many = list.length > 1;
  $('#sub-periods-hint').textContent = many ? '每段各自從開始日推算扣款日，金額也各自填（漲價、換方案時不同）' : '第一次扣款日：免費試用請填試用結束、開始扣款那天';
  const sym = (CURRENCIES[$('#sub-form').currency.value] || CURRENCIES.TWD).symbol;
  box.innerHTML = list.map((p, i) => {
    const last = i === list.length - 1;
    const type = p.endType || 'active';
    return `<li class="period-row ${type}" data-pi="${i}">
      <div class="pr-head">
        <b>${many ? `第 ${i + 1} 段` : '目前這段'}</b>
        <select name="p-type" aria-label="狀態">
          ${last ? `<option value="active" ${type === 'active' ? 'selected' : ''}>使用中</option>` : ''}
          <option value="pause" ${type === 'pause' ? 'selected' : ''}>暫停</option>
          <option value="cancel" ${type === 'cancel' ? 'selected' : ''}>取消</option>
        </select>
        ${many ? `<button type="button" class="btn quiet small icon-only" data-premove="${i}" aria-label="刪除第 ${i + 1} 段" title="刪除這段">${icon('trash')}</button>` : ''}
      </div>
      <div class="pr-fields">
        <label><span>${i === 0 ? '第一次扣款日' : '恢復（開始扣款）日'}</span><input type="date" name="p-start" value="${esc(p.start)}" required></label>
        <label><span>每期金額</span><span class="money-mini"><em>${esc(sym)}</em><input type="number" name="p-price" min="0" step="0.01" inputmode="decimal" value="${esc(p.price)}" required></span></label>
        ${type !== 'active' ? `<label><span>${type === 'pause' ? '申請暫停日' : '申請取消日'}<small>之後不再續訂扣款</small></span><input type="date" name="p-end" value="${esc(p.end)}" required></label>` : ''}
        ${type === 'pause' && last ? `<label><span>預計恢復日<small>選填</small></span><input type="date" name="p-resume" value="${esc(p.resumeAt)}"></label>` : ''}
      </div>
      ${p.ext?.length ? `<ul class="ext-list">${p.ext.map((e, ei) => extRowHtml(p, i, e, ei)).join('')}</ul>` : ''}
      ${type !== 'active' && p.end ? `<p class="pr-note">${paidThroughText(i)}</p>` : ''}
    </li>`;
  }).join('');
  renderPeriodActions();
  renderPeriodBar();
}

function renderPeriodActions() {
  const last = state.subPeriods[state.subPeriods.length - 1];
  const box = $('#sub-period-actions');
  if (!last) { box.innerHTML = ''; return; }
  const today = taipeiToday();
  let buttons;
  if (!last.endType) {
    buttons = `<button type="button" class="btn ghost small" data-pact="pause">⏸ 暫停訂閱</button>
      <button type="button" class="btn ghost small" data-pact="cancel">取消訂閱</button>`;
  } else if (last.endType === 'pause') {
    buttons = `<button type="button" class="btn primary small" data-pact="resume">⏯ 恢復訂閱</button>
      <button type="button" class="btn ghost small" data-pact="to-cancel">改成取消</button>`;
  } else {
    buttons = `<button type="button" class="btn primary small" data-pact="resume">${icon('repeat')}重新訂閱</button>`;
  }
  // 還在效期內才能疊加下訂或兌換序號
  const sub = draftSub();
  if (!last.endType || (sub && isActive(sub, today))) {
    buttons += `<button type="button" class="btn ghost small" data-pact="buy">➕ 疊加下訂</button>
      <button type="button" class="btn ghost small" data-pact="gift">🎁 序號贈送</button>`;
  }
  box.innerHTML = buttons;
}

// 期間草稿 → 正規化的訂閱（日期不合理時回傳 null）
function draftSub() {
  const periods = draftPeriods();
  if (!periods.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.start)) || validatePeriods(periods)) return null;
  const form = $('#sub-form');
  return normalizeSub({ name: 'x', cycle: form.cycle.value, every: form.every.value, ...mainPricing(), periods });
}

// 「已付的效期到哪天」說明
function paidThroughText(i) {
  const sub = draftSub();
  const p = state.subPeriods[i];
  if (!sub || !p?.end) return '';
  const np = sub.periods.find(x => x.start === p.start);
  const until = np ? accessEnd(sub, np) : '';
  if (!until) return '';
  const what = p.endType === 'pause' ? '暫停' : '取消';
  if (p.end <= p.start) return `還沒開始扣款就${what}（例如試用期內），不會被扣款；可使用到 ${fmtDate(p.start)}`;
  return `${fmtDate(p.end)} 申請${what}，不會再續訂；已付的這一期照常可用，<b>效期到 ${fmtDate(until)}</b>`;
}

function periodAction(kind) {
  if (kind === 'buy' || kind === 'gift') { addExt(kind); return; }
  collectPeriods();
  const list = state.subPeriods;
  const last = list[list.length - 1];
  const today = taipeiToday();
  if (kind === 'pause' || kind === 'cancel') {
    last.endType = kind;
    last.end = today > last.start ? today : addDays(last.start, 1);
    last.resumeAt = '';
  } else if (kind === 'to-cancel') {
    last.endType = 'cancel';
    last.resumeAt = '';
  } else if (kind === 'resume') {
    // 預設從預計恢復日開始；沒有的話從「效期結束」或今天（較晚的）開始
    const sub = draftSub();
    const until = sub ? accessEnd(sub) : '';
    let start = last.resumeAt && last.resumeAt >= last.end ? last.resumeAt : [today, until].filter(Boolean).sort().pop();
    if (last.end && start < last.end) start = last.end;
    last.resumeAt = '';
    // 新的一段預設沿用上一段的金額，可以直接改
    list.push({ start, end: '', endType: '', resumeAt: '', price: last.price, ...mainPricing() });
  }
  refreshPeriodsUi();
  const focusName = kind === 'resume' ? 'p-price' : 'p-end';
  $(`#sub-periods [data-pi="${list.length - 1}"] [name=${focusName}]`)?.focus();
  toast({ pause: '已設為暫停，請確認暫停日；可選填預計恢復日', cancel: '已設為取消，請確認取消日', resume: '已新增一段期間，請確認恢復日與這段的每期金額', 'to-cancel': '已改成取消' }[kind]);
}

// 期間橫條：有訂閱的時段上色，暫停斜線，取消灰色
function renderPeriodBar() {
  const bar = $('#sub-period-bar');
  const list = state.subPeriods.filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.start)).sort((a, b) => a.start.localeCompare(b.start));
  if (!list.length) { bar.hidden = true; return; }
  const today = taipeiToday();
  const from = list[0].start;
  const lastP = list[list.length - 1];
  // 每段可使用到「效期結束」，之後才是暫停／取消
  const sub = draftSub();
  const untilOf = p => {
    if (!p.end) return '';
    const np = sub?.periods.find(x => x.start === p.start);
    return np ? accessEnd(sub, np) : p.end;
  };
  // 序號贈送延長的時段
  const gifts = (sub?.periods || []).flatMap(p => extSpans(sub, p)).filter(s => s.type === 'gift' && s.ext.date <= today);
  const to = [today, untilOf(lastP), lastP.resumeAt, ...gifts.map(g => g.to)].filter(Boolean).sort().pop();
  const total = Math.max(1, dayDiff(from, to));
  const segs = [];
  list.forEach((p, i) => {
    const next = list[i + 1];
    const until = untilOf(p);
    const useEnd = [until || to, next ? next.start : ''].filter(Boolean).sort()[0];
    segs.push({ cls: 'on', from: p.start, to: useEnd });
    if (p.end) segs.push({ cls: p.endType === 'pause' ? 'pause' : 'off', from: useEnd, to: next ? next.start : to });
  });
  for (const g of gifts) segs.push({ cls: 'gift', from: g.from, to: g.to, title: `序號贈送 ${g.ext.days} 天` });
  bar.hidden = list.length < 2 && !lastP.end && !gifts.length;
  bar.innerHTML = `<div class="pb-track">${segs.filter(s => s.to > s.from).map(s => `<span class="pb-seg ${s.cls}" style="left:${dayDiff(from, s.from) / total * 100}%;width:${dayDiff(s.from, s.to) / total * 100}%" title="${s.title ? s.title + '・' : ''}${fmtDate(s.from)} – ${fmtDate(s.to)}"></span>`).join('')}</div>
    <div class="pb-labels"><span>${fmtDate(from)}</span><span class="pb-legend"><i class="on"></i>訂閱 ${gifts.length ? '<i class="gift"></i>贈送 ' : ''}<i class="pause"></i>暫停 <i class="off"></i>取消</span><span>${fmtDate(to)}</span></div>`;
}

function subFromForm() {
  const form = $('#sub-form');
  const old = state.subs.find(s => s.id === state.editingSubId);
  return normalizeSub({
    ...(old || {}),
    name: form.name.value, category: form.category.value, ...mainPricing(),
    cycle: form.cycle.value, every: form.every.value, link: form.link.value, note: form.note.value,
    periods: draftPeriods(), charges: chargesFromForm(old),
    updatedAt: new Date().toISOString()
  });
}

// 表單裡顯示的期數用輸入框的值；沒顯示的舊紀錄保留原值
function chargesFromForm(old) {
  const shown = new Map($$('#sub-charges [data-date]').map(li => [li.dataset.date, Number(li.querySelector('input').value) || 0]));
  const kept = (old?.charges || []).filter(c => !shown.has(c.date));
  return [...kept, ...[...shown].filter(([, twd]) => twd > 0).map(([date, twd]) => ({ date, twd }))];
}

const formReady = () => String(lastPrice()) !== '' && state.subPeriods.some(p => p.start);

// 編輯視窗：列出最近 12 期，可以填實際扣款金額
function renderChargeRows() {
  const box = $('#sub-charges');
  const typed = new Map($$('#sub-charges [data-date]').map(li => [li.dataset.date, li.querySelector('input').value]));
  if (!formReady() || validatePeriods(draftPeriods())) { $('#sub-charges-field').hidden = true; box.innerHTML = ''; return; }
  const sub = subFromForm();
  const hist = chargeHistory(sub, taipeiToday(), subRates()).slice(-12).reverse();
  $('#sub-charges-field').hidden = !hist.length;
  box.innerHTML = hist.map(h => {
    const value = typed.has(h.date) ? typed.get(h.date) : (h.actual ?? '');
    return `<li data-date="${h.date}">
      <span class="cl-date">${fmtDate(h.date)}${h.kind === 'buy' ? '<small>疊加下訂</small>' : sub.periods.length > 1 ? `<small>第 ${h.period + 1} 段</small>` : ''}</span>
      <span class="cl-est">估算 ${money(h.estimate)}</span>
      <label class="cp-input"><span>NT$</span><input type="number" min="0" step="1" inputmode="decimal" value="${esc(value)}" placeholder="實際金額" aria-label="${fmtDate(h.date)} 實際扣款"></label>
    </li>`;
  }).join('');
}

function updateSubPreview() {
  const preview = $('#sub-preview');
  if (!formReady()) { preview.textContent = ''; return; }
  const problem = validatePeriods(draftPeriods());
  if (problem) { preview.textContent = '⚠️ ' + problem; preview.classList.add('error'); return; }
  preview.classList.remove('error');
  const sub = subFromForm();
  const today = taipeiToday();
  const rates = subRates();
  const status = subStatus(sub, today);
  const next = nextCharge(sub, today);
  const paid = paidSummary(sub, today, rates);
  const st = periodStats(sub, today, rates);
  const parts = [];
  if (needsReconcile(sub)) {
    parts.push(usesActual(sub)
      ? `每期約 ${money(chargeTwd(sub, rates))}（最近 ${Math.min(3, sub.charges.filter(c => c.date >= lastOf(sub).start).length)} 次實際平均）`
      : `每期估算 ${money(estimateTwd(sub, rates))}（${priceText(sub.price, sub.currency)} × 匯率 ${rateOf(sub.currency, rates)} × ${(1 + sub.feePct / 100).toFixed(3).replace(/0+$/, '')}）`);
  }
  const cur = lastOf(sub);
  const until = accessEnd(sub, cur);
  if (status === 'active' && isEnding(sub, today)) {
    parts.push(`已${cur.endType === 'pause' ? '暫停' : '取消'}續訂，不會再扣款；效期到 ${fmtDate(until)}（還能用 ${dayDiff(today, until)} 天）`);
  } else if (status === 'active') {
    parts.push(`每月約 ${money(monthlyTwd(sub, rates))}`);
    parts.push(next ? `下次扣款 ${fmtDate(next)}（${whenText(dayDiff(today, next))}）` : '之後不會再扣款');
    if (cur.end) parts.push(`${fmtDate(cur.end)} 起${cur.endType === 'pause' ? '暫停' : '取消'}續訂，效期到 ${fmtDate(until)}`);
  } else if (status === 'paused') {
    parts.push(cur.resumeAt ? `暫停中，預計 ${fmtDate(cur.resumeAt)} 恢復` : `暫停中，效期 ${fmtDate(until)} 已結束，不會扣款`);
  } else {
    parts.push(`已取消，效期 ${fmtDate(until)} 已結束，不會再扣款`);
  }
  if (paid.count) parts.push(`至今已扣 ${paid.count} 次，共約 ${money(paid.total)}${paid.actualCount ? `（其中 ${paid.actualCount} 次為實際金額）` : ''}`);
  if (st.buys) parts.push(`疊加下訂 ${st.buys} 次`);
  if (st.gifts) parts.push(`序號贈送 ${st.gifts} 次、共 ${st.giftDays} 天，約值 ${money(st.giftValue)}`);
  if (st.periods > 1 || st.pauses) {
    parts.push(`共訂閱 ${fmtMonths(st.activeMonths)}${st.pauses ? `、暫停 ${st.pauses} 次（共 ${fmtMonths(st.pausedMonths)}）` : ''}${st.saved >= 1 ? `，暫停期間約省下 ${money(st.saved)}` : ''}`);
  }
  preview.textContent = parts.join('・');
}

function openSubEditor(id) {
  const sub = id ? state.subs.find(s => s.id === id) : null;
  state.editingSubId = sub ? sub.id : null;
  const form = $('#sub-form');
  form.reset();
  const s = sub || { currency: 'TWD', cycle: 'month', every: 1 };
  for (const key of ['name', 'category', 'currency', 'cycle', 'every', 'link', 'note']) {
    form[key].value = s[key] ?? '';
  }
  form.feePct.value = sub ? sub.feePct : defaultFeePct(s.currency);
  form.currency.dataset.prev = s.currency;
  state.subPeriods = sub
    ? sub.periods.map(p => ({ ...p }))
    : [{ start: taipeiToday(), end: '', endType: '', resumeAt: '', price: '', currency: 'TWD', feePct: 0 }];
  const used = state.subs.map(x => x.category).filter(Boolean);
  $('#dl-sub-category').innerHTML = [...new Set([...SUB_CATEGORIES, ...used])].map(v => `<option value="${esc(v)}">`).join('');
  $('#sub-title').textContent = sub ? '編輯訂閱' : '新增訂閱';
  $('#sub-delete').hidden = !sub;
  $('#sub-charges').innerHTML = '';
  refreshPeriodsUi();
  $('#sub-editor').showModal();
}

async function submitSubEditor(e) {
  e.preventDefault();
  collectPeriods();
  const problem = validatePeriods(draftPeriods());
  if (problem) { toast(problem); return; }
  const sub = subFromForm();
  const isNew = !state.editingSubId;
  $('#sub-editor').close();
  try {
    await state.store.saveSub(sub);
    toast(isNew ? `已新增訂閱「${sub.name}」` : '已更新');
  } catch (err) {
    toast('儲存失敗：' + err.message);
  }
}

async function deleteCurrentSub() {
  const sub = state.subs.find(s => s.id === state.editingSubId);
  if (!sub) return;
  if (!confirm(`確定要刪除「${sub.name}」嗎？\n刪除後累計已付的紀錄也會消失。\n如果只是不再續訂，建議按「取消訂閱」保留紀錄。`)) return;
  $('#sub-editor').close();
  await state.store.removeSub(sub.id);
  toast('已刪除訂閱');
}

boot().catch(e => {
  console.error(e);
  document.body.innerHTML = `<p style="padding:24px">啟動失敗：${esc(e.message)}</p>`;
});
