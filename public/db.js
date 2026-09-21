// 本機資料層。
//
// IndexedDB 是唯一真相來源 —— 畫面只讀它，寫入也只寫它，永遠不等網路。
// 同步是背景行為：把 dirty 的列推上去、把伺服器的變更拉下來，兩件事都失敗了也不影響使用。

const DB_NAME = "travel-money";
const DB_VERSION = 1;

export const TABLES = [
  "trips", "people", "accounts", "categories",
  "entries", "exchanges", "splits", "settlements",
];

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const t of TABLES) {
        if (!db.objectStoreNames.contains(t)) {
          const store = db.createObjectStore(t, { keyPath: "id" });
          store.createIndex("dirty", "dirty");
        }
      }
      if (!db.objectStoreNames.contains("fx")) db.createObjectStore("fx", { keyPath: "date" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode = "readonly") {
  return open().then((db) => db.transaction(stores, mode));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------- 基本讀寫

export async function getAll(table) {
  const t = await tx([table]);
  const rows = await wrap(t.objectStore(table).getAll());
  return rows.filter((r) => !r.deleted_at);
}

export async function getAllRaw(table) {
  const t = await tx([table]);
  return wrap(t.objectStore(table).getAll());
}

export async function get(table, id) {
  const t = await tx([table]);
  return wrap(t.objectStore(table).get(id));
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// 寫入一列。沒有 id 就當新增；一律標成 dirty 等待推送。
export async function put(table, obj) {
  const now = new Date().toISOString();
  const row = { ...obj };
  if (!row.id) row.id = uuid();
  if (!row.created_at) row.created_at = now;
  row.updated_at = now;
  row.dirty = 1;

  const t = await tx([table], "readwrite");
  await wrap(t.objectStore(table).put(row));
  queueSync();
  return row;
}

// 原封不動寫入，不覆蓋 updated_at。
// 還原備份時要用這支：備份檔裡的 updated_at 是判斷新舊的依據，
// 用一般的 put() 蓋成現在時間，就會把本機比較新的版本誤判成舊的而蓋掉。
export async function putRaw(table, row) {
  if (!row || !row.id) return;
  const t = await tx([table], "readwrite");
  await wrap(t.objectStore(table).put(row));
  queueSync();
}

// 軟刪除：一定要留一列帶 deleted_at，否則刪除同步不到其他裝置
export async function remove(table, id) {
  const existing = await get(table, id);
  if (!existing) return;
  const t = await tx([table], "readwrite");
  await wrap(t.objectStore(table).put({
    ...existing,
    deleted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dirty: 1,
  }));
  queueSync();
}

// ---------------------------------------------------------------- 本機設定

export async function getMeta(key, fallback = null) {
  const t = await tx(["meta"]);
  const row = await wrap(t.objectStore("meta").get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const t = await tx(["meta"], "readwrite");
  await wrap(t.objectStore("meta").put({ key, value }));
}

// ---------------------------------------------------------------- 匯率快取

export async function cacheRates(date, rates) {
  if (!date || !rates || !Object.keys(rates).length) return;
  const t = await tx(["fx"], "readwrite");
  await wrap(t.objectStore("fx").put({ date, rates }));
  await setMeta("fx_latest_date", date);
}

export async function cachedRates(date) {
  const t = await tx(["fx"]);
  if (date) {
    const exact = await wrap(t.objectStore("fx").get(date));
    if (exact) return exact;
  }
  // 沒有指定日或指定日沒資料 → 用手上最新的一份
  const all = await wrap(t.objectStore("fx").getAll());
  if (!all.length) return null;
  all.sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!date) return all[0];
  return all.find((r) => r.date <= date) || all[all.length - 1];
}

// ---------------------------------------------------------------- 同步

let syncTimer = null;
let syncing = false;
let syncAgain = false;

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(detail) { for (const fn of listeners) { try { fn(detail); } catch (e) { console.error(e); } } }

export const syncStatus = { state: "idle", lastError: null, lastSyncAt: null, pending: 0 };

function setStatus(state, error = null) {
  syncStatus.state = state;
  syncStatus.lastError = error;
  emit({ type: "sync-status" });
}

// 變更後稍等一下再送，連續記好幾筆時只會打一次 API
export function queueSync(delay = 800) {
  emit({ type: "data" });
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { sync().catch(() => {}); }, delay);
}

async function collectDirty() {
  const changes = {};
  let count = 0;
  for (const table of TABLES) {
    const t = await tx([table]);
    const rows = await wrap(t.objectStore(table).index("dirty").getAll(1));
    if (rows.length) {
      changes[table] = rows.map(({ dirty, server_seq, ...rest }) => rest);
      count += rows.length;
    }
  }
  return { changes, count };
}

// 推送成功後才清 dirty，而且只清「這段期間沒有再被改過」的列
async function clearDirty(pushed) {
  for (const [table, rows] of Object.entries(pushed)) {
    if (!rows.length) continue;
    const t = await tx([table], "readwrite");
    const store = t.objectStore(table);
    for (const sent of rows) {
      const current = await wrap(store.get(sent.id));
      if (current && current.updated_at === sent.updated_at) {
        await wrap(store.put({ ...current, dirty: 0 }));
      }
    }
  }
}

async function applyIncoming(changes) {
  let applied = 0;
  for (const [table, rows] of Object.entries(changes || {})) {
    if (!TABLES.includes(table) || !Array.isArray(rows) || !rows.length) continue;
    const t = await tx([table], "readwrite");
    const store = t.objectStore(table);
    for (const row of rows) {
      const current = await wrap(store.get(row.id));
      // 本機有更新的版本就不要蓋掉（本機還沒推上去的編輯優先）
      if (current && current.dirty === 1 && current.updated_at >= row.updated_at) continue;
      await wrap(store.put({ ...row, dirty: 0 }));
      applied += 1;
    }
  }
  return applied;
}

export async function sync() {
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { setStatus("offline"); return; }

  syncing = true;
  setStatus("syncing");

  try {
    const { changes, count } = await collectDirty();
    syncStatus.pending = count;

    const lastSeq = await getMeta("last_seq", 0);
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_seq: lastSeq, changes }),
    });

    if (res.status === 401) { setStatus("unauthed"); emit({ type: "unauthed" }); return; }
    if (!res.ok) throw new Error("同步失敗 HTTP " + res.status);

    const data = await res.json();
    await clearDirty(changes);
    const applied = await applyIncoming(data.changes);
    await setMeta("last_seq", data.seq);

    if (data.fx && data.fx.date) await cacheRates(data.fx.date, data.fx.rates);

    syncStatus.pending = 0;
    syncStatus.lastSyncAt = new Date().toISOString();
    setStatus("ok");
    if (applied) emit({ type: "data" });
  } catch (err) {
    console.warn("同步失敗（資料還在本機，之後會自動重試）", err);
    setStatus(navigator.onLine ? "error" : "offline", err.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; queueSync(200); }
  }
}

// 一連上網就把積欠的變更送出去
window.addEventListener("online", () => queueSync(300));
window.addEventListener("offline", () => setStatus("offline"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) queueSync(300); });
setInterval(() => { if (!document.hidden) sync().catch(() => {}); }, 5 * 60000);

// ---------------------------------------------------------------- 首次啟動的預設資料
//
// 用固定 id，這樣多台裝置各自初始化也不會產生重複分類。

const DEFAULT_CATEGORIES = [
  ["cat-food",      "餐飲", "🍽", 10],
  ["cat-daily",     "日常", "🧴", 15],
  ["cat-transit",   "交通", "🚇", 20],
  ["cat-stay",      "住宿", "🏨", 30],
  ["cat-travel",    "旅遊", "✈️", 42],
  ["cat-fun",       "娛樂", "🎬", 45],
  ["cat-shopping",  "購物", "🛍", 70],
  ["cat-gift",      "禮物", "🎁", 80],
  ["cat-health",    "醫藥", "💊", 90],
  ["cat-other",     "其他", "⋯", 120],
];

const DEFAULT_ACCOUNTS = [
  ["acc-cash", "現金", "cash", 40],
  ["acc-card", "信用卡", "card", 50],
];

export async function seedIfEmpty() {
  const now = new Date().toISOString();

  // 補上「還不存在」的預設項目，而不是只在整個表空的時候才建立。
  // 不這樣做的話，日後新增的預設分類，既有的裝置永遠拿不到。
  //
  // 判斷存在與否用 getAllRaw：連軟刪除的墓碑列都算數，
  // 這樣使用者自己刪掉的分類不會每次開 App 又冒出來。
  const catIds = new Set((await getAllRaw("categories")).map((c) => c.id));
  const missingCats = DEFAULT_CATEGORIES.filter(([id]) => !catIds.has(id));
  if (missingCats.length) {
    const t = await tx(["categories"], "readwrite");
    for (const [id, name, icon, sort] of missingCats) {
      await wrap(t.objectStore("categories").put({
        id, name, icon, kind: "expense", sort, hidden: 0,
        created_at: now, updated_at: now, deleted_at: null, dirty: 1,
      }));
    }
    queueSync();
  }

  const accIds = new Set((await getAllRaw("accounts")).map((a) => a.id));
  const missingAccs = DEFAULT_ACCOUNTS.filter(([id]) => !accIds.has(id));
  if (missingAccs.length) {
    const t = await tx(["accounts"], "readwrite");
    for (const [id, name, kind, sort] of missingAccs) {
      await wrap(t.objectStore("accounts").put({
        id, name, kind, currency: kind === "cash" ? "GBP" : "TWD",
        monthly_limit: null, limit_currency: "TWD", color: null, sort, archived: 0,
        created_at: now, updated_at: now, deleted_at: null, dirty: 1,
      }));
    }
    queueSync();
  }
}

// 開發用：清掉本機全部資料
export async function wipeLocal() {
  const db = await open();
  const stores = [...TABLES, "fx", "meta"];
  const t = db.transaction(stores, "readwrite");
  for (const s of stores) t.objectStore(s).clear();
  return new Promise((r) => { t.oncomplete = r; });
}
