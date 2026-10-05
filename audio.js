/* =========================================================================
   LexisAudio —— 本地真人发音管理（全部离线，零依赖）
   目标：
     · 本地 MP3 优先，永远不依赖网络
     · 单词与音频一一对应（apple.mp3 / us_apple.mp3 / uk_apple.mp3）
     · 批量导入：文件夹（支持的浏览器）/ 多选文件 / ZIP（store 与 deflate 都支持）
     · 能看到"导入了多少""哪些词还缺音频"
     · 音频损坏时：不崩、自动跳过、并在面板里标出来
   复用主程序已有的 IndexedDB 助手（openAudioDB / idbPut / idbGet / idbClear），不重复实现。
   ========================================================================= */
(function (global) {
  "use strict";
  var STORE = "clips", BAD_KEY = "lexi.badAudio";
  var badWords = loadBad();
  var listCache = null, listAt = 0;

  function loadBad() {
    try { return JSON.parse(localStorage.getItem(BAD_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function saveBad() {
    try { localStorage.setItem(BAD_KEY, JSON.stringify(badWords)); } catch (e) { }
  }
  var api = {
    /* ---------- 最近一次被请求的单词（用于"播放失败→标记损坏"时对准单词） ----------
       不能直接用"当前卡片"：用户可能在词库/音频面板里试听别的词，
       那样会把当前卡片那个词误标成损坏（实测踩过这个坑）。 */
    _lastWord: "",
    noteRequested: function (w) { if (typeof w === "string" && w) api._lastWord = w; },
    lastRequested: function () { return api._lastWord; },

    /* ---------- 损坏音频标记 ---------- */
    markBad: function (word, why) {
      if (typeof word !== "string" || !word) return;
      badWords[word] = { t: Date.now(), why: String(why || "播放失败") };
      saveBad();
      listCache = null;
    },
    isBad: function (word) { return !!badWords[word]; },
    clearBad: function (word) {
      if (word) delete badWords[word]; else badWords = {};
      saveBad(); listCache = null;
    },
    badList: function () {
      var out = [], k;
      for (k in badWords) out.push({ word: k, t: badWords[k].t, why: badWords[k].why });
      out.sort(function (a, b) { return b.t - a.t; });
      return out;
    },

    /* ---------- 读取本地音频 ---------- */
    list: function (force) {
      var now = Date.now();
      if (!force && listCache && now - listAt < 4000) return Promise.resolve(listCache);
      return api.openDB().then(function (db) {
        if (!db) return [];
        return new Promise(function (res) {
          var out = [];
          try {
            var req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
            req.onsuccess = function () {
              var c = req.result;
              if (!c) { listCache = out; listAt = Date.now(); return res(out); }
              var v = c.value || {};
              out.push({ k: String(v.k || c.key), w: String(v.w || ""), src: String(v.src || ""), t: v.t | 0, size: (v.blob && v.blob.size) | 0 });
              c.continue();
            };
            req.onerror = function () { res(out); };
          } catch (e) { res(out); }
        });
      }).catch(function () { return []; });
    },
    openDB: function () {
      return (typeof openAudioDB === "function") ? openAudioDB() : Promise.resolve(null);
    },
    /* ---------- 覆盖率 / 缺失清单 ---------- */
    coverage: function (words) {
      return api.list().then(function (clips) {
        /* 注意：应用读取本地音时用的是 word.toLowerCase()（audioKey），
           所以统计也必须按小写比对，否则 Wednesday 这类大写词会被误判成"缺音频"（实测踩过）。 */
        var have = {}, i;
        for (i = 0; i < clips.length; i++) have[String(clips[i].w).toLowerCase()] = (have[String(clips[i].w).toLowerCase()] | 0) + 1;
        var covered = 0, missing = [], bad = 0, entries = clips.length;
        for (i = 0; i < words.length; i++) {
          var w = words[i];
          if (have[String(w).toLowerCase()]) covered++; else missing.push(w);
          if (badWords[w]) bad++;
        }
        return { entries: entries, covered: covered, total: words.length, missing: missing, bad: bad, pct: words.length ? Math.round(covered / words.length * 100) : 0 };
      });
    },

    /* ---------- 导入：文件名 → 单词 ---------- */
    nameToWord: function (name) {
      var base = String(name).split("/").pop().replace(/\.[^.]+$/, "");
      var m = /^(us|uk)[_-](.+)$/i.exec(base);
      return { word: (m ? m[2] : base).trim().toLowerCase(), accent: m ? m[1].toLowerCase() : "both" };
    },
    putFiles: function (files, onProgress) {
      var arr = Array.prototype.slice.call(files || []).filter(function (f) {
        return /\.(mp3|wav|m4a|ogg|opus|aac|flac)$/i.test(f.name || "");
      });
      if (!arr.length) return Promise.resolve({ ok: 0, bad: 0, skipped: (files || []).length });
      var ok = 0, bad = 0, i = 0;
      return new Promise(function (res) {
        function step() {
          if (i >= arr.length) return res({ ok: ok, bad: bad, skipped: 0 });
          var f = arr[i++], n = api.nameToWord(f.name);
          if (!n.word || !f.size) { bad++; return setTimeout(step, 0); }
          var rec = { w: n.word, src: "file", t: Date.now(), blob: f, size: f.size };
          var writes;
          if (n.accent === "us") writes = [idbPut(Object.assign({}, rec, { k: "us|" + n.word }))];
          else if (n.accent === "uk") writes = [idbPut(Object.assign({}, rec, { k: "uk|" + n.word }))];
          else writes = [idbPut(Object.assign({}, rec, { k: "us|" + n.word })), idbPut(Object.assign({}, rec, { k: "uk|" + n.word }))];
          Promise.all(writes).then(function (rs) {
            if (rs.some(Boolean)) { ok++; delete badWords[n.word]; } else bad++;
          }).catch(function () { bad++; }).then(function () {
            if (onProgress && (ok + bad) % 25 === 0) { try { onProgress(ok + bad, arr.length); } catch (e) { } }
            setTimeout(step, 0);
          });
        }
        step();
      }).then(function (r) { listCache = null; saveBad(); return r; });
    },

    /* ---------- 导入 ZIP：store 与 deflate 都支持 ---------- */
    parseZip: function (buf) {
      var dv = new DataView(buf), u8 = new Uint8Array(buf), out = [], p = 0;
      function sig(o) { return o + 4 <= u8.length ? dv.getUint32(o, true) : -1; }
      while (p + 30 <= u8.length) {
        if (sig(p) !== 0x04034b50) {
          var q = p + 1;
          while (q + 4 <= u8.length && sig(q) !== 0x04034b50) q++;
          if (q + 4 > u8.length) break;
          p = q; continue;
        }
        var method = dv.getUint16(p + 8, true);
        var compSize = dv.getUint32(p + 18, true);
        var rawSize = dv.getUint32(p + 22, true);
        var nameLen = dv.getUint16(p + 26, true);
        var extraLen = dv.getUint16(p + 28, true);
        var dataStart = p + 30 + nameLen + extraLen;
        if (dataStart > u8.length) break;
        var name = new TextDecoder("utf-8").decode(u8.subarray(p + 30, p + 30 + nameLen));
        if (!compSize) {                                   // 数据描述符（流式写入）：只能跳过
          var q2 = dataStart;
          while (q2 + 4 <= u8.length && sig(q2) !== 0x04034b50) q2++;
          p = q2; continue;
        }
        var dataEnd = dataStart + compSize;
        if (dataEnd > u8.length) break;
        if (/\.(mp3|m4a|ogg|opus|wav|aac|flac)$/i.test(name) && (compSize > 200 || rawSize > 200)) {
          out.push({ name: name, method: method, data: u8.subarray(dataStart, dataEnd) });
        }
        p = dataEnd;
      }
      return out;
    },
    inflateRaw: function (u8) {
      if (typeof DecompressionStream === "undefined") return Promise.resolve(null);
      try {
        var ds = new DecompressionStream("deflate-raw");
        var stream = new Blob([u8]).stream().pipeThrough(ds);
        return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); }).catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    },
    putZip: function (buf, onProgress) {
      var entries;
      try { entries = api.parseZip(buf); } catch (e) { return Promise.resolve({ ok: 0, bad: 0, err: "解析失败" }); }
      if (!entries.length) return Promise.resolve({ ok: 0, bad: 0, err: "包里没有找到音频" });
      var ok = 0, bad = 0, i = 0;
      var mimeOf = function (n) {
        var e = (n.split(".").pop() || "mp3").toLowerCase();
        return e === "wav" ? "audio/wav" : e === "ogg" || e === "opus" ? "audio/ogg" : e === "m4a" || e === "aac" ? "audio/mp4"
          : e === "flac" ? "audio/flac" : "audio/mpeg";
      };
      return new Promise(function (res) {
        function step() {
          if (i >= entries.length) return res({ ok: ok, bad: bad, deflated: entries.some(function (x) { return x.method === 8; }) });
          var e = entries[i++], n = api.nameToWord(e.name);
          var raw = Promise.resolve(e.data);
          if (e.method === 8) raw = api.inflateRaw(e.data).then(function (d) { return d || null; });
          else if (e.method !== 0) raw = Promise.resolve(null);
          raw.then(function (bytes) {
            if (!bytes || !bytes.length || !n.word) { bad++; return; }
            var blob = new Blob([bytes], { type: mimeOf(e.name) });
            var rec = { w: n.word, src: "zip", t: Date.now(), blob: blob, size: blob.size };
            var writes = n.accent === "us" ? [idbPut(Object.assign({}, rec, { k: "us|" + n.word }))]
              : n.accent === "uk" ? [idbPut(Object.assign({}, rec, { k: "uk|" + n.word }))]
                : [idbPut(Object.assign({}, rec, { k: "us|" + n.word })), idbPut(Object.assign({}, rec, { k: "uk|" + n.word }))];
            return Promise.all(writes).then(function (rs) { if (rs.some(Boolean)) { ok++; delete badWords[n.word]; } else bad++; });
          }).catch(function () { bad++; }).then(function () {
            if (onProgress && (ok + bad) % 25 === 0) { try { onProgress(ok + bad, entries.length); } catch (e2) { } }
            setTimeout(step, 0);
          });
        }
        step();
      }).then(function (r) { listCache = null; saveBad(); return r; });
    },

    /* ---------- 删除 ---------- */
    removeClip: function (k) {
      return api.openDB().then(function (db) {
        if (!db) return false;
        return new Promise(function (res) {
          try {
            var t = db.transaction(STORE, "readwrite");
            t.objectStore(STORE).delete(k);
            t.oncomplete = function () { listCache = null; res(true); };
            t.onerror = function () { res(false); };
          } catch (e) { res(false); }
        });
      });
    },
    clearAll: function () {
      return (typeof idbClear === "function" ? idbClear() : Promise.resolve(false)).then(function (r) {
        listCache = null; api.clearBad(); return r;
      });
    },

    /* ---------- 缺失清单导出（方便去批量下载音频） ---------- */
    missingText: function (words) {
      return api.coverage(words).then(function (c) {
        return "# Lexis 缺少本地发音的单词（共 " + c.missing.length + " 个，总计 " + c.total + " 词）\n" +
          "# 把对应的 mp3 命名为 单词.mp3 或 us_单词.mp3 后批量导入即可\n" + c.missing.join("\n") + "\n";
      });
    }
  };
  /* ================= 音频管理面板（底部弹层） ================= */
  function $(s) { return document.querySelector(s); }
  function kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB"; }
  function download(name, text) {
    var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function pick(mode) {
    var inp = document.createElement("input");
    inp.type = "file";
    if (mode === "zip") { inp.accept = ".zip,application/zip"; }
    else {
      inp.multiple = true;
      inp.accept = "audio/*,.mp3,.wav,.m4a,.ogg,.opus,.aac,.flac";
      if (mode === "dir") { try { inp.webkitdirectory = true; } catch (e) { } }
    }
    inp.onchange = function () {
      var files = inp.files;
      if (!files || !files.length) return;
      if (mode === "zip") {
        if (typeof toast === "function") toast("正在读取音频包…");
        files[0].arrayBuffer().then(function (buf) { return api.putZip(buf); }).then(function (r) {
          if (typeof toast === "function") {
            toast(r.err ? ("音频包导入失败：" + r.err) : ("导入完成：" + r.ok + " 个发音" + (r.bad ? "，跳过 " + r.bad : "") + (r.deflated ? "（含压缩条目）" : "")));
          }
          api.panel();
          try { mirrorIfAny(); } catch (e) { }
        }).catch(function () { if (typeof toast === "function") toast("音频包读取失败"); });
        return;
      }
      if (typeof toast === "function") toast("正在导入 " + files.length + " 个文件…");
      api.putFiles(files, function (done, total) {
        if (typeof toast === "function" && done % 100 === 0) toast("导入中 " + done + "/" + total);
      }).then(function (r) {
        if (typeof toast === "function") toast("导入完成：" + r.ok + " 个发音" + (r.bad ? "，跳过 " + r.bad : ""));
        api.panel();
        try { mirrorIfAny(); } catch (e) { }
      }).catch(function () { if (typeof toast === "function") toast("导入失败"); });
    };
    inp.click();
  }
  function mirrorIfAny() {                          // 让补丁把音频元数据镜像进 lexis 库
    if (typeof window.LEXI_AUDIO_MIRROR === "function") window.LEXI_AUDIO_MIRROR();
  }

  var filt = "missing", keyword = "";
  api.panel = function () {
    var panel = $("#panel");
    if (!panel) return;
    if (typeof audioStop === "function") audioStop();
    var words = (window.LEXIS && window.LEXIS.w) || [];
    panel.innerHTML =
      '<div class="grab"></div>' +
      '<h2><span>🎧 本地真人发音</span><button class="iconbtn" id="amClose">✕</button></h2>' +
      '<div class="fore" id="amStat">正在读取本地音频…</div>' +
      '<div class="actsrow" style="margin-top:10px">' +
      '<button class="btn ghost" id="amDir">📁 导入文件夹</button>' +
      '<button class="btn ghost" id="amZip">🗜 导入 ZIP</button></div>' +
      '<div class="actsrow" style="margin-top:10px">' +
      '<button class="btn ghost" id="amFiles">🎵 多选文件</button>' +
      '<button class="btn ghost" id="amMissing">⬇ 导出缺失清单</button></div>' +
      '<div class="sub" id="amFilter" style="justify-content:flex-start;margin:12px 0 8px"></div>' +
      '<div class="f" style="display:block;border-bottom:0;padding:0 0 8px">' +
      '<input id="amSearch" type="search" placeholder="搜索单词" style="width:100%;max-width:none"></div>' +
      '<div class="wordlist" id="amList"></div>' +
      '<div class="actsrow" style="margin-top:12px">' +
      '<button class="btn ghost danger" id="amClear">清空本地音频</button>' +
      '<button class="btn ghost" id="amBadClear">清除损坏标记</button></div>' +
      '<p style="font-size:12px;color:var(--fg3);line-height:1.75;margin:12px 0 0">' +
      '文件名规则：<code>apple.mp3</code>（美英通用）、<code>us_apple.mp3</code>（美音）、<code>uk_apple.mp3</code>（英音）。' +
      '导入后完全离线播放；找不到本地音时按「系统语音 → 在线音源」顺序回退。</p>';

    $("#amClose").onclick = function () { if (typeof closeSheet === "function") closeSheet(); };
    $("#amDir").onclick = function () { pick("dir"); };
    $("#amZip").onclick = function () { pick("zip"); };
    $("#amFiles").onclick = function () { pick("files"); };
    $("#amMissing").onclick = function () {
      api.missingText(words).then(function (t) { download("lexis-missing-audio.txt", t); if (typeof toast === "function") toast("已导出缺失清单"); });
    };
    $("#amClear").onclick = function () {
      if (!confirm("清空全部本地音频？学习进度不受影响。")) return;
      api.clearAll().then(function () {
        if (typeof toast === "function") toast("本地音频已清空");
        api.panel();
      });
    };
    $("#amBadClear").onclick = function () {
      api.clearBad();
      if (typeof toast === "function") toast("已清除损坏标记，下次会重新尝试本地音频");
      api.panel();
    };
    $("#amSearch").addEventListener("input", function () { keyword = this.value.trim().toLowerCase(); renderList(); });

    var cov = null;
    api.coverage(words).then(function (c) {
      cov = c;
      var stat = $("#amStat");
      if (!stat) return;
      stat.innerHTML = "本地音频 <b>" + c.entries + "</b> 条 · 覆盖 <b>" + c.covered + "</b>/" + c.total +
        " 词（<b>" + c.pct + "%</b>）· 损坏标记 <b>" + c.bad + "</b> 个" +
        "<br>缺音频的词 <b>" + c.missing.length + "</b> 个 —— 可在下面查看并导出清单。";
      $("#amFilter").innerHTML =
        chip("missing", "缺少音频", c.missing.length) + chip("have", "已有音频", c.covered) + chip("bad", "损坏", c.bad) + chip("all", "全部词", c.total);
      var chips = $("#amFilter").querySelectorAll(".chip");
      for (var i = 0; i < chips.length; i++) {
        chips[i].addEventListener("click", function () {
          filt = this.getAttribute("data-f");
          var all = $("#amFilter").querySelectorAll(".chip");
          for (var m = 0; m < all.length; m++) all[m].classList.toggle("on", all[m] === this);
          renderList();
        });
      }
      renderList();
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (e) {
          var s2 = $("#amStat");
          if (s2 && e && e.usage) s2.innerHTML += "<br>本机存储占用约 <b>" + kb(e.usage) + "</b>（含音频与学习数据）";
        }).catch(function () { });
      }
    }).catch(function () { });

    function chip(f, label, n) {
      return '<button class="chip' + (filt === f ? " on" : "") + '" data-f="' + f + '">' + label + " " + n + "</button>";
    }
    function renderList() {
      var list = $("#amList");
      if (!list || !cov) return;
      var out = [], i, w;
      if (filt === "missing") {
        for (i = 0; i < cov.missing.length && out.length < 300; i++) {
          w = cov.missing[i];
          if (keyword && w.toLowerCase().indexOf(keyword) < 0) continue;
          out.push({ w: w, st: "无本地音", cls: "warn" });
        }
      } else if (filt === "bad") {
        var bl = api.badList();
        for (i = 0; i < bl.length && out.length < 300; i++) {
          if (keyword && bl[i].word.toLowerCase().indexOf(keyword) < 0) continue;
          out.push({ w: bl[i].word, st: "损坏", cls: "warn" });
        }
      } else {
        /* 已有音频 / 全部词：用"缺失集合的补集"判断状态，避免再查一次数据库 */
        var missSet = {}, ws = (window.LEXIS && window.LEXIS.w) || [];
        for (i = 0; i < cov.missing.length; i++) missSet[cov.missing[i]] = 1;
        for (i = 0; i < ws.length && out.length < 300; i++) {
          w = ws[i];
          var hasAudio = !missSet[w];
          if (filt === "have" && !hasAudio) continue;
          if (keyword && w.toLowerCase().indexOf(keyword) < 0) continue;
          var isBad = api.isBad(w);
          out.push({ w: w, st: hasAudio ? (isBad ? "损坏" : "本地音") : "无本地音", cls: hasAudio && !isBad ? "ok" : "warn" });
        }
      }
      if (!out.length) {
        list.innerHTML = '<div class="empty"><p>' + (filt === "missing" ? "所有词都有本地发音了 👍" : "没有匹配的词") + "</p></div>";
        return;
      }
      list.innerHTML = out.map(function (x, n) {
        return '<div class="wordrow" data-w="' + x.w.replace(/"/g, "&quot;") + '" style="grid-template-columns:46px minmax(0,1fr) minmax(90px,auto) 38px">' +
          '<span class="num">' + (n + 1) + "</span>" +
          '<span class="en">' + x.w + "</span>" +
          '<span class="zh"><small class="st ' + x.cls + '">' + x.st + "</small></span>" +
          '<button class="play" title="试听">🔊</button></div>';
      }).join("");
      var rows = list.querySelectorAll(".wordrow");
      for (var r = 0; r < rows.length; r++) {
        rows[r].addEventListener("click", function () {
          var w = this.getAttribute("data-w");
          if (w && typeof speakCard === "function") speakCard(w);
        });
      }
    }
  };

  global.LexisAudio = api;
  api.pick = pick;
})(window);
