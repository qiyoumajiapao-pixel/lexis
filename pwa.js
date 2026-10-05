/* Lexis PWA 外壳：Service Worker 注册、更新提示、安装到桌面、离线提示
   只在 PWA 版里加载；file:// 或浏览器不支持时全部静默跳过，绝不影响核心功能。 */
(function () {
  "use strict";
  var canSW = ("serviceWorker" in navigator) && /^https?:$/.test(location.protocol);
  var reg = null, deferredPrompt = null;

  /* ---------- 轻量 UI（自带样式，不动 app.css） ---------- */
  var style = document.createElement("style");
  style.textContent =
    /* 位置不写死：底部操作区在窄屏会换行变高，写死 118px 会盖住「认识/不认识」（实测踩过）。
       改成每次显示前按 footer 实际高度计算；弹层打开时改到顶部，避免挡住弹层里的按钮。 */
    "#lexisBar{position:fixed;left:50%;transform:translateX(-50%);bottom:120px;" +
    "z-index:70;display:none;align-items:center;gap:10px;background:var(--fg,#12151a);color:var(--bg,#fff);" +
    "padding:10px 14px;border-radius:14px;font-size:13.5px;font-weight:600;box-shadow:0 8px 28px rgba(0,0,0,.28);" +
    "max-width:92vw;pointer-events:none}" +
    "#lexisBar.on{display:flex}" +
    "#lexisBar button{border:0;border-radius:10px;padding:8px 12px;font-size:13.5px;font-weight:700;font-family:inherit;cursor:pointer;pointer-events:auto}" +
    "#lexisBar .go{background:var(--accent,#2f6bff);color:#fff}" +
    "#lexisBar .no{background:transparent;color:inherit;opacity:.7}" +
    "#lexisBar small{display:block;font-weight:500;opacity:.75;font-size:11.5px;margin-top:2px}";
  document.head.appendChild(style);

  var bar = document.createElement("div");
  bar.id = "lexisBar";
  bar.setAttribute("role", "status");
  document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(bar); });
  if (document.readyState !== "loading") document.body.appendChild(bar);

  var hideT = 0;
  function placeBar() {
    try {
      var sheetOpen = document.querySelector("#sheet") && document.querySelector("#sheet").classList.contains("open");
      var f = document.querySelector("footer");
      var h = f ? f.getBoundingClientRect().height : 110;
      if (sheetOpen) {                       // 弹层打开时挪到顶部，别压住弹层里的按钮
        bar.style.top = "calc(env(safe-area-inset-top,0px) + 8px)";
        bar.style.bottom = "auto";
      } else {
        bar.style.top = "auto";
        bar.style.bottom = Math.round(h + 12) + "px";
      }
    } catch (e) { }
  }
  window.addEventListener("resize", placeBar);
  window.addEventListener("orientationchange", placeBar);

  function showBar(html, actions, autoHideMs) {
    bar.innerHTML = html;
    (actions || []).forEach(function (a) {
      var b = document.createElement("button");
      b.className = a.cls || "go";
      b.textContent = a.label;
      b.onclick = function () { try { a.fn(); } catch (e) { } hideBar(); };
      bar.appendChild(b);
    });
    bar.classList.add("on");
    placeBar();
    clearTimeout(hideT);
    if (autoHideMs) hideT = setTimeout(hideBar, autoHideMs);
  }
  function hideBar() { bar.classList.remove("on"); }

  /* ---------- 1. 注册 Service Worker ---------- */
  if (canSW) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).then(function (r) {
        reg = r;
        if (r.waiting && navigator.serviceWorker.controller) showUpdate();
        r.addEventListener("updatefound", function () {
          var sw = r.installing;
          if (!sw) return;
          sw.addEventListener("statechange", function () {
            if (sw.state === "installed" && navigator.serviceWorker.controller) showUpdate();
          });
        });
      }).catch(function () { });
      /* 有网络时启动就去检查一次新版本（离线时会失败，必须吞掉，否则控制台报未处理拒绝） */
      setTimeout(function () {
        try { reg && reg.update().catch(function () { }); } catch (e) { }
      }, 4000);
    });
  }

  function showUpdate() {
    showBar("<span>有新版本可用<small>更新后学习记录不会丢</small></span>", [
      { label: "更新", fn: function () { applyUpdate(); } },
      { label: "以后", cls: "no", fn: function () { } }
    ]);
  }
  function applyUpdate() {
    if (!reg || !reg.waiting) { location.reload(); return; }
    navigator.serviceWorker.addEventListener("controllerchange", function () { location.reload(); }, { once: true });
    reg.waiting.postMessage({ type: "SKIP_WAITING" });
    setTimeout(function () { location.reload(); }, 1500);
  }

  /* ---------- 2. 安装到桌面 ---------- */
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showBar("<span>把 Lexis 装到桌面<small>装好后可以完全离线使用</small></span>", [
      { label: "安装", fn: function () { install(); } },
      { label: "以后", cls: "no", fn: function () { } }
    ]);
  });
  function install() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () { deferredPrompt = null; }).catch(function () { });
  }
  window.addEventListener("appinstalled", function () { deferredPrompt = null; hideBar(); });

  /* ---------- 3. 离线/在线提示（让用户知道断网也能用） ---------- */
  window.addEventListener("offline", function () {
    showBar("<span>已离线<small>词库、翻卡、本地发音、学习记录都能正常用</small></span>", [], 3200);
  });
  window.addEventListener("online", function () {
    showBar("<span>网络已恢复</span>", [], 2000);
  });

  /* ---------- 4. 让页面能查询 SW 状态（自动化测试用） ---------- */
  window.LEXI_PWA = {
    canSW: canSW,
    ready: function () {
      return canSW ? navigator.serviceWorker.ready.then(function (r) { return !!r.active; }).catch(function () { return false; }) : Promise.resolve(false);
    },
    version: function () {
      return canSW && navigator.serviceWorker.controller ? "controlled" : "not-controlled";
    }
  };
})();
