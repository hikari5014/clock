/* =========================================================
   Ticket Radar — Service Worker
   負責三件事：
     1) 校時：跟售票站對時，算出「我的電腦快了/慢了幾毫秒」
     2) 排程：開賣前的提醒鬧鐘（分頁在背景也叫得醒）
     3) 警報：通知、警報音（透過 offscreen 文件播）、把分頁叫到前景
   這裡不會、也不該出現任何「自動點擊 / 自動送出」的程式碼。
   ========================================================= */
'use strict';

const HARD_MIN_RELOAD_SEC = 5;    // 自動重整的硬性下限，UI 不開放調更低
const RELOAD_MAX_MINUTES  = 30;   // 自動重整最多跑這麼久，避免無人看管一直打人家伺服器
const SYNC_SAMPLES        = 7;    // 校時取樣次數

/* ---------- 儲存小工具 ---------- */
const load = (k, d) => chrome.storage.local.get({ [k]: d }).then((o) => o[k]);
const save = (k, v) => chrome.storage.local.set({ [k]: v });

/* =====================================================================
   校時
   ---------------------------------------------------------------------
   HTTP 回應的 Date 標頭只到「秒」，而且封包在路上還會花時間。
   所以每一次取樣其實只給出一個「範圍」，不是一個準確值：

     真正的伺服器時間 T ∈ [stamp, stamp + 1000)
     這個時間點對應的本機時間 ∈ [t0, t1]     （t0 送出、t1 收到）
     => offset = T - 本機  ∈ [stamp - t1, stamp + 1000 - t0]

   多取幾次，把這些範圍「交集」起來，區間就會越縮越小。
   取中點就是我們的估計值，區間寬度就是誤差上限。
   ===================================================================== */
async function syncClock(origin) {
  let lo = -Infinity, hi = Infinity;
  const rough = [];
  let bestRtt = Infinity;

  for (let i = 0; i < SYNC_SAMPLES; i++) {
    let t0, t1, res;
    try {
      t0 = Date.now();
      res = await fetch(`${origin}/?_tr=${t0}${Math.random().toString(36).slice(2)}`, {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'omit',   // 不帶 cookie：不碰使用者的登入狀態
        redirect: 'follow',
      });
      t1 = Date.now();
    } catch {
      continue;               // 單次失敗就跳過，不中斷整輪
    }

    const header = res.headers.get('date');
    const stamp = header ? Date.parse(header) : NaN;
    if (!Number.isFinite(stamp)) continue;

    const rtt = t1 - t0;
    if (rtt > 3000) continue;  // 太慢的樣本沒有參考價值

    bestRtt = Math.min(bestRtt, rtt);
    lo = Math.max(lo, stamp - t1);
    hi = Math.min(hi, stamp + 1000 - t0);
    rough.push(stamp + 500 - (t0 + rtt / 2));   // 退路用：假設剛好落在那一秒中間

    await new Promise((r) => setTimeout(r, 120));
  }

  if (!rough.length) throw new Error('拿不到伺服器時間（可能被 CDN 擋掉或沒有 Date 標頭）');

  let offset, spread, method;
  if (lo <= hi) {
    offset = Math.round((lo + hi) / 2);
    spread = Math.round(hi - lo);
    method = '區間交集';
  } else {
    // 區間兜不起來：通常是中途被導到不同節點，或本機時間在取樣途中被改了
    rough.sort((a, b) => a - b);
    offset = Math.round(rough[rough.length >> 1]);
    spread = null;
    method = '中位數（區間不一致）';
  }

  const result = {
    offset, spread, method,
    rtt: bestRtt === Infinity ? null : bestRtt,
    samples: rough.length,
    at: Date.now(),
  };
  const clocks = await load('clocks', {});
  clocks[origin] = result;
  await save('clocks', clocks);
  return result;
}

/* ---------- 警報音（MV3 的 service worker 不能播聲音，要借 offscreen 文件） ---------- */
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: '票出現或開賣時播放警報音',
    });
  } catch {
    /* 併發呼叫時會說已經有了，忽略 */
  }
}

async function alarmSound(pattern = 'hit') {
  const settings = await load('settings', {});
  if (settings.sound === false) return;
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'offscreen-beep', pattern }).catch(() => {});
}

/* ---------- 通知 ---------- */
const notifyTargets = new Map();   // notificationId -> tabId

async function notify({ title, message, tabId, priority = 2 }) {
  const settings = await load('settings', {});
  if (settings.notify === false) return;
  const id = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-192.png'),
    title,
    message,
    priority,
    requireInteraction: true,
  });
  if (tabId != null) notifyTargets.set(id, tabId);
}

chrome.notifications.onClicked.addListener(async (id) => {
  const tabId = notifyTargets.get(id);
  chrome.notifications.clear(id);
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch { /* 分頁已經關了 */ }
});

/* ---------- 把分頁叫到前景 ---------- */
async function focusTab(tabId) {
  const settings = await load('settings', {});
  if (settings.focusTab === false || tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch { /* 分頁沒了 */ }
}

/* ---------- 開賣前的提醒鬧鐘 ----------
   chrome.alarms 在短間隔會被 Chrome 壓成 ~1 分鐘，
   所以這裡只負責「還有幾分鐘」等級的提醒，
   最後那幾秒的精準倒數交給頁面上的 content script 做。          */
const PRE_ALERTS = [
  { name: 'tr-pre-600', lead: 600_000, text: '還有 10 分鐘開賣，先確認已經登入、付款方式也選好了' },
  { name: 'tr-pre-120', lead: 120_000, text: '還有 2 分鐘開賣，把分頁切到前景' },
];

async function scheduleTarget(target) {
  await Promise.all(PRE_ALERTS.map((a) => chrome.alarms.clear(a.name)));
  if (!target?.at) return;
  for (const a of PRE_ALERTS) {
    const when = target.at - a.lead;
    if (when > Date.now() + 1000) chrome.alarms.create(a.name, { when });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const hit = PRE_ALERTS.find((a) => a.name === alarm.name);
  if (!hit) return;
  const target = await load('target', null);
  if (!target?.at) return;
  await notify({ title: target.label || '開賣提醒', message: hit.text, priority: 1 });
  await alarmSound('pre');
});

/* ---------- 徽章：讓人一眼知道雷達開著沒 ---------- */
async function refreshBadge() {
  const watches = await load('watches', {});
  const on = Object.values(watches).filter((w) => w.active).length;
  chrome.action.setBadgeText({ text: on ? String(on) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
}

/* ---------- 內容腳本的註冊 / 反註冊 ----------
   只在使用者明確授權的網域註冊，不是全站亂灌。                */
const scriptId = (origin) => `tr-${origin.replace(/[^a-zA-Z0-9]+/g, "-")}`;

async function registerFor(origin) {
  const id = scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([{
    id,
    matches: [`${origin}/*`],
    js: ['content/watcher.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  }]);
}

async function unregisterFor(origin) {
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] }).catch(() => {});
}

/* ---------- 訊息路由 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type.startsWith('offscreen-')) return;   // 那是給 offscreen 文件的

  (async () => {
    switch (msg.type) {
      case 'sync-clock':
        return { ok: true, data: await syncClock(msg.origin) };

      case 'register-origin':
        await registerFor(msg.origin);
        return { ok: true };

      case 'unregister-origin':
        await unregisterFor(msg.origin);
        await refreshBadge();
        return { ok: true };

      case 'schedule-target':
        await scheduleTarget(msg.target);
        return { ok: true };

      case 'badge':
        await refreshBadge();
        return { ok: true };

      /* 盯哨命中：聲音 + 通知 + 把分頁叫過來 */
      case 'hit': {
        const tabId = sender.tab?.id;
        await Promise.all([
          alarmSound('hit'),
          notify({ title: msg.title || '有動靜！', message: msg.message || '', tabId }),
          focusTab(tabId),
        ]);
        return { ok: true };
      }

      /* 倒數歸零 */
      case 'open-now': {
        const tabId = sender.tab?.id;
        await Promise.all([
          alarmSound('open'),
          notify({ title: msg.title || '開賣了', message: msg.message || '', tabId }),
          focusTab(tabId),
        ]);
        return { ok: true };
      }

      case 'limits':
        return { ok: true, data: { HARD_MIN_RELOAD_SEC, RELOAD_MAX_MINUTES } };

      default:
        return { ok: false, error: `不認得的訊息：${msg.type}` };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));

  return true;   // 非同步回覆
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watches) refreshBadge();
});

chrome.runtime.onStartup.addListener(refreshBadge);
chrome.runtime.onInstalled.addListener(refreshBadge);
