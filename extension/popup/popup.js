/* =========================================================
   Ticket Radar — 設定面板
   流程：授權網站 → 校時 → 設開賣倒數 → 選區塊 → 開始盯哨
   ========================================================= */
'use strict';

const $ = (id) => document.getElementById(id);

const DEFAULT_KEYWORDS = {
  appear: '立即購買, 選位, 可售, 加入購物車',
  disappear: '售完, 已售完, Sold Out, 無票',
  any: '',
};

let tab = null;
let origin = null;
let watches = {};
let clocks = {};
let target = null;
let settings = { sound: true, notify: true, focusTab: true };
let formDirty = false;   // 盯哨條件被手動改過沒

/* ---------- 小工具 ---------- */
let toastTimer = null;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const send = (msg) => chrome.runtime.sendMessage(msg);

/* datetime-local 用的是本機時間字串，跟時間戳來回換算 */
function toLocalInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 19);
}
const fromLocalInput = (v) => (v ? new Date(v).getTime() : NaN);

/* ---------- 讀取狀態 ---------- */
async function loadState() {
  const s = await chrome.storage.local.get({
    watches: {}, clocks: {}, target: null,
    settings: { sound: true, notify: true, focusTab: true },
  });
  watches = s.watches; clocks = s.clocks; target = s.target; settings = s.settings;
}

const cfg = () => watches[origin] || {};

async function saveWatch(patch) {
  watches[origin] = { ...cfg(), origin, ...patch };
  await chrome.storage.local.set({ watches });
}

/* ---------- 授權 ---------- */
const originPattern = () => `${origin}/*`;

async function hasPermission() {
  return chrome.permissions.contains({ origins: [originPattern()] });
}

async function ensureInjected() {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
  } catch {
    // 註冊的內容腳本只對之後的載入生效，所以現在這個分頁要手動塞一次
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/watcher.js'] });
  }
}

async function grant() {
  const ok = await chrome.permissions.request({ origins: [originPattern()] });
  if (!ok) return toast('沒有授權，就沒辦法在這個網站運作', true);
  await send({ type: 'register-origin', origin });
  await ensureInjected();
  toast('已在這個網站啟用');
  render();
}

/* ---------- 校時 ---------- */
async function syncClock() {
  if (!(await hasPermission())) return toast('請先按上面的「在這個網站啟用」', true);
  $('sync').disabled = true;
  $('sync').textContent = '對時中…';
  const res = await send({ type: 'sync-clock', origin });
  $('sync').disabled = false;
  $('sync').textContent = '重新對時';
  if (!res?.ok) return toast(res?.error || '對時失敗', true);
  await loadState();
  render();
  toast('對時完成');
}

function renderClock() {
  const c = clocks[origin];
  const box = $('offset');
  const meta = $('offset-meta');
  if (!c) {
    box.textContent = '尚未校時';
    box.classList.remove('ok');
    meta.textContent = '跟售票站對一次時間，就知道你的電腦快了還是慢了幾毫秒。';
    $('sync').textContent = '跟這個網站對時';
    return;
  }
  const o = c.offset;
  box.textContent = Math.abs(o) < 5 ? '幾乎沒有誤差' : `你的電腦${o > 0 ? '慢' : '快'} ${Math.abs(o)} ms`;
  box.classList.toggle('ok', Math.abs(o) < 50);
  const parts = [`取樣 ${c.samples} 次`];
  if (c.rtt != null) parts.push(`最快來回 ${c.rtt}ms`);
  if (c.spread != null) parts.push(`誤差 ±${Math.round(c.spread / 2)}ms`);
  parts.push(c.method);
  meta.textContent = parts.join(' · ');
  $('sync').textContent = '重新對時';
}

/* ---------- 開賣倒數 ---------- */
async function setTarget() {
  const at = fromLocalInput($('t-at').value);
  if (!Number.isFinite(at)) return toast('請先填開賣時間', true);
  target = { at, label: $('t-label').value.trim() || '開賣' };
  await chrome.storage.local.set({ target });
  await send({ type: 'schedule-target', target });
  render();
  toast('倒數已設定');
}

async function clearTarget() {
  target = null;
  await chrome.storage.local.set({ target: null });
  await send({ type: 'schedule-target', target: null });
  render();
  toast('倒數已清除');
}

function renderTarget() {
  const c = clocks[origin];
  const offset = c ? c.offset : 0;
  if (target?.at) {
    // 這個函式每 0.5 秒跑一次，正在打字的欄位不要蓋掉
    if (document.activeElement !== $('t-label')) $('t-label').value = target.label || '';
    if (document.activeElement !== $('t-at')) $('t-at').value = toLocalInput(target.at);
    const left = target.at - (Date.now() + offset);
    $('t-now').textContent = left > 0
      ? `站方時間還有 ${Math.floor(left / 60000)} 分 ${Math.floor(left / 1000) % 60} 秒`
      : '這個時間已經過了';
  } else {
    $('t-now').textContent = c
      ? '倒數會用校正後的站方時間，不是你電腦的時間。'
      : '建議先校時，倒數才準。';
  }
}

/* ---------- 盯哨 ---------- */
async function pick() {
  if (!(await hasPermission())) return toast('請先按上面的「在這個網站啟用」', true);
  await ensureInjected();
  await chrome.tabs.sendMessage(tab.id, { type: 'pick' });
  window.close();   // 關掉面板，讓使用者可以在頁面上點
}

async function startWatch() {
  if (!(await hasPermission())) return toast('請先按上面的「在這個網站啟用」', true);
  if (!cfg().selector) return toast('請先選一個要盯的區塊', true);
  await ensureInjected();

  const seconds = Math.max(5, Math.min(120, Number($('rl-sec').value) || 10));
  formDirty = false;
  await saveWatch({
    active: true,
    label: target?.label || new URL(origin).hostname,
    mode: $('mode').value,
    keywords: $('keywords').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    reload: {
      enabled: $('rl-on').checked,
      seconds,
      until: Date.now() + 30 * 60000,
    },
  });
  render();
  toast('盯哨開始');
}

async function stopWatch() {
  await saveWatch({ active: false });
  render();
  toast('已停止');
}

function renderWatch() {
  const c = cfg();
  const pv = $('preview');
  if (c.selector) {
    pv.classList.add('set');
    pv.textContent = c.preview ? `已選：${c.preview}` : `已選：${c.selector}`;
  } else {
    pv.classList.remove('set');
    pv.textContent = '還沒選。按上面的按鈕，然後在頁面上點你要盯的那一塊（例如座位圖、張數、購買按鈕）。';
  }

  // 使用者手動改過條件之後，就不要再被 storage 的舊值蓋回去
  if (!formDirty) {
    $('mode').value = c.mode || 'appear';
    $('keywords').value = (c.keywords || []).join(', ') || DEFAULT_KEYWORDS[$('mode').value];
    $('rl-on').checked = !!c.reload?.enabled;
    $('rl-sec').value = c.reload?.seconds || 10;
  }
  $('kw-field').classList.toggle('hidden', $('mode').value === 'any');
  $('rl-row').classList.toggle('hidden', !$('rl-on').checked);

  $('start').disabled = !!c.active;
  $('stop').disabled = !c.active;
  $('watch-state').textContent = c.active
    ? '進行中。詳細狀態看頁面右下角的小面板。'
    : '沒在跑。';
}

/* ---------- 提醒設定 ---------- */
async function saveSettings() {
  settings = {
    sound: $('s-sound').checked,
    notify: $('s-notify').checked,
    focusTab: $('s-focus').checked,
  };
  await chrome.storage.local.set({ settings });
}

/* ---------- 總繪製 ---------- */
async function render() {
  $('origin').textContent = origin;
  const ok = await hasPermission();
  $('grant').classList.toggle('hidden', ok);
  $('grant').disabled = false;

  $('s-sound').checked = settings.sound !== false;
  $('s-notify').checked = settings.notify !== false;
  $('s-focus').checked = settings.focusTab !== false;

  renderClock();
  renderTarget();
  renderWatch();
}

/* ---------- 啟動 ---------- */
(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (!/^https?:\/\//.test(url)) {
    $('unsupported').classList.remove('hidden');
    return;
  }
  origin = new URL(url).origin;
  $('main').classList.remove('hidden');

  await loadState();
  await render();

  $('grant').addEventListener('click', grant);
  $('sync').addEventListener('click', syncClock);
  $('t-set').addEventListener('click', setTarget);
  $('t-clear').addEventListener('click', clearTarget);
  $('pick').addEventListener('click', pick);
  $('start').addEventListener('click', startWatch);
  $('stop').addEventListener('click', stopWatch);

  for (const id of ['mode', 'keywords', 'rl-on', 'rl-sec']) {
    $(id).addEventListener('input', () => { formDirty = true; });
  }
  $('mode').addEventListener('change', () => {
    $('keywords').value = DEFAULT_KEYWORDS[$('mode').value];
    $('kw-field').classList.toggle('hidden', $('mode').value === 'any');
  });
  $('rl-on').addEventListener('change', () => {
    $('rl-row').classList.toggle('hidden', !$('rl-on').checked);
  });
  for (const id of ['s-sound', 's-notify', 's-focus']) {
    $(id).addEventListener('change', saveSettings);
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    await loadState();
    render();
  });

  setInterval(renderTarget, 500);
})();
