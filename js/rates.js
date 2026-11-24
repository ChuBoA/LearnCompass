// 自動更新匯率：只向公開的匯率服務查詢「新台幣對各幣別」，不會送出任何個人資料。
// 主要來源失敗時改用備援來源。
const SOURCES = [
  {
    name: 'ExchangeRate-API',
    url: 'https://open.er-api.com/v6/latest/TWD',
    // rates.USD = 1 新台幣可換多少美元
    parse: j => (j && j.result === 'success' ? j.rates : null)
  },
  {
    name: 'Currency API',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/twd.json',
    parse: j => (j && j.twd ? Object.fromEntries(Object.entries(j.twd).map(([k, v]) => [k.toUpperCase(), v])) : null)
  }
];

export const RATE_REFRESH_MS = 12 * 60 * 60 * 1000;

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 回傳 { rates: { USD: 32.41, ... }（1 單位外幣 = 幾元新台幣）, source }
export async function fetchTwdRates(codes) {
  let lastError = null;
  for (const src of SOURCES) {
    try {
      const perTwd = src.parse(await getJson(src.url));
      if (!perTwd) throw new Error('格式不符');
      const rates = {};
      for (const code of codes) {
        const v = Number(perTwd[code]);
        if (v > 0) rates[code] = Math.round((1 / v) * 10000) / 10000;
      }
      if (Object.keys(rates).length === codes.length) return { rates, source: src.name };
      throw new Error('缺少部分幣別');
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error('無法取得最新匯率' + (lastError ? `（${lastError.message}）` : ''));
}
