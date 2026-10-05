
/* LEXI_PATCH_V1 —— 稳定性增强补丁（V2）
   ① 点卡片显示中文、再点一下收起（含旧手势/键盘/自动连播各条路径）
   ② 学习数据记录：事件时间线 + 每日汇总 + CSV/JSON 导出
   ③ V2 稳定性：数据清洗、启动自检、音频播放世代、暂停/离开停声、固定刷库不吞卡、词库面板
   本段在主脚本之后执行：只做"包装 + 记录"，不改动原来的间隔重复算法。
   记录写入 localStorage["lexi.log"]，可在「📈 学习记录」里查看并导出。 */
(function () {
  "use strict";
  if (typeof S === "undefined" || typeof todayKey !== "function" || typeof cardOf !== "function") return;

  var MINMS = 6e4, DAYMS = 864e5, LOG_KEY = "lexi.log", EV_MAX = 5000, DAY_MAX = 730;
  var log = { events: [], days: {} };
  var shownAt = 0, faceZh = false, saveT = 0, autoFlag = false, gstack = [];

  /* ============================ 存储层 ============================ */
  function dk(t) { try { return todayKey(t); } catch (e) { return "?"; } }
  function dayOf(t) {
    var k = dk(t), d = log.days[k];
    if (!d) d = log.days[k] = { rev: 0, ok: 0, no: 0, nw: 0, views: 0, ms: 0, t0: 0, t1: 0 };
    return d;
  }
  function dayNum(k) {
    var p = String(k).split("-");
    return (+p[0] || 0) * 10000 + (+p[1] || 0) * 100 + (+p[2] || 0);
  }
  function loadLog() {
    try {
      var o = JSON.parse(localStorage.getItem(LOG_KEY) || "null");
      if (o && typeof o === "object") {
        if (Array.isArray(o.events)) {
          log.events = o.events.filter(function (e) { return e && typeof e.w === "string" && typeof e.t === "number"; });
        }
        if (o.days && typeof o.days === "object") log.days = o.days;
      }
    } catch (e) { }
  }
  function pruneLog() {
    var ks = Object.keys(log.days).sort(function (a, b) { return dayNum(a) - dayNum(b); });
    while (ks.length > DAY_MAX) delete log.days[ks.shift()];
    if (log.events.length > EV_MAX) log.events.splice(0, log.events.length - EV_MAX);
  }
  /* V3：多标签页并发写入时，后写的那页会把先写那页的记录整份覆盖（实测丢事件）。
     这里在写盘前把"别的标签页写进去、而本页内存里没有"的事件按 (时间|动作|单词) 去重合并进来。 */
  var evKey = function (e) { return e.t + "|" + e.k + "|" + e.w; };
  function mergeStoredLog() {
    var raw;
    try { raw = localStorage.getItem(LOG_KEY); } catch (e) { return null; }
    if (!raw) return null;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || !Array.isArray(o.events) || !o.events.length) return null;
    var seen = {}, i, e, added = [], touched = {};
    for (i = 0; i < log.events.length; i++) seen[evKey(log.events[i])] = 1;
    for (i = 0; i < o.events.length; i++) {
      e = o.events[i];
      if (!e || typeof e.w !== "string" || typeof e.t !== "number") continue;
      if (seen[evKey(e)]) continue;
      seen[evKey(e)] = 1;
      log.events.push(e);
      added.push(e);
    }
    if (!added.length) return null;
    log.events.sort(function (a, b) { return a.t - b.t; });
    for (i = 0; i < added.length; i++) touched[dk(added[i].t)] = 1;
    return Object.keys(touched);
  }
  /* 每日汇总改成"可以从事件流重算"，合并后才不会出现两页数字互相清零 */
  function rebuildDay(key) {
    var d = log.days[key];
    if (!d) d = log.days[key] = { rev: 0, ok: 0, no: 0, nw: 0, views: 0, ms: 0, t0: 0, t1: 0 };
    var keepNw = d.nw | 0, sawNw = false;                 // 旧版本事件没有 nw 字段
    d.rev = d.ok = d.no = d.nw = d.views = d.ms = 0; d.t0 = 0; d.t1 = 0;
    for (var i = 0; i < log.events.length; i++) {
      var e = log.events[i];
      if (dk(e.t) !== key) continue;
      if (!d.t0) d.t0 = e.t;
      d.t1 = e.t;
      if (e.k === "show") d.views = (d.views | 0) + 1;
      else if (e.k === "ok" || e.k === "no") {
        d.rev = (d.rev | 0) + 1;
        if (e.k === "ok") d.ok = (d.ok | 0) + 1; else d.no = (d.no | 0) + 1;
        if (e.nw !== undefined) { sawNw = true; if (e.nw) d.nw = (d.nw | 0) + 1; }
        d.ms = (d.ms | 0) + (e.rt | 0);
      } else if (e.k === "undo") {
        d.rev = Math.max(0, (d.rev | 0) - 1);
        if (e.ok) d.ok = Math.max(0, (d.ok | 0) - 1); else d.no = Math.max(0, (d.no | 0) - 1);
        if (e.nw !== undefined) { sawNw = true; if (e.nw) d.nw = Math.max(0, (d.nw | 0) - 1); }
        d.ms = Math.max(0, (d.ms | 0) - (e.rt | 0));
      }
    }
    if (!sawNw) d.nw = keepNw;                            // 全是没有 nw 字段的旧记录 → 保留原值，别抹成 0
    return d;
  }
  function saveLog(force) {
    var t = Date.now();
    if (!force && t - saveT < 900) return;
    saveT = t;
    var touchedDays = null;
    try { touchedDays = mergeStoredLog(); } catch (e) { }
    pruneLog();
    if (touchedDays) { for (var i = 0; i < touchedDays.length; i++) { try { rebuildDay(touchedDays[i]); } catch (e) { } } }
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch (e) {
      /* 存储写满（QuotaExceeded）时砍掉一半历史再试一次：记录写不进去也不能让应用崩 */
      try {
        log.events.splice(0, Math.floor(log.events.length / 2));
        localStorage.setItem(LOG_KEY, JSON.stringify(log));
      } catch (e2) { }
    }
  }
  function pushEv(kind, w, extra) {
    if (typeof w !== "string" || !w) w = "(无)";
    var t = Date.now(), ev = { t: t, k: kind, w: w };
    if (extra) { for (var key in extra) { if (extra[key] !== undefined) ev[key] = extra[key]; } }
    log.events.push(ev);
    var d = dayOf(t);
    if (!d.t0) d.t0 = t;
    d.t1 = t;
    saveLog();
  }

  /* ============================ 记录动作 ============================ */
  var lastViewW = "", lastViewT = 0;
  function recView(w, auto) {                             // 答案被展示 = 一次主动回忆检验
    var t = Date.now();
    if (w === lastViewW && t - lastViewT < 60) return;     // 同一次揭晓不重复计数（防重入）
    lastViewW = w; lastViewT = t;
    var d = dayOf(t), fixed = !!S.fixed.active, c = fixed ? null : S.p[w];
    d.views = (d.views | 0) + 1;
    if (c) { c.views = (c.views | 0) + 1; c.lastView = t; saveProgress(); }
    pushEv("show", w, { n: c ? (c.views | 0) : undefined, auto: auto ? 1 : 0, fixed: fixed ? 1 : 0 });
  }
  function recGrade(w, ok, wasNew, auto) {
    var t = Date.now(), d = dayOf(t);
    var rt = shownAt ? Math.max(0, Math.min(t - shownAt, 10 * MINMS)) : 0;
    d.rev = (d.rev | 0) + 1;
    if (ok) d.ok = (d.ok | 0) + 1; else d.no = (d.no | 0) + 1;
    if (wasNew) d.nw = (d.nw | 0) + 1;
    d.ms = (d.ms | 0) + rt;
    var c = S.p[w];
    if (c) c.rt = (c.rt | 0) + rt;
    shownAt = t;
    pushEv(ok ? "ok" : "no", w, { lv: c ? (c.lv | 0) : 0, due: c ? c.due : 0, rt: rt, auto: auto ? 1 : 0, nw: wasNew ? 1 : 0 });
    saveLog(true);
    return rt;
  }

  /* ====================== 包装原有函数（只加记录） ====================== */
  function wrap(name, make) {
    var orig = window[name];
    if (typeof orig !== "function") return false;
    window[name] = make(orig);
    return true;
  }
  wrap("grade", function (orig) {
    return function (k, ok) {
      var wasNew = !(S.p[k] && S.p[k].seen);
      var c = orig.apply(this, arguments);
      try {
        var rtG = recGrade(k, !!ok, wasNew, autoFlag);
        gstack.push({ w: k, ok: !!ok, wasNew: wasNew, rt: rtG | 0 });
        try { mirrorWordSoon(k); } catch (e) { }
        if (gstack.length > 300) gstack.shift();
      } catch (e) { }
      return c;
    };
  });
  wrap("autoStep", function (orig) {
    return function () {
      autoFlag = true;
      try { return orig.apply(this, arguments); } finally { autoFlag = false; }
    };
  });
  wrap("undo", function (orig) {
    return function () {
      var s = S.ses, n = (s && s.hist) ? s.hist.length : 0;
      var h = (s && s.hist && s.hist.length) ? s.hist[s.hist.length - 1] : null;
      orig.apply(this, arguments);
      try {
        if (!S.ses || !S.ses.hist || S.ses.hist.length >= n) return;      // 没有真的撤销
        var g = gstack.pop(), d = log.days[dk()];
        if (d && g) {
          d.rev = Math.max(0, (d.rev | 0) - 1);
          if (g.ok) d.ok = Math.max(0, (d.ok | 0) - 1); else d.no = Math.max(0, (d.no | 0) - 1);
          if (g.wasNew) d.nw = Math.max(0, (d.nw | 0) - 1);
        }
        /* V3：原版只在"自动评分"时回退 S.stats，手动评分不回退，
           于是设置页的「今日判断次数」比学习记录页多 → 两处数字互相矛盾。这里补齐。 */
        if (g) {
          if (!(h && h.auto)) {
            S.stats.rev = Math.max(0, (S.stats.rev | 0) - 1);
            if (!g.ok) S.stats.again = Math.max(0, (S.stats.again | 0) - 1);
          }
          if (g.wasNew) S.stats.nw = Math.max(0, (S.stats.nw | 0) - 1);
          try { saveMeta(); } catch (e) { }
        }
        var last = S.ses.hist[S.ses.hist.length - 1];
        pushEv("undo", (g && g.w) || (last && last.w) || "(无)", g ? { ok: g.ok ? 1 : 0, nw: g.wasNew ? 1 : 0, rt: g.rt | 0 } : undefined);
        saveLog(true);
      } catch (e) { }
    };
  });
  wrap("sessionDone", function (orig) {
    return function () {
      try { pushEv("done", "(本轮完成)"); saveLog(true); } catch (e) { }
      return orig.apply(this, arguments);
    };
  });
  wrap("renderCard", function (orig) {
    return function (w) {
      var r = orig.apply(this, arguments);
      try { afterRender(w); } catch (e) { }
      return r;
    };
  });
  wrap("fixedRenderCard", function (orig) {
    return function (w) {
      var r = orig.apply(this, arguments);
      try { afterRender(w); } catch (e) { }
      return r;
    };
  });
  var chipUndo = $("#chipUndo");
  if (chipUndo) chipUndo.onclick = window.undo;             // 撤销按钮重新指向包装后的版本
  /* 所有"揭晓答案"的入口（老手势、键盘、评分前自动揭晓、固定模式）都从这里过一遍，
     这样学习记录不会漏记，也不会重复记。 */
  function afterReveal(w) {
    try {
      var hint = $("#hintEl");
      if (hint) hint.textContent = HINT_SHOWN;
      recView(w, !!(S.ui.auto || S.fixed.auto));
    } catch (e) { }
  }
  wrap("reveal", function (orig) {
    return function () {
      var was = !!S.ui.revealed;
      var r = orig.apply(this, arguments);
      try { if (!was && S.ui.revealed && typeof cur === "string") afterReveal(cur); } catch (e) { }
      return r;
    };
  });
  wrap("fixedReveal", function (orig) {
    return function () {
      var was = !!S.fixed.revealed;
      var r = orig.apply(this, arguments);
      try { if (!was && S.fixed.revealed && typeof cur === "string") afterReveal(cur); } catch (e) { }
      return r;
    };
  });

  function isZhFace(w) {
    if (S.fixed.active) return S.fixed.face === "zh";
    if (S.ui.zhFirst === "zh") return true;
    if (S.ui.zhFirst === "en") return false;
    var c = S.p[w];
    return !!(c && c.type === "zh");
  }
  function hintHidden() { return faceZh ? "想起英文 → 点一下看答案" : "想起中文 → 点一下看答案"; }
  var HINT_SHOWN = "答案已显示 · 点一下收起";
  function afterRender(w) {
    shownAt = Date.now();
    faceZh = isZhFace(w);
    var card = $("#card"), hint = $("#hintEl");
    if (!card || !hint) return;
    var shown = !card.classList.contains("hidden");
    hint.textContent = shown ? (S.ui.auto ? "" : HINT_SHOWN) : hintHidden();
    card.classList.toggle("fixedmode", !!S.fixed.active);          // 固定刷库模式一眼可辨
    var bank = $("#tBank"), bi = typeof w === "string" ? S.w.indexOf(w) : -1;
    if (bank) bank.textContent = "英语核心词" + (bi >= 0 ? " · " + (bi + 1) + "/" + S.N : "");
    if (!S.fixed.active && S.ses && typeof w === "string" && S.ses.cur !== w) {
      S.ses.cur = w;                       // 记住"当前这张卡"，刷新/重开后能回到同一张
      try { saveMeta(); } catch (e) { }
    }
    if (shown && S.ui.auto && typeof w === "string") recView(w, true);   // 极速连播：答案是自动展示的
    try { noteStudySoon(); } catch (e) { }
  }

  /* ==================== 点一下显示 / 再点一下收起 ==================== */
  function shownNow() { return S.fixed.active ? !!S.fixed.revealed : !!S.ui.revealed; }
  function setShown(on) {
    if (typeof cur !== "string") return false;
    var want = !!on;
    if (shownNow() === want) return false;
    if (S.fixed.active) {
      if (want) window.fixedReveal();          // 复用原逻辑：显示 + 按设置发声 + 记录
      else S.fixed.revealed = false;
    } else {
      if (want) window.reveal();               // 复用原逻辑：显示 + 按设置发声 + 记录
      else S.ui.revealed = false;
    }
    var shown = shownNow();
    var card = $("#card"), hint = $("#hintEl");
    if (card) card.classList.toggle("hidden", !shown);
    if (hint) hint.textContent = shown ? HINT_SHOWN : hintHidden();
    if (!shown) { pushEv("hide", cur); saveLog(true); }
    return true;
  }
  function toggleShown() {
    if (S.ui.auto) return;
    if (typeof cur !== "string") return;
    setShown(!shownNow());
  }

  /* 点击手势：与原来那套"轻点揭晓 / 左右滑动评分"共存。
     原处理器先执行，如果它已经把卡片揭晓了，这一次点击就不再切换。 */
  var card = $("#card");
  if (card) {
    var downX = 0, downY = 0, down = false, moved = false, armed = false, pend = 0, base = null, onControl = false;
    card.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      down = true; moved = false; armed = false;
      downX = e.clientX; downY = e.clientY;
      onControl = !!(e.target && e.target.closest && e.target.closest("button,input,select,a,textarea"));
      base = { fixed: !!S.fixed.active, n: !!S.ui.revealed, f: !!S.fixed.revealed };
    });
    card.addEventListener("pointermove", function (e) {
      if (!down) return;
      if (Math.abs(e.clientX - downX) > 10 || Math.abs(e.clientY - downY) > 16) moved = true;
    });
    card.addEventListener("pointerup", function () {
      if (!down) return;
      down = false;
      if (moved || onControl || S.ui.auto || typeof cur !== "string") { armed = false; return; }
      var sameMode = base && base.fixed === !!S.fixed.active;
      var justShown = sameMode && (base.fixed ? (S.fixed.revealed && !base.f) : (S.ui.revealed && !base.n));
      if (justShown) {                                  // 老逻辑刚替我揭晓，补上提示即可
        var hint = $("#hintEl");
        if (hint) hint.textContent = HINT_SHOWN;
        armed = false;
        return;
      }
      armed = true;
      clearTimeout(pend);
      pend = setTimeout(function () { if (armed) { armed = false; toggleShown(); } }, 200);   // 没有 click 时兜底
    });
    card.addEventListener("pointercancel", function () { down = false; armed = false; clearTimeout(pend); });
    card.addEventListener("click", function () {
      clearTimeout(pend);
      if (!armed) return;
      armed = false;
      toggleShown();
    });
  }

  /* ============================ 汇总计算 ============================ */
  function lastDays(n) {
    var out = [], d = new Date();
    d.setHours(0, 0, 0, 0);
    for (var i = 0; i < n; i++) {
      var k = dk(d.getTime() - i * DAYMS);
      out.push({ k: k, i: i, d: log.days[k] || { rev: 0, ok: 0, no: 0, nw: 0, views: 0, ms: 0 } });
    }
    return out;
  }
  function sumAll() {
    var rev = 0, ok = 0, no = 0, nw = 0, views = 0, ms = 0, days = 0;
    for (var k in log.days) {
      var x = log.days[k];
      if (!x) continue;
      rev += x.rev | 0; ok += x.ok | 0; no += x.no | 0; nw += x.nw | 0;
      views += x.views | 0; ms += x.ms | 0;
      if ((x.rev | 0) + (x.views | 0) > 0) days++;
    }
    return { rev: rev, ok: ok, no: no, nw: nw, views: views, ms: ms, days: days, rate: rev ? Math.round(ok / rev * 100) : 0 };
  }
  function streak() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    var n = 0;
    for (var i = 0; i < 400; i++) {
      var x = log.days[dk(d.getTime() - i * DAYMS)];
      var has = !!(x && ((x.rev | 0) + (x.views | 0) > 0));
      if (has) { n++; continue; }
      if (i === 0) continue;                        // 今天还没开始，不算断签
      break;
    }
    return n;
  }

  /* ============================ 面板渲染 ============================ */
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function clock(t) { var d = new Date(t); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
  function stamp(t) { var d = new Date(t); return (d.getMonth() + 1) + "/" + d.getDate() + " " + clock(t); }
  function md(k) { var p = String(k).split("-"); return p.length === 3 ? (+p[1]) + "/" + (+p[2]) : String(k); }
  function dur(ms) {
    var m = Math.round((ms || 0) / MINMS);
    return m < 60 ? m + " 分" : (m / 60).toFixed(1) + " 小时";
  }
  function cell(label, val) { return "<div><span>" + label + "</span><b>" + val + "</b></div>"; }
  var EVNAME = { show: "👁 看答案", hide: "▤ 收起", ok: "✓ 认识", no: "✕ 不认识", undo: "↺ 撤销", done: "🎉 完成一轮" };

  function renderLog() {
    if (typeof audioStop === "function") audioStop();
    var panel = $("#panel");
    if (!panel) return;
    var all = sumAll(), week = lastDays(7), today = week[0].d;
    var maxRev = 1, i;
    for (i = 0; i < week.length; i++) maxRev = Math.max(maxRev, week[i].d.rev | 0);
    var evs = log.events.slice(-80).reverse();
    var weak = [];
    for (i = 0; i < S.N; i++) {
      var w = S.w[i], c = S.p[w];
      if (!c || !c.seen) continue;
      var ag = c.again | 0, vw = c.views | 0;
      if (ag > 0 || vw >= 3) weak.push({ w: w, zh: S.d[i] || "", ag: ag, vw: vw, lv: c.lv | 0, s: ag * 10 + vw });
    }
    weak.sort(function (a, b) { return b.s - a.s; });
    weak = weak.slice(0, 8);

    var dayRows = week.map(function (x) {
      var name = x.i === 0 ? "今天" : x.i === 1 ? "昨天" : md(x.k);
      var okW = (x.d.ok | 0) / maxRev * 100, noW = (x.d.no | 0) / maxRev * 100;
      return '<div class="dayrow"><div class="d"><b>' + name + "</b><span class=\"sp\"></span><span>判断 " + (x.d.rev | 0) +
        " · 新 " + (x.d.nw | 0) + " · 错 " + (x.d.no | 0) + " · 看答案 " + (x.d.views | 0) + " · " + dur(x.d.ms) + "</span></div>" +
        '<div class="meter"><i style="width:' + okW.toFixed(1) + "%;background:var(--ok)\"></i>" +
        '<i style="width:' + noW.toFixed(1) + '%;background:var(--no)"></i></div></div>';
    }).join("");

    var evRows = evs.map(function (e) {
      var cls = e.k === "ok" ? "ok" : e.k === "no" ? "no" : (e.k === "show" ? "v" : "n");
      var tail = "";
      if (e.k === "ok" || e.k === "no") tail = " · " + LVNAME[clamp(e.lv | 0, 0, 7)];
      if (e.k === "show" && e.n) tail = " · 第 " + e.n + " 次";
      if (e.rt) tail += " · " + (e.rt / 1000).toFixed(1) + "s";
      return '<div class="evrow"><span class="tm">' + (e.t > Date.now() - DAYMS && dk(e.t) === dk() ? clock(e.t) : stamp(e.t)) + "</span>" +
        '<span class="wd">' + esc(e.w) + (e.auto ? "<small>自动</small>" : "") + "</span>" +
        '<span class="rs ' + cls + '">' + (EVNAME[e.k] || e.k) + tail + "</span></div>";
    }).join("") || '<div class="empty"><p>还没有记录，点几张卡片就会出现在这里。</p></div>';

    var weakRows = weak.map(function (x) {
      return '<div class="evrow"><span class="tm">错 ' + x.ag + "</span>" +
        '<span class="wd">' + esc(x.w) + "<small>" + esc(x.zh) + "</small></span>" +
        '<span class="rs ' + (x.ag ? "no" : "n") + '">看答案 ' + x.vw + " 次</span></div>";
    }).join("") || '<div class="empty"><p>暂时没有薄弱词。</p></div>';

    panel.innerHTML =
      '<div class="grab"></div>' +
      '<h2><span>📈 学习记录</span><button class="iconbtn" id="lgClose">✕</button></h2>' +

      '<div class="sec"><h3>今天</h3><div class="logstat">' +
        cell("看答案", today.views | 0) + cell("判断次数", today.rev | 0) + cell("今日新词", today.nw | 0) +
        cell("认识", today.ok | 0) + cell("不认识", today.no | 0) + cell("专注用时", dur(today.ms)) +
      "</div></div>" +

      '<div class="sec"><h3>累计（存在本机，隔天不会丢）</h3><div class="logstat">' +
        cell("学习天数", all.days) + cell("连续天数", streak()) + cell("正确率", all.rate + "%") +
        cell("总判断", all.rev) + cell("总看答案", all.views) + cell("总用时", dur(all.ms)) +
      "</div></div>" +

      '<div class="sec"><h3>近 7 天</h3><div class="daylist">' + dayRows + "</div></div>" +

      '<div class="sec"><h3>最容易忘的词（按答错 / 看答案次数）</h3><div class="evlist">' + weakRows + "</div></div>" +

      '<div class="sec"><h3>最近动作（新 → 旧，最多 80 条）</h3><div class="evlist">' + evRows + "</div></div>" +

      '<div class="sec"><h3>导出与清理</h3>' +
        '<div class="actsrow"><button class="btn ghost" id="lgCsv">导出 CSV</button>' +
        '<button class="btn ghost" id="lgJson">导出 JSON</button></div>' +
        '<div class="actsrow" style="margin-top:10px"><button class="btn ghost danger" id="lgClear">清空学习记录</button></div>' +
        '<p style="font-size:12px;color:var(--fg3);line-height:1.75;margin:12px 0 0">' +
        "记录保存在本机浏览器（localStorage），不会上传。<b>CSV</b> 可直接用 Excel / WPS 打开做统计；" +
        "清空记录不会影响单词的记忆等级与复习排期。</p>" +
      "</div>";

    $("#lgClose").onclick = closeSheet;
    $("#lgCsv").onclick = exportCSV;
    $("#lgJson").onclick = exportJSON;
    $("#lgClear").onclick = function () {
      if (!confirm("清空全部学习记录（时间线与每日统计）？单词的记忆等级不受影响。")) return;
      log = { events: [], days: {} };
      saveLog(true);
      renderLog();
      toast("学习记录已清空");
    };
  }
  function openLog() {
    renderLog();
    $("#sheet").classList.add("open");
  }

  /* ============================ 导出 ============================ */
  function csvCell(v) {
    var s = (v === undefined || v === null) ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function exportCSV() {
    var rows = [["日期", "时间", "单词", "动作", "是否认识", "记忆等级", "下次复习", "看答案次数", "思考秒数", "自动"]];
    log.events.forEach(function (e) {
      var isGrade = e.k === "ok" || e.k === "no";
      rows.push([
        dk(e.t), clock(e.t), e.w, EVNAME[e.k] || e.k,
        isGrade ? (e.k === "ok" ? "认识" : "不认识") : "",
        isGrade ? LVNAME[clamp(e.lv | 0, 0, 7)] : "",
        (isGrade && e.due) ? dk(e.due) : "",
        e.n === undefined ? "" : e.n,
        e.rt ? (e.rt / 1000).toFixed(1) : "",
        e.auto ? "是" : ""
      ]);
    });
    var csv = "\ufeff" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    download("闪卡学习记录-" + dk() + ".csv", csv, "text/csv");
    toast("已导出 CSV（" + log.events.length + " 条记录）");
  }
  function exportJSON() {
    var payload = { v: 1, at: Date.now(), exportedFrom: "闪卡 · 英语核心词", days: log.days, events: log.events };
    download("闪卡学习记录-" + dk() + ".json", JSON.stringify(payload, null, 1), "application/json");
    toast("已导出 JSON");
  }

  /* ============================ 入口按钮 ============================ */
  function addChip(host) {
    if (!host || host.querySelector("#chipLog")) return;
    var b = document.createElement("button");
    b.className = "chip";
    b.id = "chipLog";
    b.type = "button";
    b.textContent = "📈 学习记录";
    b.onclick = openLog;
    host.appendChild(b);
  }
  addChip($("#normalSub"));
  addChip($("#fixedSub"));
  wrap("renderPanel", function (orig) {                 // 设置面板的"数据管理"里也加一个入口
    return function () {
      var r = orig.apply(this, arguments);
      try {
        var secs = $("#panel").querySelectorAll(".sec");
        var last = secs[secs.length - 1];
        if (last && !$("#lgOpen")) {
          var row = document.createElement("div");
          row.className = "actsrow";
          row.style.marginTop = "10px";
          row.innerHTML = '<button class="btn ghost" id="lgOpen">📈 查看学习记录</button>' +
            '<button class="btn ghost" id="lgCsv2">导出记录 CSV</button>';
          last.appendChild(row);
          $("#lgOpen").onclick = openLog;
          $("#lgCsv2").onclick = exportCSV;
        }
        /* 数据管理：换成完整备份/恢复（含进度、记录、固定顺序、额外词库） */
        var pe = $("#pExport"), pi = $("#pImport");
        if (pe && pi && window.LexisBackup && !pe.dataset.fresh) {
          pe = rebindFresh("#pExport", "⬇ 导出数据 (JSON)", function () { doExportAll(); });
          pi = rebindFresh("#pImport", "⬆ 导入数据", function () { doImportAll(); });
          if (pe) pe.dataset.fresh = "1";
          if (pe && pe.parentNode && pe.parentNode.parentNode && !$("#pAudioZipOut")) {
            var zrow = document.createElement("div");
            zrow.className = "actsrow";
            zrow.style.marginTop = "10px";
            zrow.innerHTML = '<button class="btn ghost" id="pAudioZipOut">导出音频 ZIP</button>' +
              '<button class="btn ghost" id="pAudioZipIn">导入音频 ZIP</button>';
            pe.parentNode.parentNode.appendChild(zrow);
            $("#pAudioZipOut").onclick = function () { doExportAudio(); };
            $("#pAudioZipIn").onclick = function () { doImportAudioZip(); };
          }
        }
        /* 本地音频：改用新的导入实现（支持多选文件与 deflate ZIP），并加管理入口 */
        var af = $("#pAudioFiles"), ap = $("#pAudioPack");
        if (af && ap && window.LexisAudio && !af.dataset.fresh) {
          af = rebindFresh("#pAudioFiles", "📁 导入文件夹", function () { window.LexisAudio.pick("dir"); });
          ap = rebindFresh("#pAudioPack", "🗜 导入 ZIP", function () { window.LexisAudio.pick("zip"); });
          if (af) af.dataset.fresh = "1";
          if (af && af.parentNode && !$("#pAudioManage")) {
            var mb = document.createElement("button");
            mb.className = "chip"; mb.id = "pAudioManage"; mb.textContent = "🎧 管理音频";
            mb.style.color = "var(--accent)"; mb.style.fontWeight = "700";
            mb.onclick = function () { window.LexisAudio.panel(); };
            af.parentNode.appendChild(mb);
            var fb = document.createElement("button");
            fb.className = "chip"; fb.id = "pAudioMulti"; fb.textContent = "🎵 多选文件";
            fb.onclick = function () { window.LexisAudio.pick("files"); };
            af.parentNode.appendChild(fb);
          }
        }
        /* 试听发音：没有卡片时用词库里的真词，避免念成第 1 个词的中文释义 */
        var t = rebindFresh("#pTest") || $("#pTest");
        if (t) t.onclick = function () {
          unblockTTS();
          var w = (typeof cur === "string" && cur) ? cur : (S.w[0] || "");
          toast("试听：" + (S.ui.voiceMode === "tts" ? "系统语音" : "真人音优先"));
          if (w) speakCard(w);
        };
      } catch (e) { }
      return r;
    };
  });

  /* ==================================================================
     V2 · 稳定性修复（音频世代 / 数据清洗 / 独立模式隔离 / 极端操作防护）
     ================================================================== */

  /* ---------- ① 数据清洗：字段缺失、类型不对、旧版本残留，都只修不崩 ---------- */
  function num2(v, d) { var x = +v; return isFinite(x) ? x : (d || 0); }
  function fixCard(c) {
    c.lv = clamp(Math.round(num2(c.lv)), 0, MASTER_LV);
    c.due = Math.max(0, Math.round(num2(c.due)));
    c.seen = Math.max(0, Math.round(num2(c.seen)));
    c.know = Math.max(0, Math.round(num2(c.know)));
    c.again = Math.max(0, Math.round(num2(c.again)));
    c.streak = Math.max(0, Math.round(num2(c.streak)));
    c.steps = Math.max(0, Math.round(num2(c.steps)));
    c.first = Math.max(0, Math.round(num2(c.first)));
    c.last = Math.max(0, Math.round(num2(c.last)));
    c.views = Math.max(0, Math.round(num2(c.views)));
    c.rt = Math.max(0, Math.round(num2(c.rt)));
    if (c.type !== "zh" && c.type !== "en") c.type = "";
  }
  function sanitizeState() {
    /* 单词进度表 */
    if (!S.p || typeof S.p !== "object" || Array.isArray(S.p)) S.p = {};
    for (var k in S.p) {
      var c = S.p[k];
      if (!c || typeof c !== "object" || Array.isArray(c)) { delete S.p[k]; continue; }
      fixCard(c);
    }
    /* 今日统计 */
    if (!S.stats || typeof S.stats !== "object" || Array.isArray(S.stats)) S.stats = { day: todayKey(), rev: 0, again: 0, nw: 0, ms: 0 };
    if (typeof S.stats.day !== "string") S.stats.day = todayKey();
    S.stats.rev = Math.max(0, Math.round(num2(S.stats.rev)));
    S.stats.again = Math.max(0, Math.round(num2(S.stats.again)));
    S.stats.nw = Math.max(0, Math.round(num2(S.stats.nw)));
    S.stats.ms = Math.max(0, Math.round(num2(S.stats.ms)));
    /* 配置项 */
    var u = S.ui;
    u.newBudget = clamp(Math.round(num2(u.newBudget, 300)), 0, 5000);
    u.revBudget = clamp(Math.round(num2(u.revBudget, 600)), 0, 5000);
    u.autoMs = clamp(Math.round(num2(u.autoMs, 2600)), 500, 20000);
    u.rate = clamp(num2(u.rate, 0.95), 0.5, 1.4);
    u.reps = clamp(Math.round(num2(u.reps, 1)), 1, 3);
    if (["mix", "en", "zh"].indexOf(u.zhFirst) < 0) u.zhFirst = "mix";
    if (["hybrid", "human", "tts"].indexOf(u.voiceMode) < 0) u.voiceMode = "hybrid";
    if (["auto", "light", "dark"].indexOf(u.theme) < 0) u.theme = "auto";
    if (!AUDIO_SOURCES[u.srcId]) u.srcId = "youdao-us";
    u.speakAuto = u.speakAuto !== false;
    u.hideAnswer = u.hideAnswer !== false;
    u.zhTTS = !!u.zhTTS;
    u.ipa = !!u.ipa;
    if (typeof u.voiceName !== "string") u.voiceName = "";
    if (typeof u.accent !== "string" || !u.accent) u.accent = "en-US";
    /* 当前队列会话 */
    if (S.ses) {
      var s = S.ses, bad = (typeof s !== "object" || s === null) || s.day !== todayKey() ||
        !Array.isArray(s.q) || !s.q.length || num2(s.t0) <= 0;
      if (!bad) for (var i = 0; i < s.q.length; i++) { if (typeof s.q[i] !== "string") { bad = true; break; } }
      if (bad) S.ses = null;
      else {
        /* V3：词库被换掉后，旧会话队列里会残留已经不存在的词（卡片会显示空的中文释义）。
           这里把失效词剔掉，并按剔除数量修正游标，保证"已看过的位置"不错位。 */
        var q2 = [], cut = 0;
        for (var qj = 0; qj < s.q.length; qj++) {
          if (S.w.indexOf(s.q[qj]) < 0) { if (qj < s.qi) cut++; continue; }
          q2.push(s.q[qj]);
        }
        if (q2.length !== s.q.length) { s.q = q2; s.qi = Math.max(0, Math.round(num2(s.qi)) - cut); }
        s.qi = clamp(Math.round(num2(s.qi)), 0, s.q.length);
        if (s.qi >= s.q.length) S.ses = null;
        else {
          s.graded = Math.max(0, Math.round(num2(s.graded)));
          s.again = Math.max(0, Math.round(num2(s.again)));
          s.goal = Math.max(1, Math.round(num2(s.goal, s.q.length)));
          s.due0 = Math.max(0, Math.round(num2(s.due0)));
          s.fresh0 = Math.max(0, Math.round(num2(s.fresh0)));
          s.backlog = Math.max(0, Math.round(num2(s.backlog)));
          if (!Array.isArray(s.hist)) s.hist = [];
          if (!s.seen2 || typeof s.seen2 !== "object") s.seen2 = {};
          if (s.cur !== undefined && (typeof s.cur !== "string" || S.w.indexOf(s.cur) < 0)) delete s.cur;
        }
      }
    }
    /* 固定随机刷库状态：只动它自己的字段，与正常学习进度完全分离 */
    var f = S.fixed;
    if (!f || typeof f !== "object") {
      S.fixed = { order: [], key: "", pos: 0, completed: 0, active: false, revealed: false, auto: false, speak: true, face: "en" };
    } else {
      if (!Array.isArray(f.order)) f.order = [];
      f.order = f.order.filter(function (x) { return typeof x === "string"; });
      /* V3：顺序数组被写坏时（长度和 key 都对、内容却不在词库里）原版会照用，
         结果是卡片题面为空、答案是一个不存在的词。这里抽样校验，对不上就重新生成。 */
      var orderOk = f.order.length === S.N && f.order.length > 0;
      if (orderOk) {
        var stepO = Math.max(1, Math.floor(f.order.length / 30));
        for (var oi = 0; oi < f.order.length; oi += stepO) {
          if (S.w.indexOf(f.order[oi]) < 0) { orderOk = false; break; }
        }
      }
      if (!orderOk) {
        f.order = []; f.key = "";
        try { localStorage.removeItem(LSK("fixedOrder")); } catch (e) { }
        if (typeof loadFixedState === "function") { try { loadFixedState(); } catch (e) { } }
      }
      f.completed = Math.max(0, Math.round(num2(f.completed)));
      f.pos = clamp(Math.round(num2(f.pos)), 0, Math.max(0, f.order.length - 1));
      f.active = false;                     // 刷新后不自动进入刷库模式
      f.auto = false;
      f.revealed = false;
      f.speak = f.speak !== false;
    }
  }

  /* ---------- ② 启动自检：瞬时状态不跨会话；boot 被脏数据打断也能救回 ---------- */
  var uiWasAuto = false, bootBroken = false;
  function selfCheck() {
    uiWasAuto = !!S.ui.auto;
    S.ui.auto = false;                      // 连播状态不继承，否则重开会静默自动翻卡
    S.ui.revealed = false;
    if (uiWasAuto) { try { clearTimeout(autoTimer); audioStop(); } catch (e) { } }
    try {                                   // 清掉旧版本写进本机的瞬时字段
      var raw = JSON.parse(localStorage.getItem(LSK("ui")) || "null");
      if (raw && typeof raw === "object" && (("auto" in raw) || ("revealed" in raw))) {
        delete raw.auto; delete raw.revealed;
        localStorage.setItem(LSK("ui"), JSON.stringify(raw));
      }
    } catch (e) { }
    var face = $("#face");
    if (!face) return;
    if (typeof cur === "string" && S.w.indexOf(cur) < 0) {
      /* V3：卡片上这个词已经不在当前词库里（换了词库文件）。
         主脚本 boot() 在补丁之前就跑完了，所以这里必须换一张真实的卡，否则会一直显示空答案。 */
      var nw0 = (S.ses && S.ses.qi < S.ses.q.length) ? nextWord() : null;
      if (nw0) renderCard(nw0);
      else if (S.ses) sessionDone();
      else showStart();
      return;
    }
    if (typeof cur === "string") {
      var target = cur;
      /* 主脚本的 boot() 会 nextWord() 取下一张：如果和"刷新前正在看的那张"不是同一张，
         就把队列游标还回去并重新显示原卡，避免每刷新一次就吞掉一个词。 */
      if (S.ses && typeof S.ses.cur === "string" && S.ses.cur !== cur && S.w.indexOf(S.ses.cur) >= 0) {
        if (S.ses.q[S.ses.qi - 1] === cur) S.ses.qi = Math.max(0, S.ses.qi - 1);
        target = S.ses.cur;
      }
      if (!face.children.length || uiWasAuto || target !== cur) renderCard(target);
    } else if (!face.children.length) {
      bootBroken = true;                    // 主脚本 boot 被脏数据打断：补一次渲染，避免白屏
      try { applyTheme(); fixedUpdateChrome(); } catch (e) { }
      if (S.ses && S.ses.qi < S.ses.q.length) startSession(false); else showStart();
    }
  }

  /* ---------- ③ 音频：手动播放入口也开新的"播放世代" ----------
     原来只有 speakCard() 会开新世代，🔊 按钮走的 playHumanFromGesture()/sayWord() 不会，
     于是连点 10 次 🔊 会有多个 <audio> 同时播放（本次已实测复现）。 */
  wrap("playHumanFromGesture", function (orig) {
    return function (w, cb) {
      var inAuto = !!S.ui.auto;
      try { beginSpeakSession(); } catch (e) { }     // 停掉上一段，并让旧的异步回调全部失效
      var r = orig.apply(this, arguments);
      if (inAuto && typeof w === "string" && w === cur) {
        /* 连播中手动试听会作废连播"读完再翻"的回调，这里补一个兜底推进，避免连播卡死。
           autoStep 内部有 w !== cur 的保护，不会重复推进。 */
        try {
          clearTimeout(autoTimer);
          autoTimer = setTimeout(function () { if (S.ui.auto && w === cur) autoStep(w); },
            Math.max(900, +S.ui.autoMs || 2600) + 400);
        } catch (e) { }
      }
      return r;
    };
  });

  /* ---------- ④ 暂停 / 回首页 / 离开页面 时停掉音频 ---------- */
  wrap("toggleAuto", function (orig) {
    return function () {
      var r = orig.apply(this, arguments);
      try { if (!S.ui.auto && !S.fixed.auto) audioStop(); } catch (e) { }
      return r;
    };
  });
  wrap("toggleFixedAuto", function (orig) {
    return function () {
      var r = orig.apply(this, arguments);
      try { if (!S.fixed.auto) audioStop(); } catch (e) { }
      return r;
    };
  });
  wrap("showStart", function (orig) {
    return function () {
      try { audioStop(); } catch (e) { }
      return orig.apply(this, arguments);
    };
  });

  /* ---------- ⑤ 固定刷库进出不再吞掉正在学的那张卡 ----------
     原逻辑退出刷库时直接 nextWord()，已经出队但还没评分的那张卡会被跳过。 */
  var fixedReturn = "";
  wrap("enterFixedMode", function (orig) {
    return function () {
      fixedReturn = (typeof cur === "string") ? cur : "";
      return orig.apply(this, arguments);
    };
  });
  wrap("exitFixedMode", function (orig) {
    return function () {
      var back = fixedReturn; fixedReturn = "";
      if (back && S.w.indexOf(back) >= 0 && S.ses && S.ses.qi <= S.ses.q.length) {
        try {
          clearTimeout(fixedTimer); clearTimeout(autoTimer);
          S.fixed.active = false; S.fixed.auto = false; S.fixed.revealed = false;
          S.ui.auto = normalAutoBeforeFixed;
          audioStop(); fixedUpdateChrome();
          $("#actRow").style.display = "";
          renderCard(back);                 // 回到原来那张，队列位置不变，不丢词
          return;
        } catch (e) { }
      }
      return orig.apply(this, arguments);
    };
  });

  /* ---------- ⑥ 固定顺序不重复落盘 ----------
     词库 5000+ 词时，顺序数组 ≈ 50KB；原实现每点一次「下一词」都把它整份重写一遍。
     顺序只在生成/重排时变，所以这里只在"指纹"变化时写顺序，位置每次写很小的那份。 */
  var orderSig = "";
  function orderFingerprint() {
    var o = S.fixed.order;
    return S.fixed.key + "|" + o.length + "|" + (o[0] || "") + "|" + (o[o.length - 1] || "");
  }
  wrap("saveFixedState", function (orig) {
    return function () {
      try {
        var sig = orderFingerprint();
        if (sig !== orderSig) {
          localStorage.setItem(LSK("fixedOrder"), JSON.stringify({ key: S.fixed.key, order: S.fixed.order }));
          orderSig = sig;
        }
        localStorage.setItem(LSK("fixedState"), JSON.stringify({ pos: S.fixed.pos, completed: S.fixed.completed }));
      } catch (e) {
        try { orig.apply(this, arguments); } catch (e2) { }
      }
    };
  });
  wrap("resetFixedOrder", function (orig) {
    return function () {
      orderSig = "";                       // 要重新洗牌，先作废指纹，保证新顺序会落盘
      return orig.apply(this, arguments);
    };
  });

  /* ---------- ⑦ 词库面板：词库名 / 总数 / 已学已刷 / 状态 / 筛选 / 搜索 ---------- */
  var origWordBank = window.renderWordBank;
  function bankState(c) {
    if (!c || !c.seen) return { t: "新词", cls: "" };
    if (isMaster(c)) return { t: "已掌握", cls: " ok" };
    if (c.again) return { t: "错过 " + (c.again | 0) + " 次", cls: " warn" };
    return { t: "间隔 " + LVNAME[clamp(c.lv | 0, 0, 7)], cls: "" };
  }
  function renderWordBank2() {
    try { audioStop(); } catch (e) { }
    var panel = $("#panel");
    if (!panel) return;
    var st = totals(), lg = sumAll();
    panel.innerHTML =
      '<div class="grab"></div>' +
      '<h2><span>词库 · 英语核心词</span><button class="iconbtn" id="wbClose">✕</button></h2>' +
      '<div class="f" style="display:block;border-bottom:0;padding-top:0">' +
        '<input id="wordSearch" type="search" placeholder="搜索英文或中文释义" style="width:100%;max-width:none">' +
      "</div>" +
      '<div class="fore" id="wbStat"></div>' +
      '<div class="sub" id="wbFilter" style="justify-content:flex-start;margin:10px 0 8px"></div>' +
      '<div class="wordlist" id="wordList"></div>';
    var filter = "all";
    var FILTERS = [["all", "全部"], ["new", "未学"], ["seen", "学过"], ["weak", "模糊"], ["master", "已掌握"]];
    var cnt = { all: S.N, "new": 0, seen: 0, weak: 0, master: 0 };
    for (var i0 = 0; i0 < S.N; i0++) {
      var c0 = S.p[S.w[i0]];
      if (!c0 || !c0.seen) { cnt["new"]++; continue; }
      cnt.seen++;
      if (c0.again) cnt.weak++;
      if (isMaster(c0)) cnt.master++;
    }
    function render() {
      var el = $("#wordSearch");
      var q = String(el ? el.value : "").trim().toLowerCase();
      var rows = [];
      for (var i = 0; i < S.N; i++) {
        var en = String(S.w[i] || ""), zh = String(S.d[i] || ""), c = S.p[en];
        if (filter === "new" && c && c.seen) continue;
        if (filter === "seen" && (!c || !c.seen)) continue;
        if (filter === "weak" && (!c || !c.again)) continue;
        if (filter === "master" && (!c || !isMaster(c))) continue;
        if (q && en.toLowerCase().indexOf(q) < 0 && zh.toLowerCase().indexOf(q) < 0) continue;
        rows.push({ i: i, en: en, zh: zh, c: c });
      }
      var MAXROWS = 500, matched = rows.length, view = rows.slice(0, MAXROWS);
      $("#wbStat").innerHTML = "共 <b>" + S.N + "</b> 词 · 已学 <b>" + st.started + "</b> 词 · 已掌握 <b>" + st.master +
        "</b> 词 · 模糊 <b>" + st.weak + "</b> 词<br>累计看答案 <b>" + lg.views + "</b> 次 · 累计判断 <b>" + lg.rev +
        "</b> 次 · 当前列出 <b>" + view.length + "</b> 词" +
        (matched > MAXROWS ? "（匹配 " + matched + " 词，为流畅只列前 " + MAXROWS + "，用搜索或筛选缩小范围）" : "");
      $("#wordList").innerHTML = view.map(function (x) {
        var bs = bankState(x.c), vw = x.c ? (x.c.views | 0) : 0;
        return '<div class="wordrow" data-i="' + x.i + '"><span class="num">' + (x.i + 1) + "</span>" +
          '<span class="en">' + esc(x.en) + "</span>" +
          '<span class="zh">' + esc(x.zh) + '<small class="st' + bs.cls + '">' + bs.t + (vw ? " · 看 " + vw + " 次" : "") + "</small></span>" +
          '<button class="play" title="试听">🔊</button></div>';
      }).join("") || '<div class="empty"><p>没有匹配的词。</p></div>';
      var list = $("#wordList");
      var rs = list.querySelectorAll(".wordrow");
      for (var j = 0; j < rs.length; j++) {
        rs[j].addEventListener("click", function () {
          var idx = +this.getAttribute("data-i"), w = S.w[idx];
          if (w) speakCard(w);
        });
      }
    }
    $("#wbClose").onclick = closeSheet;
    $("#wordSearch").addEventListener("input", render);
    $("#wbFilter").innerHTML = FILTERS.map(function (f, n) {
      return '<button class="chip' + (n === 0 ? " on" : "") + '" data-f="' + f[0] + '">' + f[1] + " " + (cnt[f[0]] || 0) + "</button>";
    }).join("");
    var chips = $("#wbFilter").querySelectorAll(".chip");
    for (var i1 = 0; i1 < chips.length; i1++) {
      chips[i1].addEventListener("click", function () {
        filter = this.getAttribute("data-f");
        var all = $("#wbFilter").querySelectorAll(".chip");
        for (var m = 0; m < all.length; m++) all[m].classList.toggle("on", all[m] === this);
        render();
      });
    }
    render();
    setTimeout(function () { var e2 = $("#wordSearch"); if (e2) e2.focus(); }, 30);
  }
  window.renderWordBank = function () {
    try {
      renderWordBank2();
      $("#sheet").classList.add("open");        // 原版：📚 按钮只渲染面板、从不打开弹层 → 点了没反应
    } catch (e) { if (typeof origWordBank === "function") { try { origWordBank(); $("#sheet").classList.add("open"); } catch (e2) { } } }
  };

  /* ---------- ⑧ 顺手补一个"重听本词"入口（移动端拇指够得到） ---------- */
  function addReplayChip(host, isFixed) {
    if (!host || host.querySelector("#chipReplay")) return;
    var b = document.createElement("button");
    b.className = "chip";
    b.id = "chipReplay";
    b.type = "button";
    b.textContent = "🔊 重听";
    b.onclick = function () {
      var w = isFixed ? fixedCurrentWord() : cur;
      if (typeof w === "string") playHumanFromGesture(w);
      else toast("先开始学习");
    };
    host.appendChild(b);
  }
  addReplayChip($("#normalSub"), false);
  addReplayChip($("#fixedSub"), true);

  /* ---------- ⑨ 卡片上标明词库与位置 ---------- */
  (function addBankPill() {
    var tag = document.querySelector("#card .tag");
    if (!tag || document.getElementById("tBank")) return;
    var p = document.createElement("span");
    p.className = "pill";
    p.id = "tBank";
    p.textContent = "英语核心词";
    var sp = tag.querySelector(".sp");
    if (sp) tag.insertBefore(p, sp); else tag.appendChild(p);
  })();

  /* ==================================================================
     V3 · 破坏性压力测试发现的问题（每条都有复现步骤 + 回归用例）
     ================================================================== */

  /* ① 连续两次快速滑动：第 2 次评分被 140ms 防抖拦下，但卡片已经被平移到屏幕外，
        没有任何代码再把它复位 → 卡片"消失"。兜底：answer() 没换卡就清掉残留位移。 */
  wrap("answer", function (orig) {
    return function () {
      var w = cur;
      var r = orig.apply(this, arguments);
      try {
        if (cur === w) {
          var c = $("#card");
          if (c && c.style && c.style.transform) { c.style.transform = ""; c.style.transition = ""; }
        }
      } catch (e) { }
      return r;
    };
  });

  /* ② 手机上第二根手指的 pointer 事件会带着自己的坐标进入原手势逻辑，
        被当成"横向拖动"→ 双指触摸被判成"右滑＝认识"，卡片莫名被评分。
        在捕获阶段把非主指针的事件拦掉（只影响多指，单指/鼠标完全不受影响）。 */
  (function blockSecondaryPointers() {
    var types = ["pointerdown", "pointermove", "pointerup", "pointercancel"];
    for (var pi = 0; pi < types.length; pi++) {
      document.addEventListener(types[pi], function (e) {
        if (e.isPrimary === false) e.stopPropagation();
      }, true);
    }
  })();

  /* ③ 存储写满时，原版 saveMeta/saveProgress 的一个 try 会在第一个键失败后
        跳过后面所有键（会话、统计直接丢）。改成每个键各自兜底。 */
  function guardWrites(fn) {
    return function () {
      var proto = window.Storage && window.Storage.prototype;
      var origSet = proto && proto.setItem, swapped = false;
      if (origSet) {
        try {
          proto.setItem = function (k, v) {
            try { return origSet.call(this, k, v); } catch (e) { return undefined; }
          };
          swapped = true;
        } catch (e) { }
      }
      try { return fn.apply(this, arguments); }
      finally { if (swapped) { try { proto.setItem = origSet; } catch (e) { } } }
    };
  }
  wrap("saveMeta", guardWrites);
  wrap("saveProgress", guardWrites);
  wrap("saveFixedState", guardWrites);

  /* ==================================================================
     V4 · IndexedDB 数据层（LexisStore）
     只做"镜像"：不改变任何既有读写路径；IDB 不可用/写入失败一律静默跳过。
     用途：①备份导出 ②换手机导入 ③将来 Capacitor 复用同一套数据
     ================================================================== */
  var storeReady = false;
  function storeInit() {
    var LS = window.LexisStore;
    if (!LS || !LS.available || !LS.available()) return;
    LS.open().then(function (db) {
      if (!db) return;
      storeReady = true;
      try {
        LS.seedBuiltin("英语核心词", S.w, S.d).then(function (r) {
          if (r && r.seeded) { try { toast("词库已离线存入本机（" + r.total + " 词）"); } catch (e) { } }
        });
      } catch (e) { }
      try { LS.mirror.progressAll(S.p); } catch (e) { }
      try { LS.mirror.settings(S.ui); } catch (e) { }
      try { LS.mirror.log(log); } catch (e) { }
      try { LS.mirror.fixed(S.fixed.order, S.fixed.pos, S.fixed.completed); } catch (e) { }
      try { LS.mirror.session(S.ses); } catch (e) { }
      setTimeout(mirrorAudioMeta, 3000);
    }).catch(function () { });
  }
  function mirrorWordSoon(w) {
    var LS = window.LexisStore;
    if (!LS || !storeReady) return;
    try { LS.mirror.word(w, S.p[w]); } catch (e) { }
  }
  function mirrorStateSoon() {
    var LS = window.LexisStore;
    if (!LS || !storeReady) return;
    try { LS.mirror.settings(S.ui); } catch (e) { }
    try { LS.mirror.session(S.ses); } catch (e) { }
    try { LS.mirror.log(log); } catch (e) { }
  }
  function mirrorFixedSoon() {
    var LS = window.LexisStore;
    if (!LS || !storeReady) return;
    try { LS.mirror.fixed(S.fixed.order, S.fixed.pos, S.fixed.completed); } catch (e) { }
  }
  /* 把本地音频的"元数据"（不含 blob）镜像进 IDB，便于备份与统计 */
  function mirrorAudioMeta() {
    var LS = window.LexisStore;
    if (!LS || !LS.available() || typeof openAudioDB !== "function") return;
    try {
      openAudioDB().then(function (db) {
        if (!db) return;
        var rows = [];
        var tx2 = db.transaction("clips", "readonly"), os = tx2.objectStore("clips");
        var req = os.openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (!c) { if (rows.length) LS.mirror.audioMeta(rows); return; }
          var v = c.value || {};
          rows.push({ k: String(v.k || c.key), w: String(v.w || ""), src: String(v.src || ""), t: v.t | 0, size: (v.blob && v.blob.size) | 0 });
          c.continue();
        };
      }).catch(function () { });
    } catch (e) { }
  }
  function mirrorStateNow() {                              // 页面隐藏/关闭时立即落库
    var LS = window.LexisStore;
    if (!LS || !storeReady) return;
    try { LS.mirror.sessionNow(S.ses); } catch (e) { }
    try { LS.mirror.log(log); } catch (e) { }
  }
  wrap("saveMeta", function (orig) {
    return function () { var r = orig.apply(this, arguments); try { mirrorStateSoon(); } catch (e) { } return r; };
  });
  wrap("saveFixedState", function (orig) {
    return function () { var r = orig.apply(this, arguments); try { mirrorFixedSoon(); } catch (e) { } return r; };
  });
  wrap("importAudioFiles", function (orig) {
    return function () { var r = orig.apply(this, arguments); try { setTimeout(mirrorAudioMeta, 6000); } catch (e) { } return r; };
  });
  wrap("importAudioPack", function (orig) {
    return function () { var r = orig.apply(this, arguments); try { setTimeout(mirrorAudioMeta, 10000); } catch (e) { } return r; };
  });

  /* ==================================================================
     V5 · 本地真人发音增强
     ① 离线时不再尝试跨域在线音源（本地 blob 音频照常优先，且不再白等网络超时）
     ② 本地音频播放失败 → 标记为损坏，之后直接跳过，不再反复失败
     ③ 设置页接入「管理音频」面板（覆盖统计 / 缺失清单 / 多选导入 / deflate ZIP）
     ================================================================== */
  wrap("playViaAudio", function (orig) {
    return function (url, timeoutMs, token) {
      var u = String(url || "");
      var offline = (typeof navigator !== "undefined" && navigator.onLine === false);
      if (offline && /^https?:/i.test(u)) return Promise.resolve(false);   // 离线不试在线源
      var isLocal = /^blob:/i.test(u);
      return Promise.resolve(orig.apply(this, arguments)).then(function (ok) {
        if (!ok && isLocal && window.LexisAudio) {
          var bad = window.LexisAudio.lastRequested() || (typeof cur === "string" ? cur : "");
          try { if (bad) window.LexisAudio.markBad(bad, "本地音频无法播放"); } catch (e) { }
        }
        return ok;
      });
    };
  });
  wrap("getAudioURL", function (orig) {
    return function (w) {
      try {
        if (window.LexisAudio) {
          window.LexisAudio.noteRequested(w);
          if (window.LexisAudio.isBad(w)) return Promise.resolve(null);      // 已知损坏 → 当作没有本地音
        }
      } catch (e) { }
      return Promise.resolve(orig.apply(this, arguments));
    };
  });
  window.LEXI_AUDIO_MIRROR = function () { try { mirrorAudioMeta(); } catch (e) { } };

  /* ==================================================================
     V6 · 完整备份 / 恢复 + 「上次学到哪」信息（阶段5+6）
     ================================================================== */
  var suppressSave = false;
  /* 主程序的面板按钮是 addEventListener 绑定的：只改 onclick 会两个都触发。
     这里复制一个不带任何监听器的节点替换掉，再绑我们自己的处理器。 */
  function rebindFresh(sel, label, fn) {
    var el = $(sel);
    if (!el || !el.parentNode) return null;
    var c = el.cloneNode(true);
    if (label) c.textContent = label;
    c.onclick = fn;
    el.parentNode.replaceChild(c, el);
    return c;
  }   // 导入数据后要重载：这段时间内禁止把内存里的旧状态写回去
  function fmtTime(t) {
    if (!t) return "还没有记录";
    var d = new Date(t), now2 = new Date();
    var sameDay = d.toDateString() === now2.toDateString();
    var y = new Date(now2.getTime() - 864e5);
    var hh = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    if (sameDay) return "今天 " + hh;
    if (d.toDateString() === y.toDateString()) return "昨天 " + hh;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hh;
  }
  function lastStudyAt() {
    var best = 0, k;
    for (k in log.days) {
      var d = log.days[k];
      if (d && (+d.t1 || 0) > best) best = +d.t1 || 0;
    }
    return best;
  }
  function totalsAll() {
    var rev = 0, views = 0, ms = 0, k;
    for (k in log.days) {
      var d = log.days[k] || {};
      rev += d.rev | 0; views += d.views | 0; ms += d.ms | 0;
    }
    return { rev: rev, views: views, ms: ms, words: rev + views };
  }
  /* 开始页补上"上次学到哪 / 总刷词次数 / 当前词库" */
  function enhanceStart() {
    var face = $("#face");
    if (!face) return;
    var box = face.querySelector(".empty");
    if (!box) return;
    var t = totalsAll(), last = lastStudyAt();
    var ses = S.ses;
    var sesInfo = (ses && ses.qi < ses.q.length)
      ? ("学习队列：第 <b>" + (ses.qi + 1) + "</b> / " + ses.q.length + " 张，当前词 <b>" + esc(ses.cur || "—") + "</b>")
      : "学习队列：暂无未完成的队列";
    var fxInfo = (S.fixed.order && S.fixed.order.length)
      ? ("固定随机：第 <b>" + (S.fixed.completed + 1) + "</b> 遍 · 本遍第 <b>" + (S.fixed.pos + 1) + "</b> / " + S.fixed.order.length + " 个")
      : "固定随机：还没开始过";
    var html = '<div class="fore" style="margin-top:12px;text-align:left">' +
      "当前词库：<b>英语核心词</b> · " + S.N + " 词<br>" +
      "上次学习：<b>" + fmtTime(last) + "</b><br>" +
      sesInfo + "<br>" + fxInfo + "<br>" +
      "累计刷词：<b>" + t.words + "</b> 次（判断 " + t.rev + " · 看答案 " + t.views + "）" +
      "</div>";
    var old = box.querySelector(".resumeInfo");
    if (old) old.remove();
    var div = document.createElement("div");
    div.className = "resumeInfo";
    div.innerHTML = html;
    var btn = box.querySelector("#btnGo");
    if (btn && btn.parentNode) btn.parentNode.insertBefore(div, btn);
    else box.appendChild(div);
    var back = box.querySelector("#btnBack");
    if (back && ses && ses.qi < ses.q.length) back.textContent = "继续上次队列（剩 " + Math.max(0, ses.q.length - ses.qi) + " 张）";
  }
  wrap("showStart", function (orig) {
    return function () { var r = orig.apply(this, arguments); try { enhanceStart(); } catch (e) { } return r; };
  });
  /* 记录"上次学习时间"与"当前词库"到 meta（导出/换机时用） */
  function noteStudy() {
    try {
      if (window.LexisStore && storeReady) {
        window.LexisStore.setMeta("lastStudyAt", Date.now());
        window.LexisStore.setMeta("currentDict", window.LexisStore.BUILTIN);
      }
    } catch (e) { }
  }
  var noteT = 0;
  function noteStudySoon() {                              // 出卡时顺手刷新"最后学习时间"（节流）
    var t = Date.now();
    if (t - noteT < 60000) return;
    noteT = t;
    try { noteStudy(); } catch (e) { }
  }
  wrap("startSession", function (orig) {
    return function () { try { noteStudy(); } catch (e) { } return orig.apply(this, arguments); };
  });
  wrap("sessionDone", function (orig) {
    return function () { try { noteStudy(); } catch (e) { } return orig.apply(this, arguments); };
  });
  /* ---------- 备份 / 恢复入口 ---------- */
  function doExportAll() {
    var B = window.LexisBackup;
    if (!B) { toast("备份模块未加载"); return; }
    toast("正在打包数据…");
    try { mirrorStateNow(); } catch (e) { }
    B.exportData().then(function (r) {
      if (!r.ok) { toast("导出失败：" + (r.err || "")); return; }
      toast("已导出：" + r.progress + " 条进度 · " + r.days + " 天记录 · " + Math.round(r.bytes / 1024) + " KB");
      setTimeout(function () {                                  // 释放大负载，避免长期占内存
        try { if (window.LEXI_LAST_EXPORT) window.LEXI_LAST_EXPORT.text = ""; } catch (e) { }
      }, 60000);
    });
  }
  function doImportAll() {
    var B = window.LexisBackup;
    if (!B) { toast("备份模块未加载"); return; }
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (!confirm("导入会覆盖当前的学习进度与记录（本地音频不受影响），继续？")) return;
      var fr = new FileReader();
      fr.onload = function () {
        B.importData(fr.result).then(function (r) {
          if (!r.ok) { toast("导入失败：" + (r.err || "")); return; }
          try { window.LEXI_LAST_IMPORT = r; } catch (e) { }
          suppressSave = true;                    // 关键：别让旧的内存状态把导入结果覆盖掉
          try { saveLog = function () { }; saveProgress = function () { }; saveMeta = function () { }; } catch (e) { }
          toast("导入完成：进度 " + r.progress + " 条 · 记录 " + r.days + " 天，正在重启…");
          setTimeout(function () { location.reload(); }, 1200);
        });
      };
      fr.onerror = function () { toast("文件读取失败"); };
      fr.readAsText(f);
    };
    inp.click();
  }
  function doExportAudio() {
    var B = window.LexisBackup;
    if (!B) { toast("备份模块未加载"); return; }
    toast("正在打包本地音频…");
    B.exportAudio(function (done, total) { if (done % 200 === 0) toast("打包中 " + done + "/" + total); }).then(function (r) {
      try { window.LEXI_LAST_AUDIO = r; } catch (e) { }        // 成功失败都记，便于排查
      if (!r.ok) { toast("导出失败：" + (r.err || "")); return; }
      toast("已导出 " + r.files + " 个音频（" + Math.round(r.bytes / 1048576 * 10) / 10 + " MB）");
      setTimeout(function () {                                  // 释放大负载，避免长期占内存
        try { if (window.LEXI_LAST_AUDIO) window.LEXI_LAST_AUDIO.blob = null; } catch (e) { }
      }, 60000);
    });
  }
  function doImportAudioZip() {
    var B = window.LexisBackup;
    if (!B) { toast("备份模块未加载"); return; }
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".zip,application/zip";
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      toast("正在导入音频包…");
      B.importAudio(f).then(function (r) {
        toast(r.ok ? ("导入完成：" + r.ok + " 个发音" + (r.bad ? "，跳过 " + r.bad : "")) : ("导入失败：" + (r.err || "")));
        try { mirrorAudioMeta(); } catch (e) { }
      });
    };
    inp.click();
  }
  window.LEXI_EXPORT_DATA = doExportAll;
  window.LEXI_IMPORT_DATA = doImportAll;

  /* ==================================================================
     V7 · 落盘补齐
     saveProgress() 是 1.2 秒节流写：如果用户评完最后一张就被系统杀掉，
     这一次评分可能还没落盘。这里补"尾随写入"——无论节流是否跳过，
     最后一次变更后最多 1.5 秒一定强制写一次（代价：活跃期每 1.5 秒多写一次）。
     ================================================================== */
  var trailT = 0;
  wrap("saveProgress", function (orig) {
    return function () {
      var r = orig.apply(this, arguments);
      clearTimeout(trailT);
      trailT = setTimeout(function () { try { orig.call(window, true); } catch (e) { } }, 1500);
      return r;
    };
  });

  /* ============================ 启动 ============================ */
  loadLog();
  pruneLog();
  try { sanitizeState(); } catch (e) { }               // 先修数据
  try { selfCheck(); } catch (e) { }                   // 再对齐界面状态
  try { storeInit(); } catch (e) { }                   // 接入 IndexedDB 数据层（失败也不影响使用）
  if (typeof cur === "string") shownAt = Date.now();   // 断点续学：当前卡片已经开始计时
  window.addEventListener("pagehide", function () {
    if (suppressSave) return;
    if (!suppressSave) { try { saveLog(true); saveProgress(true); } catch (e) { } try { mirrorStateNow(); } catch (e) { } }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (!suppressSave) { try { saveLog(true); } catch (e) { } }
      try { audioStop(); } catch (e) { }               // 页面离开就停声，回来也不会串音
    }
  });
  window.LEXI_LOG = { data: log, save: saveLog, exportCSV: exportCSV, exportJSON: exportJSON, panel: renderLog };
  /* 有些按钮是在主脚本里直接绑定的函数引用（$("#x").onclick = fn），
     包装后必须重新指过去，否则包装对这几个入口不生效（这个坑已实测踩到）。 */
  (function rebind() {
    var map = { "#fixedExit": "exitFixedMode", "#btnAuto": "toggleAuto", "#chipPlay": "toggleAuto", "#fixedAuto": "toggleFixedAuto", "#chipUndo": "undo" };
    for (var sel in map) {
      var el = $(sel);
      if (el && typeof window[map[sel]] === "function") el.onclick = window[map[sel]];
    }
  })();
  window.LEXIS = S;                                    // 自检/排错用只读引用
  window.LEXI_MIRROR_NOW = function () {                 // 立即把热状态写进 IndexedDB（导出/测试用）
    try { mirrorStateNow(); return true; } catch (e) { return false; }
  };
  window.LEXI_CUR = function () { return cur; };
  window.LEXI_HEALTH = function () {
    return { boot: !bootBroken, autoResumed: uiWasAuto, words: S.N, logEvents: log.events.length, fixedRound: S.fixed.completed };
  };
})();

