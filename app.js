
"use strict";
/* =========================================================================
   闪卡 · 移动端英语核心词速刷器
   设计依据：检索练习(testing effect) · 间隔效应(spacing) · 二值最小评分
             · 涌现式大量输入 · 自动化调度（用户只做两个动作：看 / 滑）
   ========================================================================= */

/* ------------------------------- 工具 ------------------------------- */
const $ = s => document.querySelector(s);
const DAY = 864e5, MIN = 6e4;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const now = () => Date.now();
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const todayKey = t => { const d = new Date(t || now()); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0, t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* --------------------------- 间隔重复引擎 ---------------------------
   等级 0..7 → 10 分钟 / 1 天 / 3 天 / 7 天 / 16 天 / 40 天 / 100 天 / 250 天
   新词：进入系统时记 3 次"刚接触"，次日首次到期复习
   答对：升级（连对越多升得越快）   答错：降一级并当天重现
------------------------------------------------------------------- */
const LADDER = [10 * MIN, DAY, 3 * DAY, 7 * DAY, 16 * DAY, 40 * DAY, 100 * DAY, 250 * DAY];
const LVNAME = ["10 分钟", "1 天", "3 天", "7 天", "16 天", "40 天", "100 天", "250 天"];
const MASTER_LV = 7, MAX_FAIL = 6;
const DEFAULT_UI = {
  newBudget: 300, revBudget: 600, speakAuto: true, rate: .95, reps: 1, zhTTS: false,
  accent: "en-US", voiceName: "", hideAnswer: true, ipa: false, theme: "auto",
  autoMs: 2600, zhFirst: "mix", voiceMode: "hybrid", srcId: "youdao-us"
};

const S = {
  w: [], d: [], N: 0,
  p: {},                 // 进度：word -> {lv,due,seen,know,again,streak,steps,first,last,type}
  ses: null,             // 当前队列会话
  lib: null,             // 可选外部词典（音标）
  ui: Object.assign({}, DEFAULT_UI),
  stats: { day: todayKey(), rev: 0, again: 0, nw: 0, ms: 0 },
  tts: { supported: typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance !== "undefined", voice: null, zhVoice: null, id: 0, unlocked: false },
  fixed: { order: [], key: "", pos: 0, completed: 0, active: false, revealed: false, auto: false, speak: true, face: "en" }
};
let cur = -1, revealTimer = 0, autoTimer = 0, lastAns = 0;
let fixedTimer = 0;
let normalAutoBeforeFixed = false;
const LSK = k => "lexi." + k;

/* ------------------------------ 持久化 ------------------------------ */
function loadAll() {
  try { S.p = JSON.parse(localStorage.getItem(LSK("prog")) || "{}") || {}; } catch (e) { S.p = {}; }
  try { const u = JSON.parse(localStorage.getItem(LSK("ui")) || "null"); if (u && typeof u === "object") Object.assign(S.ui, u); } catch (e) { }
  try {
    const st = JSON.parse(localStorage.getItem(LSK("stats")) || "null");
    if (st && st.day === todayKey()) S.stats = st;
  } catch (e) { }
  try { const l = JSON.parse(localStorage.getItem(LSK("ipa")) || "null"); if (l && l.w === S.N && l.ipa) S.lib = l; } catch (e) { }
  try {
    const s = JSON.parse(localStorage.getItem(LSK("ses")) || "null");
    if (s && s.day === todayKey() && Array.isArray(s.q) && s.qi < s.q.length && s.t0) S.ses = s;
  } catch (e) { }
  loadFixedState();
}
let saveT = 0;
function saveProgress(force) {
  if (!force && now() - saveT < 1200) return;
  saveT = now();
  try { localStorage.setItem(LSK("prog"), JSON.stringify(S.p)); } catch (e) { }
}
function saveMeta() {
  try {
    localStorage.setItem(LSK("ui"), JSON.stringify(S.ui));
    localStorage.setItem(LSK("stats"), JSON.stringify(S.stats));
    if (S.ses) localStorage.setItem(LSK("ses"), JSON.stringify(S.ses));
    else localStorage.removeItem(LSK("ses"));
  } catch (e) { }
}

/* ---------------------------- 卡片状态机 ---------------------------- */
function newCard() { return { lv: 0, due: 0, seen: 0, know: 0, again: 0, streak: 0, steps: 0, first: 0, last: 0, type: "" }; }
function cardOf(k) { return S.p[k] || (S.p[k] = newCard()); }
function preset(c, t) {
  c.seen = 3; c.steps = 2; c.first = t; c.last = t;
  c.due = startOfDay(t) + DAY + 9 * 36e5;
  return c;
}
const isMaster = c => c.lv >= MASTER_LV;
const cloneC = c => ({ lv: c.lv, due: c.due, seen: c.seen, know: c.know, again: c.again, streak: c.streak, steps: c.steps, first: c.first, last: c.last, type: c.type });
const restoreC = (c, o) => { for (const k in o) c[k] = o[k]; };

function grade(k, ok) {
  const t = now(), c = cardOf(k);
  if (!c.seen) preset(c, t);
  c.seen++; c.last = t;
  if (ok) {
    c.know++; c.streak++;
    const oldLv = c.lv;
    let up = 1;
    if (c.streak >= 3) up++;                                               // 连对加速
    if (c.streak >= 6) up++;
    c.lv = clamp(oldLv + up, 0, MASTER_LV);
    if (oldLv === 0) c.lv = Math.max(c.lv, 2);   // 当天答对过的词：下次直接 3 天后（首次复习隔夜更稳）
    c.due = t + LADDER[c.lv];
  } else {
    c.again++; c.streak = 0; c.steps = 0;
    if (!c.first) c.first = t;
    c.lv = clamp(c.lv - 1, 0, MASTER_LV);
    c.due = t + LADDER[Math.min(c.lv, 1)];       // 答错 → 当天稍后 / 隔天重现
  }
  return c;
}
function pickFace(c) {
  if (c.again >= 2) return Math.random() < .55 ? "zh" : "en";   // 常错的词多逼回忆
  if (!c.again) return Math.random() < .6 ? "en" : "zh";
  return Math.random() < .5 ? "zh" : "en";
}

/* ------------------------- 组卷（当日队列） -------------------------
   进度一律以"单词"为键（不用下标），保证词库更新、增删、重排后进度不丢。
   到期复习优先，其次新词；各按上限截断；各自随机打乱后交错。
-------------------------------------------------------------------- */
function buildQueue() {
  const t = now();
  const rDue = [], rNew = [];
  let due = 0, fresh = 0;
  const limDue = Math.max(0, S.ui.revBudget | 0), limNew = Math.max(0, S.ui.newBudget | 0);
  for (let i = 0; i < S.N; i++) {
    const w = S.w[i], c = S.p[w];
    if (!c || !c.seen) { fresh++; if (rNew.length < limNew) rNew.push(w); continue; }
    if (isMaster(c)) continue;
    if (c.due <= t) { due++; if (rDue.length < limDue) rDue.push(w); }
  }
  shuffle(rDue); shuffle(rNew);
  const q = [];
  let a = 0, b = 0;
  while (a < rDue.length || b < rNew.length) {
    if (a < rDue.length) q.push(rDue[a++]);
    if (b < rNew.length) { q.push(rNew[b++]); if (a < rDue.length && Math.random() < .35) q.push(rDue[a++]); }
  }
  return { q, due, fresh, backlog: Math.max(0, due - rDue.length) + Math.max(0, fresh - rNew.length) };
}
function newSession(extra) {
  const b = buildQueue(), t = now();
  S.ses = Object.assign({
    day: todayKey(), q: b.q, qi: 0, t0: t, graded: 0, again: 0, goal: b.q.length || 1,
    hist: [], due0: b.due, fresh0: b.fresh, backlog: b.backlog
  }, extra || {});
  return S.ses;
}/* 把卡插回队列（当天重现）。约束：
   1) 只插在当前位置之后，绝不插到已走过的槽位；
   2) 剩余队列里同一张卡不得出现两次（重复出卡会打乱间隔节奏）；
   3) 已经排过两次的卡不再排（当天最多三次接触：首次 + 两次重现）。 */
function requeue(w, gap) {
  const s = S.ses; if (!s) return;
  const from = s.qi;
  const existing = s.q.indexOf(w, from);
  if (existing >= 0) return;                            // 已在队列里
  const done = s.seen2 = s.seen2 || {};
  if ((done[w] || 0) >= 2) return;                      // 当天重现额度用完
  done[w] = (done[w] || 0) + 1;
  const at = Math.min(s.q.length, s.qi + Math.max(1, gap || (12 + (Math.random() * 10 | 0))));
  s.q.splice(at, 0, w);
}
function nextWord() {
  const s = S.ses;
  if (!s || s.qi >= s.q.length) return null;
  return s.q[s.qi++];
}

/* -------------------------------- TTS -------------------------------- */
function voiceScore(v, accent) {
  let sc = 0;
  const lang = (v.lang || "").toLowerCase().replace("_", "-");
  if (lang.startsWith(accent.slice(0, 2))) sc += 20;
  if (lang.startsWith(accent.toLowerCase())) sc += 25;
  if (/google/i.test(v.name)) sc += 30;
  if (/natural|neural|premium|enhanced|siri|samantha|daniel|karen|aria/i.test(v.name)) sc += 24;
  if (v.localService) sc += 6;
  if (/compact|espeak|robot|festival/i.test(v.name)) sc -= 30;
  return sc;
}
function loadVoices() {
  if (!S.tts.supported) return;
  const vs = window.speechSynthesis.getVoices() || [];
  if (!vs.length) return;
  const en = vs.filter(v => /^en\b|^en[-_]/i.test(v.lang || ""));
  const zh = vs.filter(v => /^zh\b|^zh[-_]/i.test(v.lang || ""));
  const best = (arr, accent) => arr.slice().sort((a, b) => voiceScore(b, accent) - voiceScore(a, accent))[0] || null;
  S.tts.zhVoice = best(zh, "zh-CN");
  if (S.ui.voiceName) S.tts.voice = vs.find(v => v.name === S.ui.voiceName) || best(en, S.ui.accent);
  else S.tts.voice = best(en, S.ui.accent);
}
if (S.tts.supported) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
  setTimeout(loadVoices, 250); setTimeout(loadVoices, 1000); setTimeout(loadVoices, 2500);
}
function unblockTTS() {
  if (S.tts.unlocked || !S.tts.supported) return;
  S.tts.unlocked = true;
  try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; window.speechSynthesis.speak(u); } catch (e) { }
}
function setSpeaking(on) {
  const c = $("#card");
  if (c) c.classList.toggle("speaking", on);
  const el = $("#tSpeak");
  if (el) el.innerHTML = on ? '<span class="eq"><i></i><i></i><i></i></span>' : "";
}
function speak(text, lang, cb) {
  if (!text || !S.tts.supported) { cb && cb(); return; }
  const id = ++S.tts.id;
  const u = new SpeechSynthesisUtterance(text);
  if (lang === "zh") {
    if (S.tts.zhVoice) { u.voice = S.tts.zhVoice; u.lang = S.tts.zhVoice.lang; } else u.lang = "zh-CN";
  } else {
    if (S.tts.voice) { u.voice = S.tts.voice; u.lang = S.tts.voice.lang; } else u.lang = S.ui.accent || "en-US";
  }
  u.rate = clamp(+S.ui.rate || .95, .5, 1.4);
  let timer = 0;
  const fin = () => {
    clearTimeout(timer);
    if (id !== S.tts.id) return;
    setSpeaking(false);
    cb && cb();
  };
  u.onend = fin; u.onerror = fin;
  try { window.speechSynthesis.cancel(); } catch (e) { }
  setSpeaking(true);
  try { window.speechSynthesis.speak(u); } catch (e) { fin(); return; }
  timer = setTimeout(fin, 900 + text.length * 150);
  S.tts.tmr = timer;
}
function speakCard(w, cb) {
  if (typeof w !== "string") { cb && cb(); return; }
  const token = beginSpeakSession();
  let i = S.w.indexOf(w); if (i < 0) i = 0;
  const d = S.d[i];
  let n = 0;
  const done = () => { if (token === audioGeneration && cb) cb(); };
  const once = () => {
    if (token !== audioGeneration) return;
    n++;
    const more = n < clamp(S.ui.reps | 0, 1, 3);
    sayWord(w, got => {
      if (token !== audioGeneration) return;
      if (!got) {
        speak(w, "en", () => {
          if (token !== audioGeneration) return;
          if (more) { setTimeout(() => { if (token === audioGeneration) once(); }, 180); return; }
          if (S.ui.zhTTS) setTimeout(() => { if (token === audioGeneration) speak(d, "zh", done); }, 160); else done();
        });
        return;
      }
      if (more) { setTimeout(() => { if (token === audioGeneration) once(); }, 180); return; }
      if (S.ui.zhTTS) setTimeout(() => { if (token === audioGeneration) speak(d, "zh", done); }, 160);
      else done();
    });
  };
  once();
}

/* ============================ 真人发音层 ==========================
   优先级：本地真人音频 → 在线音源 → 系统语音。
   每次换词都会使旧的异步播放任务失效，防止上一词的回调在下一词继续播放。
==================================================================== */
const AUDIO_SOURCES = {
  "youdao-us": {
    label: "有道词典 · 美音（真人）",
    url: w => "https://dict.youdao.com/dictvoice?type=2&audio=" + encodeURIComponent(w)
  },
  "youdao-uk": {
    label: "有道词典 · 英音（真人）",
    url: w => "https://dict.youdao.com/dictvoice?type=1&audio=" + encodeURIComponent(w)
  },
  google: {
    label: "Google 语音（非真人）",
    url: w => "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en"
      + (S.ui.accent === "en-GB" ? "-GB" : S.ui.accent === "en-AU" ? "-AU" : "")
      + "&q=" + encodeURIComponent(w)
  },
  baidu: {
    label: "百度语音（非真人）",
    url: w => "https://fanyi.baidu.com/gettts?lan=en&spd=3&source=web&text=" + encodeURIComponent(w)
  }
};
const AUDIO_ORDER = ["youdao-us", "youdao-uk", "google", "baidu"];
let ADB = null;
const aMem = new Map();
const aBusy = new Map();
let aEl = null;
let audioGeneration = 0;
let aCancel = null;
const activeAudio = new Set();

/* 停止当前所有真人音频/系统语音。
   不能只保存“最后一个 audio”：快速重复点发音或异步回退时，
   旧的 HTMLAudioElement 可能已经不再由 aEl 引用，却仍在播放。 */
function stopAudioNow() {
  try { if (aCancel) aCancel(); } catch (e) { }
  aCancel = null;
  activeAudio.forEach(a => {
    try {
      a.onended = a.onerror = a.onplaying = a.ontimeupdate = null;
      a.pause();
      a.removeAttribute("src");
      a.load();
    } catch (e) { }
  });
  activeAudio.clear();
  aEl = null;
  try { if (S.tts.supported) window.speechSynthesis.cancel(); } catch (e) { }
  S.tts.id++;
  setSpeaking(false);
}

/* 导航到新单词时调用：让所有旧播放/旧异步任务立即失效。 */
function audioStop() {
  audioGeneration++;
  stopAudioNow();
}

/* 同一个单词被快速重复点击“发音”时，也必须开启新的播放世代，
   防止两个 speakCard() 并行导致两段声音重叠。 */
function beginSpeakSession() {
  audioGeneration++;
  stopAudioNow();
  return audioGeneration;
}

function openAudioDB() {
  if (ADB) return Promise.resolve(ADB);
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise(res => {
    let req;
    try { req = indexedDB.open("lexi-audio", 1); } catch (e) { return res(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("clips")) db.createObjectStore("clips", { keyPath: "k" });
    };
    req.onsuccess = () => { ADB = req.result; res(ADB); };
    req.onerror = () => res(null);
    setTimeout(() => res(ADB), 2500);
  });
}
function audioKey(w) {
  const acc = (S.ui.accent || "en-US").toLowerCase().indexOf("gb") >= 0 ? "uk" : "us";
  return acc + "|" + w.toLowerCase();
}
function idbGet(k) {
  return openAudioDB().then(db => new Promise(res => {
    if (!db) return res(null);
    try {
      const r = db.transaction("clips", "readonly").objectStore("clips").get(k);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    } catch (e) { res(null); }
  }));
}
function idbPut(rec) {
  return openAudioDB().then(db => new Promise(res => {
    if (!db) return res(false);
    try {
      const tx = db.transaction("clips", "readwrite");
      tx.objectStore("clips").put(rec);
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    } catch (e) { res(false); }
  }));
}
function idbCount() {
  return openAudioDB().then(db => new Promise(res => {
    if (!db) return res(0);
    try {
      const r = db.transaction("clips", "readonly").objectStore("clips").count();
      r.onsuccess = () => res(r.result || 0);
      r.onerror = () => res(0);
    } catch (e) { res(0); }
  }));
}
function idbClear() {
  return openAudioDB().then(db => new Promise(res => {
    if (!db) return res(false);
    try {
      const tx = db.transaction("clips", "readwrite");
      tx.objectStore("clips").clear();
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    } catch (e) { res(false); }
  }));
}
function getAudioURL(w) {
  const k = audioKey(w);
  if (aMem.has(k)) return Promise.resolve(aMem.get(k));
  if (aBusy.has(k)) return aBusy.get(k);
  const p = idbGet(k).then(rec => {
    if (rec && rec.blob && rec.blob.size > 400) {
      const u = URL.createObjectURL(rec.blob);
      aMem.set(k, u);
      return u;
    }
    return null;
  }).then(u => { aBusy.delete(k); return u; }, () => { aBusy.delete(k); return null; });
  aBusy.set(k, p);
  return p;
}

function playViaAudio(url, timeoutMs, token) {
  return new Promise(resolve => {
    if (typeof Audio === "undefined" || !url || token !== audioGeneration) { resolve(false); return; }
    const a = new Audio();
    a.preload = "auto";
    activeAudio.add(a);
    let settled = false, started = false;
    let startT = 0, endT = 0;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(startT); clearTimeout(endT);
      if (aCancel === cancel) aCancel = null;
      try { a.onended = a.onerror = a.onplaying = a.ontimeupdate = null; } catch (e) { }
      if (!ok || token !== audioGeneration) { try { a.pause(); a.removeAttribute("src"); a.load(); } catch (e) { } }
      activeAudio.delete(a);
      if (aEl === a) aEl = null;
      setSpeaking(false);
      resolve(!!ok && token === audioGeneration);
    };
    const cancel = () => finish(false);
    aCancel = cancel;
    a.onplaying = () => {
      if (token === audioGeneration) { started = true; setSpeaking(true); }
      else finish(false);
    };
    a.ontimeupdate = () => {
      if (token !== audioGeneration) { finish(false); return; }
      if (a.currentTime > 0) started = true;
    };
    a.onended = () => finish(token === audioGeneration);
    a.onerror = () => finish(false);
    setSpeaking(true);
    try { a.src = url; a.load(); } catch (e) { finish(false); return; }
    aEl = a;
    let pr;
    try { pr = a.play(); } catch (e) { finish(false); return; }
    if (pr && pr.catch) pr.catch(() => finish(false));
    startT = setTimeout(() => { if (!started) finish(false); }, timeoutMs || 8000);
    endT = setTimeout(() => finish(false), Math.max(30000, (timeoutMs || 8000) + 22000));
  });
}

function sayWord(w, cb) {
  const token = audioGeneration;
  const mode = S.ui.voiceMode || "hybrid";
  if (typeof w !== "string" || token !== audioGeneration) { cb(false); return; }
  if (mode === "tts" || typeof Audio === "undefined") { cb(false); return; }
  const onlineOrder = S.ui.srcId && AUDIO_SOURCES[S.ui.srcId]
    ? [S.ui.srcId].concat(AUDIO_ORDER.filter(x => x !== S.ui.srcId))
    : AUDIO_ORDER.slice();
  const safeCb = ok => { if (token === audioGeneration) cb(!!ok); };
  const fromOnline = i => {
    if (token !== audioGeneration) return;
    if (i >= onlineOrder.length) { safeCb(false); return; }
    const src = AUDIO_SOURCES[onlineOrder[i]];
    if (!src) { fromOnline(i + 1); return; }
    playViaAudio(src.url(w), 6000, token).then(ok => {
      if (token !== audioGeneration) return;
      if (ok) safeCb(true); else fromOnline(i + 1);
    }).catch(() => { if (token === audioGeneration) fromOnline(i + 1); });
  };
  getAudioURL(w).then(localUrl => {
    if (token !== audioGeneration) return;
    if (!localUrl) { fromOnline(0); return; }
    playViaAudio(localUrl, 8000, token).then(ok => {
      if (token !== audioGeneration) return;
      if (ok) safeCb(true); else fromOnline(0);
    }).catch(() => { if (token === audioGeneration) fromOnline(0); });
  }).catch(() => { if (token === audioGeneration) fromOnline(0); });
}

/* ------------------------------ 渲染 ------------------------------ */
function faceType(w) {
  const c = cardOf(w);
  if (S.ui.zhFirst === "mix") { if (!c.type) c.type = pickFace(c); return c.type; }
  return S.ui.zhFirst === "zh" ? "zh" : "en";
}
function renderCard(w, instant) {
  if (typeof w !== "string") return;
  cur = w;
  clearTimeout(revealTimer); clearTimeout(autoTimer);
  audioStop();                                          // 换卡先停掉上一张的读音，避免串音
  const c = cardOf(w), zhQ = faceType(w) === "zh";
  const show = !!instant || !!S.ui.auto;
  S.ui.revealed = show;
  const i = S.w.indexOf(w);
  const en = w, zh = i >= 0 ? S.d[i] : "";

  $("#face").innerHTML =
    '<div class="q" id="qEl">载入中…</div><div class="a" id="aEl"></div><div class="ph" id="phEl"></div>';
  $("#qEl").className = "q" + (zhQ ? " zh" : "");
  $("#qEl").textContent = zhQ ? zh : en;
  $("#aEl").textContent = zhQ ? en : zh;
  const ipa = (!zhQ && S.lib && S.lib.ipa && S.lib.ipa[w.toLowerCase()]) || "";
  $("#phEl").textContent = ipa ? "/" + ipa + "/" : "";

  $("#tType").textContent = zhQ ? "中 → 英" : "英 → 中";
  if (!c.seen) $("#tLv").textContent = "新词";
  else if (isMaster(c)) $("#tLv").textContent = "已掌握";
  else $("#tLv").textContent = "间隔 " + LVNAME[clamp(c.lv, 0, 7)] + (c.again ? " · 错过 " + c.again + " 次" : "");
  $("#card").classList.toggle("hidden", !show);
  $("#hintEl").textContent = show ? "" : (zhQ ? "想起英文 → 点一下验证" : "想起中文 → 点一下验证");
  $("#card").style.transform = "";
  $("#card").style.transition = "";
  renderBar();

  // 提前把当前卡的本地真人音从 IndexedDB 转成 blob: URL，
  // 尤其是极速连播第一张，减少用户手势结束后才去读数据库导致的自动播放拦截。
  getAudioURL(w).catch(() => null);

  if (S.ui.auto) {
    // 自动模式下卡片直接展开，但仍必须真正播放发音；等本词读完再推进。
    const wait = Math.max(900, +S.ui.autoMs || 2600);
    if (S.ui.speakAuto) {
      speakCard(w, () => {
        if (S.ui.auto && w === cur) autoTimer = setTimeout(() => autoStep(w), wait);
      });
    } else {
      autoTimer = setTimeout(() => autoStep(w), wait);
    }
  } else if (!show && !zhQ && S.ui.speakAuto) {
    // 非自动模式：英文线索出现时先读一遍。
    speakCard(w);
  }
}
function reveal(auto) {
  if (typeof cur !== "string" || S.ui.revealed) return;
  S.ui.revealed = true;
  $("#card").classList.remove("hidden");
  $("#hintEl").textContent = "";
  if (S.ui.speakAuto) speakCard(cur);
}
function renderBar() {
  const s = S.ses;
  if (!s) { $("#bar").style.width = "0%"; return; }
  const done = clamp(s.graded, 0, s.goal || 1);
  $("#bar").style.width = (done / (s.goal || 1) * 100).toFixed(1) + "%";
  $("#cntMain").textContent = done + " / " + (s.goal || 0);
  $("#cntSub").textContent = "剩 " + Math.max(0, s.q.length - s.qi) + " 张 · 模糊 " + s.again + " 次";
  $("#chipPlay").classList.toggle("on", !!S.ui.auto);
  $("#chipPlay").textContent = S.ui.auto ? "⏸ 暂停" : "▶ 极速连播";
  $("#chipSpeakOn").classList.toggle("on", !!S.ui.speakAuto);
  $("#chipSpeakOn").textContent = (S.ui.speakAuto ? "🔊" : "🔇") + " 自动发音";
  if (S.ui.zhFirst === "mix") { $("#chipZhFirst").classList.remove("on"); $("#chipZhFirst").textContent = "🔀 混合双面"; }
  else { $("#chipZhFirst").classList.toggle("on", S.ui.zhFirst === "zh"); $("#chipZhFirst").textContent = S.ui.zhFirst === "zh" ? "中 → 英" : "英 → 中"; }
}

/* ------------------------------ 评分 ------------------------------ */
function answer(ok) {
  if (typeof cur !== "string") return;
  if (now() - lastAns < 140) return;
  if (!S.ui.revealed) { reveal(false); return; }        // 未揭晓时先揭晓，避免盲评
  lastAns = now();
  clearTimeout(autoTimer);
  const w = cur, s = S.ses;
  const before = S.p[w] ? cloneC(S.p[w]) : null;
  const wasNew = !cardOf(w).seen;
  const c = grade(w, ok);
  c.type = pickFace(c);
  if (wasNew) S.stats.nw++;
  S.stats.rev++; if (!ok) S.stats.again++;
  if (s) {
    s.graded++; if (!ok) s.again++;
    s.hist.push({ w: w, ok: ok, before: before }); if (s.hist.length > 80) s.hist.shift();
    if (!isMaster(c)) {
      const gapms = c.due - now();
      if (gapms <= LADDER[0] + MIN) requeue(w, 12 + (Math.random() * 10 | 0));  // 当天要再见：稍后重现
      else if (gapms < 6 * 3600e3) requeue(w, 24 + (Math.random() * 16 | 0));  // 今天内到期：本轮再见一次
    }
  }
  saveProgress(); saveMeta();
  const nk = nextWord();
  if (!nk) sessionDone(); else renderCard(nk);
}
function autoStep(w) {
  if (!S.ui.auto || w !== cur) return;
  const s = S.ses, c = cardOf(w), wasNew = !c.seen;
  const had = c.seen;
  const before = cloneC(c);
  grade(w, true);
  if (wasNew) S.stats.nw++;
  S.stats.rev++;
  c.type = pickFace(c);
  if (had) { if (c.due - now() < 6 * 3600e3 && !isMaster(c)) requeue(w, 30 + (Math.random() * 12 | 0)); }
  if (s) { s.graded++; s.hist.push({ w: w, ok: true, before: before, auto: true }); if (s.hist.length > 80) s.hist.shift(); }
  saveProgress(); saveMeta();
  const nk = nextWord();
  if (!nk) sessionDone(); else renderCard(nk);
}
function sessionDone() {
  clearTimeout(autoTimer); clearTimeout(revealTimer);
  S.fixed.active = false; S.fixed.auto = false; fixedUpdateChrome();
  audioStop();
  S.ui.auto = false;
  const s = S.ses || { graded: 0, again: 0, t0: now(), goal: 0, due0: 0, fresh0: 0, backlog: 0 };
  S.stats.ms += Math.max(0, now() - s.t0);
  const mins = Math.max(1, Math.round((now() - s.t0) / MIN));
  S.ses = null; saveMeta(); saveProgress(true);
  cur = -1;
  const st = totals();
  $("#bar").style.width = "100%";
  $("#cntMain").textContent = "完成"; $("#cntSub").textContent = "";
  $("#card").classList.remove("hidden");
  $("#card").style.transform = "";
  $("#tType").textContent = "本轮"; $("#tLv").textContent = "";
  $("#actRow").style.display = "none";
  $("#face").innerHTML =
    '<div class="empty">' +
      '<h2>🎉 今日队列完成</h2>' +
      '<p>本轮判断 <b>' + s.graded + '</b> 次 · 用时约 <b>' + mins + '</b> 分钟<br>' +
      '到期复习 <b>' + (s.due0 || 0) + '</b> 词 · 新词 <b>' + (s.fresh0 || 0) + '</b> 词' +
      (s.backlog ? '<br><span style="color:var(--warn)">因每日上限，还有 ' + s.backlog + ' 词排在明天</span>' : '') +
      '</p>' +
      '<p>已进入长期记忆 <b>' + st.master + '</b> 词<br>明天预计到期 <b>' + st.dueTomorrow + '</b> 词</p>' +
      '<button class="btn ok" id="btnMore" style="width:100%">再来一轮</button>' +
      '<p style="margin-top:14px;font-size:12.5px">明天同一时间回来，到期的词会自动排好队。</p>' +
    '</div>';
  $("#btnMore").onclick = () => startSession(true);
}
function undo() {
  const s = S.ses;
  if (!s || !s.hist.length) { toast("没有可撤销的"); return; }
  const h = s.hist.pop();
  const c = S.p[h.w];
  if (c && h.before) restoreC(c, h.before);            // 精确回到评分前的状态
  else if (c) { c.due = now() - 1; }
  s.graded = Math.max(0, s.graded - 1);
  if (!h.ok) s.again = Math.max(0, s.again - 1);
  if (h.auto) { S.stats.rev = Math.max(0, S.stats.rev - 1); S.ui.auto = false; hideSubs(false); }
  saveProgress(true); saveMeta();
  renderCard(h.w, true);
  toast("已撤销上一张");
}

/* ------------------------------ 统计 ------------------------------ */
function totals() {
  const t = now(), tod = startOfDay(t);
  let master = 0, dueNow = 0, dueTomorrow = 0, started = 0, weak = 0, learnedToday = 0;
  for (let i = 0; i < S.N; i++) {
    const c = S.p[S.w[i]];
    if (!c || !c.seen) continue;
    started++;
    if (c.again) weak++;
    if (isMaster(c)) { master++; if (c.last >= tod) learnedToday++; continue; }
    if (c.due <= t) dueNow++;
    else if (c.due < tod + 2 * DAY) dueTomorrow++;
  }
  return { master, dueNow, dueTomorrow, started, weak, learnedToday, total: S.N };
}

/* ---------------------------- 会话启动 ---------------------------- */
function startSession(force) {
  hideSubs(false);
  if (!force && S.ses && S.ses.qi < S.ses.q.length) {
    $("#actRow").style.display = "";
    const w = nextWord();
    if (w) { renderCard(w); return; }
  }
  const s = newSession();
  $("#actRow").style.display = "";
  renderBar();
  if (!s.q.length) { sessionDone(); return; }
  const w = nextWord();
  saveMeta();                                   // 立刻落盘：中途切走/关闭也不丢队列
  if (!w) sessionDone(); else renderCard(w);
  setTimeout(() => {
    if (s.backlog > 0) toast("今日上限已满，" + s.backlog + " 词顺延到明天（可在设置里调高）");
  }, 400);
}
function startWeak() {
  const q = [];
  for (let i = 0; i < S.N; i++) {
    const w = S.w[i], c = S.p[w];
    if (c && c.again > 0 && !isMaster(c)) q.push(w);
  }
  if (!q.length) { toast("还没有答错过的词"); return; }
  shuffle(q);
  newSession({ q: q, goal: q.length, due0: 0, fresh0: 0, weak: true, backlog: 0 });
  saveMeta();
  $("#actRow").style.display = "";
  renderCard(nextWord());
  toast("只练 " + q.length + " 个模糊词");
}

/* ------------------------- 固定随机刷库（独立模式） -------------------------
   说明：这个模式只读取 S.w / S.d，不调用 grade / answer / S.ses / S.stats，\n   因此与原来的间隔重复学习完全分离。随机顺序只生成一次，之后每一遍都复用同一顺序。\n--------------------------------------------------------------------------- */
function fixedKey() { return S.w.join("\u0001"); }
function saveFixedState() {
  try {
    localStorage.setItem(LSK("fixedOrder"), JSON.stringify({ key: S.fixed.key, order: S.fixed.order }));
    localStorage.setItem(LSK("fixedState"), JSON.stringify({ pos: S.fixed.pos, completed: S.fixed.completed }));
  } catch (e) { }
}
function loadFixedState() {
  S.fixed.order = [];
  S.fixed.key = "";
  S.fixed.pos = 0;
  S.fixed.completed = 0;
  const key = fixedKey();
  try {
    const o = JSON.parse(localStorage.getItem(LSK("fixedOrder")) || "null");
    if (o && o.key === key && Array.isArray(o.order) && o.order.length === S.N) S.fixed.order = o.order.slice();
  } catch (e) { }
  if (!S.fixed.order.length) {
    S.fixed.order = S.w.slice();
    shuffle(S.fixed.order);
    S.fixed.key = key;
    S.fixed.pos = 0;
    S.fixed.completed = 0;
    saveFixedState();
  } else {
    S.fixed.key = key;
    try {
      const st = JSON.parse(localStorage.getItem(LSK("fixedState")) || "null");
      if (st && Number.isInteger(st.pos)) S.fixed.pos = clamp(st.pos, 0, Math.max(0, S.fixed.order.length - 1));
      if (st && Number.isInteger(st.completed)) S.fixed.completed = Math.max(0, st.completed);
    } catch (e) { }
  }
}
function resetFixedOrder() {
  S.fixed.order = S.w.slice();
  shuffle(S.fixed.order);
  S.fixed.key = fixedKey();
  S.fixed.pos = 0;
  S.fixed.completed = 0;
  saveFixedState();
}
function fixedCurrentWord() {
  return S.fixed.order[S.fixed.pos] || S.w[0] || "";
}
function fixedUpdateChrome() {
  const active = !!S.fixed.active;
  if ($("#actRow")) $("#actRow").style.display = active ? "none" : "";
  if ($("#fixedActRow")) $("#fixedActRow").style.display = active ? "" : "none";
  if ($("#normalSub")) $("#normalSub").style.display = active ? "none" : "";
  if ($("#fixedSub")) $("#fixedSub").style.display = active ? "" : "none";
  const ba = $("#btnAuto"), bs = $("#btnSound");
  if (ba) { ba.textContent = active ? (S.fixed.auto ? "⏸" : "🔀") : "⚡"; ba.title = active ? "固定随机自动连播" : "极速连播"; }
  if (bs) bs.title = active ? "播放当前单词" : "发音";
}
function fixedRenderBar() {
  const total = S.fixed.order.length || S.N;
  const doneInRound = Math.min(S.fixed.pos + 1, total);
  const round = S.fixed.completed + 1;
  $("#bar").style.width = total ? (doneInRound / total * 100).toFixed(1) + "%" : "0%";
  $("#cntMain").textContent = "固定随机 · 第 " + round + " 遍";
  $("#cntSub").textContent = "本遍 " + doneInRound + " / " + total + " · 已完成 " + S.fixed.completed + " 遍";
  $("#fixedAuto").classList.toggle("on", !!S.fixed.auto);
  $("#fixedAuto").textContent = S.fixed.auto ? "⏸ 暂停自动连播" : "▶ 固定自动连播";
  $("#fixedSpeak").classList.toggle("on", !!S.fixed.speak);
  $("#fixedSpeak").textContent = (S.fixed.speak ? "🔊" : "🔇") + " 自动发音";
}
function fixedRenderCard(w) {
  if (!w) return;
  audioStop();
  cur = w;
  S.fixed.revealed = false;
  const i = S.w.indexOf(w);
  const en = w, zh = i >= 0 ? S.d[i] : "";
  let face = S.ui.zhFirst;
  if (face === "mix") face = ((S.fixed.pos + S.fixed.completed) % 2 === 0) ? "en" : "zh";
  S.fixed.face = face;
  const zhQ = face === "zh";
  $("#face").innerHTML = '<div class="q" id="qEl">' + esc(zhQ ? zh : en) + '</div><div class="a" id="aEl">' + esc(zhQ ? en : zh) + '</div><div class="ph" id="phEl"></div>';
  $("#qEl").className = "q" + (zhQ ? " zh" : "");
  const ipa = (!zhQ && S.lib && S.lib.ipa && S.lib.ipa[w.toLowerCase()]) || "";
  $("#phEl").textContent = ipa ? "/" + ipa + "/" : "";
  $("#tType").textContent = "固定随机";
  $("#tLv").textContent = "第 " + (S.fixed.completed + 1) + " 遍 · " + (S.fixed.pos + 1) + "/" + S.fixed.order.length;
  $("#card").classList.toggle("hidden", true);
  $("#hintEl").textContent = zhQ ? "想起英文 → 点一下验证" : "想起中文 → 点一下验证";
  $("#card").style.transform = "";
  $("#card").style.transition = "";
  fixedRenderBar();
  if (S.fixed.auto) {
    clearTimeout(fixedTimer);
    fixedTimer = setTimeout(() => {
      if (!S.fixed.active || w !== fixedCurrentWord()) return;
      fixedReveal(true);
      if (S.fixed.speak) {
        speakCard(w, () => { if (S.fixed.active && w === fixedCurrentWord()) fixedTimer = setTimeout(fixedNext, Math.max(500, +S.ui.autoMs || 2600)); });
      } else fixedTimer = setTimeout(fixedNext, Math.max(500, +S.ui.autoMs || 2600));
    }, Math.max(500, +S.ui.autoMs || 2600));
  } else if (!zhQ && S.fixed.speak) {
    speakCard(w);
  }
}
function fixedReveal(silent) {
  if (!S.fixed.active || S.fixed.revealed) return;
  S.fixed.revealed = true;
  $("#card").classList.remove("hidden");
  $("#hintEl").textContent = "";
  if (!silent && S.fixed.speak && typeof cur === "string") speakCard(cur);
}
function fixedNext() {
  if (!S.fixed.active || !S.fixed.order.length) return;
  clearTimeout(fixedTimer);
  if (S.fixed.pos >= S.fixed.order.length - 1) {
    S.fixed.pos = 0;
    S.fixed.completed++;
  } else S.fixed.pos++;
  saveFixedState();
  fixedRenderCard(fixedCurrentWord());
}
function fixedPrev() {
  if (!S.fixed.active || !S.fixed.order.length) return;
  clearTimeout(fixedTimer);
  if (S.fixed.pos <= 0) {
    S.fixed.pos = S.fixed.order.length - 1;
    S.fixed.completed = Math.max(0, S.fixed.completed - 1);
  } else S.fixed.pos--;
  saveFixedState();
  fixedRenderCard(fixedCurrentWord());
}
function toggleFixedAuto() {
  if (!S.fixed.active) return;
  clearTimeout(fixedTimer);
  S.fixed.auto = !S.fixed.auto;
  fixedUpdateChrome(); fixedRenderBar();
  if (S.fixed.auto) fixedRenderCard(fixedCurrentWord());
}
function resetFixedProgress() {
  if (!confirm("确定把固定随机刷库重新从第1遍开始吗？原来的学习进度不会改变。")) return;
  clearTimeout(fixedTimer);
  audioStop();
  S.fixed.pos = 0; S.fixed.completed = 0;
  saveFixedState();
  if (S.fixed.active) fixedRenderCard(fixedCurrentWord());
  else renderPanel();
}
function enterFixedMode() {
  if (!S.fixed.order.length) loadFixedState();
  clearTimeout(autoTimer); clearTimeout(revealTimer); clearTimeout(fixedTimer);
  audioStop();
  normalAutoBeforeFixed = !!S.ui.auto;
  S.ui.auto = false;
  S.fixed.active = true;
  S.fixed.auto = false;
  fixedUpdateChrome();
  fixedRenderCard(fixedCurrentWord());
  toast("已进入固定随机刷库：不改变原来的学习进度");
}
function exitFixedMode() {
  clearTimeout(fixedTimer);
  audioStop();
  S.fixed.active = false;
  S.fixed.auto = false;
  S.ui.auto = normalAutoBeforeFixed;
  fixedUpdateChrome();
  if (S.ses && S.ses.qi < S.ses.q.length) {
    const w = nextWord();
    if (w) { $("#actRow").style.display = ""; renderCard(w); return; }
  }
  showStart();
}

function renderWordBank() {
  audioStop();
  const panel = $("#panel");
  const total = S.N;
  panel.innerHTML = `
    <div class="grab"></div>
    <h2><span>词库 · ${total} 词</span><button class="iconbtn" id="pWordsClose">✕</button></h2>
    <div class="f" style="display:block;border-bottom:0;padding-top:0">
      <input id="wordSearch" type="search" placeholder="搜索英文或中文释义" style="width:100%;max-width:none">
    </div>
    <div class="fixedStat" id="wordBankStat">按原词库顺序显示；点击任意词可试听。</div>
    <div class="wordlist" id="wordList"></div>`;
  const render = () => {
    const q = String($("#wordSearch").value || "").trim().toLowerCase();
    const rows = [];
    for (let i = 0; i < S.N; i++) {
      const en = String(S.w[i] || ""), zh = String(S.d[i] || "");
      if (q && !(en.toLowerCase().includes(q) || zh.toLowerCase().includes(q))) continue;
      rows.push({i,en,zh});
    }
    const shown = rows.length;
    $("#wordBankStat").innerHTML = `显示 <b>${shown}</b> / ${total} 词 · 点击右侧 🔊 试听`;
    $("#wordList").innerHTML = rows.map(x =>
      `<div class="wordrow" data-i="${x.i}"><span class="num">${x.i+1}</span><span class="en">${esc(x.en)}</span><span class="zh">${esc(x.zh)}</span><button class="play" title="试听">🔊</button></div>`
    ).join("") || '<div class="empty"><p>没有匹配的词。</p></div>';
    $("#wordList").querySelectorAll(".wordrow").forEach(row => {
      row.addEventListener("click", e => {
        const i = +row.dataset.i, w = S.w[i];
        if (w) speakCard(w);
      });
    });
  };
  $("#pWordsClose").onclick = closeSheet;
  $("#wordSearch").addEventListener("input", render);
  render();
  setTimeout(() => { const e = $("#wordSearch"); if (e) e.focus(); }, 30);
}

/* ------------------------------ 设置面板 ------------------------------ */
function openSheet() { $("#sheet").classList.add("open"); renderPanel(); }
function closeSheet() { $("#sheet").classList.remove("open"); }
function renderPanel() {
  const u = S.ui, st = totals(), t = S.stats;
  const voices = S.tts.supported ? (window.speechSynthesis.getVoices() || []) : [];
  const enVoices = voices.filter(v => /^en/i.test(v.lang || ""));
  const mins = Math.max(1, Math.round((t.ms + (S.ses ? now() - S.ses.t0 : 0)) / MIN));
  const acc = u.zhTTS && !S.tts.zhVoice ? '<br><span style="color:var(--warn)">未找到中文语音，需在系统设置里安装中文 TTS</span>' : '';
  $("#panel").innerHTML = `
    <div class="grab"></div>
    <h2><span>数据与设置</span><button class="iconbtn" id="pClose">✕</button></h2>

    <div class="sec">
      <div class="stat">
        <div><span>今日判断次数</span><b>${t.rev}</b></div>
        <div><span>今日"不认识"</span><b>${t.again}</b></div>
        <div><span>已进入长期记忆</span><b>${st.master}</b></div>
        <div><span>今日新掌握</span><b>${st.learnedToday}</b></div>
        <div><span>累计学过</span><b>${st.started}/${st.total}</b></div>
        <div><span>今日用时</span><b>${mins} 分</b></div>
      </div>
      <div class="fore" style="margin-top:10px">
        待复习 <i>${st.dueNow}</i> 词 · 明天预计到期 <i>${st.dueTomorrow}</i> 词<br>
        模糊词（答错过）<i>${st.weak}</i> 词
        <button class="chip" id="pWeak" style="color:${st.weak ? "var(--accent)" : "var(--fg3)"};font-weight:700${st.weak ? "" : ";opacity:.5"}">只练这些 →</button>
      </div>
    </div>

    <div class="sec">
      <h3>每日节奏（懒人友好：看不完也不会崩）</h3>
      <div class="f"><div class="lbl">每天新词上限<em>一天想刷几百个就调到 500</em></div>
        <input type="number" id="sNew" min="0" max="2000" step="25" value="${u.newBudget}"></div>
      <div class="f"><div class="lbl">每天复习上限<em>到期太多时先消化最该复习的</em></div>
        <input type="number" id="sRev" min="0" max="3000" step="25" value="${u.revBudget}"></div>
      <div class="f"><div class="lbl">卡片面</div>
        <select id="sFace">
          <option value="mix" ${u.zhFirst === "mix" ? "selected" : ""}>混合双面（推荐）</option>
          <option value="en" ${u.zhFirst === "en" ? "selected" : ""}>英 → 中</option>
          <option value="zh" ${u.zhFirst === "zh" ? "selected" : ""}>中 → 英</option>
        </select></div>
    </div>

    <div class="sec">
      <h3>发音</h3>
      <div class="f"><div class="lbl">自动发音<em>看答案时朗读，只听也能学</em></div>
        <label class="sw"><input type="checkbox" id="sSpeak" ${u.speakAuto ? "checked" : ""}><i></i></label></div>
      <div class="f"><div class="lbl">声音来源<em>${u.voiceMode === "human" ? "只用真人音，取不到时静默" : u.voiceMode === "tts" ? "只用手机系统语音" : "优先真人音，取不到自动回退系统语音"}</em></div>
        <select id="sVoiceMode">
          <option value="hybrid" ${u.voiceMode === "hybrid" ? "selected" : ""}>真人音 + 系统兜底</option>
          <option value="human" ${u.voiceMode === "human" ? "selected" : ""}>只用真人音</option>
          <option value="tts" ${u.voiceMode === "tts" ? "selected" : ""}>只用系统语音</option>
        </select></div>
      <div class="f"><div class="lbl">在线音源<em>${AUDIO_SOURCES[u.srcId] ? esc(AUDIO_SOURCES[u.srcId].label) : ""}；有道为真人词典音，其他源可能为合成语音</em></div>
        <select id="sSrc">
          ${AUDIO_ORDER.map(id => `<option value="${id}" ${u.srcId === id ? "selected" : ""}>${esc(AUDIO_SOURCES[id].label)}</option>`).join("")}
        </select></div>
      <div class="f"><div class="lbl">本地真人音频<em id="audioStat">查询中…</em></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="chip" id="pAudioFiles" style="color:var(--accent);font-weight:700">导入 MP3 文件夹</button>
          <button class="chip" id="pAudioPack" style="color:var(--accent);font-weight:700">导入 zip</button>
        </div></div>
      <div class="f"><div class="lbl">清除本地音频<em>只清本机存储，不影响在线播放</em></div>
        <button class="chip" id="pAudioClear" style="color:var(--fg2)">清空</button></div>
      <p style="font-size:12px;color:var(--fg3);line-height:1.7;margin:8px 0 0">
        播放顺序固定为：<b>本地真人 MP3 → 在线音源 → 系统语音</b>。
        想完全离线、零延迟，可把按单词命名的 MP3 文件放进一个文件夹，点击「导入 MP3 文件夹」；
        也可导入原来的 ZIP 音频包。文件名支持 <code>word.mp3</code>、<code>us_word.mp3</code>、<code>uk_word.mp3</code>。
      </p>
      <div class="f"><div class="lbl">语速 <em id="rateVal">${(+u.rate).toFixed(2)}×</em><em>系统语音才受语速影响；真人音是原速</em></div>
        <input type="range" id="sRate" min="0.6" max="1.2" step="0.05" value="${u.rate}"></div>
      <div class="f"><div class="lbl">连读遍数</div>
        <select id="sReps">${[1, 2, 3].map(n => `<option value="${n}" ${+u.reps === n ? "selected" : ""}>${n} 遍</option>`).join("")}</select></div>
      <div class="f"><div class="lbl">朗读中文释义${acc}</div>
        <label class="sw"><input type="checkbox" id="sZhTTS" ${u.zhTTS ? "checked" : ""}><i></i></label></div>
      <div class="f"><div class="lbl">系统语音口音 / 具体声音<em>${S.tts.supported ? (S.tts.voice ? "当前：" + esc(S.tts.voice.name) : "未找到英文语音：请在手机系统里安装英语 TTS 语音包") : "本浏览器不支持语音合成，请用 Chrome / Edge / Safari 打开"}</em></div>
        <select id="sAccent">
          <option value="en-US" ${!u.voiceName && u.accent === "en-US" ? "selected" : ""}>美音</option>
          <option value="en-GB" ${!u.voiceName && u.accent === "en-GB" ? "selected" : ""}>英音</option>
          <option value="en-AU" ${!u.voiceName && u.accent === "en-AU" ? "selected" : ""}>澳音</option>
          ${enVoices.map(v => `<option value="v:${esc(v.name)}" ${u.voiceName === v.name ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("")}
        </select></div>
    </div>

    <div class="sec">
      <h3>做题方式</h3>
      <div class="f"><div class="lbl">答案先藏起来<em>强制回忆，比直接看留存高得多</em></div>
        <label class="sw"><input type="checkbox" id="sHide" ${u.hideAnswer ? "checked" : ""}><i></i></label></div>
      <div class="f"><div class="lbl">极速连播每张停留</div>
        <select id="sAutoMs">
          ${[[1800, "极快 1.8 秒"], [2600, "快 2.6 秒"], [3600, "中 3.6 秒"], [5000, "慢 5 秒"], [8000, "很慢 8 秒"]]
      .map(([v, l]) => `<option value="${v}" ${+u.autoMs === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></div>
      <div class="f"><div class="lbl">外观</div>
        <select id="sTheme">
          <option value="auto" ${u.theme === "auto" ? "selected" : ""}>跟随系统</option>
          <option value="light" ${u.theme === "light" ? "selected" : ""}>ǳɫ</option>
          <option value="dark" ${u.theme === "dark" ? "selected" : ""}>深色</option>
        </select></div>
      <div class="f"><div class="lbl">显示音标<em>${S.lib && S.lib.ipa ? "词典已载入" : "需额外词典文件，当前无数据（不影响使用）"}</em></div>
        <label class="sw"><input type="checkbox" id="sIpa" ${u.ipa && S.lib ? "checked" : ""}${S.lib ? "" : " disabled"}><i></i></label></div>
    </div>

    <div class="sec">
      <h3>独立刷库模式</h3>
      <div class="fixedStat">
        <div class="fixedModeTitle">🔀 固定随机顺序</div>
        共 <b>${S.fixed.order.length}</b> 个词 · 当前第 <b>${S.fixed.completed + 1}</b> 遍 · 本遍第 <b>${Math.min(S.fixed.pos + 1, S.fixed.order.length)}</b> 个 · 已完成 <b>${S.fixed.completed}</b> 遍<br>
        随机顺序只生成一次，之后每一遍都保持完全相同；此模式不修改原来的记忆等级、复习队列和今日统计。
      </div>
      <div class="actsrow">
        <button class="btn ok" id="pFixedStart">开始固定随机刷库</button>
        <button class="btn ghost" id="pWords">查看词库</button>
      </div>
      <div class="actsrow" style="margin-top:10px">
        <button class="btn ghost" id="pFixedReset">重新生成固定随机顺序</button>
        <button class="btn ghost" id="pFixedRestart">从第1遍开始</button>
      </div>
    </div>

    <div class="sec">
      <h3>数据管理</h3>
      <div class="actsrow">
        <button class="btn ghost" id="pExport">导出备份</button>
        <button class="btn ghost" id="pImport">导入备份</button>
      </div>
      <div class="actsrow" style="margin-top:10px">
        <button class="btn ghost" id="pTest">试听发音</button>
        <button class="btn ghost danger" id="pReset">清空进度</button>
      </div>
      <p style="font-size:12px;color:var(--fg3);line-height:1.75;margin:12px 0 0">
        进度存在本机浏览器里。"添加到主屏幕"后可像原生 App 一样离线使用；清理浏览器数据会丢进度，建议偶尔导出备份。
      </p>
    </div>`;
  bindPanel();
}
function bindPanel() {
  const u = S.ui;
  const on = (id, ev, fn) => { const e = $("#" + id); if (e) e.addEventListener(ev, fn); };
  const re = () => { renderBar(); };
  /* 数字输入解析：先清洗再钳制，避免把 "  12  " / "0x10" / "abc" 直接塞回 input 造成浏览器警告 */
  const numIn = (e, id, min, max, fallback) => {
    const raw = String(e.target.value || "").trim().replace(/[^\d.\-]/g, "");
    let v = parseFloat(raw);
    if (!isFinite(v)) v = fallback;
    v = clamp(Math.round(v), min, max);
    e.target.value = String(v);
    return v;
  };
  on("pClose", "click", closeSheet);
  on("sNew", "change", e => { u.newBudget = numIn(e, "sNew", 0, 2000, u.newBudget); saveMeta(); });
  on("sRev", "change", e => { u.revBudget = numIn(e, "sRev", 0, 3000, u.revBudget); saveMeta(); });
  on("sFace", "change", e => { u.zhFirst = e.target.value; saveMeta(); re(); });
  on("sSpeak", "change", e => { u.speakAuto = e.target.checked; saveMeta(); re(); if (u.speakAuto && S.ui.revealed) speakCard(cur); });
  on("sVoiceMode", "change", e => { u.voiceMode = e.target.value; saveMeta(); renderPanel(); if (hasCard()) speakCard(cur); });
  on("sSrc", "change", e => { u.srcId = e.target.value; saveMeta(); if (hasCard()) speakCard(cur); });
  on("pAudioClear", "click", () => {
    if (!confirm("清空已导入的本地真人发音？清空后仍可使用在线音源，失败时再用系统语音。")) return;
    aMem.forEach(u2 => { try { URL.revokeObjectURL(u2); } catch (e) { } });
    aMem.clear();
    idbClear().then(() => { toast("本地音频已清空"); renderPanel(); });
  });
  on("pAudioFiles", "click", () => importAudioFiles());
  on("pAudioPack", "click", () => importAudioPack());
  on("sRate", "input", e => { u.rate = +e.target.value; const v = $("#rateVal"); if (v) v.textContent = u.rate.toFixed(2) + "×"; saveMeta(); });
  on("sRate", "change", () => { if (cur >= 0) speakCard(cur); });
  on("sReps", "change", e => { u.reps = +e.target.value; saveMeta(); if (cur >= 0) speakCard(cur); });
  on("sZhTTS", "change", e => { u.zhTTS = e.target.checked; saveMeta(); if (u.zhTTS && !S.tts.zhVoice) toast("未找到中文语音，可能需在系统里安装"); });
  on("sAccent", "change", e => {
    const v = e.target.value;
    if (v.indexOf("v:") === 0) {
      u.voiceName = v.slice(2);
      const f = (window.speechSynthesis.getVoices() || []).find(x => x.name === u.voiceName);
      if (f) { S.tts.voice = f; u.accent = f.lang; }
    } else { u.voiceName = ""; u.accent = v; loadVoices(); }
    saveMeta(); if (cur >= 0) speakCard(cur);
  });
  on("sHide", "change", e => { u.hideAnswer = e.target.checked; saveMeta(); });
  on("sAutoMs", "change", e => { u.autoMs = +e.target.value; saveMeta(); });
  on("sTheme", "change", e => { u.theme = e.target.value; applyTheme(); saveMeta(); });
  on("pTest", "click", () => { unblockTTS(); toast("试听：" + (S.ui.voiceMode === "tts" ? "系统语音" : "真人音优先")); speakCard(cur && typeof cur === "string" ? cur : "vocabulary"); });
  on("pWeak", "click", () => { closeSheet(); startWeak(); });
  on("pFixedStart", "click", () => { closeSheet(); enterFixedMode(); });
  on("pWords", "click", () => renderWordBank());
  on("pFixedReset", "click", () => {
    if (!confirm("重新生成固定随机顺序？这只影响独立刷库模式，不影响原来的学习进度。")) return;
    resetFixedOrder(); renderPanel(); toast("固定随机顺序已重新生成");
  });
  on("pFixedRestart", "click", resetFixedProgress);
  on("pExport", "click", doExport);
  on("pImport", "click", doImport);
  on("pReset", "click", () => {
    if (!confirm("确定清空全部学习进度？不可恢复。")) return;
    S.p = {}; S.ses = null;
    S.stats = { day: todayKey(), rev: 0, again: 0, nw: 0, ms: 0 };
    try { localStorage.removeItem(LSK("prog")); localStorage.removeItem(LSK("ses")); } catch (e) { }
    saveMeta(); closeSheet(); toast("已清空"); showStart();
  });
  /* 异步补充：音频缓存统计（不能阻塞面板渲染） */
  idbCount().then(n => {
    const el = $("#audioStat");
    if (!el) return;
    let txt = n > 0 ? n + " 个本地音频条目（约 " + (n * 15 / 1024).toFixed(1) + " MB）" : "暂无本地音频";
    const put = () => { const e2 = $("#audioStat"); if (e2) e2.textContent = txt; };
    put();
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(est => {
        if (est && est.usage) { txt += " · 本站共占用 " + (est.usage / 1048576).toFixed(1) + " MB"; put(); }
      }).catch(() => { });
    }
  }).catch(() => { });
}

/* ---------------------- 本地音频包（zip）导入 ----------------------
   为什么需要：在线音源都没有 CORS 头，浏览器里 fetch 不到音频（实测确认），
   只能靠 <audio> 元素流式播放。想离线/零延迟就导入本地音频包。
   包是 store 模式的 zip（不压缩），所以这里顺序读本地文件头即可，无需解压库。
-------------------------------------------------------------------- */
function importAudioFiles() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.accept = ".mp3,.wav,.m4a,.ogg,.opus,audio/*";
  try { inp.webkitdirectory = true; } catch (e) { }
  inp.onchange = async () => {
    const files = Array.from(inp.files || []).filter(f => /\.(mp3|wav|m4a|ogg|opus)$/i.test(f.name));
    if (!files.length) { toast("文件夹里没有找到 MP3 等音频文件"); return; }
    toast("正在导入 " + files.length + " 个音频…");
    let done = 0, bad = 0;
    for (const f of files) {
      try {
        const base = f.name.replace(/\.[^.]+$/, "");
        const m = /^(us|uk)_(.+)$/i.exec(base);
        const word = (m ? m[2] : base).trim().toLowerCase();
        if (!word) { bad++; continue; }
        const prefix = m ? m[1].toLowerCase() : "both";
        const rec = { w: word, src: "file", t: now(), blob: f };
        if (prefix === "us") {
          await idbPut({ ...rec, k: "us|" + word });
          done++;
        } else if (prefix === "uk") {
          await idbPut({ ...rec, k: "uk|" + word });
          done++;
        } else {
          const rs = await Promise.all([
            idbPut({ ...rec, k: "us|" + word }),
            idbPut({ ...rec, k: "uk|" + word })
          ]);
          rs.some(Boolean) ? done++ : bad++;
        }
        if ((done + bad) % 100 === 0) toast("导入中 " + (done + bad) + "/" + files.length);
      } catch (e) { bad++; }
    }
    aMem.forEach(u2 => { try { URL.revokeObjectURL(u2); } catch (e) { } });
    aMem.clear();
    toast("导入完成：" + done + " 个发音" + (bad ? "，跳过 " + bad : ""));
    renderPanel();
  };
  inp.click();
}

function importAudioPack() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".zip,application/zip";
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    toast("正在读取音频包…");
    const fr = new FileReader();
    fr.onload = () => {
      let entries;
      try { entries = parseZipStore(fr.result); }
      catch (e) { toast("音频包解析失败：" + e.message); return; }
      if (!entries.length) { toast("音频包里没有找到音频"); return; }
      const el = () => $("#audioStat");
      let done = 0, bad = 0;
      const one = (i) => {
        if (i >= entries.length) {
          toast("导入完成：" + done + " 个发音" + (bad ? "，跳过 " + bad : ""));
          aMem.forEach(u2 => { try { URL.revokeObjectURL(u2); } catch (e) { } });
          aMem.clear(); renderPanel();
          return;
        }
        const e = entries[i];
        const base = e.name.split("/").pop().replace(/\.[^.]+$/, "");
        const m = /^(us|uk)_(.+)$/.exec(base);
        const word = (m ? m[2] : base).toLowerCase();
        const ext = (e.name.split(".").pop() || "mp3").toLowerCase();
        const mime = ext === "wav" ? "audio/wav" : ext === "ogg" || ext === "opus" ? (ext === "opus" ? "audio/ogg; codecs=opus" : "audio/ogg")
          : ext === "m4a" ? "audio/mp4" : "audio/mpeg";
        const blob = new Blob([e.data], { type: mime });
        const writes = m
          ? [idbPut({ k: m[1].toLowerCase() + "|" + word, w: word, src: "pack", t: now(), blob: blob })]
          : [idbPut({ k: "us|" + word, w: word, src: "pack", t: now(), blob: blob }),
             idbPut({ k: "uk|" + word, w: word, src: "pack", t: now(), blob: blob })];
        Promise.all(writes).then(rs => { if (rs.some(Boolean)) done++; else bad++; })
          .catch(() => { bad++; })
          .then(() => {
            if ((done + bad) % 50 === 0 || done + bad === entries.length) {
              const e2 = el();
              if (e2) e2.textContent = "导入中 " + (done + bad) + "/" + entries.length;
            }
            setTimeout(() => one(i + 1), 0);
          });
      };
      one(0);
    };
    fr.onerror = () => toast("文件读取失败");
    fr.readAsArrayBuffer(f);
  };
  inp.click();
}
/* 解析 store 模式 zip：顺序遍历本地文件头（不依赖中央目录，容忍被截断的包）。 */
function parseZipStore(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const out = [];
  let p = 0;
  const sig = (o) => dv.getUint32(o, true);
  while (p + 30 <= u8.length) {
    if (sig(p) !== 0x04034b50) {                 // 不是本地文件头 → 往后找下一个
      let q = p + 1;
      while (q + 4 <= u8.length && sig(q) !== 0x04034b50) q++;
      if (q + 4 > u8.length) break;
      p = q; continue;
    }
    const method = dv.getUint16(p + 8, true);
    let compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const nameStart = p + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart > u8.length) break;
    const name = new TextDecoder("utf-8").decode(u8.subarray(nameStart, nameStart + nameLen));
    if (!compSize) {                              // 流式写入的包会把大小写 0，用数据描述符，这里只能跳过
      let q = dataStart;
      while (q + 4 <= u8.length && sig(q) !== 0x04034b50) q++;
      p = q; continue;
    }
    const dataEnd = dataStart + compSize;
    if (dataEnd > u8.length) break;
    if (method === 0 && /\.(mp3|m4a|ogg|wav|opus)$/i.test(name) && compSize > 400) {
      out.push({ name: name, data: u8.subarray(dataStart, dataEnd) });
    }
    p = dataEnd;
  }
  return out;
}
function doExport() {
  const data = JSON.stringify({ v: 1, at: now(), words: S.N, prog: S.p, ui: S.ui, stats: S.stats });
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "lexi-backup-" + todayKey() + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("已导出备份文件");
}
function doImport() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = ".json,application/json";
  inp.onchange = () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const o = JSON.parse(r.result);
        if (!o || !o.prog || typeof o.prog !== "object") throw new Error("bad");
        S.p = o.prog;
        if (o.ui) Object.assign(S.ui, o.ui);
        if (o.stats && o.stats.day === todayKey()) S.stats = o.stats;
        S.ses = null; saveProgress(true); saveMeta(); applyTheme();
        closeSheet(); toast("导入成功"); startSession(true);
      } catch (e) { toast("文件无法识别"); }
    };
    r.readAsText(f);
  };
  inp.click();
}

/* ------------------------------ 主题等 ------------------------------ */
function applyTheme() {
  const el = document.documentElement;
  if (S.ui.theme === "auto") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", S.ui.theme);
}
let toastT = 0;
function toast(msg) {
  const el = $("#toast"); if (!el) return;
  el.textContent = msg; el.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 1900);
}

/* ------------------------------ 手势 ------------------------------ */
(function gestures() {
  const card = $("#card");
  let sx = 0, sy = 0, dx = 0, down = false, moved = false, t0 = 0;
  const TH = 56;
  card.addEventListener("pointerdown", e => {
    if (e.button !== undefined && e.button !== 0) return;
    down = true; moved = false; sx = e.clientX; sy = e.clientY; dx = 0; t0 = now();
    card.classList.add("drag");
  });
  card.addEventListener("pointermove", e => {
    if (!down || S.ui.auto || S.fixed.active) return;
    dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) moved = true;
    if (moved) card.style.transform = "translateX(" + dx * .5 + "px) rotate(" + dx * .01 + "deg)";
  });
  let busy = false;
  const end = () => {
    if (!down) return;
    if (S.fixed.active) {
      down = false; card.classList.remove("drag");
      const quickFixed = now() - t0 < 700;
      if (quickFixed && !moved) fixedReveal();
      dx = 0; moved = false;
      return;
    }
    down = false; card.classList.remove("drag");
    const quick = now() - t0 < 700;
    if (moved && Math.abs(dx) > TH && !S.ui.auto && !busy) {
      busy = true;
      const ok = dx > 0;
      card.style.transition = "transform .16s ease-out";
      card.style.transform = "translateX(" + (ok ? 1 : -1) * (window.innerWidth || 400) + "px) rotate(" + (ok ? 8 : -8) + "deg)";
      setTimeout(() => { busy = false; answer(ok); }, 130);
      dx = 0; moved = false;
      return;
    }
    card.style.transition = "transform .16s ease-out";
    card.style.transform = "";
    setTimeout(() => { if (!down) card.style.transition = ""; }, 180);
    if (!moved && quick && !S.ui.revealed && !S.ui.auto) reveal(true);
    dx = 0; moved = false;
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
  card.addEventListener("pointerleave", end);
  document.addEventListener("keydown", e => {
    if ($("#sheet").classList.contains("open")) { if (e.key === "Escape") closeSheet(); return; }
    if (S.fixed.active) {
      if (e.key === "ArrowLeft") { e.preventDefault(); fixedPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); fixedNext(); }
      else if (e.key === " " || e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); fixedReveal(); }
      else if (e.key === "r" || e.key === "R") speakCard(fixedCurrentWord());
      else if (e.key === "Escape") exitFixedMode();
      return;
    }
    if (e.key === "ArrowLeft") answer(false);
    else if (e.key === "ArrowRight") answer(true);
    else if (e.key === " " || e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); reveal(true); }
    else if (e.key === "r" || e.key === "R") speakCard(cur);
    else if (e.key === "u" || e.key === "U") undo();
  });
})();

/* ------------------------------ 绑定 ------------------------------ */
const hasCard = () => typeof cur === "string";
function playHumanFromGesture(w, cb) {
  if (typeof w !== "string") return false;
  // 统一走 local-first 逻辑；如果本地音频已经 warm 到内存，
  // Audio.play() 会尽量留在本次点击的用户手势链里。
  const finish = (ok) => { if (cb) cb(!!ok); };
  const start = () => {
    if (S.ui.voiceMode === "tts") {
      speak(w, "en", () => finish(true));
      return;
    }
    sayWord(w, got => {
      if (got) { finish(true); return; }
      if (S.ui.voiceMode === "human") { finish(false); return; }
      // sayWord 已经尝试过本地 + 全部在线源；这里只做最后一级系统 TTS。
      speak(w, "en", () => finish(false));
    });
  };
  start();
  return true;
}
$("#btnOk").onclick = () => { if (!S.fixed.active) answer(true); };
$("#btnNo").onclick = () => { if (!S.fixed.active) answer(false); };
$("#btnSound").onclick = () => { if (S.fixed.active && hasCard()) playHumanFromGesture(fixedCurrentWord()); else if (hasCard()) playHumanFromGesture(cur); else toast("先开始学习"); };
$("#btnWords").onclick = () => renderWordBank();
$("#btnFixed").onclick = () => { if (S.fixed.active) exitFixedMode(); else enterFixedMode(); };
$("#btnMenu").onclick = openSheet;
$("#fixedPrev").onclick = fixedPrev;
$("#fixedNext").onclick = fixedNext;
$("#fixedAuto").onclick = toggleFixedAuto;
$("#fixedSpeak").onclick = () => { S.fixed.speak = !S.fixed.speak; fixedRenderBar(); if (S.fixed.active) fixedRenderCard(fixedCurrentWord()); };
$("#fixedReset").onclick = resetFixedProgress;
$("#fixedExit").onclick = exitFixedMode;
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
$("#btnAuto").onclick = toggleAuto;
$("#chipPlay").onclick = toggleAuto;
$("#chipSpeakOn").onclick = () => { S.ui.speakAuto = !S.ui.speakAuto; saveMeta(); renderBar(); if (S.ui.speakAuto && hasCard()) speakCard(cur); };
$("#chipZhFirst").onclick = () => {
  const seq = ["mix", "en", "zh"];
  S.ui.zhFirst = seq[(seq.indexOf(S.ui.zhFirst) + 1) % 3];
  saveMeta(); renderBar();
  toast(S.ui.zhFirst === "mix" ? "混合双面：随机英→中 / 中→英" : S.ui.zhFirst === "zh" ? "只看中 → 英" : "只看英 → 中");
};
$("#chipUndo").onclick = undo;

function toggleAuto() {
  if (S.fixed.active) { toggleFixedAuto(); return; }
  if (!hasCard()) { startSession(true); return; }
  S.ui.auto = !S.ui.auto;
  saveMeta();
  clearTimeout(autoTimer); clearTimeout(revealTimer);
  hideSubs(S.ui.auto);
  if (S.ui.auto) {
    unblockTTS(); S.ui.speakAuto = true;
  }
  renderBar();
  if (S.ui.auto) {
    // 第一个单词直接在“点击连播”这一用户手势中播放，降低浏览器自动播放拦截概率。
    const first = cur;
    const wasAuto = S.ui.auto;
    S.ui.auto = false;
    renderCard(first, true);
    S.ui.auto = wasAuto;
    audioStop();
    playHumanFromGesture(first, () => {
      if (S.ui.auto && first === cur) autoTimer = setTimeout(() => autoStep(first), Math.max(900, +S.ui.autoMs || 2600));
    });
    // 真正的下一张推进由这里的回调负责。
  } else {
    renderCard(cur, true);
  }
  toast(S.ui.auto ? "极速连播：自动发音 + 自动推进" : "已暂停连播");
}
function hideSubs(hide) {
  document.querySelectorAll(".sub .chip").forEach(c => { if (c.id !== "chipPlay") c.style.display = hide ? "none" : ""; });
  const ok = $("#btnOk"), no = $("#btnNo"), row = $("#actRow");
  ok.innerHTML = hide ? "✓ 认识 <span class='k'>继续</span>" : "认识 <span class='k'>→</span>";
  no.style.display = hide ? "none" : "";
  if (row) row.classList.toggle("one", !!hide);
}

/* ------------------------------ 启动 ------------------------------ */
function showStart() {
  S.fixed.active = false; S.fixed.auto = false; clearTimeout(fixedTimer); fixedUpdateChrome();
  const st = totals();
  cur = -1;
  S.ui.revealed = false;
  S.ui.auto = false;
  hideSubs(false);
  $("#actRow").style.display = "none";
  $("#card").classList.remove("hidden");
  $("#tType").textContent = "准备"; $("#tLv").textContent = "";
  $("#card").style.transform = "";
  $("#face").innerHTML = "";
  const nmax = Math.max(0, S.ui.newBudget | 0);
  $("#face").innerHTML =
    '<div class="empty">' +
      '<h2>' + (st.started ? "欢迎回来" : "一天几百词，靠复现记住") + '</h2>' +
      '<p>词库 <b>' + st.total + '</b> 词 · 已学 <b>' + st.started + '</b> 词 · 已掌握 <b>' + st.master + '</b> 词<br>' +
      '今天到期复习 <b>' + st.dueNow + '</b> 词 · 新词额度 <b>' + nmax + '</b> 词' +
      (st.again ? '<br>模糊词 <b>' + st.again + '</b> 词可单独刷' : '') + '</p>' +
      '<button class="btn ok" id="btnGo" style="width:100%">开始</button>' +
      (st.started ? '<button class="btn ghost" id="btnBack" style="width:100%;margin-top:10px">继续上次队列</button>' : '') +
      '<p style="margin-top:14px;font-size:12.5px;line-height:1.8">点屏幕看答案 · 右滑＝认识 · 左滑＝不认识<br>只做这两个动作，其余全自动</p>' +
    '</div>';
  $("#cntMain").textContent = st.dueNow + " 待复习"; $("#cntSub").textContent = "新词 " + nmax;
  $("#bar").style.width = "0%";
  $("#btnGo").onclick = () => startSession(true);
  const b = $("#btnBack"); if (b) b.onclick = () => { if (S.ses) startSession(false); else { toast("没有未完成的队列"); startSession(true); } };
}
function boot(data) {
  S.w = data.w; S.d = data.d; S.N = S.w.length;
  loadAll();
  fixedUpdateChrome();
  applyTheme();
  if (S.ses && S.ses.qi < S.ses.q.length) {
    $("#actRow").style.display = "";
    const w = nextWord();
    if (w) {
      renderCard(w);
      renderBar();
      toast("继续上次队列（剩 " + Math.max(1, S.ses.q.length - S.ses.qi + 1) + " 张）");
      $("#cntSub").textContent = "剩 " + Math.max(0, S.ses.q.length - S.ses.qi) + " 张 · 模糊 " + S.ses.again + " 次";
      return;
    }
  }
  showStart();
}
(function load() {
  if (window.LEXI_DATA && window.LEXI_DATA.w && window.LEXI_DATA.w.length) { boot(window.LEXI_DATA); return; }
  fetch("data/words.json")
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(j => { boot({ w: j.words.map(x => x[0]), d: j.words.map(x => x[1]) }); })
    .catch(() => {
      $("#qEl").className = "q";
      $("#qEl").textContent = "词库加载失败";
      $("#face").innerHTML = '<div class="empty"><h2>词库加载失败</h2><p>请改用可双击直接打开的「闪卡.html」单文件版，<br>或用本地 HTTP 服务打开本页。</p></div>';
      $("#actRow").style.display = "none";
    });
})();
window.addEventListener("beforeunload", () => { saveProgress(true); saveMeta(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { saveProgress(true); saveMeta(); } });
