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
          var viewArea = vw * vh;
          // 布局表面判定：面积 ≥ 视口 25%，或（接触视口边缘且面积 ≥ 视口 5%）
          // —— 覆盖 sidebar（~21%，接触左缘）、header（~6%，接触上缘）；内容卡片（小块、不触边）保持原样
          function isLayoutSurface(el) {
            var r = el.getBoundingClientRect();
            var area = r.width * r.height;
            if (area >= viewArea * 0.25) return true;
            var touchesEdge = r.left <= 1 || r.top <= 1 || r.right >= vw - 1 || r.bottom >= vh - 1;
            return touchesEdge && area >= viewArea * 0.05;
          }
          // 渐变装饰清除判定（v6.5.2-3）：纯渐变（无 url()）且 布局表面 或 面积 ≥ 视口 1% 或 触边
          function shouldClearGradient(el) {
            var r = el.getBoundingClientRect();
            var area = r.width * r.height;
            var touchesEdge = r.left <= 1 || r.top <= 1 || r.right >= vw - 1 || r.bottom >= vh - 1;
            return area >= viewArea * 0.01 || touchesEdge;
          }
          // 先 body：body 背景在 #tt-bg 之下，清掉更干净
          if (isSolidBg(document.body)) document.body.style.backgroundColor = 'transparent';
          // 再全树：布局表面容器透明 + 清除渐变装饰（如"连接设置"下方白色渐变；url() 背景图保留）
          var diag = [];   // 诊断：记录未被清除的渐变元素（进 main.log）
          var all = document.body.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.id === 'tt-bg' || el.id === 'tt-ui-btn' || el.id === 'tt-ui-panel') continue;
            if (isLayoutSurface(el) && isSolidBg(el)) el.style.backgroundColor = 'transparent';
            var bi = null;
            try { bi = window.getComputedStyle(el).backgroundImage; } catch (e2) { /* 忽略 */ }
            if (!bi || bi.indexOf('gradient') === -1) continue;
            if (bi.indexOf('url(') !== -1) continue;   // 含图片背景的渐变不碰
            if (shouldClearGradient(el)) { el.style.backgroundImage = 'none'; }
            else if (diag.length < 6) {
              var r = el.getBoundingClientRect();
              diag.push('id=' + (el.id || '-') + ' cls=' + (typeof el.className === 'string' ? el.className.slice(0, 50) : '-') + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height) + ' pos=(' + Math.round(r.left) + ',' + Math.round(r.top) + ') bg=' + bi.slice(0, 60));
            }
          }
          if (diag.length > 0) console.log('[tt-bg] 未清除的渐变元素: ' + diag.join(' | '));
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
          if (!d) return;
          if (st.path !== undefined) {        // 全量（path 变化）→ 重设背景图 + 重清布局表面
            if (st.path) d.style.backgroundImage = "url('ttbg://bg')";
            else d.style.backgroundImage = '';
            clearPageBg();
          }
          if (st.opacity != null) d.style.opacity = st.opacity;   // 局部（透明度）只改 opacity，避免闪烁
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
