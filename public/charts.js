// 手寫 SVG 圖表。不引入任何圖表函式庫 —— 這個 App 要離線瞬開，
// 為了一張長條圖背 100KB 以上的 runtime 不划算。
//
// 只有一張圖：每日花費。分類與各國那些是排序長條列，不是圖表，
// 因為超過六個分類的圓餅圖沒辦法比較相鄰扇形，排序長條同時兼具表格功能。

import * as fx from "./fx.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 座標軸刻度取整到好念的數字。只用「除以二還是整齊」的級距，
// 因為中間那條刻度是上限的一半：7.5k 的一半 3.75k 會被標成 4k，跟實際格線對不上。
function niceMax(value) {
  if (value <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * mag) return step * mag;
  }
  return 10 * mag;
}

const shortDate = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

// 頂端 4px 圓角、底部貼齊基線的直角
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return "";
  return `M${x},${y + h}L${x},${y + r}Q${x},${y} ${x + r},${y}` +
         `L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h}Z`;
}

// 比例上限。房租這種一個月一次的大筆支出會把其他天壓成一條線，整張圖就沒意義了。
// 所以上限看「一般的日子」：非零天數的第 85 百分位乘 2（有預算時至少涵蓋預算）。
// 只有最高那天明顯超出時才截斷；天數太少時統計不出「一般」，照實畫。
function scaleCap(days, budget) {
  const vals = days.map((d) => d.twd).filter((v) => v > 0).sort((a, b) => a - b);
  const peak = Math.max(vals[vals.length - 1] || 0, budget || 0);
  if (vals.length < 5) return { max: niceMax(peak), clipped: false };
  const p85 = vals[Math.floor((vals.length - 1) * 0.85)];
  const cap = Math.max(p85 * 2, (budget || 0) * 1.25);
  return peak > cap * 1.3 ? { max: niceMax(cap), clipped: true } : { max: niceMax(peak), clipped: false };
}

/**
 * 每日花費長條圖。
 * days: [{ date: 'YYYY-MM-DD', twd: number }]，已按日期排序
 * budget: 每日預算（台幣），沒有就傳 null
 * selected: 點選中的那天，其他長條變淡
 *
 * 文字一律放在 SVG 外面的 HTML 層。SVG 用 preserveAspectRatio="none" 撐滿寬度，
 * 寫在裡面的字會跟著被橫向壓扁（手機上 680 寬壓成 340，字變瘦一半）。
 */
export function dailyChart(days, budget, selected = null) {
  if (!days.length) return "";

  const W = 680, H = 200;                      // viewBox 座標，實際寬度由 CSS 撐滿
  const padL = 52, padR = 12, padT = 22, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { max, clipped } = scaleCap(days, budget);
  const band = plotW / days.length;
  const barW = Math.min(24, band * 0.62);      // 柱子不填滿格子，留白給眼睛
  const y = (v) => padT + plotH - (Math.min(v, max) / max) * plotH;
  const cx = (i) => padL + band * i + band / 2;
  const pct = (v, total) => (v / total * 100).toFixed(2) + "%";

  const ticks = [0, max / 2, max];
  const maxDay = days.reduce((a, b) => (b.twd > a.twd ? b : a), days[0]);

  // x 軸只標首尾與中間，標太密會擠在一起
  const labelIdx = new Set([0, days.length - 1, Math.floor((days.length - 1) / 2)]);

  // 要標金額的長條：被截斷的每一根（看不出高度，只能靠數字），沒截斷就只標最高那天
  const valueIdx = clipped
    ? days.map((d, i) => (d.twd > max ? i : -1)).filter((i) => i >= 0)
    : (maxDay.twd > 0 ? [days.indexOf(maxDay)] : []);

  const label = (cls, x, yy, text, align) =>
    `<span class="${cls} num ${align}" style="left:${pct(x, W)};top:${pct(yy, H)}">${text}</span>`;
  const edge = (i) => (i === 0 ? "a-start" : i === days.length - 1 ? "a-end" : "a-mid");

  return `
  <figure class="chart" role="group" aria-label="每日花費長條圖">
    <div class="chart-plot">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg${selected ? " picking" : ""}">
        ${ticks.map((t) => `
          <line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`).join("")}

        ${budget && budget <= max ? `
          <line class="budget-line" x1="${padL}" x2="${W - padR}" y1="${y(budget).toFixed(1)}" y2="${y(budget).toFixed(1)}"/>` : ""}

        ${days.map((d, i) => {
          const x = padL + band * i + (band - barW) / 2;
          const h = Math.max(0, padT + plotH - y(d.twd));
          const cut = d.twd > max
            // 截斷記號：靠近頂端畫一道斜的缺口，表示「實際比這高很多」
            ? `<path class="brk" d="M${(x - 2).toFixed(1)},${(padT + 16).toFixed(1)}L${(x + barW + 2).toFixed(1)},${(padT + 8).toFixed(1)}"/>`
            : "";
          return `<path class="bar${d.date === selected ? " on" : ""}" d="${barPath(x, y(d.twd), barW, h)}"/>${cut}`;
        }).join("")}

        ${days.map((d, i) => `
          <rect class="hit" data-i="${i}" x="${(padL + band * i).toFixed(1)}" y="${padT}"
                width="${band.toFixed(1)}" height="${plotH}"
                data-day="${esc(d.date)}" data-twd="${d.twd}"/>
        `).join("")}
      </svg>
      <div class="chart-labels" aria-hidden="true">
        ${ticks.map((t) => label("tick", padL - 8, y(t), t >= 1000 ? +(t / 1000).toFixed(1) + "k" : Math.round(t), "a-left")).join("")}
        ${budget && budget <= max ? label("budget-label", W - padR, y(budget), "預算", "a-above-end") : ""}
        ${days.map((d, i) => labelIdx.has(i) ? label("tick", cx(i), H - padB + 6, shortDate(d.date), edge(i) + " a-below") : "").join("")}
        ${valueIdx.map((i) => label("peak", cx(i), y(days[i].twd) - 4, fx.formatTwd(days[i].twd), edge(i) + " a-above")).join("")}
      </div>
    </div>
    <div class="chart-tip" hidden></div>
  </figure>`;
}

// 圖表的表格替身。tooltip 不能是讀到數值的唯一途徑。
export function dailyTable(days) {
  return `<div class="rows chart-table" hidden>
    ${days.slice().reverse().map((d) => `<div class="row">
      <span class="k num">${esc(fx.formatDateLabel(d.date))}</span>
      <span class="v num">${esc(fx.formatTwd(d.twd))}</span>
    </div>`).join("")}
  </div>`;
}

// 綁 hover／鍵盤焦點。render() 之後呼叫。
export function bindChart(root) {
  const fig = root.querySelector(".chart");
  if (!fig) return;
  const tip = fig.querySelector(".chart-tip");
  const svg = fig.querySelector(".chart-svg");

  const show = (rect) => {
    const date = rect.dataset.day;
    const twd = Number(rect.dataset.twd);
    tip.innerHTML = `<span class="d">${esc(fx.formatDateLabel(date))}</span><span class="v num">${esc(fx.formatTwd(twd))}</span>`;
    tip.hidden = false;

    // 依 hit 區在畫面上的實際位置擺 tooltip，並夾在圖表寬度內
    const r = rect.getBoundingClientRect();
    const f = fig.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const cx = r.left + r.width / 2 - f.left;
    tip.style.left = Math.max(half + 2, Math.min(f.width - half - 2, cx)) + "px";
  };

  const hide = () => { tip.hidden = true; };

  for (const rect of svg.querySelectorAll(".hit")) {
    rect.addEventListener("pointerenter", () => show(rect));
    rect.addEventListener("pointerdown", () => show(rect));
    rect.setAttribute("tabindex", "0");
    rect.addEventListener("focus", () => show(rect));
    rect.addEventListener("blur", hide);
  }
  svg.addEventListener("pointerleave", hide);
}
