// 訂閱（軟體、服務）：計算規則。網頁與 GitHub Actions 推播腳本共用，不可使用任何瀏覽器 API。
import { taipeiToday, dayDiff, DEFAULT_SETTINGS } from './reminders.js';

export const CURRENCIES = {
  TWD: { label: '新台幣', symbol: 'NT$' },
  USD: { label: '美元', symbol: 'US$' },
  EUR: { label: '歐元', symbol: '€' },
  JPY: { label: '日圓', symbol: '¥' },
  CNY: { label: '人民幣', symbol: 'CN¥' },
  HKD: { label: '港幣', symbol: 'HK$' }
};

// 1 單位外幣 = 幾元新台幣（使用者可在設定修改）
export const DEFAULT_RATES = DEFAULT_SETTINGS.rates;
export const DEFAULT_SUB_NOTIFY_DAYS = DEFAULT_SETTINGS.subNotifyDays;

export const SUB_CATEGORIES = ['AI 工具', '設計創作', '影音娛樂', '學習平台', '雲端儲存', '生產力', '其他'];

export function newSubId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

export function normalizeSub(s) {
  const now = new Date().toISOString();
  const cycle = s.cycle === 'year' ? 'year' : 'month';
  const currency = CURRENCIES[s.currency] ? s.currency : 'TWD';
  const fee = Number(s.feePct);
  return {
    id: s.id || newSubId(),
    name: String(s.name || '').trim().slice(0, 100) || '未命名訂閱',
    category: String(s.category || '').trim().slice(0, 30),
    price: Math.max(0, Math.round((Number(s.price) || 0) * 100) / 100),
    currency,
    // 國外交易手續費（%）：外幣預設 1.5%，新台幣預設 0%
    feePct: s.feePct === undefined || s.feePct === '' || !Number.isFinite(fee)
      ? defaultFeePct(currency)
      : Math.min(20, Math.max(0, Math.round(fee * 100) / 100)),
    // 實際扣款紀錄：[{ date: 扣款日 YYYY-MM-DD, twd: 帳單上的新台幣金額 }]
    charges: normalizeCharges(s.charges),
    cycle,
    every: Math.min(cycle === 'month' ? 36 : 10, Math.max(1, Math.round(Number(s.every) || 1))),
    startDate: isDate(s.startDate) ? s.startDate : taipeiToday(),
    cancelledAt: isDate(s.cancelledAt) ? s.cancelledAt : '',
    link: String(s.link || '').trim().slice(0, 500),
    note: String(s.note || '').slice(0, 2000),
    createdAt: s.createdAt || now,
    updatedAt: s.updatedAt || now
  };
}

export const defaultFeePct = currency => (currency === 'TWD' ? 0 : 1.5);

function normalizeCharges(list) {
  if (!Array.isArray(list)) return [];
  const byDate = new Map();
  for (const c of list) {
    const twd = Math.round((Number(c?.twd) || 0) * 100) / 100;
    if (isDate(c?.date) && twd > 0) byDate.set(c.date, { date: c.date, twd });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-240);
}

export const isActive = (sub, today) => !sub.cancelledAt || sub.cancelledAt > today;

const monthsPerCharge = sub => (sub.cycle === 'year' ? 12 : 1) * (sub.every || 1);

// 第 k 次扣款日：以開始日的「日」為錨點，遇到月底自動調整（例如 1/31 → 2/28 → 3/31）
export function chargeDate(sub, k) {
  const [y, m, d] = sub.startDate.split('-').map(Number);
  const total = (m - 1) + k * monthsPerCharge(sub);
  const year = y + Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// 今天之後（含今天）的下一次扣款日；已取消則為 null
export function nextCharge(sub, today = taipeiToday()) {
  if (!isActive(sub, today)) return null;
  if (sub.startDate >= today) return sub.startDate;
  const approx = Math.max(0, Math.floor(dayDiff(sub.startDate, today) / (monthsPerCharge(sub) * 31)) - 1);
  for (let k = approx; k < approx + 400; k++) {
    const d = chargeDate(sub, k);
    if (d >= today) return d;
  }
  return null;
}

// 到今天為止已經扣了幾次（取消日當天以後不再扣款）
export function paidCount(sub, today = taipeiToday()) {
  let n = 0;
  for (let k = 0; k < 2000; k++) {
    const d = chargeDate(sub, k);
    if (d > today || (sub.cancelledAt && d >= sub.cancelledAt)) break;
    n++;
  }
  return n;
}

export function rateOf(currency, rates = DEFAULT_RATES) {
  if (currency === 'TWD') return 1;
  const r = Number((rates || {})[currency]);
  return r > 0 ? r : DEFAULT_RATES[currency] || 1;
}

export const toTwd = (amount, currency, rates) => amount * rateOf(currency, rates);

// 估算一期扣款：外幣金額 × 匯率 × (1 + 手續費%)
export const estimateTwd = (sub, rates) => toTwd(sub.price, sub.currency, rates) * (1 + (sub.feePct || 0) / 100);

// 預估下一期：填過實際金額就用最近 3 次的平均（自然反映匯率與手續費），否則用估算
export function chargeTwd(sub, rates) {
  const recent = (sub.charges || []).slice(-3);
  if (recent.length) return recent.reduce((t, c) => t + c.twd, 0) / recent.length;
  return estimateTwd(sub, rates);
}
export const usesActual = sub => (sub.charges || []).length > 0;

// 換算成每月的新台幣
export function monthlyTwd(sub, rates) {
  return chargeTwd(sub, rates) / monthsPerCharge(sub);
}

// 到今天為止的每一期：有實際金額用實際，沒有用估算
export function chargeHistory(sub, today = taipeiToday(), rates) {
  const actual = new Map((sub.charges || []).map(c => [c.date, c.twd]));
  const est = estimateTwd(sub, rates);
  const n = paidCount(sub, today);
  const list = [];
  for (let k = 0; k < n; k++) {
    const date = chargeDate(sub, k);
    list.push({ date, estimate: est, actual: actual.has(date) ? actual.get(date) : null });
  }
  return list;
}

export function paidSummary(sub, today, rates) {
  const hist = chargeHistory(sub, today, rates);
  return {
    count: hist.length,
    actualCount: hist.filter(h => h.actual !== null).length,
    total: hist.reduce((t, h) => t + (h.actual ?? h.estimate), 0)
  };
}

export function cycleLabel(sub) {
  const unit = sub.cycle === 'year' ? '年' : '月';
  if (sub.every === 1) return unit;
  if (sub.cycle === 'month' && sub.every === 3) return '季';
  if (sub.cycle === 'month' && sub.every === 6) return '半年';
  return `${sub.every} ${unit === '月' ? '個月' : '年'}`;
}

export function priceText(amount, currency) {
  const c = CURRENCIES[currency] || CURRENCIES.TWD;
  const digits = currency === 'TWD' || currency === 'JPY' ? 0 : 2;
  const n = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(amount) ? 0 : digits, maximumFractionDigits: digits });
  return `${c.symbol} ${n}`;
}

// 「提醒」頁：未來 30 天內要扣款的訂閱
export function computeSubAlerts(subs, now = new Date(), withinDays = 30) {
  const today = taipeiToday(now);
  return subs
    .map(sub => ({ sub, date: nextCharge(sub, today) }))
    .filter(x => x.date && dayDiff(today, x.date) <= withinDays)
    .map(x => ({ ...x, daysUntil: dayDiff(today, x.date) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 推播腳本用：只挑「今天該發」的扣款提醒
export function computeSubPushMessages(subs, settings = {}, now = new Date()) {
  const days = Array.isArray(settings.subNotifyDays) ? settings.subNotifyDays : DEFAULT_SUB_NOTIFY_DAYS;
  return computeSubAlerts(subs, now, 60)
    .filter(({ daysUntil }) => days.includes(daysUntil))
    .map(({ sub, date, daysUntil }) => {
      const twd = sub.currency === 'TWD' && !sub.feePct && !usesActual(sub) ? '' : `（約 NT$ ${Math.round(chargeTwd(sub, settings.rates)).toLocaleString('en-US')}）`;
      return {
        tag: `sub-${sub.id}-${date}`,
        title: daysUntil === 0 ? '💳 今天會扣款' : `💳 ${daysUntil} 天後續訂`,
        body: `${sub.name} ${priceText(sub.price, sub.currency)}／${cycleLabel(sub)}${twd}・${date.slice(5).replace('-', '/')} 扣款。不需要的話記得先取消。`
      };
    });
}
