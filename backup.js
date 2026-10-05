/* =========================================================================
   LexisBackup —— 数据导出 / 导入（换手机、重装、跨源迁移都用它）
   · 导出：一份 JSON（学习进度/队列位置/设置/固定顺序/学习记录/音频清单）
           + 可选一份 ZIP（本地真人音频，store 模式打包，零依赖）
   · 导入：JSON 覆盖恢复；音频 ZIP 复用 LexisAudio.putZip
   · 原则：导出内容"够用来完整还原"，内置词库不重复打包（它本来就在应用里）
   ========================================================================= */
(function (global) {
  "use strict";
  var VERSION = 1, HOT_KEYS = ["prog", "ses", "ui", "stats", "fixedState", "fixedOrder", "badAudio", "log", "ipa"];
  var LSK = function (k) { return "lexi." + k; };

  /* ---------------- ZIP 打包（store 模式，运行期零依赖） ---------------- */
  var CRC = (function () {
    var t = new Int32Array(256), n, k, c;
    for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
  function u16(v) { return [v & 255, (v >>> 8) & 255]; }
  function makeZip(entries) {
    var parts = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var name = new TextEncoder().encode(e.name);
      var data = e.data, crc = crc32(data);
      var lh = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(lh), name, data);
      central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += lh.length + name.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdSize), u32(offset), u16(0)));
    return new Blob(parts.concat(central, [eocd]), { type: "application/zip" });
  }
  function saveBlob(name, blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { } }, 8000);
  }
  function dayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  var api = {
    VERSION: VERSION,
    /* ---------------- 导出数据（不含音频本体） ---------------- */
    exportData: function (note) {
      var hot = {}, i;
      for (i = 0; i < HOT_KEYS.length; i++) {
        try {
          var raw = localStorage.getItem(LSK(HOT_KEYS[i]));
          hot[HOT_KEYS[i]] = raw === null ? null : JSON.parse(raw);
        } catch (e) { hot[HOT_KEYS[i]] = null; }
      }
      var db = { dictionaries: [], words: [], wordProgress: [], studySessions: [], settings: [], audioMetadata: [], fixedOrders: [], studyLog: [] };
      var LS = global.LexisStore;
      return Promise.all([
        LS.getAll("dictionaries"), LS.getAll("words"), LS.getAll("wordProgress"),
        LS.getAll("studySessions"), LS.getAll("settings"), LS.getAll("audioMetadata"),
        LS.getAll("fixedOrders"), LS.getAll("studyLog")
      ]).then(function (a) {
        db.dictionaries = a[0];
        /* 内置词库的词不打包（应用自带，5139 词没必要重复） */
        db.words = a[1].filter(function (w) { return w.dictId !== LS.BUILTIN; });
        db.wordProgress = a[2]; db.studySessions = a[3]; db.settings = a[4];
        db.audioMetadata = a[5]; db.fixedOrders = a[6]; db.studyLog = a[7];
        var payload = {
          app: "lexis", v: VERSION, exportedAt: Date.now(), note: note || "",
          wordsInApp: (global.LEXI_DATA && global.LEXI_DATA.w || []).length,
          hot: hot, db: db
        };
        var text = JSON.stringify(payload);
        var fname = "lexis-data-" + dayKey() + ".json";
        try { global.LEXI_LAST_EXPORT = { name: fname, text: text, bytes: text.length, at: Date.now() }; } catch (e) { }
        saveBlob(fname, new Blob([text], { type: "application/json;charset=utf-8" }));
        return { ok: true, name: fname, text: text, bytes: text.length, progress: db.wordProgress.length, dictionaries: db.dictionaries.length, days: db.studyLog.length };
      }).catch(function (e) { return { ok: false, err: String(e) }; });
    },

    /* ---------------- 导入数据（覆盖恢复） ---------------- */
    importData: function (json, opts) {
      opts = opts || {};
      var payload;
      try { payload = (typeof json === "string") ? JSON.parse(json) : json; } catch (e) { return Promise.resolve({ ok: false, err: "文件不是合法 JSON" }); }
      if (!payload || payload.app !== "lexis" || !payload.hot) return Promise.resolve({ ok: false, err: "不是 Lexis 的备份文件" });
      var LS = global.LexisStore, hot = payload.hot, db = payload.db || {};
      /* 1) 热状态写回 localStorage（主程序读的就是这些键） */
      var wrote = 0;
      HOT_KEYS.forEach(function (k) {
        if (!(k in hot)) return;
        try {
          if (hot[k] === null || hot[k] === undefined) localStorage.removeItem(LSK(k));
          else { localStorage.setItem(LSK(k), JSON.stringify(hot[k])); wrote++; }
        } catch (e) { }
      });
      /* 2) 数据库写回（进度/记录/设置/固定顺序/额外词库/音频清单） */
      var jobs = [];
      if (db.wordProgress && db.wordProgress.length) jobs.push(LS.bulkPut("wordProgress", db.wordProgress));
      if (db.studyLog && db.studyLog.length) jobs.push(LS.bulkPut("studyLog", db.studyLog));
      if (db.studySessions && db.studySessions.length) jobs.push(LS.bulkPut("studySessions", db.studySessions));
      if (db.settings && db.settings.length) jobs.push(LS.bulkPut("settings", db.settings));
      if (db.fixedOrders && db.fixedOrders.length) jobs.push(LS.bulkPut("fixedOrders", db.fixedOrders));
      if (db.audioMetadata && db.audioMetadata.length) jobs.push(LS.bulkPut("audioMetadata", db.audioMetadata));
      if (db.dictionaries && db.dictionaries.length) {
        jobs.push(LS.bulkPut("dictionaries", db.dictionaries));
        if (db.words && db.words.length) jobs.push(LS.bulkPut("words", db.words));
      }
      return Promise.all(jobs).then(function () {
        try { if (global.LexisAudio && hot.badAudio) global.LexisAudio.clearBad(); } catch (e) { }
        return {
          ok: true, hotKeys: wrote, progress: (db.wordProgress || []).length, days: (db.studyLog || []).length,
          dictionaries: (db.dictionaries || []).length, words: (db.words || []).length,
          exportedAt: payload.exportedAt, wordsInApp: payload.wordsInApp
        };
      }).catch(function (e) { return { ok: false, err: String(e) }; });
    },

    /* ---------------- 导出本地音频为 ZIP ---------------- */
    exportAudio: function (onProgress) {
      /* 音频 blob 存在 lexi-audio 库（不是 lexis 库），必须用音频模块的连接 */
      var AU = global.LexisAudio;
      var p = (AU && AU.openDB) ? AU.openDB() : Promise.resolve(null);
      return p.then(function (db) {
        if (!db) return { ok: false, err: "无法读取本地数据库" };
        return new Promise(function (res) {
          var rows = [];
          var req = db.transaction("clips", "readonly").objectStore("clips").openCursor();
          req.onsuccess = function () {
            var c = req.result;
            if (!c) return res(rows);
            var v = c.value || {};
            if (v.blob && v.blob.size) rows.push({ k: String(v.k || c.key), w: String(v.w || ""), blob: v.blob });
            c.continue();
          };
          req.onerror = function () { res(rows); };
        });
      }).then(function (rows) {
        if (!rows.length) return { ok: false, err: "没有本地音频可导出" };
        return new Promise(function (res) {
          var entries = [], i = 0;
          function step() {
            if (i >= rows.length) {
              try {
                var zip = makeZip(entries);
                var zname = "lexis-audio-" + dayKey() + ".zip";
                saveBlob(zname, zip);
                res({ ok: true, name: zname, files: entries.length, bytes: zip.size, blob: zip });
              } catch (e) { res({ ok: false, err: String(e) }); }
              return;
            }
            var r = rows[i++];
            var ext = (r.blob.type || "").indexOf("wav") >= 0 ? "wav" : (r.blob.type || "").indexOf("ogg") >= 0 ? "ogg"
              : (r.blob.type || "").indexOf("mp4") >= 0 ? "m4a" : "mp3";
            var name = (r.k.indexOf("uk|") === 0 ? "uk_" : "us_") + (r.w || r.k.split("|")[1] || "clip") + "." + ext;
            var fr = new FileReader();
            fr.onload = function () {
              entries.push({ name: name, data: new Uint8Array(fr.result) });
              if (onProgress && entries.length % 50 === 0) { try { onProgress(entries.length, rows.length); } catch (e) { } }
              setTimeout(step, 0);
            };
            fr.onerror = function () { setTimeout(step, 0); };
            fr.readAsArrayBuffer(r.blob);
          }
          step();
        });
      }).catch(function (e) { return { ok: false, err: String(e) }; });
    },

    /* ---------------- 导入音频 ZIP（复用 LexisAudio 的解析器） ---------------- */
    importAudio: function (file) {
      if (!global.LexisAudio || !file) return Promise.resolve({ ok: false, err: "没有音频模块" });
      return file.arrayBuffer().then(function (buf) { return global.LexisAudio.putZip(buf); })
        .then(function (r) { return { ok: !r.err, ...r }; })
        .catch(function (e) { return { ok: false, err: String(e) }; });
    },

    /* ---------------- 测试/维护用：清空全部 Lexis 数据 ---------------- */
    wipeEverything: function () {
      HOT_KEYS.forEach(function (k) { try { localStorage.removeItem(LSK(k)); } catch (e) { } });
      var LS = global.LexisStore;
      return Promise.all([LS.wipe(), (global.LexisAudio ? global.LexisAudio.clearAll() : Promise.resolve(true))])
        .then(function () { return true; });
    }
  };
  api.makeZip = makeZip;
  global.LexisBackup = api;
})(window);
