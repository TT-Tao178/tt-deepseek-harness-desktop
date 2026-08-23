// tt-bg 浏览器 half：背景显示层（官方 bundle 插件 client，__ModuleLoader__.load 契约，与 gal-view 同构）。
// 职责：
//  1) 注入 #tt-bg 背景层（body 下、z-index:-1、opacity 可控；React 只管理 #root，不会清掉它）
//  2) 页面级背景容器透明化：运行时找出"面积 ≥ 视口 60% 且背景不透明"的元素（body 与布局容器）
//     —— 让背景层真正可见（body 背景在 #tt-bg 之下，容器背景清掉后露出背景层）
//  3) 暴露 window.__ttBg.update（主进程 applyToWindow 的 executeJavaScript 通道 + 面板滑块）
//  4) 自初始化：调 window.dshDesktop.bg.get()（preload 暴露），不依赖注入时序
// 素材通道：ttbg:// 协议（主进程注册，bypassCSP）
window.__ModuleLoader__.load({
  id: 'tt-bg',
  factory: function (require) {
    var module = { exports: {} };

    (function () {
      if (window.__ttBgInjected) return;
      window.__ttBgInjected = true;

      // ---- 样式（幂等守卫；gal-view 方式）----
      if (!document.querySelector('style[data-tt-bg-style]')) {
        var styleEl = document.createElement('style');
        styleEl.setAttribute('data-tt-bg-style', '');
        styleEl.textContent =
          '#tt-bg{position:fixed;inset:0;z-index:-1;pointer-events:none;' +
          'background-size:cover;background-position:center;background-repeat:no-repeat;' +
          'opacity:1;transition:opacity .3s}';
        document.head.appendChild(styleEl);
      }

      // ---- 背景层 ----
      function ensureBg() {
        var d = document.getElementById('tt-bg');
        if (!d) {
          d = document.createElement('div');
          d.id = 'tt-bg';
          d.style.cssText =
            'position:fixed;inset:0;z-index:-1;pointer-events:none;' +
            'background-size:cover;background-position:center;background-repeat:no-repeat;' +
            'transition:opacity .3s';
          document.body.appendChild(d);
        }
        return d;
      }

      // ---- 页面级背景容器透明化 ----
      // DSH 的背景源是 --dsw-alias-bg-base（body 与部分布局容器引用）。不直接改第三方 CSS，
      // 而是运行时把"面积接近视口且背景不透明"的容器设为透明——露出 #tt-bg。
      var TRANSPARENT = 'rgba(0, 0, 0, 0)';
      function isSolidBg(el) {
        try {
          var bg = window.getComputedStyle(el).backgroundColor;
          return bg && bg !== TRANSPARENT && bg !== 'transparent';
        } catch (e) { return false; }
      }
      function clearPageBg() {
        try {
          var vw = window.innerWidth, vh = window.innerHeight;
          var minArea = vw * vh * 0.6;
          // 先 body：body 背景在 #tt-bg 之下，清掉更干净
          if (isSolidBg(document.body)) document.body.style.backgroundColor = 'transparent';
          // 再全树：面积 ≥ 视口 60% 的布局容器
          var all = document.body.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.id === 'tt-bg' || el.id === 'tt-ui-btn' || el.id === 'tt-ui-panel') continue;
            if (!isSolidBg(el)) continue;
            var r = el.getBoundingClientRect();
            if (r.width * r.height >= minArea) el.style.backgroundColor = 'transparent';
          }
        } catch (e) { /* 忽略 */ }
      }

      // ---- 观察者：DSH 重渲染/主题切换后背景容器可能恢复 → 防抖重清 ----
      var clearTimer = null;
      function scheduleClear() {
        clearTimeout(clearTimer);
        clearTimer = setTimeout(clearPageBg, 500);
      }
      if (window.MutationObserver) {
        new MutationObserver(scheduleClear).observe(document.body, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
        });
      }

      // ---- 对外接口（主进程 applyToWindow / 面板滑块）----
      window.__ttBg = {
        update: function (st) {
          if (!st) return;
          var d = ensureBg();
          clearPageBg();
          if (st.path) {
            d.style.backgroundImage = "url('ttbg://bg')";
            d.style.opacity = st.opacity != null ? st.opacity : 1;
          } else {
            d.style.backgroundImage = '';
            d.style.opacity = 1;
          }
        }
      };

      // ---- 自初始化：preload 暴露的 dshDesktop.bg.get（不依赖 executeJavaScript 时序）----
      clearPageBg();
      try {
        var api = window.dshDesktop;
        if (api && api.bg && api.bg.get) {
          api.bg.get().then(function (st) { window.__ttBg.update(st); }).catch(function () {});
        }
      } catch (e) { /* 忽略 */ }
    })();

    module.exports = { name: 'tt-bg', inject: [], apply: function () {} };
    return module.exports;
  }
});
