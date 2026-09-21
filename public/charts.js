// 手寫 SVG 圖表。不引入任何圖表函式庫 —— 這個 App 要離線瞬開，
// 為了一張長條圖背 100KB 以上的 runtime 不划算。
//
// 只有一張圖：每日花費。分類與各國那些是排序長條列，不是圖表，
// 因為超過六個分類的圓餅圖沒辦法比較相鄰扇形，排序長條同時兼具表格功能。

import * as fx from "./fx.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 座標軸刻度取整到好念的數字
function niceMax(value) {
  if (value <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
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

/**
 * 每日花費長條圖。
 * days: [{ date: 'YYYY-MM-DD', twd: number }]，已按日期排序
 * budget: 每日預算（台幣），沒有就傳 null
 */
export function dailyChart(days, budget) {
  if (!days.length) return "";

  const W = 680, H = 200;                      // viewBox 座標，實際寬度由 CSS 撐滿
  const padL = 52, padR = 12, padT = 18, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const peak = Math.max(...days.map((d) => d.twd), budget || 0);
  const max = niceMax(peak);
  const band = plotW / days.length;
  const barW = Math.min(24, band * 0.62);      // 柱子不填滿格子，留白給眼睛
  const y = (v) => padT + plotH - (v / max) * plotH;

  const ticks = [0, max / 2, max];
  const maxDay = days.reduce((a, b) => (b.twd > a.twd ? b : a), days[0]);

  // x 軸只標首尾與中間，標太密會擠在一起
  const labelIdx = new Set([0, days.length - 1, Math.floor((days.length - 1) / 2)]);

  return `
  <figure class="chart" role="group" aria-label="每日花費長條圖">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">
      ${ticks.map((t) => `
        <line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>
        <text class="tick num" x="${padL - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${t >= 1000 ? Math.round(t / 1000) + "k" : Math.round(t)}</text>
      `).join("")}

      ${budget ? `
        <line class="budget-line" x1="${padL}" x2="${W - padR}" y1="${y(budget).toFixed(1)}" y2="${y(budget).toFixed(1)}"/>
        <text class="budget-label" x="${W - padR}" y="${(y(budget) - 6).toFixed(1)}" text-anchor="end">預算</text>
      ` : ""}

      ${days.map((d, i) => {
        const x = padL + band * i + (band - barW) / 2;
        const h = Math.max(0, padT + plotH - y(d.twd));
        return `<path class="bar" d="${barPath(x, y(d.twd), barW, h)}"/>`;
      }).join("")}

      ${days.map((d, i) => labelIdx.has(i)
        ? `<text class="tick num" x="${(padL + band * i + band / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${shortDate(d.date)}</text>`
        : "").join("")}

      ${(() => {
        // 只標最高的那天。每根都標數字會變成一團看不懂的東西。
        const i = days.indexOf(maxDay);
        const cx = padL + band * i + band / 2;
        const anchor = i === 0 ? "start" : i === days.length - 1 ? "end" : "middle";
        return maxDay.twd > 0
          ? `<text class="peak num" x="${cx.toFixed(1)}" y="${(y(maxDay.twd) - 7).toFixed(1)}" text-anchor="${anchor}">${fx.formatTwd(maxDay.twd)}</text>`
          : "";
      })()}

      ${days.map((d, i) => `
        <rect class="hit" data-i="${i}" x="${(padL + band * i).toFixed(1)}" y="${padT}"
              width="${band.toFixed(1)}" height="${plotH}"
              data-date="${esc(d.date)}" data-twd="${d.twd}"/>
      `).join("")}
    </svg>
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
    const date = rect.dataset.date;
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
