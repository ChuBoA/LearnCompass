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

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

// 預設分類；使用者在「設定 > 分類管理」改過之後，就以存在雲端設定裡的清單為準
const DEFAULT_CATEGORY_LIST = [
  ['心靈成長', '🧘'], ['理財投資', '💰'], ['程式設計', '💻'], ['平面創作', '🎨'], ['語言學習', '🗣️'],
  ['生活技能', '🏠'], ['學術報告', '📊'], ['健康運動', '🏃'], ['親子教育', '👶'], ['聲音藝術', '🎤']
].map(([name, emoji]) => ({ name, emoji }));
const DEFAULT_EMOJI = '📚';
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
  pinMode: 'set'
};

// ---------- 小工具 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = n => 'NT$ ' + Math.round(n || 0).toLocaleString('en-US');
const fmtDate = d => (d ? d.replace(/-/g, '/') : '');
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const linkify = text => esc(text).replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
const icon = name => `<svg class="i"><use href="#i-${name}"/></svg>`;
const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);

// 分類清單：[{ name, emoji }]
function categoryList() {
  const saved = state.settings.categories;
  if (Array.isArray(saved)) return saved;
  // 還沒管理過：預設分類 + 課程裡已經用到的其他分類
  const list = DEFAULT_CATEGORY_LIST.map(c => ({ ...c }));
  state.courses.forEach(c => {
    if (c.category && !list.some(x => x.name === c.category)) list.push({ name: c.category, emoji: DEFAULT_EMOJI });
  });
  return list;
}
const emojiOf = cat => categoryList().find(c => c.name === cat)?.emoji || DEFAULT_EMOJI;

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
      case 'export-json': download(`學習羅盤備份_${taipeiToday()}.json`, JSON.stringify({ version: 1, courses: state.courses, settings: state.settings }, null, 2), 'application/json'); break;
      case 'logout': if (confirm('確定要登出嗎？')) state.store.signOut(); break;
      case 'tab': switchTab(el.dataset.tab); break;
      case 'filter-status': $('#f-status').value = el.dataset.value; $('#f-category').value = ''; switchTab('courses'); renderCourses(); break;
      case 'enable-push': enablePush(el); break;
      case 'test-notify': testNotify(); break;
      case 'install': state.installPrompt?.prompt(); break;
      case 'clear-all': clearAll(); break;
      case 'pin': openPinDialog(el.dataset.mode); break;
      case 'lock-now': markLocked(); state.locked = true; state.pinEntry = ''; updateScreens(); break;
      case 'cat-delete': deleteCategory(Number(el.dataset.i)); break;
      case 'cat-up': moveCategory(Number(el.dataset.i), -1); break;
      case 'cat-down': moveCategory(Number(el.dataset.i), 1); break;
    }
  });

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

  // 課程表單：選「新增分類…」
  form.category.addEventListener('change', async () => {
    if (form.category.value !== '__new') return;
    const name = prompt('新分類名稱');
    const added = name ? await addCategory(name, '') : false;
    fillCategorySelect(added || '');
  });

  $('#view-settings').addEventListener('submit', async e => {
    if (e.target.id !== 'cat-add') return;
    e.preventDefault();
    const f = e.target;
    if (await addCategory(f.name.value, f.emoji.value)) $('#cat-add [name=name]')?.focus();
  });
  $('#view-settings').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest('.cat-row')) { e.preventDefault(); e.target.blur(); }
  });

  $('#view-settings').addEventListener('change', e => {
    const row = e.target.closest('.cat-row');
    if (row) {
      const i = Number(row.dataset.i);
      if (e.target.matches('.cat-name')) renameCategory(i, e.target.value);
      else if (e.target.matches('.cat-emoji')) setCategoryEmoji(i, e.target.value);
      return;
    }
    if (e.target.closest('#cat-add')) return;
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
    if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
      const data = JSON.parse(text);
      incoming = (data.courses || data).map(normalizeCourse);
      if (data.settings) {
        state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
        await state.store.saveSettings(state.settings);
      }
    } else {
      incoming = csvToCourses(text);
    }
    if (!incoming.length) { toast('檔案裡沒有找到課程'); return; }
    const { courses, added, updated } = mergeImport(state.courses, incoming);
    const sessions = sum(courses, c => c.sessions.length);
    if (!confirm(`即將匯入 ${courses.length} 門課：\n・新增 ${added} 門\n・更新 ${updated} 門（以課程名稱＋購買日期比對）\n・共 ${sessions} 個上課場次\n\n確定匯入？`)) return;
    await state.store.saveMany(courses);
    await ensureCategories(courses.map(c => c.category));
    toast(`匯入完成：新增 ${added}、更新 ${updated}`);
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

function courseCard(c, today) {
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
  $('#grid').innerHTML = list.length ? list.map(c => courseCard(c, today)).join('') : emptyState();
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

    ${categoryPanel()}

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
  state.settings = { ...state.settings, ...s };
  try { await state.store.saveSettings(state.settings); toast('提醒設定已儲存'); }
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
  fillCategorySelect(c.category || '');
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
    name: form.name.value, teacher: form.teacher.value, category: form.category.value === '__new' ? '' : form.category.value,
    platform: form.platform.value, price: form.price.value, purchaseDate: form.purchaseDate.value,
    accessUntil: form.accessUntil.value, energy, link: form.link.value, note: form.note.value,
    sessions, updatedAt: now,
    lastStudiedAt: old && energy > old.energy ? now : old?.lastStudiedAt || null
  };
  $('#editor').close();
  await saveCourse(course);
  toast(old ? '已更新' : '已新增課程 🌱');
}

// ---------- 分類管理 ----------
function fillCategorySelect(selected) {
  const list = categoryList();
  const extra = selected && !list.some(c => c.name === selected) ? [{ name: selected, emoji: DEFAULT_EMOJI }] : [];
  $('#editor-form').category.innerHTML = '<option value="">未分類</option>'
    + [...list, ...extra].map(c => `<option value="${esc(c.name)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('')
    + '<option value="__new">＋ 新增分類…</option>';
  $('#editor-form').category.value = selected;
}

const cleanCatName = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 20);
const cleanEmoji = s => [...String(s || '').trim()].slice(0, 2).join('') || DEFAULT_EMOJI;

async function saveCategories(list) {
  state.settings = { ...state.settings, categories: list };
  try { await state.store.saveSettings(state.settings); }
  catch (e) { toast('分類儲存失敗：' + e.message); }
  render();
}

// 匯入或新增課程時，遇到清單裡沒有的分類就自動加進去
async function ensureCategories(names) {
  const list = categoryList();
  const missing = [...new Set(names.map(cleanCatName).filter(Boolean))].filter(n => !list.some(c => c.name === n));
  if (missing.length || !Array.isArray(state.settings.categories)) {
    await saveCategories([...list, ...missing.map(name => ({ name, emoji: DEFAULT_EMOJI }))]);
  }
}

async function addCategory(name, emoji) {
  name = cleanCatName(name);
  if (!name) { toast('請輸入分類名稱'); return false; }
  if (name === '未分類' || name === '__new') { toast('這個名稱不能使用'); return false; }
  const list = categoryList();
  if (list.some(c => c.name === name)) { toast(`「${name}」已經存在`); return false; }
  await saveCategories([...list, { name, emoji: cleanEmoji(emoji) }]);
  toast(`已新增分類「${name}」`);
  return name;
}

async function renameCategory(index, newName) {
  const list = categoryList().map(c => ({ ...c }));
  const cat = list[index];
  if (!cat) return;
  newName = cleanCatName(newName);
  if (!newName || newName === cat.name) { renderSettings(); return; }
  if (newName === '未分類' || list.some(c => c.name === newName)) { toast(`「${newName}」已經存在或不能使用`); renderSettings(); return; }
  const old = cat.name;
  cat.name = newName;
  const now = new Date().toISOString();
  const changed = state.courses.filter(c => c.category === old).map(c => normalizeCourse({ ...c, category: newName, updatedAt: now }));
  await saveCategories(list);
  if (changed.length) await state.store.saveMany(changed);
  toast(`已改名為「${newName}」${changed.length ? `，${changed.length} 門課程一起更新` : ''}`);
}

async function setCategoryEmoji(index, emoji) {
  const list = categoryList().map(c => ({ ...c }));
  if (!list[index]) return;
  list[index].emoji = cleanEmoji(emoji);
  await saveCategories(list);
}

async function deleteCategory(index) {
  const list = categoryList().map(c => ({ ...c }));
  const cat = list[index];
  if (!cat) return;
  const used = state.courses.filter(c => c.category === cat.name);
  const msg = used.length
    ? `「${cat.name}」目前有 ${used.length} 門課程使用。\n刪除後，這些課程會改成「未分類」。\n\n確定刪除？`
    : `確定刪除分類「${cat.name}」？`;
  if (!confirm(msg)) return;
  list.splice(index, 1);
  const now = new Date().toISOString();
  await saveCategories(list);
  if (used.length) await state.store.saveMany(used.map(c => normalizeCourse({ ...c, category: '', updatedAt: now })));
  toast(`已刪除分類「${cat.name}」`);
}

async function moveCategory(index, delta) {
  const list = categoryList().map(c => ({ ...c }));
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to], list[index]];
  await saveCategories(list);
}

function categoryPanel() {
  const list = categoryList();
  const counts = new Map();
  state.courses.forEach(c => counts.set(c.category || '', (counts.get(c.category || '') || 0) + 1));
  const unc = counts.get('') || 0;
  return `
    <div class="panel">
      <h2>${icon('grid')}分類管理 <small>共 ${list.length} 個</small></h2>
      <p class="muted-text">直接修改圖示或名稱就會儲存；改名時，使用這個分類的課程會一起更新。</p>
      <ul class="cat-list">${list.map((c, i) => `
        <li class="cat-row" data-i="${i}">
          <input class="cat-emoji" value="${esc(c.emoji)}" aria-label="${esc(c.name)} 的圖示" autocomplete="off">
          <input class="cat-name" value="${esc(c.name)}" maxlength="20" aria-label="分類名稱" autocomplete="off">
          <span class="cat-count">${counts.get(c.name) || 0} 門</span>
          <div class="cat-actions">
            <button type="button" class="btn quiet small icon-only" data-action="cat-up" data-i="${i}" aria-label="上移" title="上移" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button type="button" class="btn quiet small icon-only" data-action="cat-down" data-i="${i}" aria-label="下移" title="下移" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
            <button type="button" class="btn quiet small icon-only" data-action="cat-delete" data-i="${i}" aria-label="刪除 ${esc(c.name)}" title="刪除">${icon('trash')}</button>
          </div>
        </li>`).join('')}
      </ul>
      ${unc ? `<p class="muted-text">未分類：${unc} 門</p>` : ''}
      <form class="cat-add" id="cat-add">
        <input name="emoji" class="cat-emoji" placeholder="${DEFAULT_EMOJI}" aria-label="新分類的圖示" autocomplete="off">
        <input name="name" placeholder="新分類名稱" maxlength="20" aria-label="新分類名稱" autocomplete="off">
        <button type="submit" class="btn primary small">${icon('plus')}新增</button>
      </form>
    </div>`;
}

boot().catch(e => {
  console.error(e);
  document.body.innerHTML = `<p style="padding:24px">啟動失敗：${esc(e.message)}</p>`;
});
