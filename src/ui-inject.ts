// v6.4.2：注入 DSH 页面「主题与桌宠」面板（v1 形态）。
// 说明：这是"改造 dsh 界面"的注入式实现——主窗口加载 DSH Web UI 后，
// 经 executeJavaScript 注入一个浮动按钮 + 面板：主题区（目前为默认：跟随系统/亮/暗，
// 走既有 theme:set IPC）+ 桌宠开关（走 pet:getEnabled/pet:setEnabled，与托盘双入口同源）。
// 后续可迁移为正式 DSH client 插件（settings.section 插槽），面板逻辑可整体复用。
// 注意：本文件只做类型导入 electron（运行时无 electron 依赖），以便 node:test 直接测编译产物。
import type { BrowserWindow } from 'electron';

/** 注入到 DSH 页面的脚本（IIFE，幂等；只使用单引号与字符串拼接，避免与外层模板字面量冲突）。 */
export const UI_PANEL_SCRIPT = `
(function () {
  if (window.__ttPanelInjected) return;
  window.__ttPanelInjected = true;
  var api = window.dshDesktop;
  if (!api) return;

  var CSS = '' +
    '#tt-ui-btn{position:fixed;right:18px;bottom:18px;z-index:99999;width:38px;height:38px;border-radius:50%;' +
    'background:rgba(30,33,40,.92);color:#fff;display:flex;align-items:center;justify-content:center;' +
    'cursor:pointer;font-size:17px;box-shadow:0 2px 10px rgba(0,0,0,.4);user-select:none;transition:transform .15s}' +
    '#tt-ui-btn:hover{transform:scale(1.08)}' +
    '#tt-ui-panel{position:fixed;right:18px;bottom:64px;z-index:99999;width:290px;box-sizing:border-box;' +
    'background:rgba(30,33,40,.97);color:#e8eaed;border:1px solid rgba(255,255,255,.12);border-radius:12px;' +
    'box-shadow:0 10px 30px rgba(0,0,0,.45);padding:14px 16px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'font-size:13px;line-height:1.5;display:none}' +
    '#tt-ui-panel.tt-open{display:block}' +
    '#tt-ui-title{font-weight:600;font-size:14px;margin-bottom:10px}' +
    '.tt-ui-sec{font-size:12px;color:#9aa3b0;margin:10px 0 6px}' +
    '.tt-ui-btn{display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border-radius:6px;cursor:pointer;' +
    'background:rgba(255,255,255,.1);color:#e8eaed;border:1px solid transparent}' +
    '.tt-ui-btn:hover{background:rgba(255,255,255,.2)}' +
    '.tt-ui-btn.tt-active{background:#4d7cfe;color:#fff}' +
    '.tt-ui-row{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}' +
    '.tt-ui-hint{font-size:11px;color:#7a828e;margin-top:8px}' +
    '.tt-ui-range{width:120px}' +
    '#tt-bg{position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;opacity:1;transition:opacity .3s}';

  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // ---- 背景层（内容之下；ttbg:// 协议绕过页面 CSP 加载本地图片）----
  var bgTransparent = document.createElement('style');
  bgTransparent.textContent = 'html,body{background:transparent!important}';
  document.head.appendChild(bgTransparent);
  var bgDiv = document.createElement('div');
  bgDiv.id = 'tt-bg';
  document.body.appendChild(bgDiv);
  window.__ttBg = {
    update: function (st) {
      if (!st) return;
      bgDiv.style.backgroundImage = st.path ? "url('ttbg://bg')" : '';
      bgDiv.style.opacity = st.opacity != null ? st.opacity : 1;
    }
  };

  var btn = document.createElement('div');
  btn.id = 'tt-ui-btn';
  btn.textContent = '\\u2699';
  btn.title = '主题与桌宠';

  var panel = document.createElement('div');
  panel.id = 'tt-ui-panel';

  var title = document.createElement('div');
  title.id = 'tt-ui-title';
  title.textContent = '主题与桌宠';

  // ---- 主题区（目前为默认：跟随系统 / 亮 / 暗，走既有 theme:set）----
  var tSec = document.createElement('div');
  tSec.className = 'tt-ui-sec';
  tSec.textContent = '主题（目前为默认）';
  var tRow = document.createElement('div');
  var tBtns = { system: '跟随系统', light: '亮色', dark: '暗色' };
  Object.keys(tBtns).forEach(function (k) {
    var b = document.createElement('span');
    b.className = 'tt-ui-btn';
    b.textContent = tBtns[k];
    b.dataset.mode = k;
    b.addEventListener('click', function () {
      api.theme.set(k).catch(function () {});
      var q = tRow.querySelectorAll('.tt-ui-btn');
      for (var i = 0; i < q.length; i++) q[i].classList.toggle('tt-active', q[i].dataset.mode === k);
    });
    tRow.appendChild(b);
  });
  var tHint = document.createElement('div');
  tHint.className = 'tt-ui-hint';
  tHint.textContent = '自定义主题皮肤开发中，当前仅默认主题。';

  // ---- 桌宠区 ----
  var pSec = document.createElement('div');
  pSec.className = 'tt-ui-sec';
  pSec.textContent = '桌宠';
  var pRow = document.createElement('label');
  pRow.className = 'tt-ui-row';
  var pCheck = document.createElement('input');
  pCheck.type = 'checkbox';
  pCheck.id = 'tt-pet-toggle';
  var pLabel = document.createElement('span');
  pLabel.textContent = '启用桌面桌宠';
  pRow.appendChild(pCheck);
  pRow.appendChild(pLabel);
  var pHint = document.createElement('div');
  pHint.className = 'tt-ui-hint';
  pHint.textContent = '与托盘「桌宠」开关一致；关闭后桌宠窗口立即隐藏。';

  // ---- 背景区 ----
  var bSec = document.createElement('div');
  bSec.className = 'tt-ui-sec';
  bSec.textContent = '背景';
  var bRow = document.createElement('div');
  var upBtn = document.createElement('span');
  upBtn.className = 'tt-ui-btn';
  upBtn.textContent = '上传背景图片';
  upBtn.addEventListener('click', function () {
    if (!(api.bg && api.bg.upload)) { setStatus('当前版本不支持背景上传', true); return; }
    setStatus('正在打开上传窗口…');
    api.bg.upload().then(function () { setStatus('上传窗口已打开'); }).catch(function (e) { setStatus('打开失败：' + String(e && e.message ? e.message : e), true); });
  });
  var clrBtn = document.createElement('span');
  clrBtn.className = 'tt-ui-btn';
  clrBtn.textContent = '清除背景';
  clrBtn.addEventListener('click', function () {
    if (!(api.bg && api.bg.clear)) { setStatus('当前版本不支持清除背景', true); return; }
    api.bg.clear().then(function () { setStatus('背景已清除'); }).catch(function (e) { setStatus('清除失败：' + String(e && e.message ? e.message : e), true); });
  });
  bRow.appendChild(upBtn);
  bRow.appendChild(clrBtn);
  var opRow = document.createElement('div');
  opRow.className = 'tt-ui-row';
  var opLabel = document.createElement('span');
  opLabel.textContent = '背景透明度';
  var slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 10; slider.max = 100; slider.value = 100;
  slider.className = 'tt-ui-range';
  slider.addEventListener('input', function () {
    bgDiv.style.opacity = Number(slider.value) / 100;
    if (api.bg && api.bg.setOpacity) api.bg.setOpacity(Number(slider.value) / 100).catch(function () {});
  });
  opRow.appendChild(opLabel);
  opRow.appendChild(slider);
  var bHint = document.createElement('div');
  bHint.className = 'tt-ui-hint';
  bHint.textContent = '建议 16:9、≥1920×1080、≤20MB；上传窗口内有完整说明。';
  var stRow = document.createElement('div');
  stRow.id = 'tt-ui-status';
  stRow.className = 'tt-ui-hint';
  stRow.style.color = '#7fd18b';
  function setStatus(msg, isErr) {
    stRow.textContent = msg;
    stRow.style.color = isErr ? '#ff6b6b' : '#7fd18b';
  }

  panel.appendChild(title);
  panel.appendChild(tSec);
  panel.appendChild(tRow);
  panel.appendChild(tHint);
  panel.appendChild(pSec);
  panel.appendChild(pRow);
  panel.appendChild(pHint);
  panel.appendChild(bSec);
  panel.appendChild(bRow);
  panel.appendChild(opRow);
  panel.appendChild(bHint);
  panel.appendChild(stRow);

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  btn.addEventListener('click', function () { panel.classList.toggle('tt-open'); });
  document.addEventListener('click', function (e) {
    if (!panel.classList.contains('tt-open')) return;
    if (e.target === btn || btn.contains(e.target)) return;
    if (panel.contains(e.target)) return;
    panel.classList.remove('tt-open');
  });

  // ---- 初始化状态 ----
  if (api.bg && api.bg.get) {
    api.bg.get().then(function (st) { window.__ttBg.update(st); if (st && st.opacity != null) slider.value = Math.round(st.opacity * 100); }).catch(function () {});
  }
  if (api.theme && api.theme.get) {
    api.theme.get().then(function (t) {
      var m = t && t.mode;
      if (m && tBtns[m] !== undefined) {
        var q = tRow.querySelectorAll('.tt-ui-btn');
        for (var i = 0; i < q.length; i++) q[i].classList.toggle('tt-active', q[i].dataset.mode === m);
      }
    }).catch(function () {});
  }
  if (api.pet && api.pet.getEnabled) {
    api.pet.getEnabled().then(function (v) { pCheck.checked = !!v; }).catch(function () {});
    pCheck.addEventListener('change', function () {
      api.pet.setEnabled(pCheck.checked).catch(function () {});
    });
  } else {
    pRow.style.opacity = '0.5';
    pHint.textContent = '当前版本不支持在界面内开关桌宠，请使用托盘菜单。';
  }
})();
`;

/**
 * 向主窗口注入「主题与桌宠」面板。幂等（脚本自带 __ttPanelInjected 标记）；
 * 页面未就绪时静默失败（由调用方在 did-finish-load 后再触发一次）。
 */
export function injectUiPanel(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(UI_PANEL_SCRIPT).catch(() => { /* 注入失败不影响主功能 */ });
}
