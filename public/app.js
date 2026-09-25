import * as db from "./db.js";
import * as fx from "./fx.js";
import { COUNTRIES, country, flagOf, nameOf, countryForCurrency } from "./countries.js";
import { dailyChart, dailyTable, bindChart } from "./charts.js";
import * as xport from "./export.js";

const app = document.getElementById("app");

const state = {
  route: "home",
  ready: false,
  trips: [],
  categories: [],
  accounts: [],
  entries: [],
  exchanges: [],
  people: [],
  splits: [],
  settlements: [],
  activeTripId: null,
  currency: "GBP",
  country: "GB",
  startOnKeypad: false,
  homeView: "list",          // 'list' | 'calendar'
  calMonth: "",              // 月曆目前顯示的月份 YYYY-MM
  selectedDate: null,        // 月曆選中的日期；記帳會落在這天
  statsPeriod: "trip",       // 'trip' | 'month' | 'year'
  statsMonth: "",            // YYYY-MM
  statsYear: "",             // YYYY
};

// ---------------------------------------------------------------- 小工具

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };

const catById = (id) => state.categories.find((c) => c.id === id);
const accById = (id) => state.accounts.find((a) => a.id === id);
const tripById = (id) => state.trips.find((t) => t.id === id);

function sum(rows, pick) {
  return rows.reduce((n, r) => n + (Number(pick(r)) || 0), 0);
}

// 換現不是消費 —— 台幣換成英鎊，錢還是你的，不該算進「這趟花了多少」。
// 換匯的價差確實是成本，但那個另外呈現，不混進支出裡。
const isExpense = (e) => e.type === "expense";

function activeTrip() {
  return state.activeTripId ? tripById(state.activeTripId) : null;
}

// 有選旅程就只看那一趟，沒有就看全部
function scopedEntries() {
  return state.activeTripId
    ? state.entries.filter((e) => e.trip_id === state.activeTripId)
    : state.entries;
}

// ---------------------------------------------------------------- 資料載入

async function reload() {
  const [trips, categories, accounts, entries, exchanges, people, splits, settlements] = await Promise.all([
    db.getAll("trips"), db.getAll("categories"), db.getAll("accounts"),
    db.getAll("entries"), db.getAll("exchanges"),
    db.getAll("people"), db.getAll("splits"), db.getAll("settlements"),
  ]);
  state.people = people.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  state.splits = splits;
  state.settlements = settlements;
  state.trips = trips.sort((a, b) => (b.start_date || "").localeCompare(a.start_date || "") || a.sort - b.sort);
  state.categories = categories.filter((c) => !c.hidden).sort((a, b) => a.sort - b.sort);
  state.accounts = accounts.filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  state.entries = entries.sort((a, b) => (a.spent_at < b.spent_at ? 1 : -1));
  state.exchanges = exchanges;

  // 選中的旅程被刪掉或封存了就退回「全部」
  const t = activeTrip();
  if (state.activeTripId && (!t || t.archived)) {
    state.activeTripId = null;
    await db.setMeta("active_trip_id", null);
  }
}

// 離線記的帳可能還沒有匯率（rate 0）。匯率一到就補算，不然台幣統計會少一塊。
async function backfillRates() {
  const missing = state.entries.filter((e) => !e.rate_to_twd && e.currency !== "TWD");
  if (!missing.length) return;
  let fixed = 0;
  for (const e of missing) {
    const rate = fx.rateToTwd(e.currency);
    if (!rate) continue;
    await db.put("entries", { ...e, rate_to_twd: rate, amount_twd: e.amount * rate });
    fixed += 1;
  }
  if (fixed) { await reload(); render(); }
}

// ---------------------------------------------------------------- 統計計算

// 卡片每月額度：以當地日期的年月分組，每月 1 號自動歸零。
// 額度是卡的屬性，不分旅程 —— 一張卡的月結單不會因為你換了旅程就重算。
function cardUsage(account, ym) {
  const rows = state.entries.filter(
    (e) => e.account_id === account.id && isExpense(e) && e.spent_date.slice(0, 7) === ym
  );
  const twd = sum(rows, (r) => r.amount_twd);
  if (!account.limit_currency || account.limit_currency === "TWD") return twd;
  const rate = fx.rateToTwd(account.limit_currency);
  return rate ? twd / rate : twd;
}

// 現金餘額。只計算跟錢包同幣別的異動 —— 把歐元支出從英鎊錢包扣掉是錯的，
// 那種情況多半是記帳時選錯錢包，寧可標出來讓人發現。
function cashBalance(account) {
  let balance = 0;
  let mismatched = 0;

  for (const e of state.entries) {
    if (e.account_id !== account.id) continue;
    if (e.type === "exchange") continue;
    if (e.currency !== account.currency) { mismatched += 1; continue; }
    if (e.type === "income") balance += e.amount;
    else balance -= e.amount;
  }

  for (const x of state.exchanges) {
    if (x.to_account_id !== account.id) continue;
    if (x.to_currency !== account.currency) { mismatched += 1; continue; }
    balance += x.to_amount;
  }

  return { balance, mismatched };
}

// ---------------------------------------------------------------- 省下
//
// 「省下」刻意跟支出完全分離，絕不相減、不出現在任何淨額裡。
// 折扣價 £30 的外套不是「省了 £20」，是「花了 £30」—— 讓省下的錢去抵銷支出，
// 這個 App 就從「看清花費」變成「幫你合理化消費」了。

function savedTwd(e) {
  const ref = Number(e.reference_amount);
  if (!Number.isFinite(ref) || ref <= e.amount) return 0;
  return (ref - e.amount) * (e.rate_to_twd || 0);
}

const hasSaving = (e) => savedTwd(e) > 0;

// ---------------------------------------------------------------- 分帳
//
// 資料長相：
//   entries.paid_by  = 'me' | people.id     誰先把錢墊出去
//   splits           = 每個參與者分攤多少（**包含我自己**，person_id 用 'me'）
//
// 我自己那份也存成一列，是為了「別人墊、我要還他」這個方向也能算。
// 只存別人的份會讓兩個方向的公式不對稱，容易寫錯。

const ME = "me";

const personName = (id) => (id === ME ? "我" : (state.people.find((p) => p.id === id)?.name || "（已刪除）"));

function splitsOf(entryId) {
  return state.splits.filter((s) => s.entry_id === entryId);
}

const isSplit = (entryId) => state.splits.some((s) => s.entry_id === entryId);

// 每位旅伴對我的淨額，單位一律台幣。
//   正數 = 對方欠我      負數 = 我欠對方
function balances() {
  const map = new Map();
  const add = (pid, v) => map.set(pid, (map.get(pid) || 0) + v);

  for (const e of state.entries) {
    const rows = splitsOf(e.id);
    if (!rows.length) continue;
    const payer = e.paid_by || ME;

    for (const s of rows) {
      if (s.person_id === payer) continue;          // 付錢的人不欠自己
      if (payer === ME) add(s.person_id, s.share_twd);        // 我墊的 → 對方欠我
      else if (s.person_id === ME) add(payer, -s.share_twd);  // 別人墊的且我有份 → 我欠他
      // 兩邊都不是我 → 別人之間的事，與我的淨額無關
    }
  }

  for (const st of state.settlements) {
    // 對方還我錢 → 他欠我的變少；我還對方錢 → 我欠他的變少
    add(st.person_id, st.direction === "they_paid_me" ? -st.amount_twd : st.amount_twd);
  }

  return map;
}

// 把總額依份數拆開。除不盡的餘數給付錢的人，讓各份加總精準等於總額。
function splitByShares(total, participants, decimals, payer) {
  const unit = Math.pow(10, decimals);
  const totalShares = participants.reduce((n, p) => n + p.shares, 0);
  if (!totalShares) return [];

  const out = participants.map((p) => ({
    person_id: p.id,
    amount: Math.floor(total * p.shares / totalShares * unit) / unit,
  }));

  const remainder = Math.round((total - out.reduce((n, r) => n + r.amount, 0)) * unit) / unit;
  if (remainder) {
    const target = out.find((r) => r.person_id === payer) || out[0];
    target.amount = Math.round((target.amount + remainder) * unit) / unit;
  }
  return out;
}

function countryTotals(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!isExpense(e)) continue;
    const key = e.country || "";
    map.set(key, (map.get(key) || 0) + (e.amount_twd || 0));
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------- 提示條

let toastTimer = null;

function toast(message, { undo = null, actionLabel = "復原", warn = false, ms = 5000 } = {}) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);

  const el = document.createElement("div");
  el.className = "toast" + (warn ? " warn" : "");
  el.innerHTML = `<span>${esc(message)}</span>` + (undo ? `<button class="undo">${esc(actionLabel)}</button>` : "");
  document.body.appendChild(el);

  if (undo) el.querySelector(".undo").onclick = async () => { el.remove(); clearTimeout(toastTimer); await undo(); };
  toastTimer = setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- 面板

// 全螢幕（手機）／置中面板（桌面）的通用外框
function panel(title, bodyHtml, { saveLabel = null } = {}) {
  const el = document.createElement("div");
  el.className = "picker";
  el.innerHTML = `
    <div class="sheet-head">
      <button class="x" aria-label="關閉">✕</button>
      <h1 style="margin:0;font-size:17px;font-weight:650">${esc(title)}</h1>
      <div class="spacer"></div>
      ${saveLabel ? `<button class="chip on" data-act="save">${esc(saveLabel)}</button>` : ""}
    </div>
    <div class="picker-list">${bodyHtml}</div>`;
  document.body.appendChild(el);
  el.querySelector(".x").onclick = () => el.remove();
  return el;
}

// ---------------------------------------------------------------- 記帳鍵盤

// 記帳鍵盤兼計算機。
// 採「由左往右依序計算」而不是先乘除後加減 —— 記帳時的算式都是
// 「這個加那個再除以三」這種流水帳，依序算才符合直覺；真的要先乘除
// 的人也不會拿記帳 App 當工程計算機。
const keypad = {
  digits: "",      // 正在輸入的數字
  acc: null,       // 已經算到的結果
  op: null,        // 待執行的運算子
  currency: "GBP",
  country: "GB",
  armed: null,
  focusIdx: -1,    // 桌面用方向鍵選分類時的位置
  field: "amount", // 目前在輸入哪個欄位：'amount' 實付 | 'reference' 原價
  amountValue: 0,  // 已提交的實付
  refValue: 0,     // 已提交的原價（選填）
};

const OP_SYMBOL = { add: "＋", sub: "−", mul: "×", div: "÷" };

function applyOp(a, op, b) {
  if (op === "add") return a + b;
  if (op === "sub") return a - b;
  if (op === "mul") return a * b;
  if (op === "div") return b === 0 ? a : a / b;   // 除以零就當沒除，別讓畫面出現 Infinity
  return b;
}

function keypadValue() {
  const d = keypad.digits === "" ? null : parseFloat(keypad.digits);
  if (keypad.op && keypad.acc !== null && d !== null) return applyOp(keypad.acc, keypad.op, d);
  if (d !== null) return d;
  return keypad.acc ?? 0;
}

// 鍵盤上有兩個金額欄位：實付與原價。
// 原價完全選填 —— 不碰它的話，整個流程跟以前一模一樣，不會多按任何一下。
// 計算機狀態（digits/acc/op）作用在「目前這個」欄位上；切換欄位時先把
// 算到一半的結果收進去，再把另一個欄位的值載出來繼續編輯。
function commitField() {
  const v = keypadValue();
  if (keypad.field === "reference") keypad.refValue = v;
  else keypad.amountValue = v;
}

function switchField(to) {
  if (keypad.field === to) return;
  commitField();
  keypad.field = to;
  keypad.acc = null;
  keypad.op = null;
  const cur = to === "reference" ? keypad.refValue : keypad.amountValue;
  keypad.digits = cur ? trimNum(cur) : "";
}

// 目前這個欄位讀計算機的即時值，另一個讀已提交的值
function fieldValue(name) {
  if (keypad.field === name) return keypadValue();
  return name === "reference" ? keypad.refValue : keypad.amountValue;
}

// 存檔時才把結果收斂到該幣別的小數位。
// 中間過程保留完整精度，否則「除以三再乘以三」會跟原本的數字對不起來。
function roundToCurrency(v, code) {
  const unit = Math.pow(10, fx.currencyInfo(code).decimals);
  return Math.round(v * unit) / unit;
}

// 顯示用：去掉浮點運算跑出來的一長串尾數
function trimNum(v) {
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 1e6) / 1e6);
}

function openKeypad() {
  keypad.digits = "";
  keypad.acc = null;
  keypad.op = null;
  keypad.armed = null;
  keypad.focusIdx = -1;
  keypad.field = "amount";
  keypad.amountValue = 0;
  keypad.refValue = 0;
  keypad.currency = state.currency;
  keypad.country = state.country;
  renderKeypad();
}

function closeKeypad() {
  document.querySelector(".sheet")?.remove();
}

function renderKeypad() {
  document.querySelector(".sheet")?.remove();

  const el = document.createElement("div");
  el.className = "sheet";
  el.innerHTML = `
    <div class="sheet-head">
      <button class="x" data-act="close" aria-label="關閉">✕</button>
      <div class="spacer"></div>
      ${targetDate() !== fx.localDate(new Date())
        ? `<span class="chip datechip">${esc(fx.formatDateLabel(targetDate()))}</span>` : ""}
      <button class="chip" data-act="country">${flagOf(keypad.country) || "🌐"} ▾</button>
      <button class="chip" data-act="currency">${esc(keypad.currency)} ▾</button>
    </div>
    <div class="amount-area">
      <div class="fieldlabel" id="kp-label" hidden></div>
      <div class="big num" id="kp-amount">0</div>
      <div class="conv num" id="kp-conv"></div>
      <div class="pending num" id="kp-pending"></div>
    </div>
    <div class="catgrid">
      ${state.categories.map((c) => `
        <button class="cat" data-cat="${esc(c.id)}">
          <span class="ic">${esc(c.icon)}</span>
          <span class="nm">${esc(c.name)}</span>
        </button>`).join("")}
    </div>
    <div class="fieldbar">
      <button class="fieldtab" data-field="amount"><span class="k">實付</span><span class="v num" id="kp-f-amount"></span></button>
      <button class="fieldtab ref" data-field="reference"><span class="k">原價</span><span class="v num" id="kp-f-ref"></span></button>
    </div>
    <div class="keypad">
      <button class="key fn" data-k="clear">C</button>
      <button class="key op" data-k="div">÷</button>
      <button class="key op" data-k="mul">×</button>
      <button class="key fn" data-k="del">⌫</button>
      <button class="key" data-k="7">7</button>
      <button class="key" data-k="8">8</button>
      <button class="key" data-k="9">9</button>
      <button class="key op" data-k="sub">−</button>
      <button class="key" data-k="4">4</button>
      <button class="key" data-k="5">5</button>
      <button class="key" data-k="6">6</button>
      <button class="key op" data-k="add">＋</button>
      <button class="key" data-k="1">1</button>
      <button class="key" data-k="2">2</button>
      <button class="key" data-k="3">3</button>
      <button class="key op" data-k="eq">=</button>
      <button class="key" data-k="0">0</button>
      <button class="key" data-k="00">00</button>
      <button class="key" data-k=".">.</button>
      <button class="key go" data-k="save">記</button>
    </div>`;

  document.body.appendChild(el);
  updateKeypadDisplay();

  el.querySelector('[data-act="close"]').onclick = () => { buzz(); closeKeypad(); };

  // 放在鍵盤正上方而不是頂列：單手拿手機時拇指搆得到，兩格並排也一眼看得出正在輸入哪一個
  for (const b of el.querySelectorAll("[data-field]")) {
    b.onclick = () => { buzz(); switchField(b.dataset.field); updateKeypadDisplay(); };
  }

  el.querySelector('[data-act="currency"]').onclick = () => openCurrencyPicker((code) => {
    keypad.currency = code;
    state.currency = code;
    db.setMeta("last_currency", code);
    // 幣別只對應一個國家時順手把國家帶過去（歐元不會，20 國共用）
    const guess = countryForCurrency(code);
    if (guess) { keypad.country = guess; state.country = guess; db.setMeta("last_country", guess); }
    renderKeypad();
  }, keypad.currency);

  el.querySelector('[data-act="country"]').onclick = () => openCountryPicker((code) => {
    keypad.country = code;
    state.country = code;
    db.setMeta("last_country", code);
    const cur = country(code)?.currency;
    if (cur) { keypad.currency = cur; state.currency = cur; db.setMeta("last_currency", cur); }
    renderKeypad();
  }, keypad.country);

  for (const key of el.querySelectorAll(".key")) {
    key.onclick = () => onKey(key.dataset.k);
  }

  // 點分類 = 直接存檔；長按 = 先帶入金額與分類，開詳細補資料
  for (const btn of el.querySelectorAll(".cat")) {
    let timer = null, longPressed = false;

    const start = () => {
      longPressed = false;
      timer = setTimeout(() => {
        longPressed = true;
        buzz(20);
        const amount = roundToCurrency(fieldValue("amount"), keypad.currency);
        if (!amount) { toast("先輸入金額", { warn: true, ms: 1800 }); return; }
        const refRaw = roundToCurrency(fieldValue("reference"), keypad.currency);
        closeKeypad();
        openDetail({ amount, currency: keypad.currency, category_id: btn.dataset.cat, country: keypad.country,
                     spent_date: targetDate(), reference_amount: refRaw > amount ? refRaw : null });
      }, 450);
    };
    const cancel = () => clearTimeout(timer);

    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", cancel);
    btn.addEventListener("pointerleave", cancel);
    btn.addEventListener("pointercancel", cancel);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    btn.onclick = () => { if (!longPressed) saveQuick(btn.dataset.cat); };
  }

  // 換幣別會整個重畫，把鍵盤選到的分類位置補回去
  if (keypad.focusIdx >= 0) {
    el.querySelectorAll(".cat")[keypad.focusIdx]?.classList.add("focus");
  }
}

// ---------------------------------------------------------------- 實體鍵盤（桌面）

function moveCatFocus(delta) {
  const n = state.categories.length;
  if (!n) return;
  keypad.focusIdx = keypad.focusIdx < 0
    ? (delta > 0 ? 0 : n - 1)
    : (keypad.focusIdx + delta + n) % n;

  const cats = document.querySelectorAll(".sheet .cat");
  cats.forEach((el, i) => el.classList.toggle("focus", i === keypad.focusIdx));
  cats[keypad.focusIdx]?.scrollIntoView({ block: "nearest" });
}

function typingInField(target) {
  return target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

document.addEventListener("keydown", (ev) => {
  if (document.querySelector(".calcpad")) return;   // 計算機面板自己處理
  if (typingInField(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;

  const sheet = document.querySelector(".sheet");
  const picker = document.querySelector(".picker");

  if (!sheet) {
    if (picker && ev.key === "Escape") { ev.preventDefault(); picker.remove(); return; }
    if (picker) return;
    if (/^[0-9]$/.test(ev.key) && state.ready) {
      ev.preventDefault();
      openKeypad();
      onKey(ev.key);
    }
    return;
  }

  if (picker) {
    if (ev.key === "Escape") { ev.preventDefault(); picker.remove(); }
    return;
  }

  const k = ev.key;
  if (/^[0-9]$/.test(k))            { ev.preventDefault(); onKey(k); }
  else if (k === "." || k === ",")  { ev.preventDefault(); onKey("."); }
  else if (k === "Backspace")       { ev.preventDefault(); onKey("del"); }
  else if (k === "+")               { ev.preventDefault(); onKey("add"); }
  else if (k === "-")               { ev.preventDefault(); onKey("sub"); }
  else if (k === "*" || k === "x")  { ev.preventDefault(); onKey("mul"); }
  else if (k === "/")               { ev.preventDefault(); onKey("div"); }
  else if (k === "=")               { ev.preventDefault(); onKey("eq"); }
  else if (k === "Escape")          { ev.preventDefault(); closeKeypad(); }
  else if (k === "Enter")           {
    ev.preventDefault();
    const cat = keypad.focusIdx >= 0 ? state.categories[keypad.focusIdx] : null;
    saveQuick(cat ? cat.id : "cat-other");
  }
  else if (k === "ArrowRight")      { ev.preventDefault(); moveCatFocus(1); }
  else if (k === "ArrowLeft")       { ev.preventDefault(); moveCatFocus(-1); }
  else if (k === "ArrowDown")       { ev.preventDefault(); moveCatFocus(4); }
  else if (k === "ArrowUp")         { ev.preventDefault(); moveCatFocus(-4); }
});

function onKey(k) {
  buzz(8);

  if (k === "clear") {
    keypad.digits = ""; keypad.acc = null; keypad.op = null;
  } else if (k === "del") {
    if (keypad.digits) keypad.digits = keypad.digits.slice(0, -1);
    else if (keypad.op) keypad.op = null;      // 先收掉運算子，再按一次才清累積值
    else keypad.acc = null;
  } else if (OP_SYMBOL[k]) {
    // 連按運算子只換掉待執行的那個，不會多算一次
    if (keypad.digits === "" && keypad.op) keypad.op = k;
    else { keypad.acc = keypadValue(); keypad.op = k; keypad.digits = ""; }
  } else if (k === "eq") {
    if (keypad.op) {
      const v = keypadValue();
      keypad.acc = null; keypad.op = null;
      keypad.digits = trimNum(v);
    }
  } else if (k === "save") {
    saveQuick(keypad.armed || "cat-other");
    return;
  } else if (k === ".") {
    if (!keypad.digits.includes(".")) keypad.digits = (keypad.digits || "0") + ".";
  } else {
    const next = keypad.digits + k;
    // 小數放寬到六位：除法算出來的中間結果不該被截掉
    if (/^\d{0,9}(\.\d{0,6})?$/.test(next)) keypad.digits = next;
  }
  updateKeypadDisplay();
}
function updateKeypadDisplay() {
  const amountEl = document.getElementById("kp-amount");
  if (!amountEl) return;

  const info = fx.currencyInfo(keypad.currency);
  const onRef = keypad.field === "reference";
  const total = keypadValue();

  // 大字顯示「正在打的數字」；還沒打就顯示目前算到的結果
  const shown = keypad.digits !== ""
    ? keypad.digits
    : (keypad.acc !== null ? trimNum(keypad.acc) : "0");

  amountEl.textContent = info.symbol + shown;
  amountEl.classList.toggle("zero", total === 0 && keypad.acc === null);

  // 只有在輸入原價時才標題，平常不佔版面
  const label = document.getElementById("kp-label");
  label.textContent = onRef ? "原價" : "";
  label.hidden = !onRef;

  const conv = document.getElementById("kp-conv");
  if (keypad.currency === "TWD") {
    conv.textContent = "";
  } else {
    const twd = fx.toTwd(total, keypad.currency);
    conv.textContent = twd === null
      ? "（尚無匯率，連上網後會自動補算）"
      : "約 " + fx.formatTwd(twd);
  }

  // 第三行輪流承擔三件事，優先序：算式 > 省下 > 空白
  const pending = document.getElementById("kp-pending");
  const amt = fieldValue("amount");
  const ref = fieldValue("reference");
  const saving = ref > amt ? ref - amt : 0;

  if (keypad.op && keypad.acc !== null) {
    const rhs = keypad.digits !== "" ? ` ${keypad.digits}` : "";
    const result = keypad.digits !== "" ? `　＝ ${fx.formatAmount(total, keypad.currency)}` : "";
    pending.textContent = `${trimNum(keypad.acc)} ${OP_SYMBOL[keypad.op]}${rhs}${result}`;
  } else if (saving > 0) {
    const other = onRef
      ? `實付 ${fx.formatAmount(amt, keypad.currency)}`
      : `原價 ${fx.formatAmount(ref, keypad.currency)}`;
    pending.innerHTML = `${esc(other)}　<b style="color:var(--ok)">省 ${esc(fx.formatAmount(saving, keypad.currency))}</b>`;
  } else if (onRef) {
    pending.textContent = `實付 ${fx.formatAmount(amt, keypad.currency)}`;
  } else {
    pending.textContent = "";
  }

  // 切換列兩格都顯示目前的值，不用切過去也知道另一邊填了什麼
  for (const b of document.querySelectorAll(".fieldtab")) {
    const on = b.dataset.field === keypad.field;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
  }
  const fAmt = document.getElementById("kp-f-amount");
  const fRef = document.getElementById("kp-f-ref");
  if (fAmt) fAmt.textContent = amt > 0 ? fx.formatAmount(amt, keypad.currency) : "—";
  if (fRef) fRef.textContent = ref > 0 ? fx.formatAmount(ref, keypad.currency) : "選填";

  const go = document.querySelector(".key.go");
  if (go) go.disabled = fieldValue("amount") <= 0;

  for (const el of document.querySelectorAll(".key.op")) {
    el.classList.toggle("armed", el.dataset.k === keypad.op);
  }
}async function saveQuick(categoryId) {
  // 就算現在正在輸入原價，存的仍然是「實付」那一欄，不會存錯
  const amount = roundToCurrency(fieldValue("amount"), keypad.currency);
  if (!amount) {
    toast(keypad.field === "reference" ? "還沒輸入實付金額" : "先輸入金額", { warn: true, ms: 2000 });
    return;
  }
  if (amount < 0) { toast("金額不能是負數", { warn: true, ms: 2200 }); return; }

  const refRaw = roundToCurrency(fieldValue("reference"), keypad.currency);
  const reference = refRaw > amount ? refRaw : null;   // 原價沒比實付高就不算省下

  buzz(18);
  const cat = catById(categoryId) || catById("cat-other");
  const date = targetDate();
  const saved = await createEntry({
    amount, currency: keypad.currency, category_id: cat ? cat.id : null, country: keypad.country,
    reference_amount: reference,
    spent_date: date, spent_at: date + new Date().toISOString().slice(10),
  });

  closeKeypad();
  await reload();
  render();

  const dateNote = date === fx.localDate(new Date()) ? "" : ` · ${fx.formatDateLabel(date)}`;
  const saveNote = reference ? ` · 省 ${fx.formatAmount(reference - amount, keypad.currency)}` : "";
  toast(`已記錄 ${fx.formatAmount(amount, keypad.currency)} · ${cat ? cat.name : "其他"}${dateNote}${saveNote}`, {
    undo: async () => {
      await db.remove("entries", saved.id);
      await reload(); render();
      toast("已復原", { ms: 1600 });
    },
  });
}

async function createEntry(fields) {
  const now = new Date();
  const currency = fields.currency || "TWD";
  // 呼叫端已經算好匯率（例如編輯頁改了日期或幣別）就用它的，否則用當前匯率
  const rate = fields.rate_to_twd != null ? fields.rate_to_twd : (fx.rateToTwd(currency) || 0);
  const amount = Number(fields.amount) || 0;

  return db.put("entries", {
    trip_id: fields.trip_id !== undefined ? fields.trip_id : state.activeTripId,
    type: fields.type || "expense",
    amount,
    currency,
    rate_to_twd: rate,
    amount_twd: amount * rate,
    reference_amount: fields.reference_amount ?? null,
    saving_note: fields.saving_note ?? null,
    category_id: fields.category_id ?? null,
    account_id: fields.account_id ?? null,
    country: fields.country ?? null,
    spent_at: fields.spent_at || now.toISOString(),
    spent_date: fields.spent_date || fx.localDate(now),
    note: fields.note ?? null,
    is_prepaid: fields.is_prepaid ? 1 : 0,
    tax_refund: fields.tax_refund ? 1 : 0,
    tax_refund_status: fields.tax_refund ? "marked" : null,
    paid_by: "me",
  });
}

// ---------------------------------------------------------------- 幣別／國家選單

function openCurrencyPicker(onPick, currentCode) {
  const el = panel("選擇幣別", `<div class="rows">
    ${fx.CURRENCIES.map((c) => `
      <button class="row${c.code === currentCode ? " on" : ""}" data-code="${c.code}">
        <span class="code num">${c.code}</span>
        <span class="k">${esc(c.name)}</span>
        <span class="v num">${c.code === "TWD" ? "—" : ratePreview(c.code)}</span>
      </button>`).join("")}
  </div>`);

  for (const row of el.querySelectorAll("[data-code]")) {
    row.onclick = () => { buzz(); el.remove(); onPick(row.dataset.code); };
  }
}

function openCountryPicker(onPick, currentCode) {
  const el = panel("目前在哪個國家", `<div class="rows">
    ${COUNTRIES.map((c) => `
      <button class="row${c.code === currentCode ? " on" : ""}" data-code="${c.code}">
        <span class="code">${c.flag}</span>
        <span class="k">${esc(c.name)}</span>
        <span class="v num">${esc(c.currency)}</span>
      </button>`).join("")}
  </div>
  <div class="note">選了國家會連幣別一起換過去。之後每筆帳都會記在這個國家名下，跨國時記得回來改。</div>`);

  for (const row of el.querySelectorAll("[data-code]")) {
    row.onclick = () => { buzz(); el.remove(); onPick(row.dataset.code); };
  }
}

function ratePreview(code) {
  const r = fx.rateToTwd(code);
  return r === null ? "—" : "1 = " + r.toLocaleString("en-US", { maximumFractionDigits: r < 1 ? 4 : 2 });
}

// ---------------------------------------------------------------- 計算機面板
//
// 編輯頁的金額欄位原本是原生數字鍵盤，打不了算式。這支是可重複使用的
// 計算機浮層：點欄位就開，算完帶值回去。跟記帳鍵盤共用同一套運算邏輯
// （applyOp / trimNum / OP_SYMBOL），只是自己一份狀態，不去動 keypad。

function openCalcPad({ title, value, currency, onDone }) {
  const cs = { digits: value ? trimNum(value) : "", acc: null, op: null };
  const info = fx.currencyInfo(currency);

  const val = () => {
    const d = cs.digits === "" ? null : parseFloat(cs.digits);
    if (cs.op && cs.acc !== null && d !== null) return applyOp(cs.acc, cs.op, d);
    if (d !== null) return d;
    return cs.acc ?? 0;
  };

  const el = document.createElement("div");
  el.className = "calcpad";
  el.innerHTML = `
    <div class="calcpad-panel">
      <div class="sheet-head">
        <button class="x" data-ck="cancel" aria-label="取消">✕</button>
        <h1 style="margin:0;font-size:17px;font-weight:650">${esc(title)}</h1>
      </div>
      <div class="amount-area">
        <div class="big num" id="ck-big">0</div>
        <div class="conv num" id="ck-conv"></div>
        <div class="pending num" id="ck-expr"></div>
      </div>
      <div class="keypad">
        <button class="key fn" data-ck="clear">C</button>
        <button class="key op" data-ck="div">÷</button>
        <button class="key op" data-ck="mul">×</button>
        <button class="key fn" data-ck="del">⌫</button>
        <button class="key" data-ck="7">7</button>
        <button class="key" data-ck="8">8</button>
        <button class="key" data-ck="9">9</button>
        <button class="key op" data-ck="sub">−</button>
        <button class="key" data-ck="4">4</button>
        <button class="key" data-ck="5">5</button>
        <button class="key" data-ck="6">6</button>
        <button class="key op" data-ck="add">＋</button>
        <button class="key" data-ck="1">1</button>
        <button class="key" data-ck="2">2</button>
        <button class="key" data-ck="3">3</button>
        <button class="key op" data-ck="eq">=</button>
        <button class="key" data-ck="0">0</button>
        <button class="key" data-ck="00">00</button>
        <button class="key" data-ck=".">.</button>
        <button class="key go" data-ck="done">完成</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  const draw = () => {
    const total = val();
    const shown = cs.digits !== "" ? cs.digits : (cs.acc !== null ? trimNum(cs.acc) : "0");
    el.querySelector("#ck-big").textContent = info.symbol + shown;

    const conv = el.querySelector("#ck-conv");
    if (currency === "TWD") conv.textContent = "";
    else {
      const twd = fx.toTwd(total, currency);
      conv.textContent = twd === null ? "" : "約 " + fx.formatTwd(twd);
    }

    const expr = el.querySelector("#ck-expr");
    if (cs.op && cs.acc !== null) {
      const rhs = cs.digits !== "" ? ` ${cs.digits}` : "";
      const res = cs.digits !== "" ? `　＝ ${fx.formatAmount(total, currency)}` : "";
      expr.textContent = `${trimNum(cs.acc)} ${OP_SYMBOL[cs.op]}${rhs}${res}`;
    } else expr.textContent = "";

    for (const b of el.querySelectorAll(".key.op")) {
      b.classList.toggle("armed", b.dataset.ck === cs.op);
    }
  };

  const close = () => { document.removeEventListener("keydown", onKeyDown, true); el.remove(); };

  const press = (k) => {
    buzz(8);
    if (k === "cancel") { close(); return; }
    if (k === "done") { const v = val(); close(); onDone(v > 0 ? v : null); return; }

    if (k === "clear") { cs.digits = ""; cs.acc = null; cs.op = null; }
    else if (k === "del") {
      if (cs.digits) cs.digits = cs.digits.slice(0, -1);
      else if (cs.op) cs.op = null;
      else cs.acc = null;
    } else if (OP_SYMBOL[k]) {
      if (cs.digits === "" && cs.op) cs.op = k;
      else { cs.acc = val(); cs.op = k; cs.digits = ""; }
    } else if (k === "eq") {
      if (cs.op) { const v = val(); cs.acc = null; cs.op = null; cs.digits = trimNum(v); }
    } else if (k === ".") {
      if (!cs.digits.includes(".")) cs.digits = (cs.digits || "0") + ".";
    } else {
      const next = cs.digits + k;
      if (/^\d{0,9}(\.\d{0,6})?$/.test(next)) cs.digits = next;
    }
    draw();
  };

  for (const b of el.querySelectorAll("[data-ck]")) b.onclick = () => press(b.dataset.ck);

  // 桌面也能直接打鍵盤。用捕獲階段搶在全域處理之前，避免 Esc 關到底下的面板。
  function onKeyDown(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key;
    const map = { "+": "add", "-": "sub", "*": "mul", x: "mul", "/": "div", "=": "eq",
                  Enter: "done", Escape: "cancel", Backspace: "del", ",": "." };
    if (/^[0-9]$/.test(k)) { ev.preventDefault(); ev.stopPropagation(); press(k); }
    else if (k === ".") { ev.preventDefault(); ev.stopPropagation(); press("."); }
    else if (map[k]) { ev.preventDefault(); ev.stopPropagation(); press(map[k]); }
  }
  document.addEventListener("keydown", onKeyDown, true);

  draw();
}

// ---------------------------------------------------------------- 詳細／編輯

function openDetail(draft, existing = null) {
  const e = existing || {};
  const amount = draft?.amount ?? e.amount ?? 0;
  const categoryId = draft?.category_id ?? e.category_id ?? "cat-other";
  const countryCode = draft?.country ?? e.country ?? state.country;
  const tripId = e.id ? (e.trip_id ?? "") : (state.activeTripId ?? "");
  const date = e.spent_date || draft?.spent_date || fx.localDate(new Date());

  // 幣別會被使用者改，所以是可變的
  let curCode = draft?.currency || e.currency || state.currency;

  const el = panel(existing ? "編輯" : "補充資料", `
    <div class="hero">
      <div class="label">金額</div>
      <div class="amount-edit">
        <button class="chip" data-act="cur">${esc(curCode)} ▾</button>
        <input class="big-input num" id="d-amount" readonly
               value="${esc(amount ? String(amount) : "")}" placeholder="0">
      </div>
      <div class="secondary num" id="d-conv"></div>
    </div>
    <div class="rows">
      <label class="row"><span class="k">分類</span>
        <select class="v sel" id="d-cat">
          ${state.categories.map((c) => `<option value="${esc(c.id)}"${c.id === categoryId ? " selected" : ""}>${esc(c.icon)} ${esc(c.name)}</option>`).join("")}
        </select>
      </label>
      <label class="row"><span class="k">旅程</span>
        <select class="v sel" id="d-trip">
          <option value="">未分類</option>
          ${state.trips.map((t) => `<option value="${esc(t.id)}"${t.id === tripId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
        </select>
      </label>
      <label class="row"><span class="k">國家</span>
        <select class="v sel" id="d-country">
          <option value="">未指定</option>
          ${COUNTRIES.map((c) => `<option value="${c.code}"${c.code === countryCode ? " selected" : ""}>${c.flag} ${esc(c.name)}</option>`).join("")}
        </select>
      </label>
      <label class="row"><span class="k">付款方式</span>
        <select class="v sel" id="d-acc">
          <option value="">未指定</option>
          ${state.accounts.map((a) => `<option value="${esc(a.id)}"${a.id === e.account_id ? " selected" : ""}>${esc(a.name)}</option>`).join("")}
        </select>
      </label>
      <label class="row"><span class="k">日期</span>
        <input class="v inp" type="date" id="d-date" value="${esc(date)}">
      </label>
      <label class="row"><span class="k">備註</span>
        <input class="v inp grow" type="text" id="d-note" placeholder="選填" value="${esc(e.note || "")}">
      </label>
      <label class="row"><span class="k">本來要花</span>
        <input class="v inp calcfield" type="text" id="d-ref" placeholder="選填" readonly
               value="${(e.reference_amount ?? draft?.reference_amount) != null ? esc(e.reference_amount ?? draft.reference_amount) : ""}" style="width:110px;max-width:110px">
      </label>
      <label class="row"><span class="k">省錢項目</span>
        <input class="v inp grow" type="text" id="d-savenote" placeholder="例如 會員價、早鳥票、走路不搭車"
               value="${esc(e.saving_note || "")}" maxlength="30">
      </label>
      <div class="row" id="d-saved-row" hidden><span class="k" style="color:var(--ok)">省下</span>
        <span class="v num" id="d-saved" style="color:var(--ok);font-weight:650"></span>
      </div>
      <label class="row"><span class="k">行前已付</span>
        <input class="v chk" type="checkbox" id="d-prepaid" ${e.is_prepaid ? "checked" : ""}>
      </label>
      <label class="row"><span class="k">可退稅</span>
        <input class="v chk" type="checkbox" id="d-tax" ${e.tax_refund ? "checked" : ""}>
      </label>
      ${existing ? `<button class="row" data-act="split">
        <span class="k">分帳</span>
        <span class="v">${splitSummary(e)} →</span>
      </button>` : ""}
    </div>
    ${existing ? `<div class="rows"><button class="row danger" data-act="delete"><span class="k">刪除這筆</span></button></div>` : ""}
    <div class="note" id="d-ratenote"></div>`, { saveLabel: "儲存" });

  // ---- 金額與幣別

  const amountInput = el.querySelector("#d-amount");
  const curBtn = el.querySelector('[data-act="cur"]');
  const conv = el.querySelector("#d-conv");
  const rateNote = el.querySelector("#d-ratenote");

  // 幣別沒改就沿用原本凍結的匯率（改金額只是修正打錯的數字，不該換匯率）；
  // 幣別改了才需要新的匯率，而且要抓「那一天」的，不是今天的。
  let rate = existing && e.rate_to_twd && e.currency === curCode
    ? e.rate_to_twd
    : (fx.rateToTwd(curCode) || 0);

  // 容忍貼上來的符號與千分位（「£12.50」「1,234」都要能認），
  // 但負號要留著 —— 不能默默把 -5 變成 5，那多半代表使用者想記退款。
  const readAmount = () => {
    const v = parseFloat(amountInput.value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(v) ? v : 0;
  };

  const refresh = () => {
    const v = readAmount();
    conv.textContent = v < 0
      ? "金額不能是負數"
      : curCode === "TWD"
        ? ""
        : (rate && v > 0 ? "約 " + fx.formatTwd(v * rate) : rate ? "" : "尚無匯率，連上網後會自動補算");

    const frozen = existing && e.currency === curCode;
    rateNote.innerHTML =
      (curCode === "TWD" ? "" :
        (frozen
          ? `匯率沿用這筆記帳當下凍結的 1 ${esc(curCode)} = ${rate.toFixed(4)} TWD，改金額不會換匯率。<br>`
          : `幣別換成 ${esc(curCode)}，會套用 ${esc(el.querySelector("#d-date").value || date)} 當天的匯率${rate ? `（1 ${esc(curCode)} = ${rate.toFixed(4)} TWD）` : ""}。<br>`)) +
      `「行前已付」是出發前就在台灣付掉的，例如機票、住宿、鐵路通票。`;
  };

  // 「本來要花」跟金額同幣別，所以直接用同一個 rate 換算
  const refInput = el.querySelector("#d-ref");
  const savedRow = el.querySelector("#d-saved-row");
  const savedEl = el.querySelector("#d-saved");

  const readRef = () => {
    const v = parseFloat(String(refInput.value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  const refreshSaved = () => {
    const ref = readRef();
    const amt = readAmount();
    const diff = ref !== null && amt > 0 ? ref - amt : 0;
    if (diff > 0) {
      savedRow.hidden = false;
      const twd = curCode === "TWD" ? diff : diff * (rate || 0);
      savedEl.textContent = fx.formatAmount(diff, curCode) + (curCode === "TWD" || !rate ? "" : "　" + fx.formatTwd(twd));
    } else {
      savedRow.hidden = true;
    }
  };

  refInput.addEventListener("input", refreshSaved);
  amountInput.addEventListener("input", refreshSaved);
  amountInput.addEventListener("input", refresh);

  // 兩個金額欄位都改成點一下開計算機。
  // 只有原價能算、金額不能算的話，同一個畫面裡兩種行為會很奇怪。
  const openCalcFor = (input, title, after) => {
    const fire = () => {
      input.blur();
      openCalcPad({
        title,
        value: parseFloat(String(input.value).replace(/[^0-9.-]/g, "")) || 0,
        currency: curCode,
        onDone: (v) => {
          input.value = v === null ? "" : trimNum(v);
          after();
        },
      });
    };
    input.addEventListener("click", fire);
    input.addEventListener("focus", fire);
  };

  openCalcFor(amountInput, "金額", () => { refresh(); refreshSaved(); });
  openCalcFor(refInput, "本來要花", refreshSaved);
  amountInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") amountInput.blur(); });

  curBtn.onclick = () => openCurrencyPicker(async (code) => {
    if (code === curCode) return;
    curBtn.textContent = code + " ▾";
    curCode = code;
    rate = existing && e.currency === code && e.rate_to_twd
      ? e.rate_to_twd
      : await fx.rateOn(el.querySelector("#d-date").value || date, code) || 0;
    refresh();
  }, curCode);

  refresh();
  refreshSaved();
  if (!existing) setTimeout(() => amountInput.focus(), 60);

  el.querySelector('[data-act="save"]').onclick = async () => {
    const newAmount = readAmount();
    if (newAmount < 0) {
      toast("金額不能是負數。退款請另外記一筆，不要用負數", { warn: true, ms: 3000 });
      return;
    }
    if (!newAmount) { toast("金額要大於 0", { warn: true, ms: 1800 }); return; }

    const fields = {
      category_id: el.querySelector("#d-cat").value || null,
      trip_id: el.querySelector("#d-trip").value || null,
      country: el.querySelector("#d-country").value || null,
      account_id: el.querySelector("#d-acc").value || null,
      spent_date: el.querySelector("#d-date").value || date,
      note: el.querySelector("#d-note").value.trim() || null,
      is_prepaid: el.querySelector("#d-prepaid").checked ? 1 : 0,
      tax_refund: el.querySelector("#d-tax").checked ? 1 : 0,
      reference_amount: readRef(),
      saving_note: el.querySelector("#d-savenote").value.trim() || null,
    };
    fields.tax_refund_status = fields.tax_refund ? (e.tax_refund_status || "marked") : null;

    if (existing) {
      // 日期改了就把時間部分一起搬過去，維持 spent_at 與 spent_date 一致
      const spentAt = fields.spent_date === e.spent_date
        ? e.spent_at
        : fields.spent_date + e.spent_at.slice(10);

      await db.put("entries", {
        ...e, ...fields,
        amount: newAmount,
        currency: curCode,
        rate_to_twd: rate,
        amount_twd: newAmount * rate,   // 金額或幣別改了，台幣金額一定要跟著重算
        spent_at: spentAt,
      });
    } else {
      await createEntry({
        ...fields, amount: newAmount, currency: curCode, rate_to_twd: rate,
        spent_at: fields.spent_date + new Date().toISOString().slice(10),
      });
    }

    el.remove();
    await reload(); render();
    toast(existing ? `已更新為 ${fx.formatAmount(newAmount, curCode)}` : `已記錄 ${fx.formatAmount(newAmount, curCode)}`, { ms: 2000 });
  };

  el.querySelector('[data-act="split"]')?.addEventListener("click", () => {
    if (!state.people.length) {
      toast("要先在「設定 → 旅伴」加旅伴", { warn: true, ms: 2800 });
      return;
    }
    el.remove();
    openSplitEditor(e);
  });

  el.querySelector('[data-act="delete"]')?.addEventListener("click", async () => {
    // 分攤紀錄跟著一起軟刪除，不然淨額會算到一筆已經不存在的帳
    for (const s of splitsOf(e.id)) await db.remove("splits", s.id);
    await db.remove("entries", e.id);
    el.remove();
    await reload(); render();
    toast("已刪除", {
      undo: async () => {
        await db.put("entries", { ...e, deleted_at: null });
        for (const s of state.splits.filter((x) => x.entry_id === e.id)) {
          await db.put("splits", { ...s, deleted_at: null });
        }
        await reload(); render();
      },
    });
  });
}

// 詳細頁那一列的摘要文字
function splitSummary(e) {
  const rows = splitsOf(e.id);
  if (!rows.length) return "未分帳";
  const payer = e.paid_by || ME;
  const mine = rows.find((s) => s.person_id === ME);
  const who = payer === ME ? "我墊的" : `${personName(payer)} 墊的`;
  return `${who}．${rows.length} 人分${mine ? `．我 ${fx.formatAmount(mine.share_amount, e.currency)}` : ""}`;
}

// ---------------------------------------------------------------- 旅程

function openTripPicker() {
  const el = panel("旅程", `
    <div class="rows">
      <button class="row${!state.activeTripId ? " on" : ""}" data-trip="">
        <span class="k">全部帳目</span>
        <span class="v num">${esc(fx.formatTwd(sum(state.entries.filter(isExpense), (r) => r.amount_twd)))}</span>
      </button>
      ${state.trips.filter((t) => !t.archived).map((t) => {
        const rows = state.entries.filter((e) => e.trip_id === t.id && isExpense(e));
        return `<button class="row${t.id === state.activeTripId ? " on" : ""}" data-trip="${esc(t.id)}">
          <span class="k">${esc(t.name)}<br><span style="font-size:12px;color:var(--faint)">${esc(tripDateLabel(t))}</span></span>
          <span class="v num">${esc(fx.formatTwd(sum(rows, (r) => r.amount_twd)))}<br><span style="font-size:12px;color:var(--faint)">${rows.length} 筆</span></span>
        </button>`;
      }).join("")}
    </div>
    <div class="rows">
      <button class="row" data-act="new"><span class="k" style="color:var(--accent);font-weight:600">＋ 新增旅程</span></button>
      ${state.trips.some((t) => t.archived) ? `<button class="row" data-act="archived"><span class="k">已封存的旅程</span><span class="v">→</span></button>` : ""}
    </div>
    <div class="note">切換旅程只影響首頁與統計看到的範圍，明細頁一樣看得到全部。長按旅程可以編輯。</div>`);

  for (const row of el.querySelectorAll("[data-trip]")) {
    let timer = null, held = false;
    const id = row.dataset.trip;

    row.addEventListener("pointerdown", () => {
      held = false;
      if (!id) return;
      timer = setTimeout(() => { held = true; buzz(20); el.remove(); openTripEditor(tripById(id)); }, 450);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
      row.addEventListener(ev, () => clearTimeout(timer));
    }
    row.onclick = async () => {
      if (held) return;
      buzz();
      state.activeTripId = id || null;
      await db.setMeta("active_trip_id", state.activeTripId);
      el.remove();
      render();
    };
  }

  el.querySelector('[data-act="new"]').onclick = () => { el.remove(); openTripEditor(null); };
  el.querySelector('[data-act="archived"]')?.addEventListener("click", () => { el.remove(); openArchivedTrips(); });
}

function tripDateLabel(t) {
  if (!t.start_date && !t.end_date) return t.local_currency;
  const fmt = (d) => (d ? d.slice(5).replace("-", "/") : "");
  return `${fmt(t.start_date)}–${fmt(t.end_date) || "進行中"} · ${t.local_currency}`;
}

function openTripEditor(trip) {
  const t = trip || {};
  const isNew = !trip;

  const el = panel(isNew ? "新增旅程" : "編輯旅程", `
    <div class="rows">
      <label class="row"><span class="k">名稱</span>
        <input class="v inp grow" type="text" id="t-name" placeholder="例如 2026 英國" value="${esc(t.name || "")}">
      </label>
      <label class="row"><span class="k">當地幣別</span>
        <select class="v sel" id="t-cur">
          ${fx.CURRENCIES.map((c) => `<option value="${c.code}"${c.code === (t.local_currency || "GBP") ? " selected" : ""}>${c.code} ${esc(c.name)}</option>`).join("")}
        </select>
      </label>
      <label class="row"><span class="k">出發日</span>
        <input class="v inp" type="date" id="t-start" value="${esc(t.start_date || "")}">
      </label>
      <label class="row"><span class="k">回程日</span>
        <input class="v inp" type="date" id="t-end" value="${esc(t.end_date || "")}">
      </label>
      <label class="row"><span class="k">每日預算</span>
        <input class="v inp" type="number" inputmode="decimal" id="t-budget" placeholder="選填 · 台幣"
               value="${t.daily_budget != null ? esc(t.daily_budget) : ""}">
      </label>
    </div>
    ${isNew ? "" : `<div class="rows">
      <button class="row" data-act="archive"><span class="k">${t.archived ? "取消封存" : "封存這趟旅程"}</span><span class="v">→</span></button>
      <button class="row danger" data-act="delete"><span class="k">刪除旅程</span></button>
    </div>`}
    <div class="note">
      回程日留空代表還在進行中。每日預算填台幣金額，首頁會拿今天的花費跟它比。<br>
      ${isNew ? "" : "刪除旅程不會刪掉帳目，那些帳會變回「未分類」。"}
    </div>`, { saveLabel: "儲存" });

  el.querySelector('[data-act="save"]').onclick = async () => {
    const name = el.querySelector("#t-name").value.trim();
    if (!name) { toast("旅程要有名字", { warn: true, ms: 1800 }); return; }

    const budget = parseFloat(el.querySelector("#t-budget").value);
    const saved = await db.put("trips", {
      ...t,
      name,
      local_currency: el.querySelector("#t-cur").value,
      start_date: el.querySelector("#t-start").value || null,
      end_date: el.querySelector("#t-end").value || null,
      daily_budget: Number.isFinite(budget) && budget > 0 ? budget : null,
      archived: t.archived ? 1 : 0,
      sort: t.sort ?? 0,
    });

    // 新建的旅程直接切換過去，不然還要多按一次
    if (isNew) {
      state.activeTripId = saved.id;
      await db.setMeta("active_trip_id", saved.id);
      state.currency = saved.local_currency;
      await db.setMeta("last_currency", saved.local_currency);
    }

    el.remove();
    await reload(); render();
    toast(isNew ? `已建立「${name}」` : "已更新", { ms: 2000 });
  };

  el.querySelector('[data-act="archive"]')?.addEventListener("click", async () => {
    await db.put("trips", { ...t, archived: t.archived ? 0 : 1 });
    el.remove();
    await reload(); render();
    toast(t.archived ? "已取消封存" : "已封存", { ms: 1800 });
  });

  el.querySelector('[data-act="delete"]')?.addEventListener("click", async () => {
    const count = state.entries.filter((e) => e.trip_id === t.id).length;
    if (!confirm(`確定刪除「${t.name}」？\n${count} 筆帳目會變回未分類，不會被刪掉。`)) return;
    await db.remove("trips", t.id);
    el.remove();
    await reload(); render();
    toast("旅程已刪除", { ms: 2000 });
  });
}

function openArchivedTrips() {
  const archived = state.trips.filter((t) => t.archived);
  const el = panel("已封存的旅程", `<div class="rows">
    ${archived.map((t) => `<button class="row" data-trip="${esc(t.id)}">
      <span class="k">${esc(t.name)}</span><span class="v num">${esc(tripDateLabel(t))}</span>
    </button>`).join("") || `<div class="note">沒有已封存的旅程。</div>`}
  </div>`);

  for (const row of el.querySelectorAll("[data-trip]")) {
    row.onclick = () => { el.remove(); openTripEditor(tripById(row.dataset.trip)); };
  }
}

// ---------------------------------------------------------------- 付款方式

// 帳戶頁：現金餘額與卡片本月額度都在這裡。
// 這些數字原本擺在首頁，但它們描述的是「這個付款方式的狀態」而不是「這趟花了多少」，
// 放在帳戶自己身上才對；首頁改由頂欄的 💳 一鍵進來。
function openAccountList() {
  const ym = fx.localDate(new Date()).slice(0, 7);

  const walletRow = (a) => {
    const { balance, mismatched } = cashBalance(a);
    return `<button class="row" data-acc="${esc(a.id)}">
      <span class="k">💵 ${esc(a.name)}</span>
      <span class="v num" style="color:${balance < 0 ? "var(--danger)" : "var(--text)"};font-weight:650;font-size:16px">
        ${esc(fx.formatAmount(balance, a.currency))}
        ${mismatched ? `<br><span style="font-size:11px;font-weight:400;color:var(--faint)">${mismatched} 筆其他幣別未計入</span>` : ""}
      </span>
    </button>`;
  };

  const cardRow = (a) => {
    if (!(a.monthly_limit > 0)) {
      return `<button class="row" data-acc="${esc(a.id)}">
        <span class="k">💳 ${esc(a.name)}</span><span class="v">未設額度</span>
      </button>`;
    }
    const used = cardUsage(a, ym);
    const pct = Math.round(used / a.monthly_limit * 100);
    return `<button class="row limit" data-acc="${esc(a.id)}">
      <div style="display:flex;gap:8px">
        <span class="k">💳 ${esc(a.name)}</span>
        <span class="v num" style="margin-left:auto">${esc(fx.formatAmount(used, a.limit_currency))} / ${esc(fx.formatAmount(a.monthly_limit, a.limit_currency))}</span>
      </div>
      ${bar(used, a.monthly_limit)}
      <div class="barlabel">${used > a.monthly_limit
        ? `<span style="color:var(--danger)">超出 ${fx.formatAmount(used - a.monthly_limit, a.limit_currency)}</span>`
        : `${pct}%　還可刷 ${fx.formatAmount(a.monthly_limit - used, a.limit_currency)}`}　·　${esc(ym)}</div>
    </button>`;
  };

  const wallets = state.accounts.filter((a) => a.kind === "cash");
  const cards = state.accounts.filter((a) => a.kind !== "cash");

  const el = panel("帳戶", `
    ${wallets.length ? `
    <div class="section-head"><h2>現金</h2><button class="more" data-act="exchange">＋ 換現</button></div>
    <div class="rows">${wallets.map(walletRow).join("")}</div>` : ""}

    ${cards.length ? `
    <div class="section-head"><h2>卡片</h2></div>
    <div class="rows">${cards.map(cardRow).join("")}</div>` : ""}

    ${(() => {
      const bal = balances();
      const rows = state.people.map((p) => ({ p, v: bal.get(p.id) || 0 })).filter((r) => Math.abs(r.v) >= 0.5);
      if (!rows.length) return "";
      return `
      <div class="section-head"><h2>分帳</h2><button class="more" data-act="settle">結算 →</button></div>
      <div class="rows">
        ${rows.map(({ p, v }) => `<div class="row">
          <span class="k">${esc(p.name)}</span>
          <span class="v num" style="color:${v > 0 ? "var(--ok)" : "var(--danger)"};font-weight:650">
            ${v > 0 ? "欠你 " : "你欠 "}${esc(fx.formatTwd(Math.abs(v)))}
          </span>
        </div>`).join("")}
      </div>`;
    })()}

    <div class="rows" style="margin-top:22px">
      <button class="row" data-act="new"><span class="k" style="color:var(--accent);font-weight:600">＋ 新增付款方式</span></button>
    </div>
    <div class="note">
      現金餘額 = 換現存入 − 用這個錢包付掉的支出，只計算跟錢包同幣別的異動。<br>
      卡片額度是你自己設的每月天花板，每月 1 號歸零，跟銀行的信用額度無關。<br>
      點任一列可以編輯。
    </div>`);

  for (const row of el.querySelectorAll("[data-acc]")) {
    row.onclick = () => { el.remove(); openAccountEditor(accById(row.dataset.acc)); };
  }
  el.querySelector('[data-act="new"]').onclick = () => { el.remove(); openAccountEditor(null); };
  el.querySelector('[data-act="exchange"]')?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    el.remove();
    openExchange();
  });
  el.querySelector('[data-act="settle"]')?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    el.remove();
    openSettlement();
  });
}

function openAccountEditor(account) {
  const a = account || {};
  const isNew = !account;
  const kind = a.kind || "card";

  const el = panel(isNew ? "新增付款方式" : "編輯付款方式", `
    <div class="rows">
      <label class="row"><span class="k">名稱</span>
        <input class="v inp grow" type="text" id="a-name" placeholder="例如 國泰世華 CUBE" value="${esc(a.name || "")}">
      </label>
      <label class="row"><span class="k">類型</span>
        <select class="v sel" id="a-kind">
          <option value="card"${kind === "card" ? " selected" : ""}>💳 信用卡／簽帳卡</option>
          <option value="cash"${kind === "cash" ? " selected" : ""}>💵 現金錢包</option>
        </select>
      </label>
      <label class="row"><span class="k" id="a-cur-label">幣別</span>
        <select class="v sel" id="a-cur">
          ${fx.CURRENCIES.map((c) => `<option value="${c.code}"${c.code === (a.currency || "TWD") ? " selected" : ""}>${c.code} ${esc(c.name)}</option>`).join("")}
        </select>
      </label>
      <div id="a-limit-block">
        <label class="row"><span class="k">每月上限</span>
          <input class="v inp" type="number" inputmode="decimal" id="a-limit" placeholder="選填"
                 value="${a.monthly_limit != null ? esc(a.monthly_limit) : ""}">
        </label>
        <label class="row"><span class="k">上限幣別</span>
          <select class="v sel" id="a-limit-cur">
            ${fx.CURRENCIES.map((c) => `<option value="${c.code}"${c.code === (a.limit_currency || "TWD") ? " selected" : ""}>${c.code}</option>`).join("")}
          </select>
        </label>
      </div>
    </div>
    ${isNew ? "" : `<div class="rows"><button class="row danger" data-act="delete"><span class="k">刪除</span></button></div>`}
    <div class="note" id="a-note"></div>`, { saveLabel: "儲存" });

  const kindSel = el.querySelector("#a-kind");
  const limitBlock = el.querySelector("#a-limit-block");
  const curLabel = el.querySelector("#a-cur-label");
  const note = el.querySelector("#a-note");

  const syncKind = () => {
    const isCash = kindSel.value === "cash";
    limitBlock.classList.toggle("hidden", isCash);
    curLabel.textContent = isCash ? "錢包幣別" : "結帳幣別";
    note.innerHTML = isCash
      ? "現金錢包的餘額 = 換現存入 − 用這個錢包付掉的支出。只計算跟錢包同幣別的異動。"
      : "每月上限是你自己設的天花板，用來提醒別刷過頭，跟銀行給的信用額度無關。每月 1 號歸零。";
  };
  kindSel.onchange = syncKind;
  syncKind();

  el.querySelector('[data-act="save"]').onclick = async () => {
    const name = el.querySelector("#a-name").value.trim();
    if (!name) { toast("要有名稱", { warn: true, ms: 1800 }); return; }

    const isCash = kindSel.value === "cash";
    const limit = parseFloat(el.querySelector("#a-limit").value);

    await db.put("accounts", {
      ...a,
      name,
      kind: kindSel.value,
      currency: el.querySelector("#a-cur").value,
      monthly_limit: !isCash && Number.isFinite(limit) && limit > 0 ? limit : null,
      limit_currency: el.querySelector("#a-limit-cur").value,
      color: a.color ?? null,
      sort: a.sort ?? (state.accounts.length + 1) * 10,
      archived: 0,
    });

    el.remove();
    await reload(); render();
    toast(isNew ? "已新增" : "已更新", { ms: 1800 });
  };

  el.querySelector('[data-act="delete"]')?.addEventListener("click", async () => {
    const count = state.entries.filter((e) => e.account_id === a.id).length;
    if (!confirm(`確定刪除「${a.name}」？\n${count} 筆帳目的付款方式會變成未指定。`)) return;
    await db.remove("accounts", a.id);
    el.remove();
    await reload(); render();
    toast("已刪除", { ms: 1800 });
  });
}

// ---------------------------------------------------------------- 旅伴

function openPeopleList() {
  const bal = balances();

  const el = panel("旅伴", `
    <div class="rows">
      ${state.people.length ? state.people.map((p) => {
        const v = bal.get(p.id) || 0;
        const label = Math.abs(v) < 0.5 ? "已結清"
          : v > 0 ? `欠你 ${fx.formatTwd(v)}` : `你欠 ${fx.formatTwd(-v)}`;
        return `<button class="row" data-person="${esc(p.id)}">
          <span class="k">${esc(p.name)}</span>
          <span class="v num" style="color:${Math.abs(v) < 0.5 ? "var(--faint)" : v > 0 ? "var(--ok)" : "var(--danger)"}">${esc(label)}</span>
        </button>`;
      }).join("") : `<div class="note" style="padding-top:18px">還沒有旅伴。加了之後，記帳時就能把一筆消費拆給他們分攤。</div>`}
    </div>
    <div class="rows">
      <button class="row" data-act="new"><span class="k" style="color:var(--accent);font-weight:600">＋ 新增旅伴</span></button>
    </div>
    <div class="note">旅伴不需要註冊或安裝任何東西，這只是你自己的一份名單。點名字可以改名或刪除。</div>`);

  for (const row of el.querySelectorAll("[data-person]")) {
    row.onclick = () => { el.remove(); openPersonEditor(state.people.find((p) => p.id === row.dataset.person)); };
  }
  el.querySelector('[data-act="new"]').onclick = () => { el.remove(); openPersonEditor(null); };
}

function openPersonEditor(person) {
  const p = person || {};
  const isNew = !person;
  const involved = state.splits.filter((s) => s.person_id === p.id).length;

  const el = panel(isNew ? "新增旅伴" : "編輯旅伴", `
    <div class="rows">
      <label class="row"><span class="k">名字</span>
        <input class="v inp grow" type="text" id="p-name" placeholder="例如 阿哲" value="${esc(p.name || "")}">
      </label>
    </div>
    ${isNew ? "" : `<div class="rows"><button class="row danger" data-act="delete"><span class="k">刪除旅伴</span></button></div>`}
    <div class="note">${isNew ? "" : `目前有 ${involved} 筆帳分攤給這個人。刪除不會動到那些帳，但淨額就算不出來了。`}</div>`,
    { saveLabel: "儲存" });

  el.querySelector('[data-act="save"]').onclick = async () => {
    const name = el.querySelector("#p-name").value.trim();
    if (!name) { toast("要有名字", { warn: true, ms: 1800 }); return; }
    await db.put("people", { ...p, name, sort: p.sort ?? (state.people.length + 1) * 10 });
    el.remove();
    await reload(); render();
    toast(isNew ? `已新增「${name}」` : "已更新", { ms: 1800 });
  };

  el.querySelector('[data-act="delete"]')?.addEventListener("click", async () => {
    if (!confirm(`確定刪除「${p.name}」？\n${involved} 筆分攤紀錄會留著，但淨額不再計入。`)) return;
    await db.remove("people", p.id);
    el.remove();
    await reload(); render();
    toast("已刪除", { ms: 1800 });
  });
}

// ---------------------------------------------------------------- 分類管理

// 記帳鍵盤是 4 欄，所以分類數量湊成 4 的倍數時最好看，
// 不過不強制 —— 這只是排序時的參考。
const EMOJI_SUGGESTIONS = [
  "🍽", "🍜", "🍔", "☕", "🍺", "🛒", "🥐",
  "🚇", "🚕", "🚌", "🚆", "✈️", "⛽", "🅿️",
  "🏨", "🏠", "🎫", "🎬", "🎡", "🎧", "📚",
  "🛍", "👕", "👟", "💄", "🎁", "🧴", "🧻",
  "💊", "🏥", "💇", "🧺", "📱", "💻", "🔌",
  "🧾", "💱", "🅿", "⋯", "•",
];

function openCategoryList() {
  const cats = state.categories.slice().sort((a, b) => a.sort - b.sort);

  const el = panel("分類", `
    <div class="rows">
      ${cats.map((c, i) => `
        <div class="row catrow">
          <button class="catmain" data-cat-edit="${esc(c.id)}">
            <span class="ic">${esc(c.icon)}</span>
            <span class="k">${esc(c.name)}</span>
          </button>
          <span class="catmove">
            <button class="movebtn" data-move-up="${esc(c.id)}" ${i === 0 ? "disabled" : ""} aria-label="往上移">▲</button>
            <button class="movebtn" data-move-down="${esc(c.id)}" ${i === cats.length - 1 ? "disabled" : ""} aria-label="往下移">▼</button>
          </span>
        </div>`).join("")}
    </div>
    <div class="rows">
      <button class="row" data-act="new-cat"><span class="k" style="color:var(--accent);font-weight:600">＋ 新增分類</span></button>
    </div>
    <div class="note">
      點名稱可以改圖示與名字，右邊箭頭調順序 —— 順序就是記帳鍵盤上的排列，常用的往前放比較好按。<br>
      目前 ${cats.length} 個分類，鍵盤一排 4 個，所以會排成 ${Math.ceil(cats.length / 4)} 排。
    </div>`);

  for (const b of el.querySelectorAll("[data-cat-edit]")) {
    b.onclick = () => { el.remove(); openCategoryEditor(catById(b.dataset.catEdit)); };
  }
  el.querySelector('[data-act="new-cat"]').onclick = () => { el.remove(); openCategoryEditor(null); };

  const swap = async (id, dir) => {
    const list = state.categories.slice().sort((a, b) => a.sort - b.sort);
    const i = list.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    // 直接對調兩者的 sort 值；重排整份清單會讓每一列都變 dirty，同步量沒必要那麼大
    const a = list[i], b = list[j];
    await db.put("categories", { ...a, sort: b.sort });
    await db.put("categories", { ...b, sort: a.sort });
    el.remove();
    await reload();
    render();
    openCategoryList();
  };
  for (const b of el.querySelectorAll("[data-move-up]")) b.onclick = () => swap(b.dataset.moveUp, -1);
  for (const b of el.querySelectorAll("[data-move-down]")) b.onclick = () => swap(b.dataset.moveDown, 1);
}

function openCategoryEditor(cat) {
  const c = cat || {};
  const isNew = !cat;
  const used = state.entries.filter((e) => e.category_id === c.id).length;

  const el = panel(isNew ? "新增分類" : "編輯分類", `
    <div class="hero" style="text-align:center">
      <div class="catpreview" id="c-preview">${esc(c.icon || "•")}</div>
    </div>
    <div class="rows">
      <label class="row"><span class="k">名稱</span>
        <input class="v inp grow" type="text" id="c-name" placeholder="例如 洗衣" value="${esc(c.name || "")}" maxlength="8">
      </label>
      <label class="row"><span class="k">圖示</span>
        <input class="v inp" type="text" id="c-icon" placeholder="貼一個 emoji" value="${esc(c.icon || "")}" maxlength="4"
               style="width:88px;max-width:88px;font-size:22px">
      </label>
    </div>
    <div class="section-head"><h2>或從這裡挑</h2></div>
    <div class="emojigrid">
      ${EMOJI_SUGGESTIONS.map((e) => `<button class="emojibtn" data-emoji="${esc(e)}">${e}</button>`).join("")}
    </div>
    ${isNew ? "" : `<div class="rows"><button class="row danger" data-act="delete"><span class="k">刪除分類</span></button></div>`}
    <div class="note">
      ${isNew ? "新分類會排在最後面，之後可以在清單裡調順序。"
              : `目前有 ${used} 筆帳目用這個分類。${used ? "刪除不會刪掉那些帳，但它們會變成「未分類」—— 想保留統計的話，先把它們改成別的分類再刪。" : "沒有帳目在用，可以安心刪。"}`}
    </div>`, { saveLabel: "儲存" });

  const nameEl = el.querySelector("#c-name");
  const iconEl = el.querySelector("#c-icon");
  const preview = el.querySelector("#c-preview");

  const sync = () => { preview.textContent = iconEl.value.trim() || "•"; };
  iconEl.addEventListener("input", sync);
  for (const b of el.querySelectorAll("[data-emoji]")) {
    b.onclick = () => { buzz(); iconEl.value = b.dataset.emoji; sync(); };
  }
  if (isNew) setTimeout(() => nameEl.focus(), 60);

  el.querySelector('[data-act="save"]').onclick = async () => {
    const name = nameEl.value.trim();
    if (!name) { toast("要有名稱", { warn: true, ms: 1800 }); return; }

    const maxSort = state.categories.reduce((n, x) => Math.max(n, x.sort), 0);
    await db.put("categories", {
      ...c,
      name,
      icon: iconEl.value.trim() || "•",
      kind: c.kind || "expense",
      sort: c.sort ?? maxSort + 10,
      hidden: 0,
    });
    el.remove();
    await reload(); render();
    toast(isNew ? `已新增「${name}」` : "已更新", { ms: 1800 });
    openCategoryList();
  };

  el.querySelector('[data-act="delete"]')?.addEventListener("click", async () => {
    if (used && !confirm(`「${c.name}」還有 ${used} 筆帳目在用。\n刪除後那些帳會變成「未分類」，金額不會消失。\n\n確定刪除？`)) return;
    if (!used && !confirm(`確定刪除「${c.name}」？`)) return;
    await db.remove("categories", c.id);
    el.remove();
    await reload(); render();
    toast("已刪除", { ms: 1800 });
    openCategoryList();
  });
}

// ---------------------------------------------------------------- 分帳編輯

function openSplitEditor(entry) {
  const existing = splitsOf(entry.id);
  const info = fx.currencyInfo(entry.currency);
  const decimals = info.decimals;

  // 目前狀態：有分帳就沿用，沒有就預設「我 + 全部旅伴各一份」
  let payer = entry.paid_by || ME;
  let mode = "shares";
  const parts = new Map();   // person_id -> { on, shares, amount }
  const all = [{ id: ME, name: "我" }, ...state.people.map((p) => ({ id: p.id, name: p.name }))];

  for (const p of all) {
    const s = existing.find((x) => x.person_id === p.id);
    parts.set(p.id, { on: !!s, shares: 1, amount: s ? s.share_amount : 0 });
  }
  if (!existing.length) for (const p of all) parts.get(p.id).on = true;
  if (existing.length) mode = "amounts";

  const el = panel("分帳", `
    <div class="hero">
      <div class="label">這筆總共</div>
      <div class="primary num">${esc(fx.formatAmount(entry.amount, entry.currency))}</div>
      <div class="secondary num" id="sp-status"></div>
    </div>
    <div class="rows">
      <label class="row"><span class="k">誰先付的</span>
        <select class="v sel" id="sp-payer">
          ${all.map((p) => `<option value="${esc(p.id)}"${p.id === payer ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
      </label>
      <label class="row"><span class="k">怎麼分</span>
        <select class="v sel" id="sp-mode">
          <option value="shares"${mode === "shares" ? " selected" : ""}>按份數（預設每人 1 份）</option>
          <option value="amounts"${mode === "amounts" ? " selected" : ""}>各自指定金額</option>
        </select>
      </label>
    </div>
    <div class="section-head"><h2>參與的人</h2></div>
    <div class="rows" id="sp-list"></div>
    ${existing.length ? `<div class="rows"><button class="row danger" data-act="clear"><span class="k">取消這筆的分帳</span></button></div>` : ""}
    <div class="note">
      勾起來的人才算有份。份數可以填不一樣的數字 —— 例如兩個人合吃一份、你自己吃兩份，就填 1 跟 2。<br>
      除不盡的零頭會算到付錢的人身上，讓各份加起來精準等於總額。
    </div>`, { saveLabel: "儲存" });

  const listEl = el.querySelector("#sp-list");
  const statusEl = el.querySelector("#sp-status");

  const activeParts = () => all.filter((p) => parts.get(p.id).on);

  const computed = () => {
    const act = activeParts();
    if (!act.length) return [];
    if (mode === "shares") {
      return splitByShares(entry.amount, act.map((p) => ({ id: p.id, shares: parts.get(p.id).shares })), decimals, payer);
    }
    return act.map((p) => ({ person_id: p.id, amount: parts.get(p.id).amount || 0 }));
  };

  const drawList = () => {
    listEl.innerHTML = all.map((p) => {
      const st = parts.get(p.id);
      return `<label class="row">
        <input class="chk" type="checkbox" data-on="${esc(p.id)}" ${st.on ? "checked" : ""} style="margin-left:0">
        <span class="k" style="flex:1">${esc(p.name)}</span>
        ${st.on ? (mode === "shares"
          ? `<input class="inp" type="number" inputmode="numeric" min="0" step="1" data-shares="${esc(p.id)}"
                    value="${st.shares}" style="width:64px;max-width:64px"> <span class="v" style="margin-left:0">份</span>`
          : `<input class="inp" type="number" inputmode="decimal" data-amount="${esc(p.id)}"
                    value="${st.amount || ""}" placeholder="0" style="width:104px;max-width:104px">`)
          : `<span class="v">未參與</span>`}
      </label>`;
    }).join("");

    const rows = computed();
    const previewEl = document.createElement("div");
    previewEl.className = "note";
    previewEl.innerHTML = rows.length
      ? rows.map((r) => `${esc(personName(r.person_id))}　${esc(fx.formatAmount(r.amount, entry.currency))}`).join("<br>")
      : "還沒有人被勾選。";
    listEl.appendChild(previewEl);

    bindList();
    updateStatus();
  };

  const updateStatus = () => {
    const rows = computed();
    const total = rows.reduce((n, r) => n + r.amount, 0);
    const diff = Math.round((entry.amount - total) * Math.pow(10, decimals)) / Math.pow(10, decimals);

    if (!rows.length) { statusEl.textContent = ""; return; }
    statusEl.innerHTML = Math.abs(diff) < Math.pow(10, -decimals) / 2
      ? `<span style="color:var(--ok)">剛好分完</span>`
      : diff > 0
        ? `<span style="color:var(--danger)">還差 ${fx.formatAmount(diff, entry.currency)} 沒分到</span>`
        : `<span style="color:var(--danger)">超出 ${fx.formatAmount(-diff, entry.currency)}</span>`;
  };

  const bindList = () => {
    for (const cb of listEl.querySelectorAll("[data-on]")) {
      cb.onchange = () => { parts.get(cb.dataset.on).on = cb.checked; drawList(); };
    }
    for (const inp of listEl.querySelectorAll("[data-shares]")) {
      inp.oninput = () => {
        parts.get(inp.dataset.shares).shares = Math.max(0, parseInt(inp.value, 10) || 0);
        updateStatus();
        // 只重畫預覽，不重畫整個列表，否則輸入焦點會跳掉
        const rows = computed();
        listEl.querySelector(".note").innerHTML = rows.map((r) =>
          `${esc(personName(r.person_id))}　${esc(fx.formatAmount(r.amount, entry.currency))}`).join("<br>");
      };
    }
    for (const inp of listEl.querySelectorAll("[data-amount]")) {
      inp.oninput = () => {
        parts.get(inp.dataset.amount).amount = parseFloat(inp.value) || 0;
        updateStatus();
      };
    }
  };

  el.querySelector("#sp-payer").onchange = (ev) => { payer = ev.target.value; drawList(); };
  el.querySelector("#sp-mode").onchange = (ev) => {
    mode = ev.target.value;
    // 從份數切到指定金額時，把目前算出來的金額帶過去當起點
    if (mode === "amounts") for (const r of computed()) parts.get(r.person_id).amount = r.amount;
    drawList();
  };

  drawList();

  el.querySelector('[data-act="save"]').onclick = async () => {
    const rows = computed().filter((r) => r.amount > 0);
    if (!rows.length) { toast("至少要有一個人分攤", { warn: true, ms: 2000 }); return; }

    const total = rows.reduce((n, r) => n + r.amount, 0);
    const diff = Math.abs(entry.amount - total);
    if (diff > Math.pow(10, -decimals) / 2) {
      toast(`各份加起來是 ${fx.formatAmount(total, entry.currency)}，跟總額對不上`, { warn: true, ms: 3000 });
      return;
    }

    // 舊的分攤先軟刪除，再寫新的（人可能被加入或移除）
    for (const s of existing) await db.remove("splits", s.id);
    for (const r of rows) {
      await db.put("splits", {
        entry_id: entry.id,
        person_id: r.person_id,
        share_amount: r.amount,
        share_twd: r.amount * (entry.rate_to_twd || 0),
      });
    }
    if ((entry.paid_by || ME) !== payer) await db.put("entries", { ...entry, paid_by: payer });

    el.remove();
    await reload(); render();
    toast(`已分給 ${rows.length} 個人`, { ms: 2200 });
  };

  el.querySelector('[data-act="clear"]')?.addEventListener("click", async () => {
    for (const s of existing) await db.remove("splits", s.id);
    if ((entry.paid_by || ME) !== ME) await db.put("entries", { ...entry, paid_by: ME });
    el.remove();
    await reload(); render();
    toast("已取消分帳", { ms: 1800 });
  });
}

// ---------------------------------------------------------------- 結算

function openSettlement() {
  const bal = balances();
  const rows = state.people
    .map((p) => ({ p, v: bal.get(p.id) || 0 }))
    .filter((r) => Math.abs(r.v) >= 0.5);

  const owedToMe = rows.filter((r) => r.v > 0).reduce((n, r) => n + r.v, 0);
  const iOwe = rows.filter((r) => r.v < 0).reduce((n, r) => n - r.v, 0);

  const el = panel("分帳結算", `
    ${rows.length ? `
    <div class="statgrid">
      <div class="stat"><div class="k">別人欠我</div><div class="v num" style="color:var(--ok)">${esc(fx.formatTwd(owedToMe))}</div></div>
      <div class="stat"><div class="k">我欠別人</div><div class="v num" style="color:${iOwe ? "var(--danger)" : "var(--text)"}">${esc(fx.formatTwd(iOwe))}</div></div>
    </div>
    <div class="rows">
      ${rows.map(({ p, v }) => `<div class="row limit">
        <div style="display:flex;gap:8px;align-items:baseline">
          <span class="k">${esc(p.name)}</span>
          <span class="v num" style="margin-left:auto;color:${v > 0 ? "var(--ok)" : "var(--danger)"};font-weight:650">
            ${v > 0 ? "欠你 " : "你欠 "}${esc(fx.formatTwd(Math.abs(v)))}
          </span>
        </div>
        <div style="margin-top:10px">
          <button class="chip" data-settle="${esc(p.id)}">標記為已結清</button>
        </div>
      </div>`).join("")}
    </div>
    <div class="rows">
      <button class="row" data-act="copy"><span class="k" style="color:var(--accent);font-weight:600">複製結算明細</span><span class="v">貼給旅伴</span></button>
    </div>
    ` : `<div class="empty"><div class="big">◌</div><p>目前沒有未結清的款項</p></div>`}
    <div class="note">
      「已結清」只是記一筆抵銷，不會刪掉任何帳目 —— 原本的消費紀錄還在，之後想回頭對帳也查得到。<br>
      金額一律換算成台幣，因為一趟旅程裡可能同時有英鎊和歐元的帳。
    </div>`);

  for (const btn of el.querySelectorAll("[data-settle]")) {
    btn.onclick = async () => {
      const p = state.people.find((x) => x.id === btn.dataset.settle);
      const v = bal.get(p.id) || 0;
      const label = v > 0 ? `${p.name} 還你 ${fx.formatTwd(v)}` : `你還 ${p.name} ${fx.formatTwd(-v)}`;
      if (!confirm(`記錄一筆結清：\n${label}\n\n原本的消費紀錄不會被刪除。`)) return;

      await db.put("settlements", {
        person_id: p.id,
        amount_twd: Math.abs(v),
        direction: v > 0 ? "they_paid_me" : "i_paid_them",
        settled_at: new Date().toISOString(),
        note: null,
      });
      el.remove();
      await reload(); render();
      toast("已記錄結清", { ms: 2200 });
      openSettlement();
    };
  }

  el.querySelector('[data-act="copy"]')?.addEventListener("click", async () => {
    const trip = activeTrip();
    const text = [
      `${trip ? trip.name + " " : ""}分帳結算`,
      ...rows.map(({ p, v }) => v > 0
        ? `${p.name} 欠我 ${fx.formatTwd(v)}`
        : `我欠 ${p.name} ${fx.formatTwd(-v)}`),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      toast("已複製，可以貼給旅伴了", { ms: 2200 });
    } catch {
      // 有些瀏覽器在非使用者手勢下會擋剪貼簿，退而求其次直接顯示讓人自己複製
      prompt("複製下面這段：", text);
    }
  });
}

// ---------------------------------------------------------------- 換現

function openExchange() {
  const cashAccounts = state.accounts.filter((a) => a.kind === "cash");
  const today = fx.localDate(new Date());

  const el = panel("換現", `
    <div class="rows">
      <label class="row"><span class="k">給出</span>
        <input class="v inp" type="number" inputmode="decimal" id="x-from-amt" placeholder="金額">
        <select class="v sel" id="x-from-cur" style="max-width:110px">
          ${fx.CURRENCIES.map((c) => `<option value="${c.code}"${c.code === "TWD" ? " selected" : ""}>${c.code}</option>`).join("")}
        </select>
      </label>
      <label class="row"><span class="k">拿到</span>
        <input class="v inp" type="number" inputmode="decimal" id="x-to-amt" placeholder="金額">
        <select class="v sel" id="x-to-cur" style="max-width:110px">
          ${fx.CURRENCIES.map((c) => `<option value="${c.code}"${c.code === state.currency ? " selected" : ""}>${c.code}</option>`).join("")}
        </select>
      </label>
      <label class="row"><span class="k">存入錢包</span>
        <select class="v sel" id="x-acc">
          ${cashAccounts.length
            ? cashAccounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}（${esc(a.currency)}）</option>`).join("")
            : `<option value="">還沒有現金錢包</option>`}
        </select>
      </label>
      <label class="row"><span class="k">日期</span>
        <input class="v inp" type="date" id="x-date" value="${today}">
      </label>
      <label class="row"><span class="k">備註</span>
        <input class="v inp grow" type="text" id="x-note" placeholder="例如 機場換匯、ATM 提領">
      </label>
    </div>
    <div class="hero" id="x-summary" style="border-top:1px solid var(--line)">
      <div class="label">實際匯率</div>
      <div class="primary num" id="x-rate" style="font-size:30px">—</div>
      <div class="secondary" id="x-spread"></div>
    </div>
    <div class="note">
      換現不算消費（錢還是你的，只是換了個幣別），所以不會進「這趟花了多少」。<br>
      但它會增加現金錢包的餘額，而且能讓你看出這次換匯划不划算。
    </div>`, { saveLabel: "儲存" });

  const $ = (id) => el.querySelector(id);
  const update = () => {
    const from = parseFloat($("#x-from-amt").value);
    const to = parseFloat($("#x-to-amt").value);
    const fc = $("#x-from-cur").value, tc = $("#x-to-cur").value;

    if (!(from > 0) || !(to > 0)) { $("#x-rate").textContent = "—"; $("#x-spread").textContent = ""; return; }

    const actual = from / to;                       // 1 單位 to 幣要花多少 from 幣
    $("#x-rate").textContent = `1 ${tc} = ${actual.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${fc}`;

    // 跟市場匯率比。兩邊都換成台幣再比，才不用管是哪兩種幣別。
    const fRate = fx.rateToTwd(fc), tRate = fx.rateToTwd(tc);
    if (!fRate || !tRate) { $("#x-spread").textContent = "（尚無匯率可比較）"; return; }

    const market = tRate / fRate;                   // 市場上 1 單位 to 幣值多少 from 幣
    const diff = (actual - market) / market * 100;  // 正 = 你付得比市場貴
    const worth = from * fRate;                     // 給出去的錢值多少台幣
    const got = to * tRate;                         // 拿到的錢值多少台幣

    $("#x-spread").innerHTML = Math.abs(diff) < 0.05
      ? `跟市場價幾乎一樣`
      : `比市場價<b style="color:${diff > 0 ? "var(--danger)" : "var(--ok)"}">${diff > 0 ? "貴" : "便宜"} ${Math.abs(diff).toFixed(2)}%</b>` +
        `　價差約 ${fx.formatTwd(Math.abs(worth - got))}`;
  };

  for (const id of ["#x-from-amt", "#x-to-amt", "#x-from-cur", "#x-to-cur"]) {
    $(id).addEventListener("input", update);
    $(id).addEventListener("change", update);
  }

  // 選了錢包就把「拿到」的幣別對齊錢包幣別，避免存進去卻算不到餘額
  $("#x-acc").addEventListener("change", () => {
    const acc = accById($("#x-acc").value);
    if (acc) { $("#x-to-cur").value = acc.currency; update(); }
  });

  el.querySelector('[data-act="save"]').onclick = async () => {
    const from = parseFloat($("#x-from-amt").value);
    const to = parseFloat($("#x-to-amt").value);
    if (!(from > 0) || !(to > 0)) { toast("兩邊金額都要填", { warn: true, ms: 1800 }); return; }

    const fc = $("#x-from-cur").value, tc = $("#x-to-cur").value;
    const accId = $("#x-acc").value || null;
    const date = $("#x-date").value || today;
    const note = $("#x-note").value.trim() || null;

    const acc = accById(accId);
    if (acc && acc.currency !== tc) {
      toast(`「${acc.name}」是 ${acc.currency} 錢包，存入 ${tc} 不會算進餘額`, { warn: true, ms: 3500 });
    }

    const entry = await createEntry({
      type: "exchange", amount: from, currency: fc,
      category_id: null, account_id: null, country: state.country,
      spent_date: date, spent_at: date + new Date().toISOString().slice(10),
      note: note || `${fx.formatAmount(from, fc)} → ${fx.formatAmount(to, tc)}`,
    });

    await db.put("exchanges", {
      entry_id: entry.id,
      from_currency: fc, from_amount: from,
      to_currency: tc, to_amount: to,
      to_account_id: accId, fee_twd: null,
    });

    el.remove();
    await reload(); render();
    toast(`已記錄換現 ${fx.formatAmount(to, tc)}`, { ms: 2500 });
  };
}

// ---------------------------------------------------------------- 省下清單

function openSavingsList() {
  // 這裡看的是「全部」而不是當前旅程 —— 省錢是跨旅程累積的成就感來源，
  // 切到別趟旅程就歸零的話這個數字沒什麼意義。
  const rows = state.entries.filter(hasSaving).sort((a, b) => (a.spent_at < b.spent_at ? 1 : -1));
  const total = sum(rows, savedTwd);
  const spent = sum(rows, (e) => e.amount_twd);
  const wouldHave = spent + total;

  const byCat = (() => {
    const m = new Map();
    for (const e of rows) m.set(e.category_id || "", (m.get(e.category_id || "") || 0) + savedTwd(e));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  })();

  const best = rows.reduce((a, b) => (savedTwd(b) > savedTwd(a) ? b : a), rows[0]);

  const line = (e) => {
    const c = catById(e.category_id);
    const saved = e.reference_amount - e.amount;
    const pct = Math.round(saved / e.reference_amount * 100);
    return `<button class="row saveline" data-saving="${esc(e.id)}">
      <span class="ic">${esc(c ? c.icon : "•")}</span>
      <span class="body">
        <span class="k">${e.country ? flagOf(e.country) + " " : ""}${esc(c ? c.name : "未分類")}${e.saving_note ? " · " + esc(e.saving_note) : (e.note ? " · " + esc(e.note) : "")}</span>
        <span class="sub num">${esc(e.spent_date)}　${esc(fx.formatAmount(e.reference_amount, e.currency))} → ${esc(fx.formatAmount(e.amount, e.currency))}</span>
      </span>
      <span class="amt">
        <span class="a num" style="color:var(--ok)">省 ${esc(fx.formatAmount(saved, e.currency))}</span>
        <span class="sub num">${esc(fx.formatTwd(savedTwd(e)))}　−${pct}%</span>
      </span>
    </button>`;
  };

  const el = panel("省下", rows.length ? `
    <div class="hero">
      <div class="label">累計省下</div>
      <div class="primary num" style="color:var(--ok)">${esc(fx.formatTwd(total))}</div>
      <div class="secondary num">${rows.length} 筆　·　平均每筆省 ${esc(fx.formatTwd(total / rows.length))}</div>
    </div>

    <div class="statgrid">
      <div class="stat"><div class="k">這些東西實付</div><div class="v num">${esc(fx.formatTwd(spent))}</div></div>
      <div class="stat"><div class="k">本來可能花</div><div class="v num">${esc(fx.formatTwd(wouldHave))}</div><div class="sub">少付 ${Math.round(total / wouldHave * 100)}%</div></div>
    </div>

    ${byCat.length > 1 ? `
    <div class="section-head"><h2>哪個分類省最多</h2></div>
    <div class="rows">
      ${byCat.map(([id, twd]) => {
        const c = catById(id);
        return `<div class="row limit">
          <div style="display:flex;gap:8px">
            <span class="k">${esc(c ? c.icon + " " + c.name : "未分類")}</span>
            <span class="v num" style="margin-left:auto;color:var(--ok)">${esc(fx.formatTwd(twd))}</span>
          </div>
          ${bar(twd, total)}
        </div>`;
      }).join("")}
    </div>` : ""}

    <div class="section-head"><h2>明細</h2>
      <button class="more" data-act="saving-csv">匯出 CSV</button>
    </div>
    <div class="rows">${rows.map(line).join("")}</div>

    <div class="note">
      單筆省最多的是 ${esc(best.spent_date)} 那筆，省了 ${esc(fx.formatTwd(savedTwd(best)))}。<br><br>
      <b>這個數字沒有從支出裡扣掉。</b>折扣價買下的東西還是花了錢 ——
      把「省下」拿去抵銷花費，只會讓帳看起來比實際好看。要看真正花了多少請回統計頁。
    </div>`
  : `
    <div class="empty"><div class="big">◌</div>
      <p>還沒有省下紀錄<br>記帳時按「原價」，或在編輯頁填「本來要花」</p>
    </div>
    <div class="note">
      買到折扣、或選了比較便宜的替代方案（走路不搭車、自己煮不外食）時填上原本要花的錢，
      這裡就會累積起來。
    </div>`);

  for (const b of el.querySelectorAll("[data-saving]")) {
    b.onclick = () => {
      const entry = state.entries.find((x) => x.id === b.dataset.saving);
      if (entry) { el.remove(); openDetail(null, entry); }
    };
  }

  el.querySelector('[data-act="saving-csv"]')?.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    try {
      const r = await xport.exportSavingsCsv();
      toast(`已匯出 ${r.count} 筆，累計省下 ${fx.formatTwd(r.total)}`, { ms: 3200 });
    } catch (err) {
      toast(err.message || "匯出失敗", { warn: true, ms: 3000 });
    }
  });
}

// ---------------------------------------------------------------- 退稅清單

function openTaxList() {
  const rows = state.entries.filter((e) => e.tax_refund);
  const pending = rows.filter((e) => e.tax_refund_status !== "claimed");
  const claimed = rows.filter((e) => e.tax_refund_status === "claimed");

  const line = (e) => {
    const c = catById(e.category_id);
    return `<button class="row" data-tax="${esc(e.id)}">
      <span class="k">${e.country ? flagOf(e.country) + " " : ""}${esc(c ? c.name : "未分類")}
        <br><span style="font-size:12px;color:var(--faint)">${esc(e.spent_date)}${e.note ? " · " + esc(e.note) : ""}</span></span>
      <span class="v num">${esc(fx.formatAmount(e.amount, e.currency))}
        <br><span style="font-size:12px;color:var(--faint)">${esc(fx.formatTwd(e.amount_twd))}</span></span>
    </button>`;
  };

  const el = panel("可退稅清單", `
    <div class="statgrid">
      <div class="stat"><div class="k">待辦理</div><div class="v num">${esc(fx.formatTwd(sum(pending, (r) => r.amount_twd)))}</div><div class="sub">${pending.length} 筆</div></div>
      <div class="stat"><div class="k">已申請</div><div class="v num">${esc(fx.formatTwd(sum(claimed, (r) => r.amount_twd)))}</div><div class="sub">${claimed.length} 筆</div></div>
    </div>
    ${pending.length ? `<div class="section-head"><h2>待辦理</h2></div><div class="rows">${pending.map(line).join("")}</div>` : ""}
    ${claimed.length ? `<div class="section-head"><h2>已申請</h2></div><div class="rows" style="opacity:.55">${claimed.map(line).join("")}</div>` : ""}
    ${rows.length ? "" : `<div class="empty"><div class="big">◌</div><p>還沒有標記可退稅的消費<br>在帳目編輯頁把「可退稅」打勾</p></div>`}
    <div class="note">
      點一筆可以切換「已申請」。金額是消費總額，不是實際退回的稅金 ——
      歐盟各國退稅比例與手續費差很多，這裡只幫你把該辦的單子列出來，離境前不會漏掉。
    </div>`);

  for (const row of el.querySelectorAll("[data-tax]")) {
    row.onclick = async () => {
      const e = state.entries.find((x) => x.id === row.dataset.tax);
      if (!e) return;
      await db.put("entries", { ...e, tax_refund_status: e.tax_refund_status === "claimed" ? "marked" : "claimed" });
      el.remove();
      await reload(); render();
      openTaxList();
    };
  }
}

// ---------------------------------------------------------------- 匯出與備份

function openExport() {
  const el = panel("匯出與備份", `
    <div class="section-head"><h2>拿去分析</h2></div>
    <div class="rows">
      <button class="row" data-act="csv"><span class="k">CSV</span><span class="v">單一表格，Excel 直接開 →</span></button>
      <button class="row" data-act="xlsx"><span class="k">Excel（XLSX）</span><span class="v">六個工作表 →</span></button>
      <button class="row" data-act="savings-csv"><span class="k">省下明細 CSV</span><span class="v">只列有省到的 →</span></button>
    </div>

    <div class="section-head"><h2>備份</h2></div>
    <div class="rows">
      <button class="row" data-act="json"><span class="k">下載完整備份</span><span class="v">JSON →</span></button>
      <button class="row" data-act="restore"><span class="k">從備份還原</span><span class="v">選檔案 →</span></button>
    </div>
    <input type="file" id="x-file" accept="application/json,.json" hidden>

    <div class="note">
      <b>CSV 與 Excel 是給你看與分析用的，不能當備份。</b>它們會遺失 id 與同步用的欄位，
      還原不回來。真的要保命請下載 JSON —— 那份才能把整本帳原樣還原。<br><br>
      Excel 檔含帳目、分帳、換現、每日彙總、匯率五個工作表，已凍結標題列並套好千分位格式。<br>
      全部在這台裝置上產生，離線也能匯出。
    </div>`);

  const run = async (fn, ok) => {
    try {
      const result = await fn();
      toast(ok(result), { ms: 3200 });
    } catch (err) {
      toast(err.message || "匯出失敗", { warn: true, ms: 3200 });
    }
  };

  el.querySelector('[data-act="csv"]').onclick = () =>
    run(xport.exportCsv, (n) => `已匯出 ${n} 筆到 CSV`);

  el.querySelector('[data-act="xlsx"]').onclick = () =>
    run(xport.exportXlsx, (sheets) => `已匯出 Excel：${sheets.join("、")}`);

  el.querySelector('[data-act="savings-csv"]').onclick = () =>
    run(xport.exportSavingsCsv, (r) => `已匯出 ${r.count} 筆，累計省下 ${fx.formatTwd(r.total)}`);

  el.querySelector('[data-act="json"]').onclick = () =>
    run(xport.exportJson, (n) => `已備份 ${n} 列資料`);

  const fileInput = el.querySelector("#x-file");
  el.querySelector('[data-act="restore"]').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!confirm(`從「${file.name}」還原？\n\n比備份檔更新的本機資料會被保留，不會被蓋掉。`)) return;
    try {
      const r = await xport.importJson(file);
      el.remove();
      await reload(); render();
      toast(`還原完成：新增 ${r.added}、更新 ${r.updated}、略過 ${r.skipped}`, { ms: 4000 });
    } catch (err) {
      toast(err.message || "還原失敗", { warn: true, ms: 4000 });
    }
  };
}

// ---------------------------------------------------------------- 行事曆
//
// 首頁可以切成月曆檢視：有記錄的日子點一個點，點某一天就只看那天，
// 而且接下來記的帳會落在那一天 —— 補記前幾天忘了記的帳用這個最快。

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function monthLabel(ym) {
  return `${ym.slice(0, 4)}年${+ym.slice(5, 7)}月`;
}

function shiftMonth(ym, delta) {
  const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// 記帳要落在哪一天：月曆上選了哪天就是哪天，沒選就是今天
function targetDate() {
  return state.selectedDate || fx.localDate(new Date());
}

function renderCalendar() {
  const ym = state.calMonth;
  const today = fx.localDate(new Date());
  const [y, m] = [+ym.slice(0, 4), +ym.slice(5, 7)];

  // 每天的支出合計，用來決定要不要點那個點
  const byDate = new Map();
  for (const e of scopedEntries()) {
    if (!isExpense(e)) continue;
    byDate.set(e.spent_date, (byDate.get(e.spent_date) || 0) + e.amount_twd);
  }

  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - first.getDay());   // 從該週的週日開始鋪
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = fx.localDate(d);
    const inMonth = d.getMonth() === m - 1;
    cells.push({ key, day: d.getDate(), inMonth, total: byDate.get(key) || 0 });
  }
  // 整列都不屬於本月就不畫，免得月底多出一整排空白
  while (cells.length > 35 && cells.slice(35).every((c) => !c.inMonth)) cells.length = 35;

  const monthTotal = cells.filter((c) => c.inMonth).reduce((n, c) => n + c.total, 0);

  return `
  <div class="calbar">
    <button class="calnav" data-cal="prev" aria-label="上個月">‹</button>
    <span class="calmonth num">${esc(monthLabel(ym))}</span>
    <button class="calnav" data-cal="next" aria-label="下個月">›</button>
    <span class="caltotal num">${esc(fx.formatTwd(monthTotal))}</span>
  </div>
  <div class="calgrid" role="grid">
    ${WEEKDAYS.map((w) => `<span class="calwd">${w}</span>`).join("")}
    ${cells.map((c) => `
      <button class="calday${c.inMonth ? "" : " out"}${c.key === today ? " today" : ""}${c.key === state.selectedDate ? " sel" : ""}"
              data-date="${esc(c.key)}" ${c.inMonth ? "" : "tabindex=-1"}>
        <span class="n num">${c.day}</span>
        ${c.total ? `<span class="dot"></span>` : ""}
      </button>`).join("")}
  </div>`;
}

// 選中那天的帳目
function renderSelectedDay() {
  const date = targetDate();
  const rows = scopedEntries().filter((e) => e.spent_date === date);
  const total = sum(rows.filter(isExpense), (r) => r.amount_twd);

  return `
    <div class="section-head">
      <h2>${esc(fx.formatDateLabel(date))}</h2>
      <span class="more num" style="color:var(--muted)">${rows.length ? esc(fx.formatTwd(total)) : ""}</span>
    </div>
    ${rows.length
      ? `<section class="daygroup">${rows.map(entryRow).join("")}</section>`
      : `<div class="empty" style="padding:34px 24px"><p>這天沒有記錄<br>按下方的橘色按鈕記在這一天</p></div>`}`;
}

// ---------------------------------------------------------------- 畫面元件

function syncBadge() {
  const s = db.syncStatus.state;
  const label = {
    idle: "", syncing: "同步中", ok: "已同步",
    offline: "離線", error: "待同步", unauthed: "請重新登入",
  }[s] || "";
  return `<span class="sync-dot" data-state="${s}"></span><span class="sync-label">${label}</span>`;
}

function topbar(title, { tripSwitcher = false, accounts = false } = {}) {
  const t = activeTrip();
  const heading = tripSwitcher
    ? `<button class="trip-btn" data-act="trips">
         <span class="nm">${esc(t ? t.name : "全部帳目")}</span><span class="caret">▾</span>
       </button>`
    : `<h1>${esc(title)}</h1>`;
  return `<div class="topbar"><div class="topbar-inner">
    ${heading}<div class="spacer"></div>
    ${accounts ? `<button class="icon-btn" data-act="accounts" aria-label="帳戶與現金餘額">💳</button>` : ""}
    ${syncBadge()}
  </div></div>`;
}

function tabbar() {
  const tab = (route, ic, name) =>
    `<button class="tab" data-route="${route}"${state.route === route ? ' aria-current="page"' : ""}>
       <span class="ic">${ic}</span><span>${name}</span></button>`;
  return `<nav class="tabbar"><div class="tabbar-inner">
    ${tab("home", "◧", "首頁")}
    ${tab("stats", "◔", "統計")}
    <div class="fab-slot"><button class="fab" data-act="add" aria-label="記一筆">＋</button></div>
    ${tab("list", "☰", "明細")}
    ${tab("settings", "⚙", "設定")}
  </div></nav>`;
}

function entryRow(e) {
  if (e.type === "exchange") {
    const x = state.exchanges.find((r) => r.entry_id === e.id);
    return `<button class="entry exchange" data-entry="${esc(e.id)}">
      <span class="icon">⇄</span>
      <span class="body">
        <span class="name">換現</span>
        <span class="meta">${esc(e.note || "")}</span>
      </span>
      <span class="amt">
        <span class="a num">${x ? esc(fx.formatAmount(x.to_amount, x.to_currency)) : ""}</span>
        <span class="twd num">${x ? esc(fx.formatAmount(x.from_amount, x.from_currency)) : ""}</span>
      </span>
    </button>`;
  }

  const cat = catById(e.category_id);
  const acc = accById(e.account_id);
  const splitRows = splitsOf(e.id);
  const meta = [
    e.note,
    acc && acc.name,
    splitRows.length ? ((e.paid_by || ME) === ME ? `分 ${splitRows.length} 人` : `${personName(e.paid_by)} 墊的`) : null,
    hasSaving(e) ? `省 ${fx.formatAmount(e.reference_amount - e.amount, e.currency)}` : null,
    e.is_prepaid ? "行前" : null,
    e.tax_refund ? "可退稅" : null,
    e.currency !== "TWD" && !e.rate_to_twd ? "待補匯率" : null,
  ].filter(Boolean).join(" · ");

  return `<button class="entry${e.type === "income" ? " income" : ""}" data-entry="${esc(e.id)}">
    <span class="icon">${esc(cat ? cat.icon : "•")}</span>
    <span class="body">
      <span class="name">${e.country ? flagOf(e.country) + " " : ""}${esc(cat ? cat.name : "未分類")}</span>
      ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
    </span>
    <span class="amt">
      <span class="a num">${esc(fx.formatAmount(e.amount, e.currency))}</span>
      ${e.currency !== "TWD" ? `<span class="twd num">${e.rate_to_twd ? esc(fx.formatTwd(e.amount_twd)) : "—"}</span>` : ""}
    </span>
  </button>`;
}

function dayGroupsHtml(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.spent_date)) map.set(e.spent_date, []);
    map.get(e.spent_date).push(e);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, rows]) => {
    const total = sum(rows.filter(isExpense), (r) => r.amount_twd);
    return `<section class="daygroup">
      <div class="dayhead">
        <span class="d">${esc(fx.formatDateLabel(date))}</span>
        <span class="t num">${esc(fx.formatTwd(total))}</span>
      </div>
      ${rows.map(entryRow).join("")}
    </section>`;
  }).join("");
}

function emptyState(text) {
  return `<div class="empty"><div class="big">◌</div><p>${text}</p></div>`;
}

function bar(used, limit, { danger = false } = {}) {
  const pct = limit > 0 ? Math.min(used / limit * 100, 100) : 0;
  const over = limit > 0 && used > limit;
  return `<div class="bar"><span class="fill${over || danger ? " over" : ""}" style="width:${pct.toFixed(1)}%"></span></div>`;
}

// ---------------------------------------------------------------- 頁面

function renderHome() {
  const trip = activeTrip();
  const rows = scopedEntries();
  const expenses = rows.filter(isExpense);
  const onTrip = expenses.filter((e) => !e.is_prepaid);
  const prepaid = expenses.filter((e) => e.is_prepaid);

  const today = fx.localDate(new Date());
  const todayRows = onTrip.filter((e) => e.spent_date === today);
  const todayTwd = sum(todayRows, (r) => r.amount_twd);

  const localCur = trip ? trip.local_currency : state.currency;
  const todayLocal = sum(todayRows.filter((r) => r.currency === localCur), (r) => r.amount);

  const onTripTwd = sum(onTrip, (r) => r.amount_twd);
  // 省下算整個範圍（含行前）：早鳥機票這種省錢多半是行前付的
  const savedRows = expenses.filter(hasSaving);
  const savedTotal = sum(savedRows, savedTwd);
  const prepaidTwd = sum(prepaid, (r) => r.amount_twd);
  const activeDays = new Set(onTrip.map((e) => e.spent_date)).size || 1;

  const budget = trip?.daily_budget || null;

  // 首頁刻意只留三塊：今日支出、統計數字、最近。
  // 現金餘額與卡片額度是「帳戶自己的屬性」，放在帳戶頁（頂欄 💳 進入）；
  // 各國花費跟分類佔比同性質，放在統計頁。
  return topbar(null, { tripSwitcher: true, accounts: true }) + `
    <div class="screen">
      <div class="hero">
        <div class="label">今日支出${budget ? `　·　預算 ${fx.formatTwd(budget)}` : ""}</div>
        <div class="primary num">${esc(localCur === "TWD" ? fx.formatTwd(todayTwd) : fx.formatAmount(todayLocal, localCur))}</div>
        <div class="secondary num">${esc(localCur === "TWD" ? "" : "約 " + fx.formatTwd(todayTwd))}</div>
        ${budget ? bar(todayTwd, budget) + `<div class="barlabel">${
          todayTwd > budget
            ? `<span style="color:var(--danger)">超出 ${fx.formatTwd(todayTwd - budget)}</span>`
            : `還剩 ${fx.formatTwd(budget - todayTwd)}`
        }</div>` : ""}
      </div>

      <div class="statgrid three">
        <div class="stat"><div class="k">在地花費</div><div class="v num">${esc(fx.formatTwd(onTripTwd))}</div><div class="sub">${onTrip.length} 筆 · ${activeDays} 天</div></div>
        <div class="stat"><div class="k">每日平均</div><div class="v num">${esc(fx.formatTwd(onTripTwd / activeDays))}</div><div class="sub">有記帳的天</div></div>
        <div class="stat saved"><div class="k">省下</div><div class="v num">${esc(fx.formatTwd(savedTotal))}</div><div class="sub">${savedRows.length} 筆</div></div>
        ${prepaid.length ? `
        <div class="stat"><div class="k">行前已付</div><div class="v num">${esc(fx.formatTwd(prepaidTwd))}</div><div class="sub">${prepaid.length} 筆</div></div>
        <div class="stat wide"><div class="k">合計</div><div class="v num">${esc(fx.formatTwd(onTripTwd + prepaidTwd))}</div><div class="sub">含行前</div></div>` : ""}
      </div>

      <div class="section-head">
        <div class="segmented">
          <button class="seg${state.homeView === "calendar" ? " on" : ""}" data-view="calendar">行事曆</button>
          <button class="seg${state.homeView === "list" ? " on" : ""}" data-view="list">清單</button>
        </div>
        ${state.homeView === "list" && rows.length > 10 ? `<button class="more" data-route="list">全部</button>` : ""}
      </div>

      ${state.homeView === "calendar"
        ? renderCalendar() + renderSelectedDay()
        : (rows.length
            ? dayGroupsHtml(rows.slice(0, 10))
            : emptyState("這趟還沒有紀錄<br>按下方的橘色按鈕記第一筆"))}
    </div>` + tabbar();
}

function renderList() {
  return topbar("明細") + `
    <div class="screen">
      ${state.entries.length ? dayGroupsHtml(state.entries) : emptyState("還沒有任何紀錄")}
    </div>` + tabbar();
}

// 統計要看哪個範圍。
// 「本趟」是旅行 App 的主軸；「月／年」則跨旅程看，因為想知道
// 「這個月總共花多少」的時候，通常不在乎它屬於哪一趟。
function statsScope() {
  const all = state.entries.filter(isExpense);
  if (state.statsPeriod === "month") {
    return { rows: all.filter((e) => e.spent_date.slice(0, 7) === state.statsMonth),
             prev: all.filter((e) => e.spent_date.slice(0, 7) === shiftMonth(state.statsMonth, -1)),
             label: monthLabel(state.statsMonth), prevLabel: "上個月" };
  }
  if (state.statsPeriod === "year") {
    const y = state.statsYear;
    return { rows: all.filter((e) => e.spent_date.slice(0, 4) === y),
             prev: all.filter((e) => e.spent_date.slice(0, 4) === String(+y - 1)),
             label: y + "年", prevLabel: "去年" };
  }
  return { rows: scopedEntries().filter(isExpense), prev: null,
           label: activeTrip() ? activeTrip().name : "全部帳目", prevLabel: null };
}

function statsPeriodBar() {
  const seg = (v, t) => `<button class="seg${state.statsPeriod === v ? " on" : ""}" data-period="${v}">${t}</button>`;
  const nav = state.statsPeriod === "trip" ? "" : `
    <button class="calnav" data-stats="prev" aria-label="上一個">‹</button>
    <button class="calnav" data-stats="next" aria-label="下一個">›</button>`;
  return `<div class="calbar" style="padding-top:12px">
    <div class="segmented">${seg("trip", "本趟")}${seg("month", "月")}${seg("year", "年")}</div>
    <span style="margin-left:auto;display:flex;align-items:center">${nav}</span>
  </div>`;
}

function renderStats() {
  const scope = statsScope();
  const rows = scope.rows;
  const total = sum(rows, (r) => r.amount_twd);
  const prevTotal = scope.prev ? sum(scope.prev, (r) => r.amount_twd) : null;

  const byCat = new Map();
  for (const e of rows) {
    const k = e.category_id || "";
    byCat.set(k, (byCat.get(k) || 0) + (e.amount_twd || 0));
  }
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);

  // 各國花費跟分類佔比同性質（都在回答「錢花到哪了」），所以擺在一起而不是首頁
  const onTrip = rows.filter((e) => !e.is_prepaid);
  const byCountry = countryTotals(onTrip).slice(0, 8);
  const onTripTwd = sum(onTrip, (r) => r.amount_twd);

  // 每日花費：從第一筆到最後一筆之間的每一天都要有，中間沒花錢的日子留 0，
  // 不然「這幾天沒花錢」會被壓縮掉，趨勢就看不出來了
  const days = (() => {
    const byDate = new Map();
    for (const e of onTrip) byDate.set(e.spent_date, (byDate.get(e.spent_date) || 0) + e.amount_twd);
    const keys = [...byDate.keys()].sort();
    if (!keys.length) return [];

    const out = [];
    const cursor = new Date(keys[0] + "T12:00:00");
    const last = new Date(keys[keys.length - 1] + "T12:00:00");
    while (cursor <= last && out.length < 120) {
      const key = fx.localDate(cursor);
      out.push({ date: key, twd: byDate.get(key) || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  })();

  const byCurrency = (() => {
    const m = new Map();
    for (const e of onTrip) m.set(e.currency, (m.get(e.currency) || 0) + e.amount_twd);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  })();

  const budget = state.statsPeriod === "trip" ? (activeTrip()?.daily_budget || null) : null;
  const taxRows = rows.filter((e) => e.tax_refund);

  const savedRows = rows.filter(hasSaving);
  const savedTotal = sum(savedRows, savedTwd);

  return topbar("統計") + `
    <div class="screen">
      ${statsPeriodBar()}
      ${rows.length ? `
      <div class="hero">
        <div class="label">${esc(scope.label)}　總支出</div>
        <div class="primary num">${esc(fx.formatTwd(total))}</div>
        <div class="secondary num">${rows.length} 筆${(() => {
          const dayCount = new Set(rows.map((e) => e.spent_date)).size;
          return dayCount ? `　·　每天平均 ${fx.formatTwd(total / dayCount)}` : "";
        })()}</div>
        ${prevTotal !== null && (prevTotal || total) ? `<div class="secondary num" style="margin-top:6px">${(() => {
          if (!prevTotal) return `${esc(scope.prevLabel)}沒有紀錄`;
          const diff = total - prevTotal;
          const pct = Math.round(Math.abs(diff) / prevTotal * 100);
          const color = diff > 0 ? "var(--danger)" : "var(--ok)";
          return `${esc(scope.prevLabel)} ${fx.formatTwd(prevTotal)}　<b style="color:${color}">${diff >= 0 ? "多" : "少"} ${fx.formatTwd(Math.abs(diff))}（${pct}%）</b>`;
        })()}</div>` : ""}
        ${savedRows.length ? `<button class="secondary num savedline" data-act="savings">
          省下 <b>${esc(fx.formatTwd(savedTotal))}</b>　·　少付了 ${Math.round(savedTotal / (total + savedTotal) * 100)}% →</button>` : ""}
      </div>
      ${days.length > 1 ? `
      <div class="section-head"><h2>每日花費</h2><button class="more" data-act="toggle-table">看數字</button></div>
      ${dailyChart(days, budget)}
      ${dailyTable(days)}` : ""}

      <div class="section-head"><h2>分類佔比</h2></div>
      <div class="rows">
        ${cats.map(([id, twd]) => {
          const c = catById(id);
          return `<div class="row limit">
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:8px">
                <span class="k">${esc(c ? c.icon + " " + c.name : "未分類")}</span>
                <span class="v num" style="margin-left:auto">${esc(fx.formatTwd(twd))}　${Math.round(twd / total * 100)}%</span>
              </div>
              ${bar(twd, total)}
            </div>
          </div>`;
        }).join("")}
      </div>
      ${byCountry.length > 1 ? `
      <div class="section-head"><h2>各國花費</h2></div>
      <div class="rows">
        ${byCountry.map(([code, twd]) => `<div class="row limit">
          <div style="display:flex;gap:8px">
            <span class="k">${code ? flagOf(code) + " " + esc(nameOf(code)) : "未指定"}</span>
            <span class="v num" style="margin-left:auto">${esc(fx.formatTwd(twd))}　${Math.round(twd / onTripTwd * 100)}%</span>
          </div>
          ${bar(twd, onTripTwd)}
        </div>`).join("")}
      </div>` : ""}

      ${byCurrency.length > 1 ? `
      <div class="section-head"><h2>幣別分佈</h2></div>
      <div class="rows">
        ${byCurrency.map(([code, twd]) => `<div class="row limit">
          <div style="display:flex;gap:8px">
            <span class="k num">${esc(code)}　${esc(fx.currencyInfo(code).name)}</span>
            <span class="v num" style="margin-left:auto">${esc(fx.formatTwd(twd))}　${Math.round(twd / onTripTwd * 100)}%</span>
          </div>
          ${bar(twd, onTripTwd)}
        </div>`).join("")}
      </div>` : ""}

      ${taxRows.length ? `
      <div class="section-head"><h2>可退稅</h2><button class="more" data-act="tax">明細 →</button></div>
      <div class="rows">
        <div class="row"><span class="k">${taxRows.length} 筆已標記</span>
          <span class="v num" style="font-weight:650">${esc(fx.formatTwd(sum(taxRows, (r) => r.amount_twd)))}</span></div>
      </div>` : ""}

      ${savedRows.length ? `<div class="note">
        「省下」<b>沒有</b>從支出裡扣掉，兩邊是分開的 —— 折扣價買下的東西還是花了錢，
        把「省下」拿去抵銷花費只會讓帳看起來比實際好看。
      </div>` : ""}
      <div class="note">
        分類與各國用排序長條而不是圓餅圖：超過六塊之後，相鄰扇形的角度差人眼分辨不出來，
        排序長條同時把數字寫在旁邊，兼具表格的功能。
      </div>
      ` : emptyState(`${esc(scope.label)}沒有資料<br>換個期間或先記幾筆`)}
    </div>` + tabbar();
}

function renderSettings() {
  const d = fx.ratesDate();
  const pendingText = db.syncStatus.pending ? `${db.syncStatus.pending} 筆待同步` : "全部已同步";
  const trip = activeTrip();

  return topbar("設定") + `
    <div class="screen">
      <div class="section-head"><h2>旅程與帳戶</h2></div>
      <div class="rows">
        <button class="row" data-act="trips"><span class="k">旅程</span><span class="v">${esc(trip ? trip.name : "全部帳目")} →</span></button>
        <button class="row" data-act="accounts"><span class="k">帳戶</span><span class="v">現金餘額與卡片額度 →</span></button>
        <button class="row" data-act="categories"><span class="k">分類</span><span class="v">${state.categories.length} 個 →</span></button>
        <button class="row" data-act="people"><span class="k">旅伴</span><span class="v">${state.people.length ? `${state.people.length} 人` : "尚未新增"} →</span></button>
        <button class="row" data-act="settle"><span class="k">分帳結算</span><span class="v">${(() => {
          const bal = balances();
          const n = state.people.filter((p) => Math.abs(bal.get(p.id) || 0) >= 0.5).length;
          return n ? `${n} 人未結清` : "都結清了";
        })()} →</span></button>
        <button class="row" data-act="exchange"><span class="k">記一筆換現</span><span class="v">→</span></button>
      </div>

      <div class="section-head"><h2>同步</h2></div>
      <div class="rows">
        <div class="row"><span class="k">狀態</span><span class="v">${esc(pendingText)}</span></div>
        <div class="row"><span class="k">上次同步</span><span class="v num">${esc(db.syncStatus.lastSyncAt ? new Date(db.syncStatus.lastSyncAt).toLocaleString("zh-TW", { hour12: false }) : "尚未")}</span></div>
        <button class="row" data-act="sync"><span class="k">立即同步</span><span class="v">→</span></button>
      </div>

      <div class="section-head"><h2>匯率</h2></div>
      <div class="rows">
        <div class="row"><span class="k">資料日期</span><span class="v num">${esc(d || "尚未取得")}${fx.isStale() && d ? "（過舊）" : ""}</span></div>
        <div class="row"><span class="k">預設幣別</span><button class="v" data-act="default-currency">${esc(state.currency)} ▾</button></div>
        <div class="row"><span class="k">目前國家</span><button class="v" data-act="default-country">${flagOf(state.country)} ${esc(nameOf(state.country))} ▾</button></div>
        <button class="row" data-act="refresh-fx"><span class="k">重新抓匯率</span><span class="v">→</span></button>
      </div>

      <div class="section-head"><h2>操作</h2></div>
      <div class="rows">
        <label class="row"><span class="k">開啟時直接跳記帳鍵盤</span>
          <input class="v chk" type="checkbox" id="s-keypad" ${state.startOnKeypad ? "checked" : ""}>
        </label>
      </div>

      <div class="section-head"><h2>匯出與備份</h2></div>
      <div class="rows">
        <button class="row" data-act="savings"><span class="k">省下</span><span class="v">${(() => {
          const r = state.entries.filter(hasSaving);
          return r.length ? fx.formatTwd(sum(r, savedTwd)) : "尚無紀錄";
        })()} →</span></button>
      </div>

      <div class="section-head"><h2>匯出與備份</h2></div>
      <div class="rows">
        <button class="row" data-act="export"><span class="k">匯出與備份</span><span class="v">CSV · Excel · JSON →</span></button>
      </div>

      <div class="section-head"><h2>帳號</h2></div>
      <div class="rows">
        <button class="row danger" data-act="logout"><span class="k">登出</span><span class="v">→</span></button>
      </div>

      <div class="note">
        資料存在這台裝置上，連上網路時會自動同步到雲端。離線時照常可以記帳，恢復連線後自動補送。<br>
        分帳、統計圖表與匯出會在後續階段加上。
      </div>
    </div>` + tabbar();
}

function render() {
  if (!state.ready) return;

  const scroller = document.scrollingElement;
  const y = scroller ? scroller.scrollTop : 0;

  app.innerHTML =
    state.route === "list" ? renderList()
    : state.route === "stats" ? renderStats()
    : state.route === "settings" ? renderSettings()
    : renderHome();

  bindScreen();
  if (scroller) scroller.scrollTop = y;
}

function bindScreen() {
  for (const el of app.querySelectorAll("[data-route]")) {
    el.onclick = () => { state.route = el.dataset.route; window.scrollTo(0, 0); render(); };
  }

  const on = (sel, fn) => app.querySelector(sel)?.addEventListener("click", fn);

  on('[data-act="add"]', () => { buzz(); openKeypad(); });
  on('[data-act="trips"]', () => { buzz(); openTripPicker(); });
  on('[data-act="accounts"]', () => openAccountList());
  on('[data-act="categories"]', () => openCategoryList());
  on('[data-act="people"]', () => openPeopleList());
  on('[data-act="settle"]', () => openSettlement());
  on('[data-act="exchange"]', () => openExchange());
  on('[data-act="tax"]', () => openTaxList());
  on('[data-act="savings"]', () => openSavingsList());
  on('[data-act="export"]', () => openExport());

  for (const el of app.querySelectorAll("[data-view]")) {
    el.onclick = async () => {
      state.homeView = el.dataset.view;
      if (state.homeView !== "calendar") state.selectedDate = null;
      await db.setMeta("home_view", state.homeView);
      render();
    };
  }
  for (const el of app.querySelectorAll("[data-period]")) {
    el.onclick = async () => {
      state.statsPeriod = el.dataset.period;
      await db.setMeta("stats_period", state.statsPeriod);
      render();
    };
  }
  for (const el of app.querySelectorAll("[data-stats]")) {
    el.onclick = () => {
      const d = el.dataset.stats === "prev" ? -1 : 1;
      if (state.statsPeriod === "month") state.statsMonth = shiftMonth(state.statsMonth, d);
      if (state.statsPeriod === "year") state.statsYear = String(+state.statsYear + d);
      render();
    };
  }
  for (const el of app.querySelectorAll("[data-cal]")) {
    el.onclick = () => {
      if (el.dataset.cal === "prev") state.calMonth = shiftMonth(state.calMonth, -1);
      if (el.dataset.cal === "next") state.calMonth = shiftMonth(state.calMonth, 1);
      render();
    };
  }
  for (const el of app.querySelectorAll("[data-date]")) {
    el.onclick = () => {
      buzz();
      const d = el.dataset.date;
      // 點到上／下個月的日子就順便跳過去，不然選了看不到
      if (d.slice(0, 7) !== state.calMonth) state.calMonth = d.slice(0, 7);
      state.selectedDate = state.selectedDate === d ? null : d;
      render();
    };
  }

  app.querySelector("#s-keypad")?.addEventListener("change", async (ev) => {
    state.startOnKeypad = ev.target.checked;
    await db.setMeta("start_on_keypad", state.startOnKeypad);
    toast(state.startOnKeypad ? "下次開啟會直接跳鍵盤" : "下次開啟會停在首頁", { ms: 2000 });
  });

  bindChart(app);
  on('[data-act="toggle-table"]', (ev) => {
    const table = app.querySelector(".chart-table");
    const chart = app.querySelector(".chart");
    if (!table) return;
    const showTable = table.hidden;
    table.hidden = !showTable;
    chart.hidden = showTable;
    ev.currentTarget.textContent = showTable ? "看圖表" : "看數字";
  });

  for (const el of app.querySelectorAll("[data-entry]")) {
    el.onclick = () => {
      const entry = state.entries.find((x) => x.id === el.dataset.entry);
      if (entry) openDetail(null, entry);
    };
  }

  on('[data-act="sync"]', async () => {
    toast("同步中…", { ms: 1200 });
    await db.sync();
    await reload(); render();
  });

  on('[data-act="refresh-fx"]', async () => {
    await fx.refreshRates();
    await backfillRates();
    render();
    toast(fx.ratesDate() ? `匯率已更新（${fx.ratesDate()}）` : "抓不到匯率，稍後再試", { ms: 2200 });
  });

  on('[data-act="default-currency"]', () => {
    openCurrencyPicker(async (code) => {
      state.currency = code;
      await db.setMeta("last_currency", code);
      render();
    }, state.currency);
  });

  on('[data-act="default-country"]', () => {
    openCountryPicker(async (code) => {
      state.country = code;
      await db.setMeta("last_country", code);
      const cur = country(code)?.currency;
      if (cur) { state.currency = cur; await db.setMeta("last_currency", cur); }
      render();
    }, state.country);
  });

  on('[data-act="logout"]', async () => {
    await fetch("/api/logout", { method: "POST" });
    location.reload();
  });
}

// ---------------------------------------------------------------- 登入

function renderLogin(message = "") {
  app.innerHTML = `
    <form class="login">
      <div class="mark">◧</div>
      <h1>旅行記帳</h1>
      <p>輸入密碼以繼續</p>
      <input type="password" id="pw" autocomplete="current-password" placeholder="密碼" required>
      <p class="err">${esc(message)}</p>
      <button type="submit">登入</button>
    </form>`;

  const form = app.querySelector("form");
  const input = app.querySelector("#pw");
  input.focus();

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "驗證中…";

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: input.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { await start(); return; }
      renderLogin(data.error || "登入失敗");
    } catch {
      renderLogin("連不上伺服器，請檢查網路");
    }
  };
}

// ---------------------------------------------------------------- 啟動

async function start() {
  await db.seedIfEmpty();
  await fx.loadRates();

  state.currency = await db.getMeta("last_currency", "GBP");
  state.country = await db.getMeta("last_country", "GB");
  state.activeTripId = await db.getMeta("active_trip_id", null);
  state.startOnKeypad = await db.getMeta("start_on_keypad", false);
  state.homeView = await db.getMeta("home_view", "list");
  state.calMonth = fx.localDate(new Date()).slice(0, 7);
  state.statsMonth = state.calMonth;
  state.statsYear = state.calMonth.slice(0, 4);
  state.statsPeriod = await db.getMeta("stats_period", "trip");
  await reload();

  state.ready = true;
  render();

  db.onChange(async (ev) => {
    if (ev.type === "unauthed") { state.ready = false; renderLogin("登入已過期，請重新登入"); return; }
    if (ev.type === "data") await reload();
    render();
  });

  await openLaunchAction();

  await db.sync();
  await fx.loadRates();
  await backfillRates();
  await reload();
  render();
}

// 啟動時要直接打開哪個面板。
// 來源有兩個：長按圖示的快捷選單（?a=…），以及「開啟直接落在鍵盤」這個設定。
// 用完就把網址參數清掉，否則使用者重新整理會又觸發一次。
async function openLaunchAction() {
  const action = new URLSearchParams(location.search).get("a");
  if (action) history.replaceState(null, "", location.pathname);

  if (action === "exchange") { openExchange(); return; }
  if (action === "accounts") { openAccountList(); return; }
  if (action === "add") { openKeypad(); return; }

  if (await db.getMeta("start_on_keypad", false)) openKeypad();
}

async function boot() {
  // 先看本機有沒有資料：有的話就算離線、就算 session 查不到也要能直接用
  const hasLocal = (await db.getAllRaw("entries")).length > 0;

  let authed = false;
  try {
    const res = await fetch("/api/session");
    authed = res.ok && (await res.json()).authed;
  } catch {
    authed = hasLocal;
  }

  if (authed || hasLocal) await start();
  else renderLogin();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").then(watchForUpdates).catch(() => {});
  }
}

// Service Worker 是快取優先（開得快、離線也能開），代價是新版要到下次開啟才生效。
// 與其讓人納悶「怎麼改了沒反應」，不如在新版準備好時直接說一聲。
function watchForUpdates(reg) {
  if (!reg) return;

  const offerReload = (worker) => {
    worker.addEventListener("statechange", () => {
      // 已經有舊版在控制這個頁面，代表這是更新而不是第一次安裝
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        toast("有新版本可以用了", {
          actionLabel: "重新載入",
          undo: () => location.reload(),
          ms: 20000,
        });
      }
    });
  };

  if (reg.installing) offerReload(reg.installing);
  reg.addEventListener("updatefound", () => { if (reg.installing) offerReload(reg.installing); });

  // 回到 App 時順手問一下伺服器有沒有新版
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) reg.update().catch(() => {});
  });
}

boot();
