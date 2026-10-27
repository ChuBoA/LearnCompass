// CSV 匯入／匯出，欄位與「夢想地圖」試算表相同，另加「上課場次」「最後學習日」。

const COLUMNS = [
  ['name', '課程名稱'],
  ['note', '備註'],
  ['teacher', '老師'],
  ['category', '課程分類'],
  ['platform', '上課平台'],
  ['price', '購入金額'],
  ['purchaseDate', '購買日期'],
  ['accessUntil', '觀看權限'],
  ['energy', '學習能量'],
  ['link', '快速傳送門'],
  ['sessions', '上課場次'],
  ['lastStudiedAt', '最後學習日']
];

// 支援引號內換行與 "" 跳脫
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim()));
}

// "2026/1/9" → "2026-01-09"
export function normalizeDate(value) {
  const m = String(value || '').trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

// 從備註辨識像「第一周　11/02（一）20:30」「7/18（六）11:00」的上課時間
export function extractSessions(note, purchaseDate) {
  const re = /(?:(第[一二三四五六七八九十\d]+[周週堂])\s*)?(\d{1,2})\/(\d{1,2})\s*[（(][一二三四五六日天][）)]\s*(\d{1,2}):(\d{2})/g;
  const baseYear = Number((purchaseDate || '').slice(0, 4)) || new Date().getFullYear();
  const sessions = [];
  for (const m of String(note || '').matchAll(re)) {
    const md = `${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    let date = `${baseYear}-${md}`;
    if (purchaseDate && date < purchaseDate) date = `${baseYear + 1}-${md}`;
    sessions.push({ at: `${date}T${m[4].padStart(2, '0')}:${m[5]}`, label: m[1] || '' });
  }
  return sessions;
}

// "2026-11-02 20:30 第一周; ..." ⇄ [{at, label}]
function parseSessionsField(value) {
  return String(value || '').split(/[;；\n]/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})(?:[ T](\d{1,2}:\d{2}))?\s*(.*)$/);
    if (!m) return null;
    const time = m[2] ? 'T' + m[2].padStart(5, '0') : '';
    return { at: normalizeDate(m[1]) + time, label: m[3] || '' };
  }).filter(Boolean);
}

function formatSessionsField(sessions) {
  return (sessions || []).map(s => `${s.at.replace('T', ' ')}${s.label ? ' ' + s.label : ''}`).join('; ');
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function normalizeCourse(c) {
  const now = new Date().toISOString();
  return {
    id: c.id || newId(),
    name: String(c.name || '').trim(),
    note: String(c.note || '').trim(),
    teacher: String(c.teacher || '').trim(),
    category: String(c.category || '').trim(),
    platform: String(c.platform || '').trim(),
    price: Math.max(0, Number(String(c.price ?? 0).replace(/[^\d.]/g, '')) || 0),
    purchaseDate: normalizeDate(c.purchaseDate),
    accessUntil: normalizeDate(c.accessUntil),
    energy: Math.min(100, Math.max(0, Math.round(Number(c.energy) || 0))),
    link: String(c.link || '').trim(),
    sessions: (c.sessions || []).filter(s => s && s.at).map(s => ({ at: s.at, label: s.label || '' })),
    lastStudiedAt: c.lastStudiedAt || null,
    createdAt: c.createdAt || now,
    updatedAt: c.updatedAt || now
  };
}

export function csvToCourses(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  const index = Object.fromEntries(COLUMNS.map(([key, label]) => [key, header.indexOf(label)]));
  if (index.name < 0) throw new Error('找不到「課程名稱」欄位，請確認是夢想地圖的 CSV。');
  return rows.slice(1).map(r => {
    const get = key => (index[key] >= 0 ? (r[index[key]] || '') : '').trim();
    const purchaseDate = normalizeDate(get('purchaseDate'));
    const sessions = index.sessions >= 0
      ? parseSessionsField(get('sessions'))
      : extractSessions(get('note'), purchaseDate);
    return normalizeCourse({
      name: get('name').replace(/\s+/g, ' '),
      note: get('note'),
      teacher: get('teacher'),
      category: get('category'),
      platform: get('platform'),
      price: get('price'),
      purchaseDate,
      accessUntil: get('accessUntil'),
      energy: get('energy'),
      link: get('link'),
      sessions,
      lastStudiedAt: get('lastStudiedAt') || null
    });
  }).filter(c => c.name);
}

export function coursesToCsv(courses) {
  const quote = v => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map(([, label]) => label).join(',')];
  for (const c of courses) {
    lines.push(COLUMNS.map(([key]) => {
      if (key === 'sessions') return quote(formatSessionsField(c.sessions));
      if (key === 'purchaseDate' || key === 'accessUntil') return quote((c[key] || '').replace(/-/g, '/'));
      if (key === 'lastStudiedAt') return quote((c.lastStudiedAt || '').slice(0, 10));
      return quote(c[key]);
    }).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// 以「課程名稱＋購買日期」比對，既有課程保留 id、場次與最後學習日
export function mergeImport(existing, incoming) {
  const key = c => `${c.name.replace(/\s+/g, ' ').trim()}|${c.purchaseDate}`;
  const byKey = new Map(existing.map(c => [key(c), c]));
  let added = 0, updated = 0;
  const result = incoming.map(c => {
    const old = byKey.get(key(c));
    if (!old) { added++; return c; }
    updated++;
    const sessions = [...old.sessions];
    for (const s of c.sessions) if (!sessions.some(o => o.at === s.at)) sessions.push(s);
    return {
      ...c,
      id: old.id,
      sessions,
      lastStudiedAt: c.lastStudiedAt || old.lastStudiedAt,
      createdAt: old.createdAt,
      updatedAt: new Date().toISOString()
    };
  });
  return { courses: result, added, updated };
}
