// 訂閱（軟體、服務）：計算規則。網頁與 GitHub Actions 推播腳本共用，不可使用任何瀏覽器 API。
//
// 一個訂閱由多段「訂閱期間」組成，支援暫停、恢復、取消、重新訂閱：
//   periods: [{ start, end, endType, resumeAt, price, currency, feePct }]
//   - start：這段的第一次扣款日，之後的扣款日都以它為準（恢復後從恢復日重新算）
//   - end：這段結束日（暫停或取消那天，這天起不再扣款）；空白 = 使用中
//   - endType：'pause' 暫停（之後可能恢復）、'cancel' 取消
//   - resumeAt：暫停時選填的預計恢復日
//   - price／currency／feePct：這段期間的價格（漲價、換方案時各段不同）
//   - ext：這段期間內的延長紀錄，依日期排序
//       { type: 'buy',  date: 下訂日, until: 延長到哪天, amount: 實付金額（這段的幣別）, note }
//         還沒到期就再次下訂：效期疊加，下一次扣款直接延到 until
//       { type: 'gift', date: 兌換日, days: 贈送天數, note }
//         輸入序號贈送：下一次扣款往後延 days 天，不用付錢
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
  // 結束日可以早於開始日：例如試用期內就取消，從頭到尾都不會扣款
  const end = isDate(p.end) ? p.end : '';
  const endType = end ? (p.endType === 'pause' ? 'pause' : 'cancel') : '';
  return {
    start,
    end,
    endType,
    resumeAt: endType === 'pause' && isDate(p.resumeAt) && p.resumeAt > end ? p.resumeAt : '',
    price: p.price === undefined || p.price === '' ? fallback.price : money2(p.price),
    currency,
    feePct: cleanFee(p.feePct ?? (currency === fallback.currency ? fallback.feePct : undefined), currency),
    ext: normalizeExt(p.ext)
  };
}

function normalizeExt(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || !isDate(e.date)) continue;
    const note = String(e.note || '').trim().slice(0, 200);
    if (e.type === 'gift') {
      const days = Math.min(3650, Math.max(0, Math.round(Number(e.days) || 0)));
      if (days > 0) out.push({ type: 'gift', date: e.date, days, note });
    } else if (isDate(e.until) && e.until > e.date) {
      out.push({ type: 'buy', date: e.date, until: e.until, amount: money2(e.amount), note });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(-100);
}

// 延長紀錄不合理時回傳錯誤訊息（給編輯視窗用，存檔前先擋）
export function validateExt(list) {
  for (const e of list || []) {
    const what = e.type === 'gift' ? '序號贈送' : '疊加下訂';
    if (!isDate(e.date)) return `${what}缺少日期`;
    if (e.type === 'gift' && !(Number(e.days) >= 1)) return '序號贈送的天數至少 1 天';
    if (e.type !== 'gift' && !isDate(e.until)) return '疊加下訂請填「延長到」哪天';
    if (e.type !== 'gift' && e.until <= e.date) return '疊加下訂的「延長到」要晚於下訂日';
  }
  return '';
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
    const extProblem = validateExt(p.ext);
    if (extProblem) return list.length > 1 ? `第 ${i + 1} 段：${extProblem}` : extProblem;
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

// 效期到哪天：訂閱是「先付款、用一整期」，提前取消或暫停只是不再續訂，已付的那一期照常可用。
// 效期結束 = 取消（暫停）日之後、原本會扣下一次款的那天；還沒開始扣款就取消（試用期）則是第一次扣款日。
export function accessEnd(sub, period = lastPeriod(sub)) {
  if (!period.end) return '';
  for (const { date } of schedule(sub, period)) {
    if (date >= period.end) return date;
  }
  return period.end;
}

// 狀態：active 使用中（含已取消續訂、效期還沒到）、paused 暫停中、cancelled 已取消
export function subStatus(sub, today = taipeiToday()) {
  const cur = lastPeriod(sub);
  if (!cur.end || accessEnd(sub, cur) > today) return 'active';
  return cur.endType === 'pause' ? 'paused' : 'cancelled';
}
export const isActive = (sub, today) => subStatus(sub, today) === 'active';
export const isPaused = (sub, today) => subStatus(sub, today) === 'paused';
// 使用中，而且之後還會續訂扣款（已申請取消／暫停的不算）
export const willRenew = (sub, today = taipeiToday()) => !lastPeriod(sub).end || lastPeriod(sub).end > today;
// 已申請取消或暫停、但效期還沒到
export const isEnding = (sub, today = taipeiToday()) => isActive(sub, today) && !willRenew(sub, today);

// 錨點日往後 n 個月：遇到月底自動調整（1/31 → 2/28 → 3/31）
function addMonths(anchor, n) {
  const [y, m, d] = anchor.split('-').map(Number);
  const total = (m - 1) + n;
  const year = y + Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
// 往後 n 期（編輯視窗預設「延長到」用）
export const addCycles = (sub, date, n = 1) => addMonths(date, n * monthsPerCharge(sub));
const addDaysIso =(date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// 依序產生這段期間「原本」的扣款日（不管 end）。
// 下一次扣款前有疊加下訂或序號贈送，就把這次扣款延後，之後從新的日期重新起算。
// 每一項：{ date, shifts: [{ type, from, to, ext }] }（shifts = 這次扣款被延後的紀錄）
function* schedule(sub, period) {
  const ext = period.ext || [];
  const step = monthsPerCharge(sub);
  let anchor = period.start;
  let k = 0;
  let ei = 0;
  for (let n = 0; n < 2000; n++) {
    let date = addMonths(anchor, k * step);
    const shifts = [];
    while (ei < ext.length && ext[ei].date < date) {
      const e = ext[ei++];
      const to = e.type === 'gift' ? addDaysIso(date, e.days) : (e.until > date ? e.until : date);
      shifts.push({ type: e.type, from: date, to, ext: e });
      date = to;
    }
    if (shifts.length) { anchor = date; k = 0; }
    yield { date, shifts };
    k++;
  }
}

// 這段期間內、在 [from, to] 之間的扣款日
function periodCharges(sub, period, to, from = '') {
  const out = [];
  for (const { date } of schedule(sub, period)) {
    if (date > to || (period.end && date >= period.end)) break;
    if (date >= from) out.push(date);
  }
  return out;
}

// 這段期間內每筆延長實際延了哪一段（期限條、統計用）：[{ type, from, to, ext }]
export function extSpans(sub, period) {
  const ext = period.ext || [];
  if (!ext.length) return [];
  const out = [];
  const lastDate = ext[ext.length - 1].date;
  for (const { date, shifts } of schedule(sub, period)) {
    out.push(...shifts);
    // 扣款日超過最後一筆延長的日期，代表所有延長都已套用
    if (date > lastDate) break;
  }
  return out;
}

// 今天之後（含今天）的下一次扣款日；暫停或取消則為 null
export function nextCharge(sub, today = taipeiToday()) {
  for (const p of sub.periods) {
    if (p.end && p.end <= today) continue;
    for (const { date } of schedule(sub, p)) {
      if (p.end && date >= p.end) break;
      if (date >= today) return date;
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

// 目前這段填過的實際金額（換方案、漲價前的不算；疊加下訂那筆金額不固定，也不算）
const currentActuals = sub => {
  const cur = lastPeriod(sub);
  const buys = new Set((cur.ext || []).filter(e => e.type === 'buy').map(e => e.date));
  return (sub.charges || []).filter(c => c.date >= cur.start && !buys.has(c.date));
};

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

// 到今天為止的每一筆付款（跨所有期間，含疊加下訂）：有實際金額用實際，沒有用估算
// kind：'charge' 自動扣款、'buy' 疊加下訂
export function chargeHistory(sub, today = taipeiToday(), rates) {
  const actual = new Map((sub.charges || []).map(c => [c.date, c.twd]));
  const list = [];
  sub.periods.forEach((p, i) => {
    const est = estimateTwd(sub, rates, p);
    const rate = toTwd(1, p.currency, rates) * (1 + (p.feePct || 0) / 100);
    const add = (date, kind, estimate) => list.push({ date, period: i, kind, estimate, actual: actual.has(date) ? actual.get(date) : null });
    for (const date of periodCharges(sub, p, today)) add(date, 'charge', est);
    for (const e of p.ext || []) {
      if (e.type === 'buy' && e.date <= today && e.amount > 0) add(e.date, 'buy', e.amount * rate);
    }
  });
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

export const paidCount = (sub, today = taipeiToday()) => chargeHistory(sub, today).length;

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
  let giftDays = 0;
  let giftValue = 0;
  let gifts = 0;
  let buys = 0;
  sub.periods.forEach((p, i) => {
    // 序號贈送：天數 × 這段的每日費用
    const perDay = estimateTwd(sub, rates, p) / (monthsPerCharge(sub) * 30.4375);
    for (const e of p.ext || []) {
      if (e.date > today) continue;
      if (e.type === 'gift') { gifts++; giftDays += e.days; giftValue += e.days * perDay; } else buys++;
    }
    const until = p.end ? accessEnd(sub, p) : '';
    const next = sub.periods[i + 1];
    // 可使用的期間：到效期結束（下一段提早開始就算到下一段）
    const useEnd = [until || today, today, next ? next.start : ''].filter(Boolean).sort()[0];
    if (p.start <= today) activeMonths += monthsBetween(p.start, useEnd);
    if (p.endType !== 'pause' || !p.end || p.end > today) return;
    pauses++;
    const gapEnd = next && next.start <= today ? next.start : today;
    if (until < gapEnd) pausedMonths += monthsBetween(until, gapEnd);
    // 如果沒暫停，這段時間原本會扣幾次
    const missed = periodCharges(sub, { ...p, end: '' }, gapEnd, p.end).filter(d => d < gapEnd || !next).length;
    saved += missed * estimateTwd(sub, rates, p);
  });
  return { activeMonths, pausedMonths, pauses, saved, gifts, giftDays, giftValue, buys, periods: sub.periods.length };
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

// 已申請暫停、有「預計恢復日」的訂閱；daysUntil < 0 表示預計日已過、還沒記錄恢復
export function computeResumeAlerts(subs, now = new Date(), withinDays = 30) {
  const today = taipeiToday(now);
  return subs
    .filter(sub => lastPeriod(sub).endType === 'pause' && lastPeriod(sub).end <= today && lastPeriod(sub).resumeAt)
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
