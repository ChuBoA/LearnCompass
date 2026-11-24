// 訂閱（軟體、服務）：計算規則。網頁與 GitHub Actions 推播腳本共用，不可使用任何瀏覽器 API。
//
// 一個訂閱由多段「訂閱期間」組成，支援暫停、恢復、取消、重新訂閱：
//   periods: [{ start, end, endType, resumeAt, price, currency, feePct }]
//   - start：這段的第一次扣款日，之後的扣款日都以它為準（恢復後從恢復日重新算）
//   - end：這段結束日（暫停或取消那天，這天起不再扣款）；空白 = 使用中
//   - endType：'pause' 暫停（之後可能恢復）、'cancel' 取消
//   - resumeAt：暫停時選填的預計恢復日
//   - price／currency／feePct：這段期間的價格（漲價、換方案時各段不同）
// 最上層的 price、currency、feePct、startDate、cancelledAt 會同步成「目前這段」的值，方便相容舊資料。
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
const money2 = v => Math.max(0, Math.round((Number(v) || 0) * 100) / 100);

export const defaultFeePct = currency => (currency === 'TWD' ? 0 : 1.5);

function cleanFee(v, currency) {
  const fee = Number(v);
  return v === undefined || v === '' || v === null || !Number.isFinite(fee)
    ? defaultFeePct(currency)
    : Math.min(20, Math.max(0, Math.round(fee * 100) / 100));
}

function normalizePeriod(p, fallback) {
  const currency = CURRENCIES[p.currency] ? p.currency : fallback.currency;
  const start = isDate(p.start) ? p.start : fallback.start;
  const end = isDate(p.end) && p.end > start ? p.end : '';
  const endType = end ? (p.endType === 'pause' ? 'pause' : 'cancel') : '';
  return {
    start,
    end,
    endType,
    resumeAt: endType === 'pause' && isDate(p.resumeAt) && p.resumeAt > end ? p.resumeAt : '',
    price: p.price === undefined || p.price === '' ? fallback.price : money2(p.price),
    currency,
    feePct: cleanFee(p.feePct ?? (currency === fallback.currency ? fallback.feePct : undefined), currency)
  };
}

export function normalizeSub(s) {
  const now = new Date().toISOString();
  const cycle = s.cycle === 'year' ? 'year' : 'month';
  const currency = CURRENCIES[s.currency] ? s.currency : 'TWD';
  const fallback = {
    start: isDate(s.startDate) ? s.startDate : taipeiToday(),
    price: money2(s.price),
    currency,
    feePct: cleanFee(s.feePct, currency)
  };
  // 舊資料只有 startDate／cancelledAt：轉成「第 1 段」
  const raw = Array.isArray(s.periods) && s.periods.length
    ? s.periods
    : [{ start: fallback.start, end: isDate(s.cancelledAt) ? s.cancelledAt : '', endType: 'cancel', price: fallback.price, currency, feePct: fallback.feePct }];
  const periods = raw.map(p => normalizePeriod(p || {}, fallback))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(-60);
  const cur = periods[periods.length - 1];
  return {
    id: s.id || newSubId(),
    name: String(s.name || '').trim().slice(0, 100) || '未命名訂閱',
    category: String(s.category || '').trim().slice(0, 30),
    periods,
    // 以下同步成目前這段的值
    price: cur.price,
    currency: cur.currency,
    feePct: cur.feePct,
    startDate: periods[0].start,
    cancelledAt: cur.endType === 'cancel' ? cur.end : '',
    // 實際扣款紀錄：[{ date: 扣款日 YYYY-MM-DD, twd: 帳單上的新台幣金額 }]
    charges: normalizeCharges(s.charges),
    cycle,
    every: Math.min(cycle === 'month' ? 36 : 10, Math.max(1, Math.round(Number(s.every) || 1))),
    link: String(s.link || '').trim().slice(0, 500),
    note: String(s.note || '').slice(0, 2000),
    createdAt: s.createdAt || now,
    updatedAt: s.updatedAt || now
  };
}

// 檢查期間是否合理；回傳錯誤訊息或空字串
export function validatePeriods(periods) {
  const list = [...periods].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!isDate(p.start)) return `第 ${i + 1} 段缺少開始日`;
    if (p.end && p.end <= p.start) return `第 ${i + 1} 段的結束日要晚於開始日`;
    if (i < list.length - 1) {
      if (!p.end) return `第 ${i + 1} 段後面還有期間，請填結束日（暫停或取消的那天）`;
      if (p.end > list[i + 1].start) return `第 ${i + 1} 段和第 ${i + 2} 段的日期重疊了`;
    }
  }
  return '';
}

function normalizeCharges(list) {
  if (!Array.isArray(list)) return [];
  const byDate = new Map();
  for (const c of list) {
    const twd = money2(c?.twd);
    if (isDate(c?.date) && twd > 0) byDate.set(c.date, { date: c.date, twd });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-240);
}

const monthsPerCharge = sub => (sub.cycle === 'year' ? 12 : 1) * (sub.every || 1);
const lastPeriod = sub => sub.periods[sub.periods.length - 1];

// 狀態：active 使用中、paused 暫停中、cancelled 已取消
export function subStatus(sub, today = taipeiToday()) {
  const cur = lastPeriod(sub);
  if (!cur.end || cur.end > today) return 'active';
  return cur.endType === 'pause' ? 'paused' : 'cancelled';
}
export const isActive = (sub, today) => subStatus(sub, today) === 'active';
export const isPaused = (sub, today) => subStatus(sub, today) === 'paused';

// 某段期間的第 k 次扣款日：以這段開始日的「日」為錨點，遇到月底自動調整（1/31 → 2/28 → 3/31）
function periodChargeDate(sub, period, k) {
  const [y, m, d] = period.start.split('-').map(Number);
  const total = (m - 1) + k * monthsPerCharge(sub);
  const year = y + Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// 這段期間內、在 [from, to] 之間的扣款日
function periodCharges(sub, period, to, from = '') {
  const out = [];
  for (let k = 0; k < 2000; k++) {
    const d = periodChargeDate(sub, period, k);
    if (d > to || (period.end && d >= period.end)) break;
    if (d >= from) out.push(d);
  }
  return out;
}

// 今天之後（含今天）的下一次扣款日；暫停或取消則為 null
export function nextCharge(sub, today = taipeiToday()) {
  for (const p of sub.periods) {
    if (p.end && p.end <= today) continue;
    if (p.start >= today) return p.start;
    const approx = Math.max(0, Math.floor(dayDiff(p.start, today) / (monthsPerCharge(sub) * 31)) - 1);
    for (let k = approx; k < approx + 400; k++) {
      const d = periodChargeDate(sub, p, k);
      if (p.end && d >= p.end) break;
      if (d >= today) return d;
    }
  }
  return null;
}

export function rateOf(currency, rates = DEFAULT_RATES) {
  if (currency === 'TWD') return 1;
  const r = Number((rates || {})[currency]);
  return r > 0 ? r : DEFAULT_RATES[currency] || 1;
}

export const toTwd = (amount, currency, rates) => amount * rateOf(currency, rates);

// 估算一期扣款：外幣金額 × 匯率 × (1 + 手續費%)；預設用目前這段的價格
export const estimateTwd = (sub, rates, period = lastPeriod(sub)) =>
  toTwd(period.price, period.currency, rates) * (1 + (period.feePct || 0) / 100);

// 目前這段填過的實際金額（換方案、漲價前的不算）
const currentActuals = sub => (sub.charges || []).filter(c => c.date >= lastPeriod(sub).start);

// 預估下一期：目前這段填過實際金額就用最近 3 次的平均，否則用估算
export function chargeTwd(sub, rates) {
  const recent = currentActuals(sub).slice(-3);
  if (recent.length) return recent.reduce((t, c) => t + c.twd, 0) / recent.length;
  return estimateTwd(sub, rates);
}
export const usesActual = sub => currentActuals(sub).length > 0;

// 換算成每月的新台幣
export function monthlyTwd(sub, rates) {
  return chargeTwd(sub, rates) / monthsPerCharge(sub);
}

// 到今天為止的每一期（跨所有期間）：有實際金額用實際，沒有用估算
export function chargeHistory(sub, today = taipeiToday(), rates) {
  const actual = new Map((sub.charges || []).map(c => [c.date, c.twd]));
  const list = [];
  sub.periods.forEach((p, i) => {
    const est = estimateTwd(sub, rates, p);
    for (const date of periodCharges(sub, p, today)) {
      list.push({ date, period: i, estimate: est, actual: actual.has(date) ? actual.get(date) : null });
    }
  });
  return list;
}

export const paidCount = (sub, today = taipeiToday()) => sub.periods.reduce((n, p) => n + periodCharges(sub, p, today).length, 0);

export function paidSummary(sub, today, rates) {
  const hist = chargeHistory(sub, today, rates);
  return {
    count: hist.length,
    actualCount: hist.filter(h => h.actual !== null).length,
    total: hist.reduce((t, h) => t + (h.actual ?? h.estimate), 0)
  };
}

const monthsBetween = (a, b) => Math.max(0, dayDiff(a, b)) / 30.4375;

// 期間統計：訂閱多久、暫停幾次、暫停多久、暫停期間約省下多少
export function periodStats(sub, today = taipeiToday(), rates) {
  let activeMonths = 0;
  let pausedMonths = 0;
  let pauses = 0;
  let saved = 0;
  sub.periods.forEach((p, i) => {
    if (p.start <= today) activeMonths += monthsBetween(p.start, p.end && p.end < today ? p.end : today);
    if (p.endType !== 'pause' || !p.end || p.end > today) return;
    pauses++;
    const next = sub.periods[i + 1];
    const gapEnd = next && next.start <= today ? next.start : today;
    pausedMonths += monthsBetween(p.end, gapEnd);
    // 如果沒暫停，這段時間原本會扣幾次
    const missed = periodCharges(sub, { ...p, end: '' }, gapEnd, p.end).filter(d => d < gapEnd || !next).length;
    saved += missed * estimateTwd(sub, rates, p);
  });
  return { activeMonths, pausedMonths, pauses, saved, periods: sub.periods.length };
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

// 「提醒」頁：未來 N 天內要扣款的訂閱
export function computeSubAlerts(subs, now = new Date(), withinDays = 30) {
  const today = taipeiToday(now);
  return subs
    .map(sub => ({ sub, date: nextCharge(sub, today) }))
    .filter(x => x.date && dayDiff(today, x.date) <= withinDays)
    .map(x => ({ ...x, daysUntil: dayDiff(today, x.date) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 暫停中、有「預計恢復日」的訂閱；daysUntil < 0 表示預計日已過、還沒記錄恢復
export function computeResumeAlerts(subs, now = new Date(), withinDays = 30) {
  const today = taipeiToday(now);
  return subs
    .filter(sub => isPaused(sub, today) && lastPeriod(sub).resumeAt)
    .map(sub => ({ sub, date: lastPeriod(sub).resumeAt, daysUntil: dayDiff(today, lastPeriod(sub).resumeAt) }))
    .filter(x => x.daysUntil <= withinDays)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 推播腳本用：只挑「今天該發」的扣款與恢復提醒
export function computeSubPushMessages(subs, settings = {}, now = new Date()) {
  const days = Array.isArray(settings.subNotifyDays) ? settings.subNotifyDays : DEFAULT_SUB_NOTIFY_DAYS;
  const twdOf = sub => (sub.currency === 'TWD' && !sub.feePct && !usesActual(sub) ? '' : `（約 NT$ ${Math.round(chargeTwd(sub, settings.rates)).toLocaleString('en-US')}）`);
  const charges = computeSubAlerts(subs, now, 60)
    .filter(({ daysUntil }) => days.includes(daysUntil))
    .map(({ sub, date, daysUntil }) => ({
      tag: `sub-${sub.id}-${date}`,
      title: daysUntil === 0 ? '💳 今天會扣款' : `💳 ${daysUntil} 天後續訂`,
      body: `${sub.name} ${priceText(sub.price, sub.currency)}／${cycleLabel(sub)}${twdOf(sub)}・${date.slice(5).replace('-', '/')} 扣款。不需要的話記得先取消。`
    }));
  const resumes = computeResumeAlerts(subs, now, 60)
    .filter(({ daysUntil }) => days.includes(daysUntil))
    .map(({ sub, date, daysUntil }) => ({
      tag: `resume-${sub.id}-${date}`,
      title: daysUntil === 0 ? '⏯ 今天恢復扣款' : `⏯ ${daysUntil} 天後恢復扣款`,
      body: `${sub.name} 預計 ${date.slice(5).replace('-', '/')} 恢復訂閱，${priceText(sub.price, sub.currency)}／${cycleLabel(sub)}${twdOf(sub)}。不想恢復的話記得先處理。`
    }));
  return [...charges, ...resumes];
}
