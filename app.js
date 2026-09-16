/* =========================================================
   Millis — 沉浸式時鐘 / 秒錶 / 倒數
   三個核心決定：
     1) 用 requestAnimationFrame 跟著螢幕更新，毫秒才滑順
     2) 時鐘每幀重讀系統時間；秒錶與倒數改用 performance.now()
        （單調時鐘，系統時間被調整也不會跳）
     3) 只有數字真的變了才寫 DOM，省電、省 CPU
   ========================================================= */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const el = {
    root: document.documentElement,
    stage: $('#stage'), clock: $('#clock'), time: $('#time'),
    h: $('#p-h'), m: $('#p-m'), s: $('#p-s'), sep1: $('#sep1'), sep2: $('#sep2'),
    ms: $('#ms'), date: $('#date'), ampm: $('#ampm'), tz: $('#tz'), status: $('#status'),
    hint: $('#hint'), bar: $('#bar'),
    progress: $('#progress'), fill: $('#progress-fill'),
    presets: $('#presets'), cSet: $('#c-set'), cH: $('#c-h'), cM: $('#c-m'), cS: $('#c-s'),
    laps: $('#laps'),
    actions: $('#actions'), aPrimary: $('#a-primary'), aSecond: $('#a-second'), aReset: $('#a-reset'),
    bFull: $('#btn-fullscreen'), bLock: $('#btn-lock'), bSet: $('#btn-settings'),
    sheet: $('#sheet'), scrim: $('#scrim'), bClose: $('#btn-close'), bReset: $('#btn-reset'),
    selTz: $('#sel-tz'), outScale: $('#out-scale'), wakeNote: $('#wake-note'),
  };

  /* ===================== 設定 ===================== */
  const DEFAULTS = {
    view: 'clock',
    // 時間
    hour12: false, showSeconds: true, showMs: true, showDate: true, showTz: true, tz: 'auto',
    // 秒錶與倒數
    beep: true, vibrate: true, showLaps: true,
    // 外觀
    mode: 'auto', theme: 'neutral', font: 'sans', weight: 300, scale: 100,
    // 效果
    glow: 'off', blink: false, fade: true, autoHide: 3, wake: false,
  };
  const KEY = 'millis.v2';
  const RT_KEY = 'millis.runtime';
  let state = loadState();

  function loadState() {
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
  // 顯示的字元越少，基準字級就越大
  const TIERS = [
    { min: 11, base: 'clamp(44px, 14vw, 320px)', land: 'clamp(44px, 19vh, 200px)' },
    { min: 8,  base: 'clamp(52px, 19vw, 420px)', land: 'clamp(52px, 26vh, 260px)' },
    { min: 0,  base: 'clamp(60px, 26vw, 560px)', land: 'clamp(60px, 34vh, 340px)' },
  ];

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

  // 回傳「該時區的牆上時間 − UTC」的毫秒差，之後每幀只要做一次加法
  function offsetOf(tz, d) {
    if (tz === 'auto') return -d.getTimezoneOffset() * 60000;
    try {
      const p = {};
      for (const x of partsFmt(tz).formatToParts(d)) p[x.type] = x.value;
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return asUTC - Math.floor(d.getTime() / 1000) * 1000;
    } catch {
      return -d.getTimezoneOffset() * 60000;   // 時區名稱有問題就退回本機
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
    el.selTz.add(new Option(`跟隨裝置（${localName}）`, 'auto'));

    const g1 = document.createElement('optgroup'); g1.label = '常用';
    COMMON.forEach((z) => g1.appendChild(new Option(z, z)));
    el.selTz.add(g1);

    let all = [];
    try { all = Intl.supportedValuesOf('timeZone'); } catch { /* 舊瀏覽器沒這個 API */ }
    if (all.length) {
      const g2 = document.createElement('optgroup'); g2.label = '全部';
      all.forEach((z) => g2.appendChild(new Option(z, z)));
      el.selTz.add(g2);
    }
  }

  /* ===================== 秒錶 / 倒數 ===================== */
  // accum 存已累積的毫秒，anchor 是這一段開始時的 performance.now()
  const sw = { running: false, accum: 0, anchor: 0, laps: [] };
  const cd = { running: false, remain: 0, total: 0, anchor: 0, done: false };

  const swElapsed = () => sw.accum + (sw.running ? performance.now() - sw.anchor : 0);
  const cdRemain = () => Math.max(0, cd.remain - (cd.running ? performance.now() - cd.anchor : 0));

  function saveRuntime() {
    try {
      localStorage.setItem(RT_KEY, JSON.stringify({
        at: Date.now(),
        sw: { running: sw.running, accum: swElapsed(), laps: sw.laps },
        cd: { running: cd.running, remain: cdRemain(), total: cd.total, done: cd.done },
      }));
    } catch { /* 無痕模式就算了 */ }
  }

  let alarmOnLoad = false;
  function loadRuntime() {
    let r;
    try { r = JSON.parse(localStorage.getItem(RT_KEY) || '{}'); } catch { return; }
    const away = r.at ? Math.max(0, Date.now() - r.at) : 0;

    if (r.sw) {
      sw.laps = Array.isArray(r.sw.laps) ? r.sw.laps : [];
      sw.running = !!r.sw.running;
      sw.accum = (+r.sw.accum || 0) + (sw.running ? away : 0);
      sw.anchor = performance.now();
    }
    if (r.cd) {
      cd.total = +r.cd.total || 0;
      cd.done = !!r.cd.done;
      const left = (+r.cd.remain || 0) - (r.cd.running ? away : 0);
      if (r.cd.running && left <= 0) {
        // 人不在的時候就倒數完了，回來補一次提示
        cd.running = false; cd.remain = 0; cd.done = true; alarmOnLoad = true;
      } else {
        cd.running = !!r.cd.running;
        cd.remain = Math.max(0, left);
        cd.anchor = performance.now();
      }
    }
  }

  function swToggle() {
    if (sw.running) { sw.accum = swElapsed(); sw.running = false; }
    else { sw.anchor = performance.now(); sw.running = true; }
    afterRun();
  }
  function swLap() {
    if (!sw.running) return;
    const total = swElapsed();
    const prev = sw.laps.length ? sw.laps[sw.laps.length - 1].total : 0;
    sw.laps.push({ total, split: total - prev });
    afterRun();
  }
  function swReset() {
    sw.running = false; sw.accum = 0; sw.laps = [];
    afterRun();
  }

  function cdToggle() {
    if (cd.running) { cd.remain = cdRemain(); cd.running = false; }
    else {
      if (cdRemain() <= 0) return;
      cd.done = false; cd.anchor = performance.now(); cd.running = true;
    }
    afterRun();
  }
  function cdSet(sec) {
    cd.running = false; cd.done = false;
    cd.remain = cd.total = Math.max(0, Math.round(sec)) * 1000;
    afterRun();
  }
  function cdAdd(sec) {
    cd.remain = cdRemain() + sec * 1000;
    cd.total = Math.max(cd.total + sec * 1000, cd.remain);
    cd.done = false;
    if (cd.running) cd.anchor = performance.now();
    afterRun();
  }
  function cdReset() {
    cd.running = false; cd.done = false; cd.remain = 0; cd.total = 0;
    afterRun();
  }

  function afterRun() { syncViewUI(); saveRuntime(); scheduleFit(); }

  /* ---------- 倒數結束的提示 ---------- */
  let ac = null;
  function beep(times = 3) {
    if (!state.beep) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = ac || new AC();
      if (ac.state === 'suspended') ac.resume();
      for (let i = 0; i < times; i++) {
        const t = ac.currentTime + i * 0.35;
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g); g.connect(ac.destination);
        o.start(t); o.stop(t + 0.32);
      }
    } catch { /* 沒聲音就算了，畫面還是會閃 */ }
  }

  function fireAlarm() {
    el.stage.classList.remove('finished');
    void el.stage.offsetWidth;
    el.stage.classList.add('finished');
    setTimeout(() => el.stage.classList.remove('finished'), 3200);
    beep();
    if (state.vibrate && navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200, 100, 400]); } catch { /* 不支援就算了 */ }
    }
  }

  /* ===================== 畫面輸出 ===================== */
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const last = {};

  function put(node, key, val) {
    if (last[key] !== val) { node.textContent = val; last[key] = val; }
  }

  // 統一的數字輸出：hh 傳 null 代表不顯示小時
  function setDigits(hh, mm, ss, ms) {
    const showH = hh !== null;
    if (last.showH !== showH) {
      el.h.hidden = el.sep1.hidden = !showH;
      last.showH = showH;
    }
    if (showH) put(el.h, 'h', hh);
    put(el.m, 'm', mm);
    if (!el.s.hidden) put(el.s, 's', ss);
    if (state.showMs) put(el.ms, 'ms', ms);
  }

  // 把毫秒數拆成時分秒毫秒，超過一小時才顯示小時
  function breakdown(ms) {
    const t = Math.floor(ms);
    const h = Math.floor(t / 3600000);
    return {
      h: h ? pad(h) : null,
      m: pad(Math.floor(t / 60000) % 60),
      s: pad(Math.floor(t / 1000) % 60),
      ms: '.' + pad(t % 1000, 3),
    };
  }

  function renderClock() {
    const nowMs = Date.now();
    refreshOffset(nowMs, false);

    const wall = new Date(nowMs + tzOffset);   // 用 getUTC* 讀就是目標時區的牆上時間
    let hh = wall.getUTCHours();
    let ampm = '';
    if (state.hour12) { ampm = hh < 12 ? 'AM' : 'PM'; hh = hh % 12 || 12; }

    setDigits(pad(hh), pad(wall.getUTCMinutes()), pad(wall.getUTCSeconds()),
      '.' + pad(wall.getUTCMilliseconds(), 3));
    put(el.ampm, 'ampm', ampm);

    if (state.blink) {
      const on = wall.getUTCMilliseconds() < 500;
      if (on !== last.sep) {
        last.sep = on;
        el.sep1.classList.toggle('off', !on);
        el.sep2.classList.toggle('off', !on);
      }
    }
    if (state.showDate) {
      put(el.date, 'date',
        `${wall.getUTCFullYear()}/${pad(wall.getUTCMonth() + 1)}/${pad(wall.getUTCDate())}（週${WEEK[wall.getUTCDay()]}）`);
    }
  }

  function renderStopwatch() {
    const b = breakdown(swElapsed());
    setDigits(b.h, b.m, b.s, b.ms);
  }

  function renderTimer() {
    const left = cdRemain();
    if (cd.running && left <= 0) {      // 剛好在這一幀倒數完
      cd.running = false; cd.remain = 0; cd.done = true;
      fireAlarm(); afterRun();
    }
    const b = breakdown(left);
    setDigits(b.h, b.m, b.s, b.ms);

    const ratio = cd.total > 0 ? left / cd.total : 0;
    const w = ratio.toFixed(4);
    if (last.fill !== w) { el.fill.style.transform = `scaleX(${w})`; last.fill = w; }
  }

  function tick() {
    if (state.view === 'stopwatch') renderStopwatch();
    else if (state.view === 'timer') renderTimer();
    else renderClock();
    requestAnimationFrame(tick);
  }

  /* ---------- 計圈列表 ---------- */
  let lapsDrawn = -1;
  function drawLaps() {
    if (lapsDrawn === sw.laps.length) return;
    lapsDrawn = sw.laps.length;

    if (!sw.laps.length) { el.laps.replaceChildren(); return; }
    const splits = sw.laps.map((l) => l.split);
    const best = Math.min(...splits), worst = Math.max(...splits);
    const fmt = (ms) => { const b = breakdown(ms); return (b.h ? b.h + ':' : '') + b.m + ':' + b.s + b.ms; };

    const rows = sw.laps.map((l, i) => {
      const li = document.createElement('li');
      if (sw.laps.length > 1 && l.split === best) li.className = 'best';
      else if (sw.laps.length > 1 && l.split === worst) li.className = 'worst';
      li.innerHTML = `<span class="no">#${i + 1}</span><b></b><span class="total"></span>`;
      li.querySelector('b').textContent = fmt(l.split);
      li.querySelector('.total').textContent = fmt(l.total);
      return li;
    }).reverse();                       // 最新的放最上面
    el.laps.replaceChildren(...rows);
  }

  /* ===================== 套用設定 ===================== */
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const resolvedMode = () => (state.mode === 'auto' ? (mq.matches ? 'light' : 'dark') : state.mode);

  function apply(animate) {
    const r = el.root;
    const resolved = resolvedMode();

    r.dataset.mode = state.mode;
    r.dataset.resolved = resolved;
    r.dataset.theme = state.theme;
    r.dataset.view = state.view;
    r.style.setProperty('--clock-font', FONTS[state.font] || FONTS.sans);
    r.style.setProperty('--clock-weight', String(state.weight));
    r.style.setProperty('--scale', String(state.scale / 100));
    r.style.setProperty('--glow-size', GLOW[state.glow] || '0px');

    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BG[resolved][state.theme] || '#000000');

    // 強迫下一幀重畫（不能用空字串，否則「AM 變成空白」會被當成沒變）
    for (const k of Object.keys(last)) last[k] = null;
    lapsDrawn = -1;
    refreshOffset(Date.now(), true);

    syncViewUI();

    el.bLock.classList.toggle('on', state.wake);
    syncWakeLock();

    syncUI();
    resetIdle();
    save();
    scheduleFit();

    if (animate && state.fade) {
      el.clock.classList.remove('fade');
      void el.clock.offsetWidth;        // 重啟 CSS animation 的老招
      el.clock.classList.add('fade');
    }
  }

  // 依目前顯示的內容決定要藏什麼、按鈕寫什麼、字級用哪一檔
  function syncViewUI() {
    const v = state.view;
    const isClock = v === 'clock';

    el.date.hidden = !(isClock && state.showDate);
    el.tz.hidden = !(isClock && state.showTz);
    el.ampm.hidden = !isClock;
    el.s.hidden = isClock && !state.showSeconds;
    el.sep2.hidden = el.s.hidden;
    el.ms.hidden = !state.showMs;

    el.actions.hidden = isClock;
    el.laps.hidden = !(v === 'stopwatch' && state.showLaps && sw.laps.length);
    el.progress.hidden = !(v === 'timer' && cd.total > 0);
    el.presets.hidden = !(v === 'timer' && !cd.running);

    if (!state.blink || !isClock) {
      last.sep = null;
      el.sep1.classList.remove('off');
      el.sep2.classList.remove('off');
    }

    let status = '';
    if (v === 'stopwatch') {
      el.aPrimary.textContent = sw.running ? '暫停' : (sw.accum > 0 ? '繼續' : '開始');
      el.aSecond.textContent = '計圈';
      el.aSecond.hidden = false;
      el.aSecond.disabled = !sw.running;
      el.aReset.disabled = sw.running || swElapsed() === 0;
      if (!sw.running && sw.accum > 0) status = '暫停中';
    } else if (v === 'timer') {
      const left = cdRemain();
      el.aPrimary.textContent = cd.running ? '暫停' : (left > 0 && left < cd.total ? '繼續' : '開始');
      el.aPrimary.disabled = left <= 0;
      el.aSecond.textContent = '+1 分';
      el.aSecond.hidden = false;
      el.aSecond.disabled = false;
      el.aReset.disabled = cd.total === 0;
      status = cd.done ? '時間到' : (!cd.running && left > 0 && left < cd.total ? '暫停中' : '');
    }
    if (v !== 'timer') el.aPrimary.disabled = false;
    put(el.status, 'status', status);
    el.status.hidden = !status;

    drawLaps();

    // 標出目前選的預設時間
    const sec = cd.total / 1000;
    el.presets.querySelectorAll('button[data-sec]').forEach((btn) =>
      btn.classList.toggle('on', v === 'timer' && +btn.dataset.sec === sec));

    // 字級檔位：算目前實際會顯示幾個字元
    const showH = v === 'clock' ? true : breakdown(v === 'stopwatch' ? swElapsed() : cdRemain()).h !== null;
    const chars = (showH ? 3 : 0) + 2 + (el.s.hidden ? 0 : 3) + (state.showMs ? 4 : 0);
    const tier = TIERS.find((t) => chars >= t.min);
    if (last.tier !== tier.base) {
      last.tier = tier.base;
      el.root.style.setProperty('--base', tier.base);
      el.root.style.setProperty('--base-land', tier.land);
      scheduleFit();
    }
  }

  mq.addEventListener('change', () => { if (state.mode === 'auto') apply(false); });

  /* ---------- 自動縮放：保證任何設定組合都塞得下 ---------- */
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
  // 秒錶跨過一小時、倒數位數變化時，字級檔位要跟著換
  setInterval(() => { if (state.view !== 'clock') syncViewUI(); }, 1000);

  /* ===================== 設定頁控制項 ===================== */
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

  /* ===================== 設定頁開關 ===================== */
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
    } catch { /* iOS Safari 沒這個 API，裝成 App 後本來就全螢幕 */ }
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

  /* ===================== 主要動作 ===================== */
  const primary = () => (state.view === 'timer' ? cdToggle() : state.view === 'stopwatch' ? swToggle() : null);
  const second = () => (state.view === 'timer' ? cdAdd(60) : state.view === 'stopwatch' ? swLap() : null);
  const doReset = () => (state.view === 'timer' ? cdReset() : state.view === 'stopwatch' ? swReset() : null);

  const setView = (v) => { state.view = v; apply(true); };

  /* ===================== 快捷鍵 ===================== */
  const keys = {
    '1': () => setView('clock'),
    '2': () => setView('stopwatch'),
    '3': () => setView('timer'),
    ' ': primary,
    'l': second,
    'r': doReset,
    'f': toggleFullscreen,
    'h': () => { state.hour12 = !state.hour12; apply(true); },
    'm': () => { state.showMs = !state.showMs; apply(true); },
    's': () => { state.showSeconds = !state.showSeconds; apply(true); },
    'c': () => { state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]; apply(true); },
    'd': () => { state.mode = state.mode === 'dark' ? 'light' : 'dark'; apply(true); },
    'k': () => { state.wake = !state.wake; apply(true); },
    ',': toggleSheet,
  };

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'Escape') { if (sheetOpen) { ev.preventDefault(); closeSheet(); } return; }
    if (sheetOpen) return;                          // 設定頁開著時不搶鍵盤
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select') return; // 正在打字也不搶
    const fn = keys[ev.key.length === 1 ? ev.key.toLowerCase() : ev.key];
    if (fn) { ev.preventDefault(); fn(); }
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

  el.aPrimary.addEventListener('click', primary);
  el.aSecond.addEventListener('click', second);
  el.aReset.addEventListener('click', doReset);

  el.presets.querySelectorAll('button[data-sec]').forEach((b) =>
    b.addEventListener('click', () => cdSet(+b.dataset.sec)));
  el.cSet.addEventListener('click', () => {
    const sec = (+el.cH.value || 0) * 3600 + (+el.cM.value || 0) * 60 + (+el.cS.value || 0);
    if (sec > 0) cdSet(sec);
  });
  [el.cH, el.cM, el.cS].forEach((i) => i.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el.cSet.click();
  }));

  // 分頁被切走或關掉時把進度存起來，回來才接得上
  addEventListener('pagehide', saveRuntime);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveRuntime();
    else syncWakeLock();                 // 瀏覽器會自動釋放 Wake Lock，回來要重拿
  });

  buildTzList();
  loadRuntime();
  bindControls();
  apply(false);
  if (alarmOnLoad) fireAlarm();
  requestAnimationFrame(tick);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
