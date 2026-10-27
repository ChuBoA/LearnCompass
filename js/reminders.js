// 提醒規則：網頁與 GitHub Actions 推播腳本共用，不可使用任何瀏覽器 API。

export const DEFAULT_SETTINGS = {
  expiryNotifyDays: [30, 7, 3, 1, 0], // 到期前第幾天推播
  staleDays: 14,                      // 超過幾天沒學習算「久未學習」
  staleDigestWeekday: 1,              // 每週哪天推播久未學習摘要（0=週日）
  sessionNotify: true                 // 上課當天與前一天推播
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 以台灣時間取得今天 YYYY-MM-DD
export function taipeiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

export function dayDiff(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

export function weekdayOf(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

export function weekdayLabel(dateStr) {
  return WEEKDAYS[weekdayOf(dateStr)];
}

// "2026-11-02T20:30" → "11/02（一）20:30"
export function formatSession(at) {
  const d = at.slice(0, 10);
  const time = at.length > 10 ? ' ' + at.slice(11, 16) : '';
  return `${d.slice(5, 7)}/${d.slice(8, 10)}（${weekdayLabel(d)}）${time}`.trim();
}

export function daysLeft(course, today) {
  return course.accessUntil ? dayDiff(today, course.accessUntil) : null;
}

export function courseStatus(course, today) {
  const left = daysLeft(course, today);
  if (left !== null && left < 0) return 'expired';
  if ((course.energy || 0) >= 100) return 'done';
  if (!course.energy) return 'notStarted';
  return 'inProgress';
}

export function upcomingSessions(course, today) {
  return (course.sessions || [])
    .filter(s => s.at && s.at.slice(0, 10) >= today)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function idleDays(course, today) {
  const last = (course.lastStudiedAt || '').slice(0, 10) || course.purchaseDate;
  return last ? dayDiff(last, today) : null;
}

// 網頁「提醒」頁面用：範圍較寬的清單
export function computeAlerts(courses, settings = DEFAULT_SETTINGS, now = new Date()) {
  const today = taipeiToday(now);
  const expiring = [];
  const sessions = [];
  const stale = [];
  for (const c of courses) {
    const left = daysLeft(c, today);
    const unfinished = (c.energy || 0) < 100;
    if (left !== null && left >= 0 && left <= 30 && unfinished) expiring.push({ course: c, daysLeft: left });
    for (const s of upcomingSessions(c, today)) {
      const until = dayDiff(today, s.at.slice(0, 10));
      if (until <= 14) sessions.push({ course: c, session: s, daysUntil: until });
    }
    const idle = idleDays(c, today);
    if (unfinished && (left === null || left >= 0) && idle !== null && idle >= settings.staleDays) {
      stale.push({ course: c, idleDays: idle });
    }
  }
  expiring.sort((a, b) => a.daysLeft - b.daysLeft);
  sessions.sort((a, b) => a.session.at.localeCompare(b.session.at));
  stale.sort((a, b) => (b.course.price || 0) - (a.course.price || 0));
  return { today, expiring, sessions, stale };
}

// 推播腳本用：只挑「今天該發」的通知，每天執行一次不會重複轟炸
export function computePushMessages(courses, settings = DEFAULT_SETTINGS, now = new Date()) {
  const { today, expiring, sessions, stale } = computeAlerts(courses, settings, now);
  const messages = [];

  for (const { course, daysLeft: left } of expiring) {
    if (!settings.expiryNotifyDays.includes(left)) continue;
    messages.push({
      tag: `expiry-${course.id}-${left}`,
      title: left === 0 ? '⏰ 今天是觀看權限最後一天' : `⏰ 觀看權限剩 ${left} 天`,
      body: `《${course.name}》到期日 ${course.accessUntil.replace(/-/g, '/')}，目前學習能量 ${course.energy || 0}%`
    });
  }

  if (settings.sessionNotify) {
    for (const { course, session, daysUntil } of sessions) {
      if (daysUntil > 1) continue;
      const time = session.at.length > 10 ? session.at.slice(11, 16) : '';
      messages.push({
        tag: `session-${course.id}-${session.at}`,
        title: daysUntil === 0 ? '📅 今天要上課' : '📅 明天要上課',
        body: `《${course.name}》${session.label ? session.label + ' ' : ''}${time}`.trim()
      });
    }
  }

  if (stale.length && weekdayOf(today) === Number(settings.staleDigestWeekday)) {
    const names = stale.slice(0, 3).map(s => `《${s.course.name}》`).join('、');
    messages.push({
      tag: `stale-${today}`,
      title: '🌱 這些課程在等你回來',
      body: `有 ${stale.length} 門課超過 ${settings.staleDays} 天沒學習：${names}${stale.length > 3 ? ' 等' : ''}`
    });
  }

  return messages;
}
