// Google 雲端硬碟：授權、上傳、下載、離線佇列
// 只使用 drive.file 權限：學習羅盤只看得到「自己上傳的檔案」，碰不到你雲端硬碟裡的其他東西。
const CFG = self.LC_CONFIG || {};
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_NAME = '學習羅盤';
const TOKEN_KEY = 'lc.driveToken';
const FOLDER_KEY = 'lc.driveFolder';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 30;
export const driveConfigured = () => !!CFG.googleClientId;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 忽略 */ } }
};

export class NeedAuthError extends Error {
  constructor() { super('需要連結 Google 雲端硬碟'); this.name = 'NeedAuthError'; }
}

// ---------- 授權（Google Identity Services） ----------
let gisPromise = null;
let tokenClient = null;
let pendingAuth = null;
let hintEmail = '';

export function setDriveAccount(email) { hintEmail = email || ''; }

// 事先載入，按鈕按下時才能「同步」跳出授權視窗（不然會被瀏覽器當成廣告視窗擋掉）
export function preloadDrive() {
  if (!driveConfigured() || gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new Error('無法載入 Google 授權元件，請檢查網路')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

function storedToken() {
  try {
    const t = JSON.parse(ls.get(TOKEN_KEY) || 'null');
    return t && t.exp > Date.now() + 60_000 ? t : null;
  } catch { return null; }
}

export const driveConnected = () => !!storedToken();
export const driveTokenExpiry = () => storedToken()?.exp || 0;

function forgetToken() { ls.del(TOKEN_KEY); }

// 一定要在使用者點擊的當下呼叫
export function connectDrive() {
  if (!driveConfigured()) return Promise.reject(new Error('尚未設定 googleClientId（請看 SETUP.md）'));
  if (pendingAuth) return pendingAuth;
  if (!window.google?.accounts?.oauth2) {
    preloadDrive();
    return Promise.reject(new Error('Google 授權元件還在載入，請稍等一下再按一次'));
  }
  pendingAuth = new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.googleClientId,
      scope: SCOPE,
      hint: hintEmail || undefined,
      callback: resp => {
        pendingAuth = null;
        if (resp.error || !google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
          reject(new Error(resp.error === 'access_denied' || !resp.error ? '沒有取得雲端硬碟權限' : '授權失敗：' + resp.error));
          return;
        }
        ls.set(TOKEN_KEY, JSON.stringify({ token: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 }));
        resolve();
      },
      error_callback: err => {
        pendingAuth = null;
        reject(new Error(err?.type === 'popup_closed' ? '授權視窗已關閉' : err?.type === 'popup_failed_to_open' ? '授權視窗被瀏覽器擋住了，請允許彈出式視窗' : '授權失敗'));
      }
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
  return pendingAuth;
}

export function disconnectDrive() {
  const t = storedToken();
  forgetToken();
  ls.del(FOLDER_KEY);
  if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t.token, () => {});
}

async function api(url, opts = {}) {
  const t = storedToken();
  if (!t) throw new NeedAuthError();
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${t.token}`, ...(opts.headers || {}) } });
  if (res.status === 401) { forgetToken(); throw new NeedAuthError(); }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* 忽略 */ }
    const err = new Error('雲端硬碟錯誤：' + msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ---------- 資料夾與檔案 ----------
async function folderId() {
  const cached = ls.get(FOLDER_KEY);
  if (cached) return cached;
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await (await api(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&pageSize=1`)).json();
  let id = found.files?.[0]?.id;
  if (!id) {
    const created = await (await api(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
    })).json();
    id = created.id;
  }
  ls.set(FOLDER_KEY, id);
  return id;
}

async function uploadBlob(blob, name, mime) {
  let parent;
  try { parent = await folderId(); }
  catch (e) { if (e instanceof NeedAuthError) throw e; parent = null; }
  const meta = { name, mimeType: mime, ...(parent ? { parents: [parent] } : {}) };
  const fields = 'id,webViewLink';
  try {
    return await doUpload(blob, meta, mime, fields);
  } catch (e) {
    // 資料夾被手動刪除：重建一次再試
    if (e.status === 404 && parent) {
      ls.del(FOLDER_KEY);
      meta.parents = [await folderId()];
      return doUpload(blob, meta, mime, fields);
    }
    throw e;
  }
}

async function doUpload(blob, meta, mime, fields) {
  if (blob.size <= 5 * 1024 * 1024) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob);
    return (await api(`${UPLOAD}?uploadType=multipart&fields=${fields}`, { method: 'POST', body: form })).json();
  }
  const start = await api(`${UPLOAD}?uploadType=resumable&fields=${fields}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
    body: JSON.stringify(meta)
  });
  const location = start.headers.get('Location');
  if (!location) throw new Error('雲端硬碟沒有回傳上傳位置');
  const res = await fetch(location, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob });
  if (!res.ok) throw new Error(`上傳失敗（HTTP ${res.status}）`);
  return res.json();
}

const MEDIA_CACHE = 'lc-drive-media';

// 讀取原檔（快取起來，下次離線也看得到）
export async function fetchDriveFile(driveId) {
  const key = `https://lc.local/drive/${driveId}`;
  try {
    const hit = await (await caches.open(MEDIA_CACHE)).match(key);
    if (hit) return hit.blob();
  } catch { /* 忽略 */ }
  const res = await api(`${API}/files/${encodeURIComponent(driveId)}?alt=media`);
  const blob = await res.blob();
  try { await (await caches.open(MEDIA_CACHE)).put(key, new Response(blob)); } catch { /* 忽略 */ }
  return blob;
}

async function trashDriveFile(driveId) {
  try {
    await api(`${API}/files/${encodeURIComponent(driveId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });
  } catch (e) {
    if (e.status === 404) return; // 已經不在了
    throw e;
  }
  try { await (await caches.open(MEDIA_CACHE)).delete(`https://lc.local/drive/${driveId}`); } catch { /* 忽略 */ }
}

// ---------- 離線佇列（IndexedDB） ----------
// 每一筆：{ key, op: 'upload' | 'trash', noteId, attId, blob, name, mime, driveId }
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('learncompass', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('queue', mode);
    const out = fn(t.objectStore('queue'));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('儲存空間不足'));
  });
}

export const queueAll = () => tx('readonly', s => s.getAll()).then(r => r || []);
export const queueGet = key => tx('readonly', s => s.get(key));
const queuePut = item => tx('readwrite', s => s.put(item));
const queueDel = key => tx('readwrite', s => s.delete(key));

export const enqueueUpload = (noteId, attId, blob, name, mime) =>
  queuePut({ key: 'up:' + attId, op: 'upload', noteId, attId, blob, name, mime });
export const enqueueTrash = driveId => queuePut({ key: 'trash:' + driveId, op: 'trash', driveId });
export const dropUpload = attId => queueDel('up:' + attId);
export async function localBlob(attId) { return (await queueGet('up:' + attId))?.blob || null; }
export async function pendingCount() { return (await queueAll()).filter(i => i.op === 'upload').length; }

let running = null;
// onUploaded(noteId, attId, {driveId, link}) 由 app.js 更新筆記
export function processQueue(onUploaded, onProgress) {
  if (running) return running;
  running = (async () => {
    let done = 0;
    let failed = 0;
    try {
      if (!storedToken()) throw new NeedAuthError();
      for (const item of await queueAll()) {
        if (!navigator.onLine) break;
        try {
          if (item.op === 'upload') {
            onProgress?.(item);
            const file = await uploadBlob(item.blob, item.name, item.mime);
            try { await (await caches.open(MEDIA_CACHE)).put(`https://lc.local/drive/${file.id}`, new Response(item.blob)); } catch { /* 忽略 */ }
            await onUploaded(item.noteId, item.attId, { driveId: file.id, link: file.webViewLink || '' });
          } else {
            await trashDriveFile(item.driveId);
          }
          await queueDel(item.key);
          done++;
        } catch (e) {
          if (e instanceof NeedAuthError) throw e;
          console.warn('雲端硬碟同步失敗', e);
          failed++;
        }
      }
      return { done, failed };
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------- 圖片處理 ----------
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取這張圖片')); };
    img.src = url;
  });
}

function drawScaled(img, maxEdge) {
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 透明背景轉成白色，避免變黑
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, w, h };
}

const toBlob = (canvas, q) => new Promise(r => canvas.toBlob(r, 'image/jpeg', q));

// 回傳 { blob, mime, name, w, h, thumb }：長邊壓到 1600px，另產生 360px 縮圖存在筆記裡
export async function prepareImage(file) {
  const { img, url } = await loadImage(file);
  try {
    const big = drawScaled(img, 1600);
    const keepOriginal = file.type === 'image/gif'
      || (file.type === 'image/jpeg' && Math.max(img.naturalWidth, img.naturalHeight) <= 1600 && file.size <= 1.5 * 1024 * 1024);
    let blob = file;
    let mime = file.type || 'image/jpeg';
    if (!keepOriginal) {
      blob = await toBlob(big.canvas, 0.85);
      mime = 'image/jpeg';
      if (!blob) throw new Error('圖片壓縮失敗');
    }
    const small = drawScaled(img, 360);
    const thumb = small.canvas.toDataURL('image/jpeg', 0.7);
    const base = (file.name || '圖片').replace(/\.[^.]+$/, '') || '圖片';
    const name = mime === 'image/jpeg' && !keepOriginal ? `${base}.jpg` : (file.name || `${base}.jpg`);
    return { blob, mime, name, w: big.w, h: big.h, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}
