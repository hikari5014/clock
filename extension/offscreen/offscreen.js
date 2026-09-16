/* MV3 的 service worker 沒有 DOM，也就不能播聲音。
   所以警報音統一在這個看不見的 offscreen 文件裡用 Web Audio 合成，
   不需要任何音檔，也不受頁面的自動播放限制。 */
'use strict';

let ac = null;

/* 三種節奏：開賣前提醒、盯哨命中、開賣瞬間 */
const PATTERNS = {
  pre:  [{ f: 660, t: 0.00 }, { f: 660, t: 0.30 }],
  hit:  [{ f: 880, t: 0.00 }, { f: 1175, t: 0.16 }, { f: 880, t: 0.32 },
         { f: 1175, t: 0.48 }, { f: 880, t: 0.64 }, { f: 1175, t: 0.80 }],
  open: [{ f: 988, t: 0.00 }, { f: 988, t: 0.18 }, { f: 988, t: 0.36 },
         { f: 1319, t: 0.54, long: true }],
};

function play(pattern) {
  const notes = PATTERNS[pattern] || PATTERNS.hit;
  try {
    const AC = self.AudioContext || self.webkitAudioContext;
    if (!AC) return;
    ac = ac || new AC();
    if (ac.state === 'suspended') ac.resume();

    for (const n of notes) {
      const t = ac.currentTime + n.t;
      const dur = n.long ? 0.9 : 0.28;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = n.f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.3, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.02);
    }
  } catch { /* 沒聲音就算了，通知跟畫面閃爍還在 */ }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'offscreen-beep') play(msg.pattern);
});
