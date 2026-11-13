// 資料儲存：有 Firebase 設定時用雲端（Firestore，自動同步＋離線快取），否則用本機 localStorage。
import { DEFAULT_SETTINGS } from './reminders.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export async function createStore({ onCourses, onAuth }) {
  const cfg = self.LC_CONFIG || {};
  return cfg.firebase ? firebaseStore(cfg, onCourses, onAuth) : localStore(onCourses, onAuth);
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隱私模式等情況 */ }
}

function localStore(onCourses, onAuth) {
  let courses = readJson('lc.courses', []);
  const commit = () => { writeJson('lc.courses', courses); onCourses([...courses]); };
  const upsert = c => {
    const i = courses.findIndex(x => x.id === c.id);
    if (i >= 0) courses[i] = c; else courses.push(c);
  };
  queueMicrotask(() => { onAuth({ local: true }); onCourses([...courses]); });
  return {
    mode: 'local',
    async signIn() {},
    async signOut() {},
    async save(c) { upsert(c); commit(); },
    async saveMany(list) { list.forEach(upsert); commit(); },
    async remove(id) { courses = courses.filter(c => c.id !== id); commit(); },
    async removeAll() { courses = []; commit(); },
    async getSettings() { return { ...DEFAULT_SETTINGS, ...readJson('lc.settings', {}) }; },
    async saveSettings(s) { writeJson('lc.settings', s); },
    async saveToken() { throw new Error('推播需要先完成雲端設定（見 SETUP.md）。'); }
  };
}

async function firebaseStore(cfg, onCourses, onAuth) {
  const [appMod, authMod, fs] = await Promise.all([
    import(FB + 'firebase-app.js'),
    import(FB + 'firebase-auth.js'),
    import(FB + 'firebase-firestore.js')
  ]);
  const app = appMod.initializeApp(cfg.firebase);
  const auth = authMod.getAuth(app);
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
  });

  let uid = null;
  let unsubscribe = null;
  authMod.getRedirectResult(auth).catch(() => {});
  authMod.onAuthStateChanged(auth, user => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    uid = user ? user.uid : null;
    onAuth(user ? { name: user.displayName, email: user.email, photo: user.photoURL } : null);
    if (user) {
      unsubscribe = fs.onSnapshot(fs.collection(db, 'users', uid, 'courses'),
        snap => onCourses(snap.docs.map(d => d.data())));
    }
  });

  const courseDoc = id => fs.doc(db, 'users', uid, 'courses', id);
  const userDoc = () => fs.doc(db, 'users', uid);

  return {
    mode: 'cloud',
    app,
    async signIn() {
      const provider = new authMod.GoogleAuthProvider();
      try {
        await authMod.signInWithPopup(auth, provider);
      } catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) {
          await authMod.signInWithRedirect(auth, provider);
        } else if (e.code !== 'auth/popup-closed-by-user') throw e;
      }
    },
    signOut: () => authMod.signOut(auth),
    save: c => fs.setDoc(courseDoc(c.id), c),
    async saveMany(list) {
      for (let i = 0; i < list.length; i += 400) {
        const batch = fs.writeBatch(db);
        list.slice(i, i + 400).forEach(c => batch.set(courseDoc(c.id), c));
        await batch.commit();
      }
    },
    remove: id => fs.deleteDoc(courseDoc(id)),
    async removeAll() {
      const snap = await fs.getDocs(fs.collection(db, 'users', uid, 'courses'));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = fs.writeBatch(db);
        snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    },
    async getSettings() {
      const snap = await fs.getDoc(userDoc());
      return { ...DEFAULT_SETTINGS, ...(snap.data()?.settings || {}) };
    },
    saveSettings: s => fs.setDoc(userDoc(), { settings: s }, { merge: true }),
    saveToken: token => fs.setDoc(fs.doc(db, 'users', uid, 'tokens', token), {
      token,
      device: navigator.userAgent.slice(0, 200),
      createdAt: new Date().toISOString()
    })
  };
}

export async function getPushToken(store) {
  const cfg = self.LC_CONFIG || {};
  if (store.mode !== 'cloud') throw new Error('推播需要先完成雲端設定（見 SETUP.md）。');
  if (!cfg.vapidKey) throw new Error('config.js 尚未填入 vapidKey（見 SETUP.md）。');
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    throw new Error('這個瀏覽器不支援推播。iPhone 請先用 Safari「加入主畫面」，再從主畫面打開 APP。');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知權限未開啟，請到手機設定允許此 APP 的通知。');
  const { getMessaging, getToken, isSupported } = await import(FB + 'firebase-messaging.js');
  if (!(await isSupported())) throw new Error('這個瀏覽器不支援推播。iPhone 請先「加入主畫面」再打開。');
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(store.app), { vapidKey: cfg.vapidKey, serviceWorkerRegistration: registration });
  await store.saveToken(token);
  return token;
}
