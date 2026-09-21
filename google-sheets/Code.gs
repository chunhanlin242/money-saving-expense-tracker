/**
 * 旅行記帳 → Google 試算表
 *
 * 每天固定時間把記帳 App 的帳目拉下來，產生三張工作表：
 *   帳目   全部明細
 *   省下   只列有填「本來要花」的，含省錢項目與累計
 *   總覽   每月／每年花費、累計省下，附每月花費長條圖
 *
 * 單向：試算表不會回寫到 App。想加自己的分析請另開工作表用公式參照，
 * 直接在這三張上面加東西每次更新都會被清掉。
 */

// ── 只有這兩行需要你改 ────────────────────────────────
var API_URL = 'https://money.example.com/api/export/entries';   // 換成你自己的網域
var TOKEN   = '把你設定的 EXPORT_TOKEN 貼在這裡';
// ─────────────────────────────────────────────────

var MONEY_FMT = '"NT$"#,##0';

/** 主要動作：拉資料並重建三張工作表 */
function updateEntries() {
  var res = UrlFetchApp.fetch(API_URL, {
    headers: { Authorization: 'Bearer ' + TOKEN },
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('抓取失敗（HTTP ' + code + '）：' + res.getContentText().slice(0, 200));
  }

  var data = JSON.parse(res.getContentText());
  var idx = {};
  data.columns.forEach(function (c, i) { idx[c] = i; });

  writeEntries(data);
  writeSavings(data, idx);
  writeOverview(data, idx);

  orderSheets(['總覽', '帳目', '省下']);

  SpreadsheetApp.getActive().toast('已更新 ' + data.rows.length + ' 筆', '旅行記帳', 5);
  return data.rows.length;
}

// ---------------------------------------------------------------- 帳目

function writeEntries(data) {
  var sheet = freshSheet('帳目');
  var cols = data.columns;

  // 整張覆寫而不是附加。App 那邊可以編輯與刪除帳目，
  // 用附加的話舊值會留下來，對不起帳。
  header(sheet, cols, 1);
  if (data.rows.length) {
    sheet.getRange(2, 1, data.rows.length, cols.length).setValues(data.rows);
  }
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);      // 往右捲時日期要留在畫面上
  stamp(sheet, data.rows.length + 3);
  fitColumns(sheet, cols.length);
}

// ---------------------------------------------------------------- 省下

function writeSavings(data, idx) {
  var sheet = freshSheet('省下');
  var cols = ['日期', '分類', '省錢項目', '原價', '實付', '幣別',
              '省下', '省下台幣', '折扣%', '累計省下台幣', '國家', '備註'];

  var running = 0;
  var rows = [];
  data.rows.forEach(function (r) {
    var savedTwd = Number(r[idx['省下台幣']]);
    if (!savedTwd) return;
    running += savedTwd;
    var ref = Number(r[idx['原價']]) || 0;
    var paid = Number(r[idx['金額']]) || 0;
    rows.push([
      r[idx['日期']], r[idx['分類']], r[idx['省錢項目']],
      ref, paid, r[idx['幣別']],
      Number(r[idx['省下']]) || 0, savedTwd,
      ref ? Math.round((ref - paid) / ref * 100) : 0,
      Math.round(running * 100) / 100,
      r[idx['國家']], r[idx['備註']]
    ]);
  });

  // 累計省下放最上面，這是這張表最想看到的數字
  sheet.getRange(1, 1).setValue('累計省下');
  sheet.getRange(1, 2).setValue(Math.round(running))
    .setNumberFormat(MONEY_FMT).setFontSize(18).setFontWeight('bold').setFontColor('#00875a');
  sheet.getRange(1, 3).setValue(rows.length + ' 筆').setFontColor('#888888');

  header(sheet, cols, 3);
  if (rows.length) {
    sheet.getRange(4, 1, rows.length, cols.length).setValues(rows);
    sheet.getRange(4, 8, rows.length, 1).setNumberFormat('#,##0.00');
    sheet.getRange(4, 10, rows.length, 1).setNumberFormat('#,##0.00');
    sheet.getRange(4, 9, rows.length, 1).setNumberFormat('0"%"');
  }
  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(1);
  stamp(sheet, rows.length + 6);
  fitColumns(sheet, cols.length);
}

// ---------------------------------------------------------------- 總覽

function writeOverview(data, idx) {
  var sheet = freshSheet('總覽');

  var byMonth = {}, byYear = {};
  var totalSpent = 0, totalSaved = 0;

  data.rows.forEach(function (r) {
    // 換現不是消費（錢還是你的，只是換了幣別），不能算進花費
    if (r[idx['類型']] !== '支出') return;

    var date = String(r[idx['日期']]);
    var m = date.slice(0, 7), y = date.slice(0, 4);
    var spent = Number(r[idx['台幣']]) || 0;
    var saved = Number(r[idx['省下台幣']]) || 0;

    if (!byMonth[m]) byMonth[m] = { spent: 0, saved: 0, n: 0 };
    if (!byYear[y]) byYear[y] = { spent: 0, saved: 0, n: 0 };
    byMonth[m].spent += spent; byMonth[m].saved += saved; byMonth[m].n++;
    byYear[y].spent += spent;  byYear[y].saved += saved;  byYear[y].n++;
    totalSpent += spent; totalSaved += saved;
  });

  // 三個大數字。省下用綠色，跟支出區分開 —— 它們是兩個獨立的數字，不相減。
  var kpi = [['總支出', totalSpent, '#111111'],
             ['累計省下', totalSaved, '#00875a'],
             ['本來可能花', totalSpent + totalSaved, '#111111']];
  kpi.forEach(function (k, i) {
    var col = i * 2 + 1;
    sheet.getRange(1, col).setValue(k[0]).setFontColor('#888888').setFontSize(10);
    sheet.getRange(2, col).setValue(Math.round(k[1]))
      .setNumberFormat(MONEY_FMT).setFontSize(16).setFontWeight('bold').setFontColor(k[2]);
  });

  // 每月
  var months = Object.keys(byMonth).sort();
  sheet.getRange(4, 1).setValue('每月').setFontWeight('bold');
  header(sheet, ['月份', '支出', '省下', '筆數'], 5);
  var mRows = months.map(function (m) {
    return [m, Math.round(byMonth[m].spent), Math.round(byMonth[m].saved), byMonth[m].n];
  });
  if (mRows.length) {
    sheet.getRange(6, 1, mRows.length, 4).setValues(mRows);
    sheet.getRange(6, 2, mRows.length, 2).setNumberFormat(MONEY_FMT);
  }

  // 每年，接在每月下面空兩列
  var yStart = 6 + mRows.length + 2;
  var years = Object.keys(byYear).sort();
  sheet.getRange(yStart, 1).setValue('每年').setFontWeight('bold');
  header(sheet, ['年份', '支出', '省下', '筆數'], yStart + 1);
  var yRows = years.map(function (y) {
    return [y, Math.round(byYear[y].spent), Math.round(byYear[y].saved), byYear[y].n];
  });
  if (yRows.length) {
    sheet.getRange(yStart + 2, 1, yRows.length, 4).setValues(yRows);
    sheet.getRange(yStart + 2, 2, yRows.length, 2).setNumberFormat(MONEY_FMT);
  }

  // 每月花費長條圖，放右邊不擋表格
  if (mRows.length) {
    var chart = sheet.newChart()
      .setChartType(Charts.ChartType.COLUMN)
      .addRange(sheet.getRange(5, 1, mRows.length + 1, 3))   // 含標題列，支出與省下兩個數列
      .setPosition(4, 6, 0, 0)
      .setOption('title', '每月花費與省下')
      .setOption('legend', { position: 'top' })
      .setOption('colors', ['#e8590c', '#00875a'])
      .setOption('width', 520)
      .setOption('height', 300)
      .build();
    sheet.insertChart(chart);
  }

  stamp(sheet, yStart + yRows.length + 4);
  fitColumns(sheet, 5);
}

// ---------------------------------------------------------------- 小工具

/** 拿到一張清空的工作表（沒有就建）。圖表要一起清掉，否則每次更新會愈疊愈多。 */
function freshSheet(name) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.getCharts().forEach(function (c) { sheet.removeChart(c); });
  sheet.clear();
  return sheet;
}

/**
 * 依內容算欄寬。
 * 不用 autoResizeColumns：它按字元數估，中日韓字實際佔兩倍寬，
 * 結果就是「省錢項目」被切成「省錢」、「可退稅」被切成「可退」。
 * 用 getDisplayValues 讀「畫面上看到的字」，套用數字格式後的長度才算得準。
 */
function fitColumns(sheet, numCols) {
  var last = sheet.getLastRow();
  if (last < 1) return;

  var shown = sheet.getRange(1, 1, last, numCols).getDisplayValues();

  for (var c = 0; c < numCols; c++) {
    var widest = 0;
    for (var r = 0; r < shown.length; r++) {
      var text = shown[r][c];
      if (!text) continue;
      var units = 0;
      for (var i = 0; i < text.length; i++) {
        // 中日韓與全形標點算兩個單位
        units += /[⺀-〿㐀-鿿가-힯豈-﫿＀-￯]/.test(text.charAt(i)) ? 2 : 1;
      }
      if (units > widest) widest = units;
    }
    // 8px 一個單位 + 左右留白；夾在 62–260 之間，太窄看不到標題、太寬要一直捲
    sheet.setColumnWidth(c + 1, Math.min(Math.max(widest * 8 + 22, 62), 260));
  }
}

/** 依指定順序排列工作表 */
function orderSheets(names) {
  var ss = SpreadsheetApp.getActive();
  names.forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });
}

function header(sheet, cols, row) {
  sheet.getRange(row, 1, 1, cols.length)
    .setValues([cols]).setFontWeight('bold').setBackground('#f2f2f2');
}

function stamp(sheet, row) {
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  sheet.getRange(row, 1)
    .setValue('最後更新：' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'))
    .setFontColor('#888888');
}

// ---------------------------------------------------------------- 定時與選單

/** 跑一次就好：建立每天晚上 10 點的自動更新 */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'updateEntries'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('updateEntries')
    .timeBased()
    .atHour(22)      // Apps Script 會在 22:00–23:00 之間跑，不是分秒不差
    .everyDays(1)
    .create();

  SpreadsheetApp.getActive().toast('已設定每天晚上 10 點自動更新', '旅行記帳', 5);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('旅行記帳')
    .addItem('立即更新', 'updateEntries')
    .addItem('設定每天自動更新', 'installDailyTrigger')
    .addToUi();
}
