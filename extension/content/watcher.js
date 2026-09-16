/* =========================================================
   Ticket Radar — 頁面端（content script）
   做四件事：
     1) 浮出一個小面板，顯示「校正後的伺服器時間」與開賣倒數
     2) 讓使用者用滑鼠點選要盯的區塊，記住它的位置
     3) 用 MutationObserver 盯那塊 DOM —— 順著網站自己的更新看，
        不額外打對方 API，網站完全感覺不到我們
     4) 有動靜就閃畫面、改分頁標題、請背景播警報音

   這裡沒有、也不會有任何自動點擊、自動選位、自動送出的程式碼。
   ========================================================= */
(() => {
  'use strict';

  if (window.__ticketRadarLoaded) return;
  window.__ticketRadarLoaded = true;

  const ORIGIN = location.origin;
  const HARD_MIN_RELOAD_SEC = 5;
  const HIT_COOLDOWN_MS = 8000;
  const SEP = String.fromCharCode(1);   // 快照裡用來隔開「文字」與「幾個按不下去的東西」

  let cfg = null;                       // 這個網域的盯哨設定
  let target = null;                    // { at, label }
  let clockInfo = { offset: 0 };        // 校時結果

  let node = null, observer = null, rebindTimer = null, reloadTimer = null;
  let lastHit = 0, hits = 0, openFired = false, openTimer = null;

  /* 校正後的「售票站現在幾點」。
     這是時鐘不是碼表，所以每幀重讀 Date.now()，分頁切走再回來也不會跑掉。 */
  const serverNow = () => Date.now() + (clockInfo.offset || 0);

  /* ===================== 小工具 ===================== */
  const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

  function fmtClock(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function fmtDelta(ms) {
    const sign = ms < 0 ? '-' : '';
    const a = Math.abs(ms);
    const d = Math.floor(a / 86400000);
    const h = Math.floor(a / 3600000) % 24;
    const m = Math.floor(a / 60000) % 60;
    const s = Math.floor(a / 1000) % 60;
    const msec = Math.floor(a % 1000);
    const head = d > 0 ? `${d}天 ` : '';
    return `${sign}${head}${pad(h)}:${pad(m)}:${pad(s)}.${pad(msec, 3)}`;
  }

  /* 產生一條可以再查回來的 CSS 路徑。優先用 id，沒有就用 nth-of-type 往上疊。 */
  function cssPath(start) {
    if (!start || start.nodeType !== 1) return null;
    const parts = [];
    let el = start;
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(el.id)}`);
        return parts.join(' > ');
      }
      let part = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = parent;
    }
    parts.unshift('html');
    return parts.join(' > ');
  }

  /* 這塊區域「長什麼樣子」。除了文字，也把「有幾個按不下去的東西」算進去——
     按鈕從 disabled 變成可以按，是票放出來最典型的訊號之一。 */
  function snapshotOf(n) {
    if (!n) return '';
    const text = (n.innerText ?? n.textContent ?? '').replace(/\s+/g, ' ').trim();
    let disabled = 0;
    try { disabled = n.querySelectorAll('[disabled], [aria-disabled="true"]').length; } catch { /* noop */ }
    return `${text}${SEP}${disabled}`;
  }

  const snapKey = (sel = cfg?.selector || '') => `__tr_snap_${ORIGIN}_${sel}`;

  function readSnap() {
    try { return sessionStorage.getItem(snapKey()); } catch { return null; }
  }
  function writeSnap(v) {
    try { sessionStorage.setItem(snapKey(), v); } catch { /* 無痕模式可能會擋 */ }
  }

  /* ===================== 面板（放在 Shadow DOM 裡，不會被網站的 CSS 汙染） ===================== */
  const host = document.createElement('div');
  host.id = '__ticket_radar_host';
  host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
      .panel {
        min-width: 232px; padding: 10px 12px; border-radius: 12px;
        background: rgba(17,17,20,.94); color: #e8e8ea;
        border: 1px solid rgba(255,255,255,.14);
        box-shadow: 0 10px 34px rgba(0,0,0,.45);
        font-size: 12px; line-height: 1.5;
      }
      .head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
      .dot { width:8px; height:8px; border-radius:50%; background:#555; flex:none; }
      .dot.on { background:#22c55e; box-shadow:0 0 8px #22c55e; }
      .name { font-weight:700; letter-spacing:.04em; flex:1; font-size:11px; opacity:.85; }
      .mini { border:0; background:transparent; color:#999; cursor:pointer; font-size:14px; padding:0 2px; }
      .mini:hover { color:#fff; }
      .row { display:flex; justify-content:space-between; gap:10px; }
      .k { opacity:.55; }
      .v { font-variant-numeric: tabular-nums; }
      .big { font-size:20px; font-weight:700; font-variant-numeric: tabular-nums; letter-spacing:.02em; margin:2px 0; }
      .big.hot { color:#fb7185; }
      .big.go  { color:#4ade80; }
      .foot { margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,.1); display:flex; gap:6px; }
      button.act { flex:1; border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.06);
                   color:#e8e8ea; border-radius:8px; padding:4px 6px; cursor:pointer; font-size:11px; }
      button.act:hover { background:rgba(255,255,255,.14); }
      .note { margin-top:6px; font-size:10px; opacity:.45; }
      .hidden { display:none; }
      .collapsed .body, .collapsed .foot, .collapsed .note { display:none; }
    </style>
    <div class="panel" id="panel">
      <div class="head">
        <span class="dot" id="dot"></span>
        <span class="name">搶票雷達</span>
        <button class="mini" id="fold" title="收合">-</button>
      </div>
      <div class="body" id="body">
        <div class="row"><span class="k">站方時間</span><span class="v" id="srv">--:--:--.---</span></div>
        <div class="row"><span class="k">本機偏差</span><span class="v" id="off">尚未校時</span></div>
        <div id="cdwrap" class="hidden">
          <div class="big" id="cd">--:--:--.---</div>
          <div class="row"><span class="k" id="cdlabel">距離開賣</span><span class="v" id="cdat"></span></div>
        </div>
        <div class="row"><span class="k">盯哨</span><span class="v" id="watch">未啟用</span></div>
      </div>
      <div class="foot hidden" id="foot">
        <button class="act" id="stop">停止盯哨</button>
      </div>
      <div class="note">只提醒，不代按</div>
    </div>`;

  const $ = (id) => root.getElementById(id);
  const ui = {
    panel: $('panel'), dot: $('dot'), srv: $('srv'), off: $('off'),
    cdwrap: $('cdwrap'), cd: $('cd'), cdlabel: $('cdlabel'), cdat: $('cdat'),
    watch: $('watch'), stop: $('stop'), fold: $('fold'), foot: $('foot'),
  };

  /* 只有真的有東西要顯示（在盯哨、或設了開賣倒數）才掛面板，
     不然使用者授權過的網站每一頁都會多一個浮窗，很煩。 */
  function syncHud() {
    const wanted = !!(cfg?.selector || cfg?.active || target?.at);
    if (wanted && !host.isConnected) (document.body || document.documentElement).appendChild(host);
    else if (!wanted && host.isConnected) host.remove();
    return wanted;
  }

  ui.fold.addEventListener('click', () => {
    const c = ui.panel.classList.toggle('collapsed');
    ui.fold.textContent = c ? '+' : '-';
  });

  ui.stop.addEventListener('click', async () => {
    const { watches } = await chrome.storage.local.get({ watches: {} });
    if (watches[ORIGIN]) {
      watches[ORIGIN].active = false;
      await chrome.storage.local.set({ watches });
    }
  });

  /* ===================== 命中時的警報 ===================== */
  let flashEl = null;
  function flash() {
    if (!flashEl || !flashEl.isConnected) {
      flashEl = document.createElement('div');
      flashEl.style.cssText =
        'all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;' +
        'background:rgba(34,197,94,.30);opacity:0;transition:opacity .12s;';
      (document.body || document.documentElement).appendChild(flashEl);
    }
    let n = 0;
    const blink = () => {
      flashEl.style.opacity = n % 2 ? '0' : '1';
      if (++n < 8) setTimeout(blink, 140);
      else flashEl.style.opacity = '0';
    };
    blink();
  }

  let titleTimer = null;
  const originalTitle = document.title;
  function shoutTitle(text) {
    clearInterval(titleTimer);
    let on = false;
    titleTimer = setInterval(() => {
      document.title = (on = !on) ? `(!) ${text}` : originalTitle;
    }, 700);
    setTimeout(() => { clearInterval(titleTimer); document.title = originalTitle; }, 30000);
  }

  function fireHit(reason) {
    const now = Date.now();
    if (now - lastHit < HIT_COOLDOWN_MS) return;
    lastHit = now;
    hits += 1;

    // 有動靜了，人要開始操作了 —— 立刻停掉自動重整，別把使用者的頁面洗掉
    clearTimeout(reloadTimer);
    reloadTimer = null;

    flash();
    shoutTitle('有票了？');
    chrome.runtime.sendMessage({
      type: 'hit',
      title: `有動靜：${cfg?.label || ORIGIN}`,
      message: reason,
    }).catch(() => {});
    renderWatchState();
  }

  function fireOpen() {
    if (openFired) return;
    openFired = true;
    flash();
    shoutTitle('開賣了');
    chrome.runtime.sendMessage({
      type: 'open-now',
      title: target?.label || '開賣了',
      message: '現在是站方時間的開賣時刻',
    }).catch(() => {});
  }

  /* ===================== 盯哨 ===================== */
  function matchReason(prev, cur) {
    const kws = (cfg.keywords || []).filter(Boolean);
    if (cfg.mode === 'appear') {
      for (const k of kws) if (cur.includes(k) && !prev.includes(k)) return `出現了「${k}」`;
      return null;
    }
    if (cfg.mode === 'disappear') {
      for (const k of kws) if (!cur.includes(k) && prev.includes(k)) return `「${k}」不見了`;
      return null;
    }
    return prev === cur ? null : '盯著的區塊內容變了';
  }

  let checkQueued = false;
  function queueCheck() {
    if (checkQueued) return;
    checkQueued = true;
    requestAnimationFrame(() => {
      checkQueued = false;
      if (!node || !cfg?.active) return;
      const cur = snapshotOf(node);
      const prev = readSnap();
      writeSnap(cur);
      if (prev === null) return;               // 第一次只記錄，不當成變化
      const reason = matchReason(prev, cur);
      if (reason) fireHit(reason);
    });
  }

  function bind() {
    if (!cfg?.active || !cfg.selector) return;
    let found = null;
    try { found = document.querySelector(cfg.selector); } catch { found = null; }
    if (found === node) return;

    observer?.disconnect();
    node = found;
    if (!node) { renderWatchState(); return; }

    observer = new MutationObserver(queueCheck);
    observer.observe(node, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class', 'style'],
    });
    queueCheck();
    renderWatchState();
  }

  function stopWatching() {
    observer?.disconnect();
    observer = null;
    node = null;
    clearInterval(rebindTimer); rebindTimer = null;
    clearTimeout(reloadTimer); reloadTimer = null;
    renderWatchState();
  }

  function startWatching() {
    stopWatching();
    bind();
    // 售票網站常常整塊重畫，節點會被換掉，所以定期確認還抓不抓得到
    rebindTimer = setInterval(bind, 2000);
    scheduleReload();
  }

  /* ---------- 有節制的自動重整 ----------
     只在「頁面自己完全不會更新」時才需要。
     下限 5 秒寫死在程式裡，加隨機抖動，而且最多跑 30 分鐘就自己關掉。 */
  async function scheduleReload() {
    clearTimeout(reloadTimer);
    if (!cfg?.active || !cfg.reload?.enabled) return;

    if (Date.now() > (cfg.reload.until || 0)) {
      const { watches } = await chrome.storage.local.get({ watches: {} });
      if (watches[ORIGIN]?.reload) {
        watches[ORIGIN].reload.enabled = false;
        await chrome.storage.local.set({ watches });
      }
      return;
    }

    const base = Math.max(HARD_MIN_RELOAD_SEC, Number(cfg.reload.seconds) || HARD_MIN_RELOAD_SEC) * 1000;
    const wait = Math.round(base * (0.85 + Math.random() * 0.3));
    reloadTimer = setTimeout(() => {
      const ae = document.activeElement;
      const typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
      if (typing) return scheduleReload();     // 使用者正在打字，不要洗掉他的輸入
      location.reload();
    }, wait);
  }

  /* ===================== 選取區塊 ===================== */
  let picking = false;

  function startPicking() {
    if (picking) return;
    picking = true;

    const box = document.createElement('div');
    box.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;pointer-events:none;' +
      'border:2px solid #22c55e;background:rgba(34,197,94,.16);border-radius:4px;transition:all .06s;';
    const tip = document.createElement('div');
    tip.textContent = '點一下要盯的區塊（Esc 取消）';
    tip.style.cssText =
      'all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
      'z-index:2147483647;pointer-events:none;padding:8px 14px;border-radius:999px;' +
      'background:#111;color:#fff;font:600 13px/1 ui-monospace,monospace;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.4);';
    document.documentElement.append(box, tip);

    let hovered = null;

    const move = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === host || el === box || el === tip) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, {
        top: `${r.top}px`, left: `${r.left}px`,
        width: `${r.width}px`, height: `${r.height}px`,
      });
      hovered = el;
    };

    const finish = async (el) => {
      picking = false;
      box.remove(); tip.remove();
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      if (!el) return;

      const selector = cssPath(el);
      const preview = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      try { sessionStorage.removeItem(snapKey(selector)); } catch { /* noop */ }
      const { watches } = await chrome.storage.local.get({ watches: {} });
      watches[ORIGIN] = { ...(watches[ORIGIN] || {}), origin: ORIGIN, selector, preview, pickedAt: Date.now() };
      await chrome.storage.local.set({ watches });
    };

    const click = (e) => { e.preventDefault(); e.stopPropagation(); finish(hovered); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  /* ===================== 畫面更新 ===================== */
  function renderWatchState() {
    const on = !!cfg?.active;
    ui.dot.classList.toggle('on', on);
    ui.foot.classList.toggle('hidden', !on);
    if (!cfg?.selector) ui.watch.textContent = '未選區塊';
    else if (!on) ui.watch.textContent = '已停止';
    else if (!node) ui.watch.textContent = '找不到區塊…重試中';
    else ui.watch.textContent = `進行中 · 命中 ${hits} 次`;
  }

  function renderClock() {
    const now = serverNow();
    ui.srv.textContent = fmtClock(now);

    if (clockInfo.at) {
      const o = clockInfo.offset;
      const dir = o > 0 ? '慢' : '快';
      const spread = clockInfo.spread != null ? ` ±${Math.round(clockInfo.spread / 2)}ms` : '';
      ui.off.textContent = Math.abs(o) < 5 ? `幾乎沒差${spread}` : `本機${dir} ${Math.abs(o)}ms${spread}`;
    }

    if (target?.at) {
      ui.cdwrap.classList.remove('hidden');
      const diff = target.at - now;
      ui.cd.textContent = fmtDelta(diff);
      ui.cd.classList.toggle('hot', diff > 0 && diff < 60000);
      ui.cd.classList.toggle('go', diff <= 0);
      ui.cdlabel.textContent = diff > 0 ? '距離開賣' : '已開賣';
      ui.cdat.textContent = target.label || '';
      if (diff <= 0) fireOpen();
    } else {
      ui.cdwrap.classList.add('hidden');
    }
  }

  function loop() {
    renderClock();
    requestAnimationFrame(loop);
  }

  /* ===================== 設定載入 ===================== */
  async function refresh() {
    const s = await chrome.storage.local.get({ watches: {}, clocks: {}, target: null });
    const prevActive = cfg?.active;
    const prevSelector = cfg?.selector;
    const prevReload = JSON.stringify(cfg?.reload || null);

    cfg = s.watches[ORIGIN] || null;
    clockInfo = s.clocks[ORIGIN] || { offset: 0 };

    const next = s.target;
    if (next?.at !== target?.at) {
      openFired = next?.at ? serverNow() >= next.at : false;
      clearTimeout(openTimer);
      openTimer = null;
      if (next?.at) {
        const delay = next.at - serverNow();
        // rAF 在背景分頁不會跑，所以再放一個 timer 當備援
        if (delay > 0) openTimer = setTimeout(fireOpen, delay);
      }
    }
    target = next;

    syncHud();

    if (cfg?.active) {
      if (!observer || prevSelector !== cfg.selector || !prevActive) startWatching();
      else if (prevReload !== JSON.stringify(cfg.reload)) scheduleReload();
    } else if (prevActive) {
      stopWatching();
    }
    renderWatchState();
    renderClock();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') refresh();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'pick') { startPicking(); sendResponse({ ok: true }); }
    else if (msg?.type === 'ping') sendResponse({ ok: true, origin: ORIGIN });
    return true;
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) bind(); });

  refresh();
  requestAnimationFrame(loop);
})();
