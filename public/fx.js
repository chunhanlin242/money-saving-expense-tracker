// 匯率與金額格式化。
//
// 記帳當下就把 rate_to_twd 與 amount_twd 算好存進那一筆，之後匯率再怎麼變，
// 歷史帳目的台幣金額都不會動 —— 否則「這趟總共花了多少」會是個每天都在變的數字。

import { cacheRates, cachedRates } from "./db.js";

export const HOME = "TWD";

// 常用幣別排前面，其餘照字母序
export const CURRENCIES = [
  { code: "GBP", symbol: "£",  name: "英鎊",     decimals: 2 },
  { code: "EUR", symbol: "€",  name: "歐元",     decimals: 2 },
  { code: "TWD", symbol: "NT$", name: "台幣",    decimals: 0 },
  { code: "USD", symbol: "$",  name: "美元",     decimals: 2 },
  { code: "JPY", symbol: "¥",  name: "日圓",     decimals: 0 },
  { code: "CHF", symbol: "Fr", name: "瑞士法郎", decimals: 2 },
  { code: "SEK", symbol: "kr", name: "瑞典克朗", decimals: 2 },
  { code: "NOK", symbol: "kr", name: "挪威克朗", decimals: 2 },
  { code: "DKK", symbol: "kr", name: "丹麥克朗", decimals: 2 },
  { code: "ISK", symbol: "kr", name: "冰島克朗", decimals: 0 },
  { code: "PLN", symbol: "zł", name: "波蘭茲羅提", decimals: 2 },
  { code: "CZK", symbol: "Kč", name: "捷克克朗", decimals: 2 },
  { code: "HUF", symbol: "Ft", name: "匈牙利福林", decimals: 0 },
  { code: "RON", symbol: "lei", name: "羅馬尼亞列伊", decimals: 2 },
  { code: "BGN", symbol: "лв", name: "保加利亞列弗", decimals: 2 },
  { code: "RSD", symbol: "дин", name: "塞爾維亞第納爾", decimals: 0 },
  { code: "TRY", symbol: "₺",  name: "土耳其里拉", decimals: 2 },
  { code: "UAH", symbol: "₴",  name: "烏克蘭格里夫納", decimals: 2 },
  { code: "AUD", symbol: "A$", name: "澳幣",     decimals: 2 },
  { code: "NZD", symbol: "NZ$", name: "紐幣",    decimals: 2 },
  { code: "CAD", symbol: "C$", name: "加幣",     decimals: 2 },
  { code: "SGD", symbol: "S$", name: "新加坡幣", decimals: 2 },
  { code: "HKD", symbol: "HK$", name: "港幣",    decimals: 2 },
  { code: "KRW", symbol: "₩",  name: "韓元",     decimals: 0 },
  { code: "THB", symbol: "฿",  name: "泰銖",     decimals: 2 },
  { code: "MYR", symbol: "RM", name: "馬幣",     decimals: 2 },
  { code: "VND", symbol: "₫",  name: "越南盾",   decimals: 0 },
  { code: "PHP", symbol: "₱",  name: "披索",     decimals: 2 },
  { code: "IDR", symbol: "Rp", name: "印尼盾",   decimals: 0 },
  { code: "CNY", symbol: "¥",  name: "人民幣",   decimals: 2 },
  { code: "INR", symbol: "₹",  name: "印度盧比", decimals: 2 },
  { code: "AED", symbol: "د.إ", name: "阿聯迪拉姆", decimals: 2 },
  { code: "SAR", symbol: "﷼",  name: "沙烏地里亞爾", decimals: 2 },
  { code: "ZAR", symbol: "R",  name: "南非蘭特", decimals: 2 },
  { code: "MXN", symbol: "MX$", name: "墨西哥披索", decimals: 2 },
  { code: "BRL", symbol: "R$", name: "巴西里拉", decimals: 2 },
  { code: "ILS", symbol: "₪",  name: "以色列謝克爾", decimals: 2 },
  { code: "MAD", symbol: "DH", name: "摩洛哥迪拉姆", decimals: 2 },
  { code: "EGP", symbol: "E£", name: "埃及鎊",   decimals: 2 },
  { code: "GEL", symbol: "₾",  name: "喬治亞拉里", decimals: 2 },
];

const BY_CODE = Object.fromEntries(CURRENCIES.map((c) => [c.code, c]));

export function currencyInfo(code) {
  return BY_CODE[code] || { code, symbol: code + " ", name: code, decimals: 2 };
}

// 目前手上的匯率表（開機時從快取載入，同步時更新）
let current = { date: null, rates: { TWD: 1 }, stale: true };

export function ratesDate() { return current.date; }
export function isStale() { return !!current.stale; }

export async function loadRates() {
  const cached = await cachedRates(null);
  if (cached) {
    current = { date: cached.date, rates: cached.rates, stale: !isFresh(cached.date) };
  }
  return current;
}

// 主動更新（同步時伺服器也會順便帶回來，這支是給「設定 → 匯率」手動重抓用）
export async function refreshRates() {
  try {
    const res = await fetch("/api/fx");
    if (!res.ok) return current;
    const data = await res.json();
    if (data.date && data.rates) {
      await cacheRates(data.date, data.rates);
      current = { date: data.date, rates: data.rates, stale: !isFresh(data.date) };
    }
  } catch { /* 離線就繼續用快取 */ }
  return current;
}

// 不能拿匯率日期直接跟「本地日期」比對是否相等：
//   伺服器以 UTC 記日，台北是 UTC+8、倫敦夏令是 UTC+1，本地日期常常比 UTC 早一天，
//   一比就永遠是「非今日」。而且匯率來源週末不發布，週一早上最新的是上週五。
// 所以改看實際年齡，四天內都算堪用。
const FRESH_MS = 4 * 86400000;

export function isFresh(date) {
  if (!date) return false;
  const t = Date.parse(date + "T00:00:00Z");
  return Number.isFinite(t) && Date.now() - t < FRESH_MS;
}

// 1 單位 code = ? TWD
export function rateToTwd(code) {
  if (code === HOME) return 1;
  const r = current.rates[code];
  return typeof r === "number" && r > 0 ? r : null;
}

// 取「某一天」的匯率。編輯舊帳目改幣別時要用那天的匯率，不是今天的 ——
// 一筆三週前的消費套上今天的匯率就不對了。離線時退回手上最新的一份。
export async function rateOn(date, code) {
  if (code === HOME) return 1;

  try {
    const res = await fetch("/api/fx?date=" + encodeURIComponent(date));
    if (res.ok) {
      const data = await res.json();
      const r = data.rates && data.rates[code];
      if (typeof r === "number" && r > 0) {
        await cacheRates(data.date, data.rates);
        return r;
      }
    }
  } catch { /* 離線，往下走快取 */ }

  const cached = await cachedRates(date);
  const r = cached && cached.rates && cached.rates[code];
  return typeof r === "number" && r > 0 ? r : rateToTwd(code);
}

export function toTwd(amount, code) {
  const r = rateToTwd(code);
  return r === null ? null : amount * r;
}

// ---------------------------------------------------------------- 格式化

export function formatAmount(amount, code, { withSymbol = true, sign = false } = {}) {
  const info = currencyInfo(code);
  const n = Number(amount) || 0;
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: info.decimals,
    maximumFractionDigits: info.decimals,
  });
  const prefix = (sign && n < 0 ? "−" : sign && n > 0 ? "+" : n < 0 ? "−" : "");
  return prefix + (withSymbol ? info.symbol : "") + body;
}

export function formatTwd(amount) {
  return formatAmount(amount, "TWD");
}

// ---------------------------------------------------------------- 日期
//
// 用「當地日期」而不是 UTC 日期分組。跨時區旅行時這件事很要緊：
// 在倫敦晚上 11 點吃的那頓飯，不該被算成隔天。

export function localDate(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

export function formatDateLabel(dateStr) {
  const today = localDate(new Date());
  const yesterday = localDate(new Date(Date.now() - 86400000));
  if (dateStr === today) return "今天";
  if (dateStr === yesterday) return "昨天";

  const d = new Date(dateStr + "T00:00:00");
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日 週${week}`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
