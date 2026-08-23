// v6.5.2：直接修改 dsh-web-frontend 的 dist/index.html（改 dsh 显示逻辑）。
// 依据（源码实锤）：DSH 的背景色在 body 上 —— body{background:var(--dsw-alias-bg-base)}，
// 启动画面/布局容器同样引用 --dsw-alias-bg-base。因此：
//   1) 把 :root 的 --dsw-alias-bg-base 置为 transparent —— 所有 DSH 背景一次清空；
//   2) 注入背景显示逻辑（#tt-bg 层 + window.__ttBg + 自初始化 + 主题切换兜底）。
// 背景层挂 body 下（#root 之外，React 不会清掉），z-index:-1（body 背景之上、内容之下），
// 透明度由 opacity 控制；图片走 ttbg:// 协议（bypassCSP）。
// 幂等：检测 data-tt-bg-patch 标记；pnpm install 重装后需重新 build（自动执行）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function locateIndexHtml() {
  const pnpmDir = path.resolve('node_modules/.pnpm');
  if (fs.existsSync(pnpmDir)) {
    const hits = fs.readdirSync(pnpmDir).filter((n) => n.startsWith('@deepseek-ai+dsh-web-frontend@'));
    for (const h of hits) {
      const p = path.join(pnpmDir, h, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html');
      if (fs.existsSync(p)) return p;
    }
  }
  const legacy = path.resolve('node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html');
  return fs.existsSync(legacy) ? legacy : null;
}

const STYLE =
  '\n  <style data-tt-bg-patch>\n' +
  '    /* v6.5.2 背景：DSH 全部容器背景透明（--dsw-alias-bg-base 是唯一背景源，源码实锤）*/\n' +
  '    :root { --dsw-alias-bg-base: transparent !important; }\n' +
  '  </style>\n';

const SCRIPT =
  '\n<script data-tt-bg-patch>\n' +
  '(function () {\n' +
  "  function ensureBg() {\n" +
  "    if (document.getElementById('tt-bg')) return;\n" +
  "    var d = document.createElement('div');\n" +
  "    d.id = 'tt-bg';\n" +
  "    d.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;transition:opacity .3s';\n" +
  "    document.body.appendChild(d);\n" +
  "  }\n" +
  "  function keepRootTransparent() {\n" +
  "    try { document.documentElement.style.setProperty('--dsw-alias-bg-base', 'transparent'); } catch (e) {}\n" +
  "  }\n" +
  "  window.__ttBg = {\n" +
  "    update: function (st) {\n" +
  "      ensureBg(); keepRootTransparent();\n" +
  "      var d = document.getElementById('tt-bg');\n" +
  "      if (!d) return;\n" +
  "      if (st && st.path) {\n" +
  "        d.style.backgroundImage = \"url('ttbg://bg')\";\n" +
  "        d.style.opacity = st.opacity != null ? st.opacity : 1;\n" +
  "      } else {\n" +
  "        d.style.backgroundImage = '';\n" +
  "        d.style.opacity = 1;\n" +
  "      }\n" +
  "    }\n" +
  "  };\n" +
  "  keepRootTransparent();\n" +
  "  if (window.MutationObserver) {\n" +
  "    new MutationObserver(function () { keepRootTransparent(); })\n" +
  "      .observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });\n" +
  "  }\n" +
  "  try {\n" +
  "    var api = window.dshDesktop;\n" +
  "    if (api && api.bg && api.bg.get) api.bg.get().then(function (st) { window.__ttBg.update(st); }).catch(function () {});\n" +
  "  } catch (e) {}\n" +
  "})();\n" +
  '</script>\n';

const file = locateIndexHtml();
if (!file) {
  console.error('[patch-frontend] dsh-web-frontend dist/index.html 未找到（先 pnpm install）');
  process.exit(1);
}
let html = fs.readFileSync(file, 'utf8');
if (html.includes('data-tt-bg-patch')) {
  console.log('[patch-frontend] 已打过补丁（幂等跳过）: ' + file);
  process.exit(0);
}
if (!html.includes('</head>') || !html.includes('</body>')) {
  console.error('[patch-frontend] index.html 结构异常（缺少 </head> 或 </body>）: ' + file);
  process.exit(1);
}
html = html.replace('</head>', STYLE + '</head>');
html = html.replace('</body>', SCRIPT + '</body>');
fs.writeFileSync(file, html, 'utf8');
console.log('[patch-frontend] 已补丁 dsh 显示逻辑: ' + file);
