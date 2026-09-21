// travel-money Worker
//   /api/*  → JSON API（登入、同步、匯率）
//   其他     → public/ 靜態檔，找不到就回 index.html（SPA）
//
// 靜態檔（app shell）本身是公開的，那只是程式碼；資料一律要通過驗證。

import { nameOf as countryName } from "../public/countries.js";

const COOKIE_NAME = "tm_auth";
const SESSION_DAYS = 365;

// 追蹤的幣別。歐洲為主，加上常去的亞洲與其他地區。
const CURRENCIES = [
  "TWD", "GBP", "EUR", "USD", "JPY", "CHF",
  "SEK", "NOK", "DKK", "ISK", "PLN", "CZK", "HUF", "RON", "BGN", "RSD", "TRY", "UAH",
  "AUD", "NZD", "CAD", "SGD", "HKD", "KRW", "THB", "MYR", "VND", "PHP", "IDR", "CNY",
  "INR", "AED", "SAR", "ZAR", "MXN", "BRL", "ILS", "MAD", "EGP", "GEL",
];

// 可同步的表與其欄位白名單。欄位名會直接進 SQL，必須來自這裡，不能來自請求。
const SYNC_TABLES = {
  trips:       ["id", "name", "local_currency", "start_date", "end_date", "daily_budget", "archived", "sort", "created_at", "updated_at", "deleted_at"],
  people:      ["id", "name", "sort", "created_at", "updated_at", "deleted_at"],
  accounts:    ["id", "name", "kind", "currency", "monthly_limit", "limit_currency", "color", "sort", "archived", "created_at", "updated_at", "deleted_at"],
  categories:  ["id", "name", "icon", "kind", "sort", "hidden", "created_at", "updated_at", "deleted_at"],
  entries:     ["id", "trip_id", "type", "amount", "currency", "rate_to_twd", "amount_twd", "reference_amount", "saving_note", "category_id", "account_id", "country", "spent_at", "spent_date", "note", "is_prepaid", "tax_refund", "tax_refund_status", "paid_by", "created_at", "updated_at", "deleted_at"],
  exchanges:   ["id", "entry_id", "from_currency", "from_amount", "to_currency", "to_amount", "to_account_id", "fee_twd", "created_at", "updated_at", "deleted_at"],
  splits:      ["id", "entry_id", "person_id", "share_amount", "share_twd", "created_at", "updated_at", "deleted_at"],
  settlements: ["id", "person_id", "amount_twd", "direction", "settled_at", "note", "created_at", "updated_at", "deleted_at"],
};

// ---------------------------------------------------------------- 工具

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

// 常數時間比較，避免用回應時間猜出正確值
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

function secrets(env) {
  const password = env.APP_PASSWORD;
  // 沒另外設 SESSION_SECRET 就從密碼衍生，至少不會裸奔；設了才能單獨換掉踢登入
  const sessionSecret = env.SESSION_SECRET || (password ? "derived:" + password : null);
  return { password, sessionSecret };
}

async function makeToken(env) {
  const { sessionSecret } = secrets(env);
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return exp + "." + (await hmac(sessionSecret, exp));
}

async function isAuthed(request, env) {
  const { password, sessionSecret } = secrets(env);
  if (!password) return false;

  const raw = getCookie(request, COOKIE_NAME)
    || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!raw) return false;

  const dot = raw.lastIndexOf(".");
  if (dot < 1) return false;
  const exp = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;

  return timingSafeEqual(sig, await hmac(sessionSecret, exp));
}

// 登入失敗節流。存在 isolate 記憶體裡，重啟就清空 —— 對個人用途夠了，
// 目的只是讓自動化猜密碼變得不划算。
const loginFails = new Map();

function loginDelay(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.at > 15 * 60000) { loginFails.delete(ip); return 0; }
  return Math.min(2 ** rec.n * 250, 8000);
}

function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { n: 0, at: 0 };
  loginFails.set(ip, { n: rec.n + 1, at: Date.now() });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 匯率

// 回傳 { 幣別: 該幣兌台幣匯率 }，也就是 1 單位該幣 = ? TWD
async function fetchRates() {
  // 主來源：以 TWD 為基準，值是 1 TWD = ? 該幣，取倒數
  try {
    const r = await fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/twd.json", {
      cf: { cacheTtl: 3600 },
    });
    if (r.ok) {
      const data = await r.json();
      const table = data.twd;
      if (table && table.gbp) {
        const out = {};
        for (const cur of CURRENCIES) {
          const v = table[cur.toLowerCase()];
          if (typeof v === "number" && v > 0) out[cur] = 1 / v;
        }
        out.TWD = 1;
        if (Object.keys(out).length > 5) return { rates: out, source: "fawazahmed0", date: data.date };
      }
    }
  } catch { /* 換備援 */ }

  const r2 = await fetch("https://open.er-api.com/v6/latest/TWD");
  if (!r2.ok) throw new Error("兩個匯率來源都失敗了");
  const d2 = await r2.json();
  if (d2.result !== "success" || !d2.rates) throw new Error("備援匯率來源回傳異常");

  const out = {};
  for (const cur of CURRENCIES) {
    const v = d2.rates[cur];
    if (typeof v === "number" && v > 0) out[cur] = 1 / v;
  }
  out.TWD = 1;
  return { rates: out, source: "er-api", date: new Date().toISOString().slice(0, 10) };
}

async function storeRates(env, date) {
  const { rates, source } = await fetchRates();
  const stmt = env.DB.prepare(
    "INSERT INTO fx_rates (date, currency, rate_to_twd, source) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(date, currency) DO UPDATE SET rate_to_twd = excluded.rate_to_twd, source = excluded.source"
  );
  const batch = Object.entries(rates).map(([cur, rate]) => stmt.bind(date, cur, rate, source));
  batch.push(env.DB.prepare("UPDATE sync_state SET last_fx_sync = ? WHERE id = 1").bind(new Date().toISOString()));
  await env.DB.batch(batch);
  return rates;
}

// 取某日匯率；當天還沒有就即時補抓，再不行就退回最近一天有資料的
async function ratesForDate(env, date) {
  const today = new Date().toISOString().slice(0, 10);
  const wanted = date || today;

  const hit = await env.DB.prepare("SELECT currency, rate_to_twd FROM fx_rates WHERE date = ?").bind(wanted).all();
  if (hit.results && hit.results.length > 5) {
    return { date: wanted, rates: Object.fromEntries(hit.results.map((r) => [r.currency, r.rate_to_twd])) };
  }

  if (wanted === today) {
    try {
      return { date: today, rates: await storeRates(env, today) };
    } catch { /* 抓不到就往下退回舊資料 */ }
  }

  const near = await env.DB.prepare(
    "SELECT date, currency, rate_to_twd FROM fx_rates WHERE date <= ? ORDER BY date DESC LIMIT 200"
  ).bind(wanted).all();
  const rows = near.results || [];
  if (!rows.length) return { date: null, rates: {} };

  const newest = rows[0].date;
  return {
    date: newest,
    rates: Object.fromEntries(rows.filter((r) => r.date === newest).map((r) => [r.currency, r.rate_to_twd])),
    stale: true,
  };
}

// ---------------------------------------------------------------- 對外匯出
//
// 給 Google 試算表（Apps Script）定時來拉的唯讀端點。
//
// 用獨立的 EXPORT_TOKEN 而不是登入密碼：試算表的腳本只該能讀帳目，
// 不該能登入、改資料、或看到其他東西。token 外流的損害因此被限縮，
// 而且可以單獨換掉不影響手機上的登入。

// 零小數的幣別。前端有完整的 fx.js，但那支相依 IndexedDB 進不了 Worker，
// 所以這裡只列出「不是兩位小數」的例外，其餘一律兩位。
const ZERO_DECIMAL = new Set(["TWD", "JPY", "KRW", "VND", "IDR", "HUF", "ISK", "CLP"]);

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const roundCur = (v, code) => {
  const unit = ZERO_DECIMAL.has(code) ? 1 : 100;
  return Math.round((Number(v) || 0) * unit) / unit;
};

const EXPORT_COLUMNS = [
  "日期", "類型", "金額", "幣別", "匯率", "台幣",
  "原價", "省下", "省下台幣", "省錢項目",
  "分類", "付款方式", "國家", "旅程", "備註",
  "行前已付", "可退稅", "誰先付",
];

const TYPE_LABEL = { expense: "支出", income: "收入", exchange: "換現" };

async function exportEntries(env) {
  const [entries, cats, accs, trips, people] = await Promise.all([
    env.DB.prepare("SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY spent_at").all(),
    env.DB.prepare("SELECT id, name FROM categories").all(),
    env.DB.prepare("SELECT id, name FROM accounts").all(),
    env.DB.prepare("SELECT id, name FROM trips").all(),
    env.DB.prepare("SELECT id, name FROM people").all(),
  ]);

  const byId = (r) => Object.fromEntries((r.results || []).map((x) => [x.id, x.name]));
  const cat = byId(cats), acc = byId(accs), trip = byId(trips), person = byId(people);

  const rows = (entries.results || []).map((e) => {
    const ref = Number(e.reference_amount);
    const saved = Number.isFinite(ref) && ref > e.amount ? ref - e.amount : 0;
    return [
      e.spent_date,
      TYPE_LABEL[e.type] || e.type,
      e.amount,
      e.currency,
      e.rate_to_twd,                       // 匯率刻意不四捨五入：它是凍結值，收斂後台幣就算不回來
      round2(e.amount_twd),
      e.reference_amount || "",
      saved ? roundCur(saved, e.currency) : "",
      saved ? round2(saved * e.rate_to_twd) : "",
      e.saving_note || "",
      cat[e.category_id] || "",
      acc[e.account_id] || "",
      e.country ? countryName(e.country) : "",
      trip[e.trip_id] || "",
      e.note || "",
      e.is_prepaid ? "是" : "",
      e.tax_refund ? (e.tax_refund_status === "claimed" ? "已申請" : "是") : "",
      e.paid_by === "me" ? "我" : (person[e.paid_by] || ""),
    ];
  });

  return { columns: EXPORT_COLUMNS, rows, generated_at: new Date().toISOString() };
}

// ---------------------------------------------------------------- 同步

function sqlValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return String(v);
}

async function handleSync(request, env) {
  const body = await request.json().catch(() => ({}));
  const lastSeq = Number.isFinite(body.last_seq) ? body.last_seq : 0;
  const incoming = body.changes && typeof body.changes === "object" ? body.changes : {};

  const state = await env.DB.prepare("SELECT seq FROM sync_state WHERE id = 1").first();
  let seq = state ? state.seq : 0;

  // ---- 推：客戶端的變更寫進 D1
  const statements = [];
  const pushedIds = {};

  for (const [table, cols] of Object.entries(SYNC_TABLES)) {
    const rows = Array.isArray(incoming[table]) ? incoming[table] : [];
    if (!rows.length) continue;
    pushedIds[table] = new Set();

    for (const row of rows) {
      if (!row || typeof row.id !== "string" || !row.id) continue;
      if (typeof row.updated_at !== "string" || !row.updated_at) continue;

      seq += 1;
      pushedIds[table].add(row.id);

      const allCols = [...cols, "server_seq"];
      const values = cols.map((c) => sqlValue(row[c]));
      values.push(seq);

      // 只有比資料庫裡更新的版本才蓋過去（last-write-wins）
      const setClause = allCols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");
      const sql =
        `INSERT INTO ${table} (${allCols.join(", ")}) VALUES (${allCols.map(() => "?").join(", ")}) ` +
        `ON CONFLICT(id) DO UPDATE SET ${setClause} WHERE excluded.updated_at > ${table}.updated_at`;

      statements.push(env.DB.prepare(sql).bind(...values));
    }
  }

  if (statements.length) {
    statements.push(env.DB.prepare("UPDATE sync_state SET seq = ? WHERE id = 1").bind(seq));
    await env.DB.batch(statements);
  }

  // ---- 拉：伺服器上比 last_seq 新的東西（排掉剛剛自己推上去的，省流量）
  const outgoing = {};
  for (const [table, cols] of Object.entries(SYNC_TABLES)) {
    const { results } = await env.DB
      .prepare(`SELECT ${[...cols, "server_seq"].join(", ")} FROM ${table} WHERE server_seq > ? ORDER BY server_seq`)
      .bind(lastSeq).all();
    const mine = pushedIds[table];
    const rows = (results || []).filter((r) => !mine || !mine.has(r.id));
    if (rows.length) outgoing[table] = rows;
  }

  const fx = await ratesForDate(env, null);

  return json({
    ok: true,
    seq,
    changes: outgoing,
    server_time: new Date().toISOString(),
    fx,
  });
}

// ---------------------------------------------------------------- API 路由

async function handleApi(request, env, path) {
  const method = request.method;

  if (path === "/api/login" && method === "POST") {
    const { password } = await request.json().catch(() => ({}));
    const ip = request.headers.get("CF-Connecting-IP") || "local";

    const wait = loginDelay(ip);
    if (wait) await sleep(wait);

    const expected = secrets(env).password;
    if (!expected) return json({ error: "伺服器還沒設定密碼（wrangler secret put APP_PASSWORD）" }, 500);
    if (typeof password !== "string" || !timingSafeEqual(password, expected)) {
      noteLoginFail(ip);
      return json({ error: "密碼錯誤" }, 401);
    }

    loginFails.delete(ip);
    const token = await makeToken(env);
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
    });
  }

  if (path === "/api/session" && method === "GET") {
    return json({ authed: await isAuthed(request, env) });
  }

  // 試算表匯出：走 EXPORT_TOKEN，不吃登入 cookie
  if (path === "/api/export/entries" && method === "GET") {
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer[ ]+/i, "");
    if (!env.EXPORT_TOKEN) return json({ error: "伺服器還沒設定 EXPORT_TOKEN" }, 500);
    if (!timingSafeEqual(token, env.EXPORT_TOKEN)) return json({ error: "token 不正確" }, 401);
    return json(await exportEntries(env));
  }

  if (!(await isAuthed(request, env))) return json({ error: "未登入" }, 401);

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  if (path === "/api/sync" && method === "POST") {
    return handleSync(request, env);
  }

  if (path === "/api/fx" && method === "GET") {
    const date = new URL(request.url).searchParams.get("date");
    return json(await ratesForDate(env, date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null));
  }

  // 匯率歷史，統計頁與匯出用
  if (path === "/api/fx/history" && method === "GET") {
    const p = new URL(request.url).searchParams;
    const from = p.get("from") || "0000-01-01";
    const to = p.get("to") || "9999-12-31";
    const { results } = await env.DB.prepare(
      "SELECT date, currency, rate_to_twd FROM fx_rates WHERE date BETWEEN ? AND ? ORDER BY date, currency"
    ).bind(from, to).all();
    return json(results || []);
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------- 進入點

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url.pathname);
      } catch (err) {
        console.error("API error", err);
        return json({ error: "伺服器錯誤：" + (err && err.message ? err.message : String(err)) }, 500);
      }
    }

    // 找不到對應檔案時回 app shell 這件事，交給 wrangler.toml 的
    // not_found_handling = "single-page-application" 處理
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      storeRates(env, new Date().toISOString().slice(0, 10))
        .then(() => console.log("匯率已更新"))
        .catch((e) => console.error("匯率更新失敗", e))
    );
  },
};
