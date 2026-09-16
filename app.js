/* =========================================================
   Millis — 沉浸式毫秒時鐘
   三個核心決定：
     1) 用 requestAnimationFrame 跟著螢幕更新，毫秒才滑順
     2) 每一幀都重新問系統時間，所以不會累積誤差
     3) 只有數字真的變了才寫 DOM，省電、省 CPU
   ========================================================= */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const el = {
    root: document.documentElement,
    stage: $('#stage'), clock: $('.clock'), time: $('#time'),
    h: $('#p-h'), m: $('#p-m'), s: $('#p-s'), sep1: $('#sep1'), sep2: $('#sep2'),
    ms: $('#ms'), date: $('#date'), ampm: $('#ampm'), tz: $('#tz'),
    hint: $('#hint'), bar: $('#bar'),
    bFull: $('#btn-fullscreen'), bLock: $('#btn-lock'), bSet: $('#btn-settings'),
    sheet: $('#sheet'), scrim: $('#scrim'), bClose: $('#btn-close'), bReset: $('#btn-reset'),
    selTz: $('#sel-tz'), outScale: $('#out-scale'), wakeNote: $('#wake-note'),
  };

  // ---------- 預設值 ----------
  const DEFAULTS = {
    // 時間
    hour12: false, showSeconds: true, showMs: true, showDate: true, showTz: true, tz: 'auto',
    // 外觀
    mode: 'auto', theme: 'neutral', font: 'sans', weight: 300, scale: 100,
    // 效果
    glow: 'off', blink: false, fade: true, autoHide: 3, wake: false,
  };
  const KEY = 'millis.v2';
  let state = load();

  function load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
    catch { return { ...DEFAULTS }; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 無痕模式就算了 */ }
  }

  const FONTS = { sans: 'var(--f-sans)', serif: 'var(--f-serif)', mono: 'var(--f-mono)', rounded: 'var(--f-rounded)' };
  const GLOW = { off: '0px', soft: 'clamp(16px, 4vw, 50px)', strong: 'clamp(30px, 9vw, 110px)' };
  const THEMES = ['neutral', 'amber', 'mint', 'ice', 'rose'];
  const BG = {
    dark:  { neutral: '#000000', amber: '#0a0500', mint: '#00110d', ice: '#00060f', rose: '#12030a' },
    light: { neutral: '#f4f4f5', amber: '#fdf6e8', mint: '#edfaf4', ice: '#eef5fd', rose: '#fdeff4' },
  };

  /* ===================== 時區 ===================== */
  const fmtCache = new Map();
  function partsFmt(tz) {
    if (!fmtCache.has(tz)) {
      fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
    }
    return fmtCache.get(tz);
  }

  // 回傳「該時區的牆上時間 − UTC」的毫秒差，之後直接把時間加上去就好
  function offsetOf(tz, d) {
    if (tz === 'auto') return -d.getTimezoneOffset() * 60000;
    try {
      const p = {};
      for (const x of partsFmt(tz).formatToParts(d)) p[x.type] = x.value;
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return asUTC - Math.floor(d.getTime() / 1000) * 1000;
    } catch {
      return -d.getTimezoneOffset() * 60000; // 時區名稱有問題就退回本機
    }
  }

  let tzOffset = 0, tzCheckedAt = 0;
  function refreshOffset(now, force) {
    // 每 10 秒重算一次就夠，夏令時間切換也吃得到
    if (force || now - tzCheckedAt > 10000) {
      tzOffset = offsetOf(state.tz, new Date(now));
      tzCheckedAt = now;
    }
  }

  const COMMON = ['UTC', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong',
    'Asia/Singapore', 'Asia/Seoul', 'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York',
    'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
    'Australia/Sydney', 'Pacific/Auckland'];

  function buildTzList() {
    const localName = Intl.DateTimeFormat().resolvedOptions().timeZone || '本機';
    const auto = new Option(`跟隨裝置（${localName}）`, 'auto');
    el.selTz.add(auto);

    const g1 = document.createElement('optgroup'); g1.label = '常用';
    COMMON.forEach((z) => g1.appendChild(new Option(z, z)));
    el.selTz.add(g1);

    let all = [];
    try { all = Intl.supportedValuesOf('timeZone'); } catch { /* 舊瀏覽器沒有這個 API */ }
    if (all.length) {
      const g2 = document.createElement('optgroup'); g2.label = '全部';
      all.forEach((z) => g2.appendChild(new Option(z, z)));
      el.selTz.add(g2);
    }
  }

  /* ===================== 每一幀 ===================== */
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  // 用 null 當「還沒畫過」：任何字串都不等於 null，所以一定會重畫一次
  const last = { h: null, m: null, s: null, ms: null, date: null, ampm: null, sep: null };

  function tick() {
    const nowMs = Date.now();
    refreshOffset(nowMs, false);

    const wall = new Date(nowMs + tzOffset);   // 用 getUTC* 讀就是目標時區的牆上時間
    let hh = wall.getUTCHours();
    let ampm = '';
    if (state.hour12) { ampm = hh < 12 ? 'AM' : 'PM'; hh = hh % 12 || 12; }

    const h = pad(hh), m = pad(wall.getUTCMinutes());
    if (h !== last.h) { el.h.textContent = last.h = h; }
    if (m !== last.m) { el.m.textContent = last.m = m; }

    if (state.showSeconds) {
      const s = pad(wall.getUTCSeconds());
      if (s !== last.s) { el.s.textContent = last.s = s; }
    }
    if (state.showMs) {
      const ms = '.' + pad(wall.getUTCMilliseconds(), 3);
      if (ms !== last.ms) { el.ms.textContent = last.ms = ms; }
    }
    if (ampm !== last.ampm) { el.ampm.textContent = last.ampm = ampm; }

    // 冒號閃爍：直接跟著毫秒算，永遠跟秒同步、不會漂
    if (state.blink) {
      const on = wall.getUTCMilliseconds() < 500;
      if (on !== last.sep) {
        last.sep = on;
        el.sep1.classList.toggle('off', !on);
        el.sep2.classList.toggle('off', !on);
      }
    }

    if (state.showDate) {
      const d = `${wall.getUTCFullYear()}/${pad(wall.getUTCMonth() + 1)}/${pad(wall.getUTCDate())}（週${WEEK[wall.getUTCDay()]}）`;
      if (d !== last.date) { el.date.textContent = last.date = d; }
    }

    requestAnimationFrame(tick);
  }

  /* ===================== 套用設定 ===================== */
  const mq = window.matchMedia('(prefers-color-scheme: light)');

  function resolvedMode() {
    return state.mode === 'auto' ? (mq.matches ? 'light' : 'dark') : state.mode;
  }

  function apply(animate) {
    const r = el.root;
    const resolved = resolvedMode();

    r.dataset.mode = state.mode;
    r.dataset.resolved = resolved;
    r.dataset.theme = state.theme;
    r.style.setProperty('--clock-font', FONTS[state.font] || FONTS.sans);
    r.style.setProperty('--clock-weight', String(state.weight));
    r.style.setProperty('--scale', String(state.scale / 100));
    r.style.setProperty('--glow-size', GLOW[state.glow] || '0px');

    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BG[resolved][state.theme] || '#000000');

    el.ms.hidden = !state.showMs;
    el.time.classList.toggle('no-ms', !state.showMs);
    el.s.hidden = !state.showSeconds;
    el.sep2.hidden = !state.showSeconds;
    el.date.hidden = !state.showDate;
    el.tz.hidden = !state.showTz;

    el.tz.textContent = state.tz === 'auto'
      ? (Intl.DateTimeFormat().resolvedOptions().timeZone || '')
      : state.tz;

    if (!state.blink) {
      last.sep = null;
      el.sep1.classList.remove('off');
      el.sep2.classList.remove('off');
    }

    el.bLock.classList.toggle('on', state.wake);
    syncWakeLock();

    // 強迫下一幀重畫（不能用空字串，不然「AM 變成空白」這種變化會被當作沒變）
    last.h = last.m = last.s = last.ms = last.date = last.ampm = null;
    refreshOffset(Date.now(), true);

    syncUI();
    resetIdle();
    save();
    scheduleFit();

    if (animate && state.fade) {
      el.clock.classList.remove('fade');
      void el.clock.offsetWidth;          // 重啟 CSS animation 的老招
      el.clock.classList.add('fade');
    }
  }

  mq.addEventListener('change', () => { if (state.mode === 'auto') apply(false); });

  /* ---------- 自動縮放：保證不管字型／字級／格式怎麼組合都塞得下 ---------- */
  function fit() {
    el.root.style.setProperty('--fit', '1');      // 先回到基準再量
    const tw = el.time.getBoundingClientRect().width;
    const ch = el.clock.getBoundingClientRect().height;
    if (!tw || !ch) return;
    const f = Math.min(1, (innerWidth * 0.94) / tw, (innerHeight * 0.90) / ch);
    if (f < 1) el.root.style.setProperty('--fit', f.toFixed(4));
  }
  const scheduleFit = () => requestAnimationFrame(fit);
  addEventListener('resize', scheduleFit);
  addEventListener('orientationchange', scheduleFit);

  /* ===================== 設定頁：控制項綁定 ===================== */
  const coerce = (v) => v === 'true' ? true
    : v === 'false' ? false
    : (v !== '' && v !== null && !isNaN(v)) ? +v : v;

  function bindControls() {
    $$('[data-seg]').forEach((g) => {
      const key = g.dataset.seg;
      g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        state[key] = coerce(b.dataset.value);
        apply(true);
      }));
    });
    $$('[data-toggle]').forEach((i) => i.addEventListener('change', () => {
      state[i.dataset.toggle] = i.checked;
      apply(true);
    }));
    $$('[data-select]').forEach((i) => i.addEventListener('change', () => {
      state[i.dataset.select] = coerce(i.value);
      apply(true);
    }));
    // 拖滑桿不要每次都閃一下，所以不帶動畫
    $$('[data-range]').forEach((i) => i.addEventListener('input', () => {
      state[i.dataset.range] = +i.value;
      apply(false);
    }));
  }

  function syncUI() {
    $$('[data-seg]').forEach((g) => {
      const cur = String(state[g.dataset.seg]);
      g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === cur));
    });
    $$('[data-toggle]').forEach((i) => { i.checked = !!state[i.dataset.toggle]; });
    $$('[data-select]').forEach((i) => { i.value = String(state[i.dataset.select]); });
    $$('[data-range]').forEach((i) => { i.value = String(state[i.dataset.range]); });
    el.outScale.textContent = state.scale + '%';
  }

  /* ===================== 設定頁：開關 ===================== */
  let sheetOpen = false;
  function openSheet() {
    sheetOpen = true;
    el.sheet.hidden = el.scrim.hidden = false;
    el.stage.classList.remove('idle');
    clearTimeout(idleTimer);
  }
  function closeSheet() {
    sheetOpen = false;
    el.sheet.hidden = el.scrim.hidden = true;
    resetIdle();
  }
  const toggleSheet = () => (sheetOpen ? closeSheet() : openSheet());

  /* ===================== 全螢幕 ===================== */
  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await el.root.requestFullscreen({ navigationUI: 'hide' });
      else await document.exitFullscreen();
    } catch { /* iOS Safari 沒有這個 API，裝成 App 後本來就全螢幕 */ }
  }
  document.addEventListener('fullscreenchange', () =>
    el.bFull.classList.toggle('on', !!document.fullscreenElement));

  /* ===================== 螢幕不休眠 ===================== */
  let wakeLock = null;
  const wakeSupported = 'wakeLock' in navigator;
  if (!wakeSupported) el.wakeNote.hidden = false;

  async function syncWakeLock() {
    if (!wakeSupported) return;
    try {
      if (state.wake && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!state.wake && wakeLock) {
        const w = wakeLock; wakeLock = null;
        await w.release();
      }
    } catch { wakeLock = null; }
  }
  // 分頁切走時瀏覽器會自動釋放，切回來要重拿
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncWakeLock();
  });

  /* ===================== 閒置自動隱藏 ===================== */
  let idleTimer;
  function resetIdle() {
    clearTimeout(idleTimer);
    el.stage.classList.remove('idle');
    if (sheetOpen || !state.autoHide) return;
    idleTimer = setTimeout(() => el.stage.classList.add('idle'), state.autoHide * 1000);
  }
  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']
    .forEach((e) => window.addEventListener(e, resetIdle, { passive: true }));

  /* ===================== 快捷鍵 ===================== */
  const actions = {
    f: toggleFullscreen,
    h: () => { state.hour12 = !state.hour12; apply(true); },
    m: () => { state.showMs = !state.showMs; apply(true); },
    s: () => { state.showSeconds = !state.showSeconds; apply(true); },
    c: () => { state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]; apply(true); },
    d: () => { state.mode = state.mode === 'dark' ? 'light' : 'dark'; apply(true); },
    k: () => { state.wake = !state.wake; apply(true); },
    ',': toggleSheet,
  };

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'Escape') { if (sheetOpen) { ev.preventDefault(); closeSheet(); } return; }
    if (sheetOpen) return;                       // 設定頁開著時不搶鍵盤
    const a = actions[ev.key.toLowerCase()];
    if (a) { ev.preventDefault(); a(); }
  });

  /* ===================== 啟動 ===================== */
  el.bFull.addEventListener('click', toggleFullscreen);
  el.bSet.addEventListener('click', openSheet);
  el.bClose.addEventListener('click', closeSheet);
  el.scrim.addEventListener('click', closeSheet);
  el.bLock.addEventListener('click', () => { state.wake = !state.wake; apply(false); });
  el.bReset.addEventListener('click', () => { state = { ...DEFAULTS }; apply(true); });
  el.stage.addEventListener('dblclick', toggleFullscreen);
  window.addEventListener('pointerdown', () => el.hint.classList.add('gone'), { once: true });

  buildTzList();
  bindControls();
  apply(false);
  requestAnimationFrame(tick);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
