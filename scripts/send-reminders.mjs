// 由 GitHub Actions 每天執行：讀取每位使用者的課程，計算今天該發的提醒，透過 Firebase Cloud Messaging 推播。
// 需要環境變數 FIREBASE_SERVICE_ACCOUNT（服務帳戶 JSON 全文）；APP_URL（選填，點通知要打開的網址）。
// TEST_PUSH=true 時不看規則，直接送一則測試通知給所有已註冊的裝置。
import admin from 'firebase-admin';
import { computePushMessages, DEFAULT_SETTINGS, taipeiToday } from '../js/reminders.js';

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('缺少 FIREBASE_SERVICE_ACCOUNT，請在 GitHub 的 Settings > Secrets and variables > Actions 新增。');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const appUrl = (process.env.APP_URL || '').trim().replace(/\/?$/, '/');
const testMode = process.env.TEST_PUSH === 'true';
const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

async function send(tokens, message) {
  const webpush = {
    notification: {
      title: message.title,
      body: message.body,
      tag: message.tag,
      ...(appUrl.startsWith('https://') ? { icon: appUrl + 'icons/icon-192.png' } : {})
    },
    ...(appUrl.startsWith('https://') ? { fcmOptions: { link: appUrl } } : {})
  };
  const res = await admin.messaging().sendEachForMulticast({ tokens, webpush });
  const dead = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      console.warn('  傳送失敗', r.error?.code);
      if (DEAD_TOKEN.has(r.error?.code)) dead.push(tokens[i]);
    }
  });
  return { sent: res.successCount, dead };
}

let total = 0;
const users = await db.collection('users').listDocuments();
console.log(`今天（台灣）${taipeiToday()}，共 ${users.length} 位使用者`);

for (const userRef of users) {
  const [userSnap, courseSnap, tokenSnap] = await Promise.all([
    userRef.get(), userRef.collection('courses').get(), userRef.collection('tokens').get()
  ]);
  let tokens = tokenSnap.docs.map(d => d.data().token).filter(Boolean);
  if (!tokens.length) continue;

  const settings = { ...DEFAULT_SETTINGS, ...(userSnap.data()?.settings || {}) };
  const messages = testMode
    ? [{ tag: 'test', title: '🧭 學習羅盤', body: '推播測試成功！之後每天早上會在這裡提醒你。' }]
    : computePushMessages(courseSnap.docs.map(d => d.data()), settings);
  console.log(`使用者 ${userRef.id.slice(0, 6)}…：${tokens.length} 台裝置、${messages.length} 則通知`);

  for (const message of messages) {
    if (!tokens.length) break;
    const { sent, dead } = await send(tokens, message);
    total += sent;
    for (const t of dead) await userRef.collection('tokens').doc(t).delete();
    tokens = tokens.filter(t => !dead.includes(t));
    console.log(`  ・${message.title}（送達 ${sent}）`);
  }
}

console.log(`完成，共送出 ${total} 則`);
