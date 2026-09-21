// 匯出與備份。三種格式，用途不同：
//
//   CSV   丟進試算表快速看一眼
//   XLSX  多工作表，拿來認真分析
//   JSON  真正的備份 —— 前兩者會遺失同步欄位，救不回來
//
// 全部在客戶端讀 IndexedDB 產生，所以離線也能匯出。零依賴。

import * as db from "./db.js";
import * as fx from "./fx.js";
import { nameOf } from "./countries.js";

// ---------------------------------------------------------------- 下載

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const stamp = () => fx.localDate(new Date()).replace(/-/g, "");

// ---------------------------------------------------------------- 取資料

async function gather() {
  const [trips, categories, accounts, entries, exchanges, people, splits, settlements] = await Promise.all([
    db.getAll("trips"), db.getAll("categories"), db.getAll("accounts"),
    db.getAll("entries"), db.getAll("exchanges"),
    db.getAll("people"), db.getAll("splits"), db.getAll("settlements"),
  ]);
  return { trips, categories, accounts, entries, exchanges, people, splits, settlements };
}

function lookups(d) {
  const by = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
  return { trip: by(d.trips), cat: by(d.categories), acc: by(d.accounts), person: by(d.people) };
}

const TYPE_LABEL = { expense: "支出", income: "收入", exchange: "換現" };

// 匯出的金額一律收斂到合理位數。浮點減法會跑出 7.199999999999999 這種尾數，
// 直接寫進 CSV 會讓檔案看起來像壞掉。
const twd = (v) => Math.round((Number(v) || 0) * 100) / 100;
const inCur = (v, code) => {
  const unit = Math.pow(10, fx.currencyInfo(code).decimals);
  return Math.round((Number(v) || 0) * unit) / unit;
};

// 省下 = 參考價 − 實付。參考價沒填或沒比實付高就是 0。
function savedOf(e) {
  const ref = Number(e.reference_amount);
  return Number.isFinite(ref) && ref > e.amount ? ref - e.amount : 0;
}

// 省下專用表：只列有省到的，附累計欄位方便直接畫圖
function savingRows(d) {
  const L = lookups(d);
  let running = 0;
  return d.entries
    .filter(savedOf)
    .sort((a, b) => (a.spent_at < b.spent_at ? -1 : 1))
    .map((e) => {
      const saved = savedOf(e);
      const savedTwd = saved * e.rate_to_twd;
      running += savedTwd;
      return {
        日期: e.spent_date,
        分類: L.cat[e.category_id]?.name || "",
        原價: e.reference_amount,
        實付: e.amount,
        幣別: e.currency,
        省下: inCur(saved, e.currency),
        省下台幣: twd(savedTwd),
        省錢項目: e.saving_note || "",
        折扣百分比: e.reference_amount ? Math.round(saved / e.reference_amount * 100) : 0,
        累計省下台幣: twd(running),
        國家: e.country ? nameOf(e.country) : "",
        旅程: L.trip[e.trip_id]?.name || "",
        備註: e.note || "",
      };
    });
}

// 攤平成一列一筆帳，CSV 與 XLSX 的「帳目」工作表共用
function entryRows(d) {
  const L = lookups(d);
  return d.entries
    .slice()
    .sort((a, b) => (a.spent_at < b.spent_at ? -1 : 1))
    .map((e) => ({
      日期: e.spent_date,
      類型: TYPE_LABEL[e.type] || e.type,
      金額: e.amount,
      幣別: e.currency,
      匯率: e.rate_to_twd,
      台幣: twd(e.amount_twd),
      原價: e.reference_amount || "",
      省下: savedOf(e) ? inCur(savedOf(e), e.currency) : "",
      省下台幣: savedOf(e) ? twd(savedOf(e) * e.rate_to_twd) : "",
      省錢項目: e.saving_note || "",
      分類: L.cat[e.category_id]?.name || "",
      付款方式: L.acc[e.account_id]?.name || "",
      國家: e.country ? nameOf(e.country) : "",
      旅程: L.trip[e.trip_id]?.name || "",
      備註: e.note || "",
      行前已付: e.is_prepaid ? "是" : "",
      可退稅: e.tax_refund ? (e.tax_refund_status === "claimed" ? "已申請" : "是") : "",
      誰先付: e.paid_by === "me" ? "我" : (L.person[e.paid_by]?.name || ""),
    }));
}

function splitRows(d) {
  const L = lookups(d);
  const byEntry = Object.fromEntries(d.entries.map((e) => [e.id, e]));
  return d.splits
    .filter((s) => byEntry[s.entry_id])
    .map((s) => {
      const e = byEntry[s.entry_id];
      return {
        日期: e.spent_date,
        分類: L.cat[e.category_id]?.name || "",
        帳目總額: e.amount,
        幣別: e.currency,
        誰先付: e.paid_by === "me" ? "我" : (L.person[e.paid_by]?.name || ""),
        分攤者: s.person_id === "me" ? "我" : (L.person[s.person_id]?.name || "（已刪除）"),
        分攤金額: s.share_amount,
        分攤台幣: twd(s.share_twd),
        備註: e.note || "",
      };
    })
    .sort((a, b) => (a.日期 < b.日期 ? -1 : 1));
}

function exchangeRows(d) {
  const byEntry = Object.fromEntries(d.entries.map((e) => [e.id, e]));
  const L = lookups(d);
  return d.exchanges
    .filter((x) => byEntry[x.entry_id])
    .map((x) => {
      const e = byEntry[x.entry_id];
      const actual = x.to_amount ? x.from_amount / x.to_amount : 0;
      return {
        日期: e.spent_date,
        給出: x.from_amount,
        給出幣別: x.from_currency,
        拿到: x.to_amount,
        拿到幣別: x.to_currency,
        實際匯率: actual,
        存入錢包: L.acc[x.to_account_id]?.name || "",
        備註: e.note || "",
      };
    })
    .sort((a, b) => (a.日期 < b.日期 ? -1 : 1));
}

// 日 × 分類交叉表，給樞紐分析用
function dailyRows(d) {
  const L = lookups(d);
  const cats = d.categories.slice().sort((a, b) => a.sort - b.sort);
  const byDay = new Map();

  for (const e of d.entries) {
    if (e.type !== "expense") continue;
    if (!byDay.has(e.spent_date)) byDay.set(e.spent_date, {});
    const row = byDay.get(e.spent_date);
    const name = L.cat[e.category_id]?.name || "未分類";
    row[name] = (row[name] || 0) + e.amount_twd;
  }

  const names = [...cats.map((c) => c.name), "未分類"];
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, row]) => {
    const out = { 日期: date };
    let total = 0;
    for (const n of names) {
      if (row[n]) { out[n] = twd(row[n]); total += row[n]; }
      else out[n] = 0;
    }
    out["合計"] = twd(total);
    return out;
  });
}

async function rateRows(d) {
  const dates = [...new Set(d.entries.map((e) => e.spent_date))].sort();
  if (!dates.length) return [];
  try {
    const res = await fetch(`/api/fx/history?from=${dates[0]}&to=${dates[dates.length - 1]}`);
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => ({ 日期: r.date, 幣別: r.currency, 對台幣匯率: r.rate_to_twd }));
  } catch {
    return [];   // 離線就略過這張表，其他照樣匯出
  }
}

// ---------------------------------------------------------------- CSV

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}

export async function exportCsv() {
  const d = await gather();
  const rows = entryRows(d);
  if (!rows.length) throw new Error("沒有資料可以匯出");

  // BOM 是必要的：少了它 Excel 會把 UTF-8 中文開成亂碼
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  download(blob, `旅行記帳_${stamp()}.csv`);
  return rows.length;
}

export async function exportSavingsCsv() {
  const d = await gather();
  const rows = savingRows(d);
  if (!rows.length) throw new Error("還沒有填過「本來要花」的帳目");

  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  download(blob, `旅行記帳_省下_${stamp()}.csv`);
  return { count: rows.length, total: rows[rows.length - 1].累計省下台幣 };
}

// ---------------------------------------------------------------- XLSX
//
// .xlsx 就是一包 zip 裝著幾支 XML。zip 用 STORED（不壓縮）模式寫，
// 只需要自己算 CRC32 + 組檔頭，不必引入 SheetJS（壓縮後 400KB 上下，
// 對一個要求離線瞬開的 PWA 太重了）。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  for (const { name, content } of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);

    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),   // 0 = STORED
      ...u16(0), ...u16(0),                                    // 時間戳留 0，Excel 不在意
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    parts.push(new Uint8Array(local), nameBytes, data);

    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]);
    central.push(nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const dirParts = [];
  let dirSize = 0;
  for (const c of central) {
    const bytes = c instanceof Uint8Array ? c : new Uint8Array(c);
    dirParts.push(bytes);
    dirSize += bytes.length;
  }

  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(dirSize), ...u32(offset), ...u16(0),
  ]);

  return new Blob([...parts, ...dirParts, eocd], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

const xmlEsc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");   // 控制字元會讓 Excel 判定檔案損毀

const colName = (n) => {
  let s = "";
  n += 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// 樣式索引：0 一般 / 1 標題 / 2 金額千分位 / 3 匯率四位小數
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0000"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const MONEY_COLS = /金額|台幣|總額|分攤|給出|拿到|合計|原價|實付|省下/;
const RATE_COLS = /匯率/;

function sheetXml(rows) {
  if (!rows.length) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;
  }

  const cols = Object.keys(rows[0]);
  const styleFor = (col) => (RATE_COLS.test(col) ? 3 : MONEY_COLS.test(col) ? 2 : 0);

  // 欄寬依內容估算。中日韓字元寬度約是拉丁字母的兩倍。
  const width = (col, i) => {
    const w = (s) => [...String(s ?? "")].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
    let m = w(col);
    for (const r of rows) m = Math.max(m, w(typeof r[col] === "number" ? r[col].toFixed(2) : r[col]));
    return Math.min(Math.max(m + 2, 8), 42);
  };

  const cell = (v, ref, style) => {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) {
      return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>`;
    }
    return `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };

  const header = `<row r="1">${cols.map((c, i) =>
    `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${xmlEsc(c)}</t></is></c>`).join("")}</row>`;

  const body = rows.map((r, ri) => `<row r="${ri + 2}">${cols.map((c, ci) =>
    cell(r[c], `${colName(ci)}${ri + 2}`, styleFor(c))).join("")}</row>`).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${width(c, i)}" customWidth="1"/>`).join("")}</cols>
<sheetData>${header}${body}</sheetData>
</worksheet>`;
}

export async function exportXlsx() {
  const d = await gather();
  if (!d.entries.length) throw new Error("沒有資料可以匯出");

  const sheets = [
    { name: "帳目", rows: entryRows(d) },
    { name: "分帳", rows: splitRows(d) },
    { name: "換現", rows: exchangeRows(d) },
    { name: "省下", rows: savingRows(d) },
    { name: "每日彙總", rows: dailyRows(d) },
    { name: "匯率", rows: await rateRows(d) },
  ];

  const files = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: "xl/styles.xml", content: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s.rows) })),
  ];

  download(zip(files), `旅行記帳_${stamp()}.xlsx`);
  return sheets.map((s) => `${s.name} ${s.rows.length} 列`);
}

// ---------------------------------------------------------------- JSON 備份

const BACKUP_VERSION = 1;

export async function exportJson() {
  const tables = {};
  for (const t of db.TABLES) {
    // 用 raw：備份要含 deleted_at 的墓碑列，否則還原後刪除會「復活」
    tables[t] = (await db.getAllRaw(t)).map(({ dirty, ...rest }) => rest);
  }
  const payload = {
    app: "travel-money",
    backup_version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    tables,
  };
  const count = Object.values(tables).reduce((n, rows) => n + rows.length, 0);
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `旅行記帳備份_${stamp()}.json`);
  return count;
}

// 還原：依 UUID 比對，走跟同步引擎同一套 last-write-wins。
// 所以重複匯入同一個檔不會產生重複資料，也不會蓋掉本機更新的版本。
export async function importJson(file) {
  const text = await file.text();
  const data = JSON.parse(text);

  if (data.app !== "travel-money" || !data.tables) throw new Error("這不是旅行記帳的備份檔");
  if (data.backup_version > BACKUP_VERSION) throw new Error("這個備份檔來自更新版本的 App，請先更新再還原");

  let added = 0, updated = 0, skipped = 0;

  for (const table of db.TABLES) {
    const rows = data.tables[table];
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      if (!row || typeof row.id !== "string" || typeof row.updated_at !== "string") { skipped += 1; continue; }
      const current = await db.get(table, row.id);
      if (!current) { await db.putRaw(table, { ...row, dirty: 1 }); added += 1; }
      else if (row.updated_at > current.updated_at) { await db.putRaw(table, { ...row, dirty: 1 }); updated += 1; }
      else skipped += 1;
    }
  }

  await db.sync().catch(() => {});
  return { added, updated, skipped };
}
