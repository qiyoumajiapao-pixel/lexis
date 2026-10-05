/* =========================================================================
   LexisStore —— Lexis 的 IndexedDB 数据层（零依赖，全部 Promise 化）
   设计原则（与「架构方案 A」一致）：
     1) 只承担"大数据 + 镜像"：词典、单词、音频元数据、学习记录/进度的副本
     2) 热状态仍由 localStorage 负责（同步、已通过压力测试）；这里只做镜像，
        用于①备份导出 ②将来换手机导入 ③将来 Capacitor/Android 复用同一套数据
     3) 任何一步失败都不允许影响主流程：所有 API 内部吞异常并返回安全值
   表结构：
     meta            {k}                    版本/迁移标记
     dictionaries    {id}                   词库（名称、词数、来源、时间）
     words           {dictId, word, zh, idx} + 索引 byWord / byDict
     wordProgress    {dictId, word, ...card} + 索引 byDict
     studySessions   {id}                   学习会话（当前队列/断点）
     settings        {k}                    设置镜像
     audioMetadata   {k}                    本地音频元数据（blob 仍在 lexi-audio）
     fixedOrders     {dictId}               固定随机顺序 + 位置 + 轮次
     studyLog        {id}                   每日汇总
   ========================================================================= */
(function (global) {
  "use strict";
  var DB_NAME = "lexis", DB_VER = 1, BUILTIN = "builtin";
  var dbp = null, broken = false;
  /* 时间戳是 13 位毫秒，绝不能用 | 0（会被截成 int32 → 变成 1970 年） */
  function big(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0; }

  function isOK() { return !broken && typeof indexedDB !== "undefined"; }

  function open() {
    if (dbp) return dbp;
    if (!isOK()) return Promise.resolve(null);
    dbp = new Promise(function (res) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { broken = true; return res(null); }
      req.onupgradeneeded = function () {
        var db = req.result;
        function mk(name, opt) { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opt); }
        mk("meta", { keyPath: "k" });
        mk("dictionaries", { keyPath: "id" });
        mk("words", { keyPath: ["dictId", "word"] });
        mk("wordProgress", { keyPath: ["dictId", "word"] });
        mk("studySessions", { keyPath: "id" });
        mk("settings", { keyPath: "k" });
        mk("audioMetadata", { keyPath: "k" });
        mk("fixedOrders", { keyPath: "dictId" });
        mk("studyLog", { keyPath: "id" });
        try {
          var ws = req.transaction.objectStore("words");
          if (!ws.indexNames.contains("byWord")) ws.createIndex("byWord", "word");
          if (!ws.indexNames.contains("byDict")) ws.createIndex("byDict", "dictId");
          var ps = req.transaction.objectStore("wordProgress");
          if (!ps.indexNames.contains("byDict")) ps.createIndex("byDict", "dictId");
        } catch (e) { }
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { broken = true; res(null); };
      req.onblocked = function () { res(null); };
      setTimeout(function () { if (broken) res(null); }, 3000);
    });
    return dbp;
  }

  function tx(stores, mode) {
    return open().then(function (db) {
      if (!db) return null;
      try { return db.transaction(stores, mode || "readonly"); } catch (e) { return null; }
    });
  }
  function put(store, val) {
    return tx([store], "readwrite").then(function (t) {
      if (!t) return false;
      return new Promise(function (res) {
        try {
          t.objectStore(store).put(val);
          t.oncomplete = function () { res(true); };
          t.onerror = t.onabort = function () { res(false); };
        } catch (e) { res(false); }
      });
    }).catch(function () { return false; });
  }
  function bulk(store, arr, chunk, onProgress) {
    return new Promise(function (res) {
      var i = 0;
      function step() {
        if (i >= arr.length) return res(true);
        var slice = arr.slice(i, i + chunk);
        putChunk(store, slice).then(function (ok) {
          i += chunk;
          if (onProgress) { try { onProgress(Math.min(i, arr.length), arr.length); } catch (e) { } }
          if (!ok) return res(false);
          setTimeout(step, 0);
        });
      }
      step();
    });
  }
  function putChunk(store, slice) {
    return tx([store], "readwrite").then(function (t) {
      if (!t) return false;
      return new Promise(function (res) {
        try {
          var os = t.objectStore(store);
          for (var i = 0; i < slice.length; i++) os.put(slice[i]);
          t.oncomplete = function () { res(true); };
          t.onerror = t.onabort = function () { res(false); };
        } catch (e) { res(false); }
      });
    }).catch(function () { return false; });
  }
  function count(store) {
    return tx([store]).then(function (t) {
      if (!t) return -1;
      return new Promise(function (res) {
        try { var r = t.objectStore(store).count(); r.onsuccess = function () { res(r.result | 0); }; r.onerror = function () { res(-1); }; }
        catch (e) { res(-1); }
      });
    }).catch(function () { return -1; });
  }
  function getAll(store) {
    return tx([store]).then(function (t) {
      if (!t) return [];
      return new Promise(function (res) {
        try { var r = t.objectStore(store).getAll(); r.onsuccess = function () { res(r.result || []); }; r.onerror = function () { res([]); }; }
        catch (e) { res([]); }
      });
    }).catch(function () { return []; });
  }
  function getMeta(k) {
    return tx(["meta"]).then(function (t) {
      if (!t) return null;
      return new Promise(function (res) {
        try { var r = t.objectStore("meta").get(k); r.onsuccess = function () { res(r.result ? r.result.v : null); }; r.onerror = function () { res(null); }; }
        catch (e) { res(null); }
      });
    }).catch(function () { return null; });
  }
  function setMeta(k, v) { return put("meta", { k: k, v: v, t: Date.now() }); }

  /* ---------------- 词库：首次把内嵌词库写入 IDB（分批，不卡界面） ---------------- */
  function seedBuiltin(name, w, d) {
    var total = w.length;
    return getMeta("builtinSeeded").then(function (done) {
      if (done && done === total) return { seeded: false, total: total };
      var rows = [];
      for (var i = 0; i < total; i++) rows.push({ dictId: BUILTIN, word: String(w[i]), zh: String(d[i] == null ? "" : d[i]), idx: i });
      return put("dictionaries", { id: BUILTIN, name: name || "英语核心词", wordCount: total, source: "embedded", createdAt: Date.now() })
        .then(function () { return bulk("words", rows, 400); })
        .then(function (ok) { if (ok) setMeta("builtinSeeded", total); return { seeded: !!ok, total: total }; });
    });
  }

  /* ---------------- 导入额外词库（与内置词库完全独立） ---------------- */
  function importDictionary(id, name, pairs, onProgress) {
    var rows = [];
    for (var i = 0; i < pairs.length; i++) {
      rows.push({ dictId: id, word: String(pairs[i][0]), zh: String(pairs[i][1] == null ? "" : pairs[i][1]), idx: i });
    }
    return put("dictionaries", { id: id, name: name || id, wordCount: rows.length, source: "import", createdAt: Date.now() })
      .then(function () { return bulk("words", rows, 400, onProgress); })
      .then(function (ok) { return { ok: ok, count: rows.length }; });
  }

  /* ---------------- 搜索：英文走前缀索引，中文走 byDict 全表游标 ---------------- */
  function search(dictId, q, limit) {
    limit = limit || 50;
    q = String(q || "").trim();
    if (!q) return Promise.resolve([]);
    return tx(["words"]).then(function (t) {
      if (!t) return [];
      var store = t.objectStore("words"), low = q.toLowerCase(), ascii = /^[\x00-\x7F]+$/.test(q);
      return new Promise(function (res) {
        var out = [];
        try {
          if (ascii) {
            var r = store.index("byWord").openCursor(IDBKeyRange.bound(low, low + "\uffff"));
            r.onsuccess = function () {
              var c = r.result;
              if (!c || out.length >= limit) return res(out);
              var v = c.value;
              if (v.dictId === dictId && String(v.word).toLowerCase().indexOf(low) === 0) out.push(v);
              c.continue();
            };
            r.onerror = function () { res(out); };
          } else {
            var r2 = store.index("byDict").openCursor(IDBKeyRange.only(dictId));
            r2.onsuccess = function () {
              var c = r2.result;
              if (!c || out.length >= limit) return res(out);
              var v = c.value;
              if (String(v.zh).indexOf(q) >= 0 || String(v.word).indexOf(q) >= 0) out.push(v);
              c.continue();
            };
            r2.onerror = function () { res(out); };
          }
        } catch (e) { res(out); }
      });
    }).catch(function () { return []; });
  }

  /* ---------------- 镜像：热状态 → IDB（每种数据各自节流 + 静默失败） ---------------- */
  var timers = {}, pendWord = {};
  function soon(key, fn, ms) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(function () { try { fn(); } catch (e) { } }, ms);
  }
  var M = {
    dictId: BUILTIN,
    word: function (word, card) {
      if (!isOK() || !card) return;
      /* 关键：不能"每次评分都重置同一个定时器"，否则 1.2 秒内连评 3 个词只会写进最后一个。
         这里改成累积到待写队列，到点一次性批量写入。 */
      pendWord[String(word)] = {
        dictId: M.dictId, word: String(word), lv: card.lv | 0, due: big(card.due), seen: card.seen | 0,
        know: card.know | 0, again: card.again | 0, streak: card.streak | 0, steps: card.steps | 0,
        first: big(card.first), last: big(card.last), type: card.type || "", views: card.views | 0, rt: card.rt | 0
      };
      soon("word", function () {
        var rows = [], k;
        for (k in pendWord) rows.push(pendWord[k]);
        pendWord = {};
        if (rows.length) bulk("wordProgress", rows, 200);
      }, 1200);
    },
    progressAll: function (prog) {
      if (!isOK() || !prog) return Promise.resolve(false);
      var rows = [];
      for (var k in prog) {
        var c = prog[k] || {};
        rows.push({
          dictId: M.dictId, word: k, lv: c.lv | 0, due: big(c.due), seen: c.seen | 0, know: c.know | 0,
          again: c.again | 0, streak: c.streak | 0, steps: c.steps | 0, first: big(c.first), last: big(c.last),
          type: c.type || "", views: c.views | 0, rt: c.rt | 0
        });
      }
      return bulk("wordProgress", rows, 400);
    },
    session: function (ses) {
      if (!isOK()) return;
      soon("session", function () {                       // 队列可能上万条，节流放宽
        if (!ses) return put("studySessions", { id: M.dictId, dictId: M.dictId, empty: true, t: Date.now() });
        put("studySessions", {
          id: M.dictId, dictId: M.dictId, day: ses.day, qi: ses.qi | 0, q: (ses.q || []).slice(0, 4000),
          t0: big(ses.t0), graded: ses.graded | 0, again: ses.again | 0, goal: ses.goal | 0, cur: ses.cur || "",
          due0: big(ses.due0), fresh0: ses.fresh0 | 0, backlog: ses.backlog | 0, t: Date.now()
        });
      }, 8000);
    },
    sessionNow: function (ses) {                          // 页面隐藏/关闭时立即落库
      if (!isOK()) return Promise.resolve(false);
      clearTimeout(timers.session);
      if (!ses) return put("studySessions", { id: M.dictId, dictId: M.dictId, empty: true, t: Date.now() });
      return put("studySessions", {
        id: M.dictId, dictId: M.dictId, day: ses.day, qi: ses.qi | 0, q: (ses.q || []).slice(0, 4000),
        t0: big(ses.t0), graded: ses.graded | 0, again: ses.again | 0, goal: ses.goal | 0, cur: ses.cur || "",
        due0: big(ses.due0), fresh0: ses.fresh0 | 0, backlog: ses.backlog | 0, t: Date.now()
      });
    },
    settings: function (ui) {
      if (!isOK() || !ui) return;
      soon("settings", function () {
        for (var k in ui) {
          if (k === "auto" || k === "revealed") continue;      // 瞬时状态不入库
          put("settings", { k: k, v: ui[k], t: Date.now() });
        }
      }, 1200);
    },
    log: function (log) {
      if (!isOK() || !log) return;
      soon("log", function () {
        var days = log.days || {}, keys = Object.keys(days);
        var rows = [];
        for (var i = 0; i < keys.length; i++) {
          var d = days[keys[i]] || {};
          rows.push({ id: keys[i], dictId: M.dictId, rev: d.rev | 0, ok: d.ok | 0, no: d.no | 0, nw: d.nw | 0, views: d.views | 0, ms: d.ms | 0, t0: big(d.t0), t1: big(d.t1) });
        }
        if (rows.length) bulk("studyLog", rows, 200);
      }, 1500);
    },
    fixed: function (order, pos, completed) {
      if (!isOK()) return;
      soon("fixed", function () {
        put("fixedOrders", {
          dictId: M.dictId, key: (order || []).length,
          order: (order || []).slice(0, 6000), pos: pos | 0, completed: completed | 0, t: Date.now()
        });
      }, 1500);
    },
    audioMeta: function (list) {
      if (!isOK() || !list || !list.length) return Promise.resolve(false);
      return bulk("audioMetadata", list, 300);
    }
  };

  function stats() {
    return Promise.all([count("dictionaries"), count("words"), count("wordProgress"), count("audioMetadata"), count("studyLog")])
      .then(function (a) {
        return { dictionaries: a[0], words: a[1], progress: a[2], audio: a[3], days: a[4] };
      });
  }
  function wipe() {
    return open().then(function (db) {
      if (!db) return false;
      var names = ["meta", "dictionaries", "words", "wordProgress", "studySessions", "settings", "audioMetadata", "fixedOrders", "studyLog"];
      return Promise.all(names.map(function (n) {
        return tx([n], "readwrite").then(function (t) {
          if (!t) return false;
          return new Promise(function (res) { try { var r = t.objectStore(n).clear(); r.onsuccess = function () { res(true); }; r.onerror = function () { res(false); }; } catch (e) { res(false); } });
        });
      })).then(function () { return true; });
    }).catch(function () { return false; });
  }

  global.LexisStore = {
    DB_NAME: DB_NAME, DB_VER: DB_VER, BUILTIN: BUILTIN,
    available: isOK, open: open, put: put, count: count, getAll: getAll,
    getMeta: getMeta, setMeta: setMeta,
    seedBuiltin: seedBuiltin, importDictionary: importDictionary, search: search,
    bulkPut: function (store, arr) { return bulk(store, arr || [], 400); },
    mirror: M, stats: stats, wipe: wipe,
    isBroken: function () { return broken; }
  };
})(window);
