/* =========================================================
   Ticket Radar — 回流票統計
   ---------------------------------------------------------
   核心觀念只有一個：**次數要除以你盯了多久**。

   「21 點掉了 5 次、凌晨 3 點掉了 1 次」看起來像是晚上比較好守，
   但如果你在 21 點盯了 5 小時、凌晨只盯了 10 分鐘，那結論剛好相反。
   所以這頁所有的圖都是「每小時幾次」，不是「總共幾次」。
   ========================================================= */
'use strict';

const $ = (id) => document.getElementById(id);

const MIN_EXPOSURE_MS = 10 * 60000;   // 一個時段盯不到 10 分鐘，就不拿來下結論
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

let raw = { events: [], sessions: [], origins: [], beatMs: 60000 };

/* ===================== 格式 ===================== */
const pad = (n) => String(n).padStart(2, '0');

function fmtDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h} 小時 ${r} 分` : `${h} 小時`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小時`;
}

function fmtWhen(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const fmtRate = (r) => (r >= 10 ? r.toFixed(0) : r.toFixed(1));

/* ===================== 計算 ===================== */

/* 把觀測時段沿著整點切開，一段一段交給 onSlice。
   小時分布跟星期分布都用得到（星期在午夜換日，也是整點）。 */
function eachSlice(sessions, from, to, onSlice) {
  for (const s of sessions) {
    let cur = Math.max(s.s, from);
    const end = Math.min(s.e, to);
    while (cur < end) {
      const d = new Date(cur);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
      const stop = Math.min(end, next);
      if (stop <= cur) break;              // 保險：夏令時間之類的怪狀況別卡死
      onSlice(d, stop - cur);
      cur = stop;
    }
  }
}

function distribution(events, sessions, from, to, keyOf, size) {
  const counts = new Array(size).fill(0);
  const exposure = new Array(size).fill(0);
  for (const e of events) counts[keyOf(new Date(e.t))] += 1;
  eachSlice(sessions, from, to, (d, ms) => { exposure[keyOf(d)] += ms; });
  const rates = counts.map((c, i) =>
    exposure[i] >= MIN_EXPOSURE_MS ? c / (exposure[i] / 3600000) : null);
  return { counts, exposure, rates };
}

/* 兩次掉票之間隔多久。只算「同一段觀測之內」的間隔——
   跨越兩個晚上的那個 8 小時空檔不是回流票的節奏，是你去睡覺了。 */
function intervalsWithinSessions(events, sessions) {
  if (!sessions.length) return [];
  const sorted = [...sessions].sort((a, b) => a.s - b.s);
  const buckets = new Map();
  for (const e of events) {
    let hit = -1;
    // 時段不重疊，所以找最後一個開始時間 <= 事件時間的
    let lo = 0, hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].s <= e.t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit < 0 || e.t > sorted[hit].e + raw.beatMs) continue;
    if (!buckets.has(hit)) buckets.set(hit, []);
    buckets.get(hit).push(e.t);
  }
  const out = [];
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a - b);
    for (let i = 1; i < arr.length; i++) out.push(arr[i] - arr[i - 1]);
  }
  return out.sort((a, b) => a - b);
}

const median = (sorted) => (sorted.length
  ? (sorted.length % 2 ? sorted[sorted.length >> 1]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
  : null);

function totalExposure(sessions, from, to) {
  let sum = 0;
  for (const s of sessions) sum += Math.max(0, Math.min(s.e, to) - Math.max(s.s, from));
  return sum;
}

/* 軸的上限取一個好看的整數 */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 1.5, 2, 3, 5, 10]) {
    if (v <= step * mag) return step * mag;
  }
  return 10 * mag;
}

/* ===================== 圖 ===================== */
let tipTimer = null;

function showTip(evt, html) {
  const tip = $('tip');
  tip.innerHTML = html;
  tip.classList.add('on');
  const r = evt.currentTarget.getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
  tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
  clearTimeout(tipTimer);
}
function hideTip() {
  tipTimer = setTimeout(() => $('tip').classList.remove('on'), 60);
}

function drawBars(mount, { rates, counts, exposure, labels, tickEvery = 1, peak, noExposure }) {
  const max = niceMax(Math.max(0, ...rates.filter((r) => r != null)));
  const ticks = [0, max / 2, max];
  const dp = max >= 10 ? 0 : 1;      // 同一條軸的刻度小數位要一致，不能 0.0 / 5.0 / 10 混著用

  const yaxis = ticks.map((t) =>
    `<span class="ytick" style="bottom:${(t / max) * 100}%">${t.toFixed(dp)}</span>`).reverse().join('');

  const grid = ticks.map((t) => `<div class="gridline" style="bottom:${(t / max) * 100}%"></div>`).join('');

  const cols = rates.map((r, i) => {
    const enough = r != null;
    const h = enough ? Math.max(0.8, (r / max) * 100) : 0;
    const cls = enough ? (i === peak ? 'col hot' : 'col') : 'col';
    const bar = enough
      ? `<div class="bar" style="height:${h}%"></div>`
      : `<div class="bar ${exposure[i] > 0 ? 'thin' : 'none'}"></div>`;
    return `<div class="${cls}" data-i="${i}">${bar}</div>`;
  }).join('');

  const xticks = labels.map((l, i) =>
    `<span class="xtick${i % tickEvery === 0 ? '' : ' dim'}">${l}</span>`).join('');

  mount.innerHTML = `
    <div class="plot-row">
      <div class="yaxis">${yaxis}</div>
      <div class="plot">${grid}<div class="bars">${cols}</div></div>
    </div>
    <div class="xaxis">${xticks}</div>
    <div class="chart-legend">縱軸：每小時掉票次數${noExposure ? '（沒有觀測時長紀錄，改用總次數）' : ''}　·　灰色細線：盯的時間不到 10 分鐘，資料不夠</div>`;

  for (const col of mount.querySelectorAll('.col')) {
    const i = Number(col.dataset.i);
    col.addEventListener('mouseenter', (e) => {
      const lines = [`<b>${labels[i]}</b>`];
      if (rates[i] != null) {
        lines.push(`每小時 <b>${fmtRate(rates[i])}</b> 次`);
        lines.push(`共 ${counts[i]} 次 / 盯了 ${fmtDuration(exposure[i])}`);
      } else if (exposure[i] > 0) {
        lines.push(`只盯了 ${fmtDuration(exposure[i])}，資料不夠`);
        if (counts[i]) lines.push(`（期間掉了 ${counts[i]} 次）`);
      } else {
        lines.push('這個時段沒盯過');
      }
      showTip(e, lines.join('<br>'));
    });
    col.addEventListener('mouseleave', hideTip);
  }
}

/* ===================== 繪製全部 ===================== */
function render() {
  const originFilter = $('f-origin').value;
  const days = Number($('f-range').value);
  const to = Date.now();
  const from = days ? to - days * 86400000 : 0;

  const inScope = (x, t) => (!originFilter || x.o === originFilter) && t >= from && t <= to;
  const events = raw.events.filter((e) => inScope(e, e.t)).sort((a, b) => a.t - b.t);
  const sessions = raw.sessions.filter((s) => (!originFilter || s.o === originFilter) && s.e >= from && s.s <= to);

  $('empty').classList.toggle('hidden', events.length > 0);
  $('board').classList.toggle('hidden', events.length === 0);
  if (!events.length) { $('coverage').textContent = ''; return; }

  const watched = totalExposure(sessions, from, to);
  const noExposure = watched < MIN_EXPOSURE_MS;
  $('coverage').textContent = `${events.length} 筆命中 · 盯了 ${fmtDuration(watched)}`;

  /* --- 分布 --- */
  const hour = distribution(events, sessions, from, to, (d) => d.getHours(), 24);
  const day = distribution(events, sessions, from, to, (d) => d.getDay(), 7);

  // 完全沒有觀測時長紀錄（例如舊資料）就退回原始次數，並在圖例講清楚
  if (noExposure) {
    hour.rates = hour.counts.map((c) => c);
    day.rates = day.counts.map((c) => c);
  }

  const peakOf = (o) => {
    let best = -1, bi = null;
    o.rates.forEach((r, i) => { if (r != null && r > best) { best = r; bi = i; } });
    return best > 0 ? bi : null;
  };
  const peakHour = peakOf(hour);
  const peakDay = peakOf(day);

  /* --- 數字磚 --- */
  $('t-count').textContent = events.length;
  $('t-count-m').textContent =
    `${fmtWhen(events[0].t)} 起算`;

  $('t-watched').textContent = watched ? fmtDuration(watched) : '沒有紀錄';
  $('t-watched-m').textContent = watched
    ? `分成 ${sessions.length} 段`
    : '這批資料沒有心跳紀錄';

  const gaps = intervalsWithinSessions(events, sessions);
  const med = median(gaps);
  $('t-gap').textContent = med != null ? fmtDuration(med) : '—';
  $('t-gap-m').textContent = med != null
    ? `中位數，${gaps.length} 個間隔；最短 ${fmtDuration(gaps[0])}`
    : '同一段觀測裡還沒掉過兩次';

  if (peakHour != null && !noExposure) {
    $('t-peak').textContent = `${pad(peakHour)}:00`;
    $('t-peak-m').textContent =
      `每小時 ${fmtRate(hour.rates[peakHour])} 次` +
      (peakDay != null ? ` · 最旺是${WEEKDAYS[peakDay]}` : '');
  } else {
    $('t-peak').textContent = '資料不夠';
    $('t-peak-m').textContent = '每個時段至少要盯滿 10 分鐘才算數';
  }

  /* --- 圖 --- */
  drawBars($('chart-hour'), {
    ...hour,
    labels: Array.from({ length: 24 }, (_, i) => `${pad(i)}`),
    tickEvery: 3,
    peak: peakHour,
    noExposure,
  });
  drawBars($('chart-day'), {
    ...day,
    labels: WEEKDAYS,
    peak: peakDay,
    noExposure,
  });

  /* --- 表 --- */
  const rows = events.slice(-20).reverse();
  $('recent').tBodies[0].innerHTML = rows.map((e, i) => {
    const prev = rows[i + 1];
    const gap = prev ? fmtDuration(e.t - prev.t) : '—';
    const host = (() => { try { return new URL(e.o).hostname; } catch { return e.o || '—'; } })();
    return `<tr>
      <td class="num">${fmtWhen(e.t)}</td>
      <td class="num">${gap}</td>
      <td>${host}</td>
      <td class="reason">${(e.r || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</td>
    </tr>`;
  }).join('');
  $('recent-note').textContent = events.length > rows.length
    ? `只顯示最近 ${rows.length} 筆，範圍內總共 ${events.length} 筆。要看全部請按「匯出 CSV」。`
    : '';
}

/* ===================== 匯出 / 清除 ===================== */
function exportCsv() {
  const originFilter = $('f-origin').value;
  const days = Number($('f-range').value);
  const from = days ? Date.now() - days * 86400000 : 0;
  const rows = raw.events
    .filter((e) => (!originFilter || e.o === originFilter) && e.t >= from)
    .sort((a, b) => a.t - b.t);

  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = ['時間,時間戳,網站,原因']
    .concat(rows.map((e) => [esc(new Date(e.t).toLocaleString()), e.t, esc(e.o), esc(e.r || '')].join(',')))
    .join('\n');

  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `ticket-radar-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function clearAll() {
  if (!confirm('要刪掉全部的命中紀錄與觀測時長嗎？這個動作沒辦法復原。')) return;
  await chrome.runtime.sendMessage({ type: 'clear-stats' });
  await boot();
}

/* ===================== 啟動 ===================== */
async function boot() {
  const res = await chrome.runtime.sendMessage({ type: 'get-stats' });
  if (!res?.ok) return;
  raw = res.data;

  const sel = $('f-origin');
  const keep = sel.value;
  sel.innerHTML = '<option value="">全部</option>' + raw.origins.map((o) => {
    let host = o;
    try { host = new URL(o).hostname; } catch { /* 不是合法網址就原樣顯示 */ }
    return `<option value="${o}">${host}</option>`;
  }).join('');
  if (raw.origins.includes(keep)) sel.value = keep;

  render();
}

$('f-origin').addEventListener('change', render);
$('f-range').addEventListener('change', render);
$('export').addEventListener('click', exportCsv);
$('clear').addEventListener('click', clearAll);
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.events || c.sessions)) boot();
});

boot();
