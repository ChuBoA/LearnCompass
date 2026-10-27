// 密碼鎖：密碼只存在這台裝置（加鹽 SHA-256），用來防止別人打開 APP 看到課程，不是資料加密。
const KEY = 'lc.lock';
const UNLOCKED = 'lc.unlocked';
const HIDDEN_AT = 'lc.hiddenAt';

export const AUTO_LOCK_CHOICES = [
  [0, '離開 APP 就上鎖'],
  [1, '離開 1 分鐘後'],
  [5, '離開 5 分鐘後'],
  [15, '離開 15 分鐘後'],
  [-1, '只在重新開啟 APP 時']
];

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

function write(value) {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch { /* 無法儲存時密碼鎖等同關閉 */ }
}

function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { return null; }
}

async function hash(pin, salt) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const isValidPin = pin => /^\d{4,6}$/.test(pin);

export function lockEnabled() {
  return !!read()?.hash;
}

export function lockSettings() {
  const cfg = read();
  return { enabled: !!cfg?.hash, length: cfg?.length || 4, autoLockMin: cfg?.autoLockMin ?? 1 };
}

export async function setPin(pin) {
  const salt = crypto.getRandomValues(new Uint32Array(4)).join('-');
  const old = read();
  write({ salt, hash: await hash(pin, salt), length: pin.length, autoLockMin: old?.autoLockMin ?? 1 });
  session(UNLOCKED, '1');
}

export function setAutoLock(minutes) {
  const cfg = read();
  if (cfg) write({ ...cfg, autoLockMin: minutes });
}

export function clearPin() {
  write(null);
  session(UNLOCKED, null);
}

export async function verifyPin(pin) {
  const cfg = read();
  return !!cfg && (await hash(pin, cfg.salt)) === cfg.hash;
}

// 本次開啟 APP 是否需要先解鎖（sessionStorage 在 APP 關閉後會清空）
export function needsUnlock() {
  if (!lockEnabled() || session(UNLOCKED) !== '1') return lockEnabled();
  const { autoLockMin } = lockSettings();
  const hiddenAt = Number(session(HIDDEN_AT) || 0);
  return autoLockMin >= 0 && hiddenAt > 0 && Date.now() - hiddenAt >= autoLockMin * 60000;
}

export function markUnlocked() {
  session(UNLOCKED, '1');
  session(HIDDEN_AT, null);
}

export function markLocked() {
  session(UNLOCKED, null);
}

// 切到背景時記錄時間，回來時若超過設定就呼叫 onLock
export function watchVisibility(onLock) {
  document.addEventListener('visibilitychange', () => {
    if (!lockEnabled()) return;
    if (document.visibilityState === 'hidden') {
      if (session(UNLOCKED) === '1') session(HIDDEN_AT, String(Date.now()));
    } else if (needsUnlock()) {
      markLocked();
      onLock();
    } else {
      session(HIDDEN_AT, null);
    }
  });
}
