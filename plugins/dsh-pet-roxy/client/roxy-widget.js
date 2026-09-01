// ============================================================================
// dsh-pet-roxy —— 页面侧脚本（浏览器上下文，原生 JS，IIFE）
//
// 模块分区：
//   ① 常量与工具          ② DOM 构建          ③ 表情系统
//   ④ 行为状态机          ⑤ 定位与吸附        ⑥ 数据轮询
//   ⑦ 右键菜单 + 设置面板  ⑧ 统计 Dashboard    ⑨ 气泡与台词
//
// ============================================================================
// 行为 → 表情键 → 图片 → 触发方式（映射来自 /config 的 expressions）
//   default 默认     roxy0.png  开机/待机
//   happy   行为一   roxy1.png  单击（与行为二随机二选一）；任务完成；每轮消耗 <5 元
//   surprised 行为二 roxy2.png  单击（与行为一随机二选一）；任务失败；每轮消耗 ≥5 元
//   sleepy  行为三   roxy3.png  任务进行中 80% 概率出现，平时 20% 概率出现（工作态）
//   angry   行为四   roxy4.png  双击；随机犯困（25~35 秒，30% 概率；任务进行中不犯困）
// ============================================================================
// 设计说明见项目 README.md
// ============================================================================
(function () {
  if (window.__dshPetRoxy) return
  window.__dshPetRoxy = true

  // -------------------------------------------------------------------------
  // ① 常量与工具
  // -------------------------------------------------------------------------
  var API = {
    config: '/dsh-pet-roxy/config',
    prefs: '/dsh-pet-roxy/prefs',
    balance: '/dsh-pet-roxy/balance.json',
    lastTurn: '/dsh-pet-roxy/last-turn.json',
    tasks: '/dsh-pet-roxy/tasks',
    userImage: '/dsh-pet-roxy/user-image',
    image: '/dsh-pet-roxy/image?name=',
  }
  var EXPR_KEYS = ['default', 'happy', 'surprised', 'sleepy', 'angry']
  var EXPR_LABELS = { default: '默认', happy: '行为一', surprised: '行为二', sleepy: '行为三', angry: '行为四' }
  var MIN_SCALE = 0.6
  var MAX_SCALE = 2.5
  var CLICK_SQ = 25 // 单击阈值（位移平方 < 25 即 <5px）
  var DRAG_SQ = 25 // 拖拽判定与单击同阈（>5px）
  var FETCH_TIMEOUT_MS = 25000
  var reducedMotion = false
  try { reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) {}

  var FALLBACK = {
    expressions: { default: 'roxy0.png', happy: 'roxy1.png', surprised: 'roxy2.png', sleepy: 'roxy3.png', angry: 'roxy4.png' },
    reactions: { turnCost: [{ min: 5, expr: 'surprised' }, { min: 0.01, expr: 'happy' }, { min: 0, expr: 'angry' }], balanceLow: { threshold: 10, line: '余额不多了。……自己看着办。' } },
    prefs: { scale: 1.0, corner: 'bottom-right', marginX: 16, marginY: 16, mirrorOnLeft: false, animationOn: true, linesOn: true, turnCostOn: true, turnCostCloseMs: 5000 },
    behavior: { breatheMs: 2400, flickEverySec: [10, 20], flickChance: 0.2, flickMs: 1200, sleepyEverySec: [25, 35], sleepyChance: 0.3, sleepyMs: 5000, refreshMs: 60000, bubbleMs: 5000, taskPollMs: 1000 },
    speech: { toggles: { randomLines: true, turnCost: true, balanceLow: true }, customLines: [] },
    lines: [],
    reportLines: { taskDone: '……%title%，做完了。', taskFailed: '%title%……失败了。自己看日志。', taskAdded: '记下了：%title%。' },
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)) }
  function fmtMoney(v, currency) {
    var n = Number(v)
    if (!isFinite(n)) return '--'
    if (currency === 'CNY' || !currency) return '¥' + n.toFixed(2)
    return n.toFixed(2) + ' ' + currency
  }
  function pickWeighted(groups) {
    var total = 0
    for (var i = 0; i < groups.length; i++) total += Number(groups[i].weight) || 0
    if (total <= 0) return null
    var roll = Math.random() * total
    for (var j = 0; j < groups.length; j++) {
      roll -= Number(groups[j].weight) || 0
      if (roll < 0) return groups[j]
    }
    return groups[groups.length - 1]
  }
  function deepMerge(base, over) {
    if (!base || typeof base !== 'object' || Array.isArray(base)) return over === undefined ? base : over
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
    var out = {}
    for (var k in base) out[k] = base[k]
    for (var key in over) {
      var b = base[key]
      var o = over[key]
      out[key] = (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o)) ? deepMerge(b, o) : o
    }
    return out
  }
  function apiFetch(url, opts) {
    opts = opts || {}
    var ctrl = new AbortController()
    var timer = setTimeout(function () { ctrl.abort() }, opts.timeout || FETCH_TIMEOUT_MS)
    var p = fetch(url, { method: opts.method || 'GET', headers: opts.headers || { 'Content-Type': 'application/json' }, body: opts.body, signal: ctrl.signal })
      .then(function (r) { return r.json().catch(function () { return { ok: false, code: 'BAD_RESPONSE' } }) })
      .catch(function (err) { return { ok: false, code: 'NETWORK', error: String((err && err.message) || err) } })
      .finally(function () { clearTimeout(timer) })
    return p
  }
  function localDateKey() {
    var d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }

  // -------------------------------------------------------------------------
  // 全局状态
  // -------------------------------------------------------------------------
  var state = {
    config: null,
    prefs: {},
    speech: {},
    behavior: {},
    expressions: {},
    balance: null,
    balanceError: null,
    lastSeq: 0,
    expr: 'default',
    exprTimer: null,
    costBubbleActive: false,
    costCloseTimer: null,
    bubbleMode: 'none', // 'none' | 'balance' | 'line' | 'cost' | 'plain'
    dragging: false,
    press: false,
    snapH: 'right', // 'left' | 'right' | 'free'
    snapV: 'bottom', // 'top' | 'bottom' | 'free'
    left: 0,
    top: 0,
    viewW: 0,
    viewH: 0,
    sizeKey: null,
    bubbleTimer: null,
    flickTimer: null,
    sleepyTimer: null,
    menuOpen: false,
    dialogOpen: false,
    // 任务
    taskMap: {}, // id -> status（上次看到的状态）
    selfTaskId: null,
    selfTaskAt: 0,
    taskWorking: false, // 是否有任务处于 doing（决定行为三出现概率 80% / 20%）
  }

  // -------------------------------------------------------------------------
  // ② DOM 构建
  // -------------------------------------------------------------------------
  var css = [
    '.rx-root{position:fixed;left:0;top:0;z-index:9999;pointer-events:none;--rx-scale:1;--rx-base:clamp(96px,calc(min(180px,min(100vw,100vh) * 0.22) * var(--rx-scale)),420px);width:var(--rx-base);height:calc(var(--rx-base) * 1.6);transition:left .16s ease,top .16s ease}',
    '.rx-root.rx-mirror{transform:scaleX(-1)}',
    '.rx-root.rx-dragging{transition:none}',
    '.rx-body{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:auto;transform-origin:50% 100%;transition:transform .22s cubic-bezier(.34,1.56,.64,1);cursor:grab}',
    '.rx-root.rx-dragging .rx-body{cursor:grabbing}',
    '.rx-img{position:absolute;left:0;bottom:0;width:100%;height:var(--rx-base);object-fit:contain;object-position:center bottom;display:block;pointer-events:none;-webkit-user-drag:none;user-select:none;transform-origin:50% 100%}',
    '.rx-root.rx-anim .rx-img{animation:rx-breathe var(--rx-breathe,2.4s) ease-in-out infinite}',
    '@keyframes rx-breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.03)}}',
    '.rx-root.rx-mirror .rx-img{transform:scaleX(-1)}',
    '.rx-root.rx-mirror.rx-anim .rx-img{animation-name:rx-breathe-mirror}',
    '@keyframes rx-breathe-mirror{0%,100%{transform:scaleX(-1) scaleY(1)}50%{transform:scaleX(-1) scaleY(1.03)}}',
    '.rx-bubble{position:absolute;left:0;top:0;width:86%;aspect-ratio:1026/700;pointer-events:none;z-index:1;opacity:0;transition:opacity .2s ease;--rx-u:calc(var(--rx-base) / 1026)}',
    '.rx-bubble.rx-bubble-open{opacity:1}',
    '.rx-bubble svg{display:block;width:100%;height:100%;pointer-events:none}',
    '.rx-bubble svg path,.rx-bubble svg ellipse{pointer-events:auto;cursor:pointer}',
    '.rx-text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);text-align:center;color:#203170;line-height:1.15;white-space:nowrap;pointer-events:none}',
    '.rx-root.rx-mirror .rx-text{transform:translate(-50%,-50%) scaleX(-1)}',
    '.rx-label{font-size:calc(var(--rx-u) * 66);font-weight:600;letter-spacing:.06em}',
    '.rx-amount{font-size:calc(var(--rx-u) * 128);font-weight:800;line-height:1.05}',
    '.rx-period{font-size:calc(var(--rx-u) * 104);font-weight:800;line-height:1.05}',
    '.rx-hint{font-size:calc(var(--rx-u) * 56);color:#9fb0d9;letter-spacing:.02em;margin-top:calc(var(--rx-u) * 9);min-height:calc(var(--rx-u) * 64);line-height:1.15}',
    '.rx-wrap{white-space:normal;max-width:calc(var(--rx-u) * 560);line-height:1.2}',
    '.rx-menu-btn{position:absolute;top:4px;right:4px;width:26px;height:26px;border:none;border-radius:6px;background:rgba(32,49,112,.85);cursor:pointer;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0;z-index:3;opacity:0;transition:opacity .15s ease}',
    '.rx-root:hover .rx-menu-btn,.rx-root:focus-within .rx-menu-btn,.rx-menu-btn:focus-visible{opacity:1}',
    '.rx-menu-btn span{display:block;width:14px;height:2px;background:#fff;border-radius:1px}',
    '.rx-menu{position:fixed;min-width:168px;background:rgba(255,255,255,.96);border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:6px;opacity:0;transform:scale(.94) translateY(-4px);transform-origin:top right;transition:opacity .15s ease,transform .18s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:10000;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:light}',
    '.rx-menu.rx-menu-open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto}',
    '.rx-menu-item{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;padding:8px 10px;border-radius:6px;font-size:13px;color:#203170;cursor:pointer;text-align:left}',
    '.rx-menu-item:hover{background:rgba(32,49,112,.08)}',
    '.rx-dialog{color-scheme:light;border:1px solid rgba(32,49,112,.3);border-radius:12px;padding:0;box-shadow:0 12px 32px rgba(0,0,0,.25);background:#fffdf7;color:#203170;width:min(480px,92vw);height:min(560px,86vh)}',
    '.rx-dialog[open]{display:flex;flex-direction:column;overflow:hidden}',
    '.rx-dialog .rx-panel{overflow-y:auto;flex:1}',
    '.rx-dialog::backdrop{background:rgba(2,6,23,.35)}',
    '.rx-dialog-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(32,49,112,.12);position:sticky;top:0;background:#fffdf7;z-index:2}',
    '.rx-dialog-head h3{margin:0;font-size:16px;font-weight:800}',
    '.rx-dialog-close{border:none;background:rgba(32,49,112,.08);border-radius:6px;width:28px;height:28px;cursor:pointer;font-size:14px;color:#203170}',
    '.rx-tabs{display:flex;gap:4px;padding:10px 18px 0;border-bottom:1px solid rgba(32,49,112,.1)}',
    '.rx-tab{border:none;background:transparent;padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px;color:#64748b}',
    '.rx-tab.rx-tab-active{background:rgba(32,49,112,.08);color:#203170;font-weight:700}',
    '.rx-panel{padding:16px 18px}',
    '.rx-row{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:13px;flex-wrap:wrap}',
    '.rx-row label{min-width:96px;color:#475569}',
    '.rx-range{flex:1;min-width:120px;accent-color:#203170}',
    '.rx-number{width:56px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:3px 6px;font-size:12px;color:#203170;background:#fff}',
    '.rx-check{width:16px;height:16px;accent-color:#203170}',
    '.rx-btn{border:1px solid rgba(32,49,112,.35);background:rgba(32,49,112,.06);color:#203170;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer}',
    '.rx-btn:hover{background:rgba(32,49,112,.12)}',
    '.rx-btn-primary{background:#203170;border-color:#203170;color:#fff}',
    '.rx-btn-primary:hover{background:#2b3f8f}',
    '.rx-sep{height:1px;background:rgba(32,49,112,.12);margin:10px 0}',
    '.rx-slot-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:10px 0}',
    '.rx-slot{border:1px solid rgba(32,49,112,.18);border-radius:8px;padding:8px;text-align:center;background:#fff}',
    '.rx-slot img{width:100%;height:64px;object-fit:contain;display:block;margin-bottom:4px;background:repeating-conic-gradient(#f1f5f9 0 25%,#fff 0 50%) 0 0/12px 12px}',
    '.rx-slot-name{font-size:11px;font-weight:700;color:#203170}',
    '.rx-slot-src{font-size:10px;color:#94a3b8;margin:2px 0 6px;word-break:break-all}',
    '.rx-stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}',
    '.rx-stat{border:1px solid rgba(32,49,112,.15);border-radius:10px;padding:10px 8px;text-align:center;background:#fff}',
    '.rx-stat b{display:block;font-size:26px;font-weight:800;line-height:1.1}',
    '.rx-stat span{font-size:11px;color:#64748b}',
    '.rx-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}',
    '.rx-donut-wrap{display:flex;align-items:center;gap:18px;margin:14px 0;flex-wrap:wrap}',
    '.rx-donut{position:relative;width:120px;height:120px;flex:0 0 auto}',
    '.rx-donut svg{width:100%;height:100%;transform:rotate(-90deg)}',
    '.rx-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:12px;color:#64748b}',
    '.rx-donut-center b{font-size:17px;color:#203170}',
    '.rx-legend{font-size:12px;color:#475569;display:flex;flex-direction:column;gap:4px}',
    '.rx-trend{margin:12px 0}',
    '.rx-trend-row{display:flex;align-items:center;gap:6px;margin:3px 0;font-size:10px;color:#94a3b8}',
    '.rx-trend-bar{flex:1;height:16px;border-radius:4px;overflow:hidden;display:flex;background:#e2e8f0;min-width:60px}',
    '.rx-trend-bar i{display:block;height:100%}',
    '.rx-task-list{margin:10px 0;display:flex;flex-direction:column;gap:4px}',
    '.rx-task{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:13px;background:#fff}',
    '.rx-task:hover{background:#f1f5f9}',
    '.rx-task-title{flex:1;word-break:break-all}',
    '.rx-task-btn{border:none;background:rgba(32,49,112,.07);border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:12px;color:#203170}',
    '.rx-task-btn:hover{background:rgba(32,49,112,.16)}',
    '.rx-task-del{border:none;background:transparent;cursor:pointer;color:#cbd5e1;font-size:14px;padding:2px 4px}',
    '.rx-task-del:hover{color:#ef4444}',
    '.rx-add-task{display:flex;gap:6px;margin:8px 0}',
    '.rx-add-task input{flex:1;border:1px solid rgba(32,49,112,.35);border-radius:6px;padding:6px 8px;font-size:13px;color:#203170;background:#fff}',
    '.rx-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#203170;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:10001;box-shadow:0 6px 18px rgba(0,0,0,.25);opacity:0;transition:opacity .2s ease;pointer-events:none}',
    '.rx-toast.rx-toast-on{opacity:1}',
    '.rx-note{position:fixed;width:250px;background:#fff9c4;color:#203170;border-radius:2px;box-shadow:0 10px 24px rgba(0,0,0,.28);padding:26px 14px 12px;transform:rotate(-1.2deg);z-index:10002;font-size:13px;color-scheme:light;pointer-events:auto}',
    '.rx-note::before{content:"";position:absolute;top:-10px;left:50%;transform:translateX(-50%) rotate(2deg);width:64px;height:18px;background:rgba(255,255,255,.6);box-shadow:0 1px 3px rgba(0,0,0,.18);border-radius:1px}',
    '.rx-note input{width:100%;box-sizing:border-box;border:none;background:transparent;border-bottom:1px dashed rgba(32,49,112,.4);padding:6px 2px;font-size:14px;color:#203170;outline:none;font-family:inherit}',
    '.rx-note input:focus{border-bottom-color:#203170}',
    '.rx-note-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:10px}',
    '.rx-note-actions button{border:none;background:rgba(32,49,112,.08);border-radius:6px;padding:5px 12px;font-size:12px;color:#203170;cursor:pointer}',
    '.rx-note-actions button:hover{background:rgba(32,49,112,.16)}',
    '.rx-note-add{background:#203170 !important;color:#fff !important}',
    '@media (max-width:560px){.rx-stats-grid{grid-template-columns:repeat(2,1fr)}.rx-slot-grid{grid-template-columns:repeat(3,1fr)}}',
  ].join('\n')

  var root = null
  var bodyEl = null
  var imgEl = null
  var bubbleEl = null
  var textEl = null
  var menuBtn = null
  var contextMenu = null
  var toastEl = null

  function buildDom() {
    var styleEl = document.createElement('style')
    styleEl.textContent = css
    document.head.appendChild(styleEl)

    root = document.createElement('div')
    root.className = 'rx-root'
    root.setAttribute('role', 'img')
    root.setAttribute('aria-label', '洛琪希宠物挂件')

    bodyEl = document.createElement('div')
    bodyEl.className = 'rx-body'
    root.appendChild(bodyEl)

    imgEl = document.createElement('img')
    imgEl.className = 'rx-img'
    imgEl.alt = '洛琪希'
    imgEl.draggable = false
    bodyEl.appendChild(imgEl)

    bubbleEl = document.createElement('div')
    bubbleEl.className = 'rx-bubble'
    bubbleEl.innerHTML =
      '<svg viewBox="0 0 1026 700" aria-hidden="true">' +
      '<ellipse class="rx-bshape" cx="454" cy="247" rx="373" ry="232" fill="#FFFDF7" stroke="#203170" stroke-width="18" stroke-linejoin="round"/>' +
      '<path class="rx-bshape" d="M301 465 Q356 448 413 484 Q368 498 301 465 Z" fill="#FFFDF7" stroke="#203170" stroke-width="18" stroke-linejoin="round"/>' +
      '<ellipse class="rx-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFDF7" stroke="#203170" stroke-width="18"/>' +
      '<ellipse class="rx-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFDF7" stroke="#203170" stroke-width="18"/>' +
      '</svg>'
    bodyEl.appendChild(bubbleEl)

    textEl = document.createElement('div')
    textEl.className = 'rx-text'
    bubbleEl.appendChild(textEl)

    menuBtn = document.createElement('button')
    menuBtn.type = 'button'
    menuBtn.className = 'rx-menu-btn'
    menuBtn.title = '菜单'
    menuBtn.setAttribute('aria-label', '打开菜单')
    menuBtn.innerHTML = '<span></span><span></span><span></span>'
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      var r = bodyEl.getBoundingClientRect()
      openContextMenu(r.right - 4, r.top + 30)
    })
    root.appendChild(menuBtn)

    document.body.appendChild(root)

    // 右键菜单
    contextMenu = document.createElement('div')
    contextMenu.className = 'rx-menu'
    contextMenu.setAttribute('role', 'menu')
    contextMenu.style.display = 'none'
    document.body.appendChild(contextMenu)

    // Toast
    toastEl = document.createElement('div')
    toastEl.className = 'rx-toast'
    document.body.appendChild(toastEl)

    // 交互
    bodyEl.addEventListener('contextmenu', onContextMenu)
    bodyEl.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('pointermove', onDocPointerMove)
    document.addEventListener('pointerup', onDocPointerUp)
    document.addEventListener('pointercancel', onDocPointerUp)
    document.addEventListener('click', onDocClickStopper)
    document.addEventListener('keydown', onDocKeydown)
    // 点击菜单/宠物以外的任意位置关闭右键菜单（捕获阶段，先于其他处理）
    document.addEventListener('pointerdown', function (e) {
      if (!state.menuOpen) return
      if (contextMenu.contains(e.target)) return
      closeContextMenu()
    }, true)
    window.addEventListener('resize', function () { settle() })
  }

  // -------------------------------------------------------------------------
  // ③ 表情系统
  // -------------------------------------------------------------------------
  function resolveImgUrl(expr) {
    var v = state.expressions && state.expressions[expr]
    if (!v) v = FALLBACK.expressions[expr] || 'roxy0.png'
    var src
    if (v.indexOf('user-image/') === 0) {
      src = API.userImage + '?name=' + encodeURIComponent(v.slice('user-image/'.length))
    } else {
      src = API.image + encodeURIComponent(v)
    }
    return src
  }

  function setExpression(expr, holdMs) {
    if (state.exprTimer) { clearTimeout(state.exprTimer); state.exprTimer = null }
    var newSrc = resolveImgUrl(expr)
    if (newSrc.indexOf('user-image') !== -1) newSrc += '&t=' + Date.now()
    if (holdMs && !reducedMotion) {
      // 淡出 -> 换图 -> 淡入
      imgEl.style.transition = 'opacity .15s ease'
      imgEl.style.opacity = '0'
      setTimeout(function () {
        imgEl.src = newSrc
        imgEl.onerror = function () { imgEl.onerror = null; imgEl.src = API.image + 'roxy0.png' }
        imgEl.style.transition = 'opacity .2s ease'
        imgEl.style.opacity = '1'
      }, 150)
    } else {
      imgEl.src = newSrc
      imgEl.onerror = function () { imgEl.onerror = null; imgEl.src = API.image + 'roxy0.png' }
    }
    state.expr = expr
    if (holdMs) {
      state.exprTimer = setTimeout(function () {
        state.exprTimer = null
        if (!state.costBubbleActive) setExpression('default', 0)
      }, holdMs)
    }
  }

  // -------------------------------------------------------------------------
  // ④ 行为状态机
  // -------------------------------------------------------------------------
  function startIdleTimers() {
    scheduleFlick()
    scheduleSleepy()
  }

  // 行为三（working 工作态）：任务进行中时 80% 概率短暂出现，平时 20% 概率出现
  function scheduleFlick() {
    if (state.flickTimer) clearTimeout(state.flickTimer)
    var bh = state.behavior || FALLBACK.behavior
    var sec = randInt((bh.flickEverySec && bh.flickEverySec[0]) || 10, (bh.flickEverySec && bh.flickEverySec[1]) || 20)
    state.flickTimer = setTimeout(function () {
      state.flickTimer = null
      if (!state.costBubbleActive && state.expr === 'default') {
        var chance = state.taskWorking ? 0.8 : (Number(bh.flickChance) || 0.2)
        if (Math.random() < chance) setExpression('sleepy', Number(bh.flickMs) || 1200)
      }
      scheduleFlick()
    }, sec * 1000)
  }

  function scheduleSleepy() {
    if (state.sleepyTimer) clearTimeout(state.sleepyTimer)
    var bh = state.behavior || FALLBACK.behavior
    var sec = randInt((bh.sleepyEverySec && bh.sleepyEverySec[0]) || 25, (bh.sleepyEverySec && bh.sleepyEverySec[1]) || 35)
    state.sleepyTimer = setTimeout(function () {
      state.sleepyTimer = null
      // 任务进行中不犯困（行为三 working 优先）；行为四 = 犯困
      if (!state.costBubbleActive && state.expr === 'default' && !state.taskWorking && Math.random() < (Number(bh.sleepyChance) || 0.3)) {
        enterSleepy(Number(bh.sleepyMs) || 5000)
      }
      scheduleSleepy()
    }, sec * 1000)
  }

  // 行为四 = 犯困状态
  function enterSleepy(ms) {
    setExpression('angry', ms)
  }

  function stopAllBehavior() {
    if (state.flickTimer) clearTimeout(state.flickTimer)
    if (state.sleepyTimer) clearTimeout(state.sleepyTimer)
  }

  function pressDown() {
    if (state.dragging) return
    state.press = true
    bodyEl.style.transform = 'scaleY(.88) scaleX(1.05)'
  }
  function pressUp() {
    state.press = false
    bodyEl.style.transform = ''
  }

  // -------------------------------------------------------------------------
  // ⑤ 定位与吸附
  // -------------------------------------------------------------------------
  function viewport() {
    return { w: window.innerWidth || document.documentElement.clientWidth, h: window.innerHeight || document.documentElement.clientHeight }
  }

  function applyPosition() {
    root.style.left = state.left + 'px'
    root.style.top = state.top + 'px'
  }

  function cornerPosition(corner) {
    var v = viewport()
    var w = root.offsetWidth || 180
    var h = root.offsetHeight || 180
    var p = state.prefs || FALLBACK.prefs
    var mx = Number(p.marginX) || 16
    var my = Number(p.marginY) || 16
    var map = {
      'bottom-right': { left: v.w - w - mx, top: v.h - h - my, h: 'right', v: 'bottom' },
      'bottom-left': { left: mx, top: v.h - h - my, h: 'left', v: 'bottom' },
      'top-right': { left: v.w - w - mx, top: my, h: 'right', v: 'top' },
      'top-left': { left: mx, top: my, h: 'left', v: 'top' },
    }
    return map[corner] || map['bottom-right']
  }

  function place(corner) {
    var pos = cornerPosition(corner || (state.prefs && state.prefs.corner) || 'bottom-right')
    state.left = pos.left
    state.top = pos.top
    state.snapH = pos.h
    state.snapV = pos.v
    applyPosition()
    applyMirror()
  }

  function applyMirror() {
    var mirrored = state.snapH === 'left' && state.prefs && state.prefs.mirrorOnLeft
    root.classList.toggle('rx-mirror', !!mirrored)
  }

  function settle() {
    var v = viewport()
    var r = root.getBoundingClientRect()
    var w = r.width || 180
    var h = r.height || 180
    var cx = state.left + w / 2
    var cy = state.top + h / 2
    var qW = v.w / 4
    var qH = v.h / 4
    var hSnap = cx < qW ? 'left' : cx > 3 * qW ? 'right' : 'free'
    var vSnap = cy < qH ? 'top' : cy > 3 * qH ? 'bottom' : 'free'
    var p = state.prefs || FALLBACK.prefs
    var mx = Number(p.marginX) || 16
    var my = Number(p.marginY) || 16
    if (hSnap === 'left') state.left = mx
    else if (hSnap === 'right') state.left = v.w - w - mx
    else state.left = clamp(state.left, mx, Math.max(mx, v.w - w - mx))
    if (vSnap === 'top') state.top = my
    else if (vSnap === 'bottom') state.top = v.h - h - my
    else state.top = clamp(state.top, my, Math.max(my, v.h - h - my))
    state.snapH = hSnap
    state.snapV = vSnap
    applyPosition()
    applyMirror()
  }

  // 缩放时以角色所在角为固定点
  function applyScale(scale) {
    var w = root.offsetWidth || 180
    var h = root.offsetHeight || 180
    var corner = (state.prefs && state.prefs.corner) || 'bottom-right'
    var anchorX = corner.indexOf('left') !== -1 ? state.left + 4 : state.left + w - 4
    var anchorY = corner.indexOf('top') !== -1 ? state.top + 4 : state.top + h - 4
    state.scale = scale
    root.style.setProperty('--rx-scale', String(scale))
    // 等新尺寸确定后按锚点重算位置
    requestAnimationFrame(function () {
      var w2 = root.offsetWidth || 180
      var h2 = root.offsetHeight || 180
      if (corner.indexOf('left') !== -1) state.left = anchorX - 4
      else state.left = anchorX - w2 + 4
      if (corner.indexOf('top') !== -1) state.top = anchorY - 4
      else state.top = anchorY - h2 + 4
      state.left = clamp(state.left, 0, Math.max(0, viewport().w - w2))
      state.top = clamp(state.top, 0, Math.max(0, viewport().h - h2))
      applyPosition()
    })
  }

  // 拖拽
  var drag = { active: false, startX: 0, startY: 0, origLeft: 0, origTop: 0, moved: false, downAt: 0, clicks: 0, lastClickAt: 0, lastClickTarget: null }

  function onDocPointerDown(e) {
    if (!bodyEl.contains(e.target)) return
    if (e.button !== undefined && e.button !== 0 && e.button !== 2) return
    drag.active = true
    drag.startX = e.clientX
    drag.startY = e.clientY
    drag.origLeft = state.left
    drag.origTop = state.top
    drag.moved = false
    drag.downAt = Date.now()
    state.dragging = false
    pressDown()
    try { bodyEl.setPointerCapture(e.pointerId) } catch (err) {}
    e.preventDefault()
  }

  function onDocPointerMove(e) {
    if (!drag.active) return
    var dx = e.clientX - drag.startX
    var dy = e.clientY - drag.startY
    if (!state.dragging && dx * dx + dy * dy >= DRAG_SQ) {
      state.dragging = true
      drag.moved = true
      root.classList.add('rx-dragging')
    }
    if (state.dragging) {
      state.left = drag.origLeft + dx
      state.top = drag.origTop + dy
      applyPosition()
    }
  }

  function onDocPointerUp(e) {
    if (!drag.active) return
    drag.active = false
    pressUp()
    if (state.dragging) {
      state.dragging = false
      root.classList.remove('rx-dragging')
      settle()
      return
    }
    // 单击 / 连点
    var dx = e.clientX - drag.startX
    var dy = e.clientY - drag.startY
    var isClick = !drag.moved && dx * dx + dy * dy < CLICK_SQ && Date.now() - drag.downAt < 600
    if (isClick && e.button !== 2) {
      var now = Date.now()
      if (now - drag.lastClickAt < 500) {
        drag.lastClickAt = 0
        handleDoubleClick()
      } else {
        drag.lastClickAt = now
        setTimeout(function () {
          if (drag.lastClickAt === now && !state.dragging) handleSingleClick()
        }, 520)
      }
    }
  }

  function onDocClickStopper(e) {
    // 防止拖动后的 click 冒泡到页面
    if (e.target && bodyEl.contains(e.target)) e.stopPropagation()
  }

  function handleSingleClick() {
    // 行为一 / 行为二：点击时随机出现一个
    var pool = ['happy', 'surprised']
    setExpression(pool[randInt(0, pool.length - 1)], 2000)
    showBalanceBubble(true)
  }

  function handleDoubleClick() {
    // 行为四 = 犯困
    setExpression('angry', 1500)
    showBubbleText([{ t: '……别戳了，我要睡了。', s: 'A', w: true }], 1500)
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') {
      closeContextMenu()
      closeSettings()
      closeDashboard()
    }
  }

  // -------------------------------------------------------------------------
  // ⑥ 数据轮询
  // -------------------------------------------------------------------------
  function refreshBalance(manual) {
    apiFetch(API.balance).then(function (data) {
      if (data && data.ok) {
        state.balanceError = null
        var changed = state.balance && state.balance.totalBalance !== data.totalBalance
        state.balance = data
        if (manual) {
          showBalanceBubble(false)
        } else if (changed && !state.costBubbleActive && !bubbleOpen()) {
          showBubble([{ t: '余额变化', s: 'C' }, { t: fmtMoney(data.totalBalance, data.currency), s: 'B' }], (state.behavior && state.behavior.bubbleMs) || 5000, 'balance')
        }
        // 余额到达后，若气泡还停在"加载中/错误"占位，则刷新为真实内容
        renderBalanceHint()
      } else {
        state.balanceError = (data && data.code === 'NO_KEY')
          ? '未配置 DEEPSEEK_API_KEY，去 DSH 凭据里添加'
          : '余额获取失败，稍后重试'
        if (manual && !bubbleOpen()) {
          showBubble([{ t: state.balanceError, s: 'C', w: true }], 4000, 'balance')
        } else {
          renderBalanceHint()
        }
      }
    })
  }

  function renderBalanceHint() {
    // 只有"余额气泡"处于占位/旧内容时才更新，避免覆盖随机台词或消耗泡泡
    if (!bubbleOpen() || state.bubbleMode !== 'balance') return
    swapBubbleLines(bubbleLines())
  }

  function startIntervals() {
    var bh = state.behavior || FALLBACK.behavior
    setInterval(function () { refreshBalance(false) }, Number(bh.refreshMs) || 60000)
    setInterval(tick1s, Number(bh.taskPollMs) || 1000)
  }

  function tick1s() {
    pollLastTurn()
    pollTasks()
  }

  function pollLastTurn() {
    if (state.speech && state.speech.toggles && state.speech.toggles.turnCost === false) return
    apiFetch(API.lastTurn).then(function (data) {
      if (!data || !data.ok) return
      if (data.seq === 0) return
      if (state.lastSeq === 0) { state.lastSeq = data.seq; return } // 首轮只对齐
      if (data.seq > state.lastSeq) {
        state.lastSeq = data.seq
        if (state.prefs && state.prefs.turnCostOn === false) return
        onTurnEnd(data)
      }
    })
  }

  function onTurnEnd(data) {
    var reaction = data.reaction || 'happy'
    state.costBubbleActive = true
    setExpression(reaction, 3000)
    showCostBubble(data.amount)
    var closeMs = Number(state.prefs && state.prefs.turnCostCloseMs)
    if (!closeMs) closeMs = 0
    if (state.costCloseTimer) clearTimeout(state.costCloseTimer)
    if (closeMs > 0) {
      state.costCloseTimer = setTimeout(hideCostBubble, closeMs)
    }
  }

  function hideCostBubble() {
    state.costBubbleActive = false
    if (state.costCloseTimer) { clearTimeout(state.costCloseTimer); state.costCloseTimer = null }
    hideBubble()
    if (state.exprTimer) { clearTimeout(state.exprTimer); state.exprTimer = null }
    setExpression('default', 0)
  }

  // 任务轮询（含汇报）
  function pollTasks() {
    apiFetch(API.tasks).then(function (data) {
      if (!data || !data.ok || !Array.isArray(data.tasks)) return
      var now = Date.now()
      var selfExempt = function (id) { return state.selfTaskId === id && now - state.selfTaskAt < 2000 }
      for (var i = 0; i < data.tasks.length; i++) {
        var task = data.tasks[i]
        var prev = state.taskMap[task.id]
        if (prev !== undefined && prev !== task.status && !selfExempt(task.id)) {
          if (task.status === 'done') reportTask('taskDone', task)
          else if (task.status === 'failed') reportTask('taskFailed', task)
        }
        state.taskMap[task.id] = task.status
      }
      // 清理已删除任务
      var ids = {}
      for (var j = 0; j < data.tasks.length; j++) ids[data.tasks[j].id] = true
      for (var k in state.taskMap) { if (!ids[k]) delete state.taskMap[k] }
      // 是否有任务处于进行中（驱动行为三的 80% 出现概率）
      state.taskWorking = data.tasks.some(function (t) { return t.status === 'doing' })
    })
  }

  function reportTask(kind, task) {
    var lines = (state.config && state.config.reportLines) || FALLBACK.reportLines
    var tmpl = lines[kind] || (kind === 'taskDone' ? '完成啦！%title% 搞定~' : '%title% 失败了…')
    var text = String(tmpl).replace(/%title%/g, task.title)
    setExpression(kind === 'taskDone' ? 'happy' : 'surprised', 3000)
    showBubbleText([{ t: text, s: 'C', w: true }], 3000)
  }

  // -------------------------------------------------------------------------
  // ⑨ 气泡与台词
  // -------------------------------------------------------------------------
  function bubbleOpen() {
    return bubbleEl.classList.contains('rx-bubble-open')
  }

  function bubbleLines() {
    // 三行结构：label / amount / hint
    var bal = state.balance
    if (!bal) {
      // 余额还没加载到：占位（加载中/错误提示），不渲染空的时间段行
      if (state.balanceError) return [{ t: state.balanceError, s: 'C', w: true }]
      return [{ t: '加载中…', s: 'C' }]
    }
    var hintText = ''
    var period = ''
    if (bal.isPeak) period = '高峰时段'
    else period = '空闲时段'
    hintText = '今日已用 ' + fmtMoney(bal.todayUsage, bal.currency)
    var low = false
    var lowCfg = (state.config && state.config.reactions && state.config.reactions.balanceLow) || FALLBACK.reactions.balanceLow
    var lowOn = !(state.speech && state.speech.toggles && state.speech.toggles.balanceLow === false)
    if (lowOn && bal.ok && typeof bal.totalBalance === 'number' && bal.totalBalance < (Number(lowCfg.threshold) || 10)) {
      low = true
      hintText = lowCfg.line || '余额不多啦，省着点用~'
    }
    return [
      { t: '当前时间段为:', s: 'A' },
      { t: period, s: 'P', c: period === '高峰时段' ? '#ef4444' : '#22c55e' },
      { t: hintText, s: 'C', c: low ? '#ef4444' : undefined },
    ]
  }

  function showBubble(lines, ms, mode) {
    state.bubbleMode = mode || 'plain'
    clearBubbleTimer()
    textEl.innerHTML = ''
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      var cls = 'rx-' + (line.s === 'A' ? 'label' : line.s === 'B' ? 'amount' : line.s === 'P' ? 'period' : 'hint')
      if (line.w) cls += ' rx-wrap'
      var div = document.createElement('div')
      div.className = cls
      div.textContent = line.t
      if (line.c) div.style.color = line.c
      textEl.appendChild(div)
    }
    bubbleEl.classList.add('rx-bubble-open')
    if (ms) state.bubbleTimer = setTimeout(hideBubble, ms)
  }

  function showBubbleText(lines, ms) {
    showBubble(lines, ms)
  }

  function showBalanceBubble(switchToLine) {
    if (state.costBubbleActive) return
    if (bubbleOpen()) {
      // 首次点击切换台词，再点关闭
      if (switchToLine) {
        var line = pickRandomLines()
        if (line) {
          state.bubbleMode = 'line'
          swapBubbleLines(line)
          return
        }
      }
      hideBubble()
      return
    }
    // 先立刻显示（缓存内容或加载中占位），同时发起刷新；数据到达后 renderBalanceHint 更新内容
    showBubble(bubbleLines(), (state.behavior && state.behavior.bubbleMs) || 5000, 'balance')
    refreshBalance(false)
  }

  function swapBubbleLines(line) {
    // 淡出 -> 换内容 -> 淡入
    bubbleEl.style.transition = 'opacity .19s ease'
    bubbleEl.style.opacity = '0'
    setTimeout(function () {
      textEl.innerHTML = ''
      for (var i = 0; i < line.length; i++) {
        var l = line[i]
        var cls = 'rx-' + (l.s === 'A' ? 'label' : l.s === 'B' ? 'amount' : l.s === 'P' ? 'period' : 'hint')
        if (l.w) cls += ' rx-wrap'
        var div = document.createElement('div')
        div.className = cls
        div.textContent = l.t
        if (l.c) div.style.color = l.c
        textEl.appendChild(div)
      }
      bubbleEl.style.transition = 'opacity .22s ease'
      bubbleEl.style.opacity = '1'
    }, 190)
  }

  function hideBubble() {
    bubbleEl.classList.remove('rx-bubble-open')
    state.bubbleMode = 'none'
    clearBubbleTimer()
  }

  function clearBubbleTimer() {
    if (state.bubbleTimer) { clearTimeout(state.bubbleTimer); state.bubbleTimer = null }
  }

  function showCostBubble(amount) {
    showBubble([{ t: '上一轮对话消耗:', s: 'A' }, { t: fmtMoney(amount, 'CNY'), s: 'B', c: '#ef4444' }], 0, 'cost')
  }

  function pickRandomLines() {
    if (state.speech && state.speech.toggles && state.speech.toggles.randomLines === false) return null
    var lines = []
    var cfgLines = (state.config && state.config.lines) || []
    var custom = (state.speech && state.speech.customLines) || []
    for (var i = 0; i < cfgLines.length; i++) {
      if (cfgLines[i].template) continue
      if (cfgLines[i].items && cfgLines[i].items.length) lines.push({ weight: Number(cfgLines[i].weight) || 5, items: cfgLines[i].items })
    }
    for (var j = 0; j < custom.length; j++) {
      if (custom[j].items && custom[j].items.length) lines.push({ weight: Number(custom[j].weight) || 10, items: custom[j].items })
    }
    var group = pickWeighted(lines)
    if (!group) return null
    var item = group.items[randInt(0, group.items.length - 1)]
    return [{ t: item, s: 'A', w: true }]
  }

  function speakNow() {
    var line = pickRandomLines()
    if (line) {
      state.bubbleMode = 'line'
      showBubbleText(line, (state.behavior && state.behavior.bubbleMs) || 5000)
    } else {
      showBubbleText([{ t: '……', s: 'B' }], 1500)
    }
    setExpression('happy', 2000)
  }

  // -------------------------------------------------------------------------
  // ⑦ 右键菜单 + 设置面板
  // -------------------------------------------------------------------------
  function onContextMenu(e) {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY)
  }

  function openContextMenu(x, y) {
    var items = [
      { label: '💬 说话', fn: speakNow },
      { label: '📊 数据统计', fn: openDashboard },
      { label: '➕ 添加任务', fn: promptAddTask },
      { label: '⚙️ 设置', fn: openSettings },
    ]
    contextMenu.innerHTML = ''
    for (var i = 0; i < items.length; i++) {
      ;(function (item) {
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'rx-menu-item'
        btn.setAttribute('role', 'menuitem')
        btn.textContent = item.label
        btn.addEventListener('click', function () {
          closeContextMenu()
          item.fn()
        })
        contextMenu.appendChild(btn)
      })(items[i])
    }
    contextMenu.style.display = 'block'
    contextMenu.style.left = '0px'
    contextMenu.style.top = '0px'
    var r = contextMenu.getBoundingClientRect()
    var v = viewport()
    var px = clamp(x, 4, v.w - r.width - 4)
    var py = clamp(y, 4, v.h - r.height - 4)
    contextMenu.style.left = px + 'px'
    contextMenu.style.top = py + 'px'
    requestAnimationFrame(function () {
      contextMenu.classList.add('rx-menu-open')
    })
    state.menuOpen = true
  }

  function closeContextMenu() {
    contextMenu.classList.remove('rx-menu-open')
    contextMenu.style.display = 'none'
    state.menuOpen = false
  }

  function toast(text) {
    toastEl.textContent = text
    toastEl.classList.add('rx-toast-on')
    clearTimeout(toastEl._t)
    toastEl._t = setTimeout(function () { toastEl.classList.remove('rx-toast-on') }, 1800)
  }

  // ---- 设置面板 ----
  var settingsDialog = null
  var settingsTab = 'speech'

  function buildSettingsDialog() {
    if (settingsDialog) return settingsDialog
    settingsDialog = document.createElement('dialog')
    settingsDialog.className = 'rx-dialog'
    settingsDialog.id = 'rx-settings-dialog'
    settingsDialog.setAttribute('aria-labelledby', 'rx-settings-title')
    settingsDialog.innerHTML =
      '<div class="rx-dialog-head"><h3 id="rx-settings-title">Roxy 设置</h3><button type="button" class="rx-dialog-close" aria-label="关闭">✕</button></div>' +
      '<div class="rx-tabs">' +
      '<button type="button" class="rx-tab" data-tab="speech">说的话</button>' +
      '<button type="button" class="rx-tab" data-tab="images">图片</button>' +
      '<button type="button" class="rx-tab" data-tab="behavior">行为</button>' +
      '</div>' +
      '<div class="rx-panel" id="rx-settings-body"></div>'
    document.body.appendChild(settingsDialog)
    settingsDialog.querySelector('.rx-dialog-close').addEventListener('click', closeSettings)
    var tabs = settingsDialog.querySelectorAll('.rx-tab')
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        settingsTab = this.getAttribute('data-tab')
        renderSettingsTab()
      })
    }
    return settingsDialog
  }

  function openSettings() {
    buildSettingsDialog()
    renderSettingsTab()
    if (!settingsDialog.open) settingsDialog.showModal()
  }

  function closeSettings() {
    if (settingsDialog && settingsDialog.open) settingsDialog.close()
  }

  function renderSettingsTab() {
    if (!settingsDialog) return
    var tabs = settingsDialog.querySelectorAll('.rx-tab')
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('rx-tab-active', tabs[i].getAttribute('data-tab') === settingsTab)
    }
    var body = settingsDialog.querySelector('#rx-settings-body')
    if (settingsTab === 'speech') body.innerHTML = tabSpeechHtml()
    else if (settingsTab === 'images') body.innerHTML = tabImagesHtml()
    else body.innerHTML = tabBehaviorHtml()
    bindSettingsTab()
  }

  function tabSpeechHtml() {
    var toggles = (state.speech && state.speech.toggles) || FALLBACK.speech.toggles
    var custom = (state.speech && state.speech.customLines) || []
    var customHtml = ''
    for (var i = 0; i < custom.length; i++) {
      customHtml +=
        '<div class="rx-row" data-custom-group="' + i + '">' +
        '<input type="number" class="rx-number" min="1" max="50" value="' + (Number(custom[i].weight) || 10) + '" data-weight="' + i + '" title="权重">' +
        '<textarea style="flex:1;min-width:160px;border:1px solid rgba(32,49,112,.35);border-radius:6px;padding:4px 6px;font-size:12px;color:#203170;background:#fff;resize:vertical" rows="2" data-items="' + i + '" placeholder="每行一条台词">' + esc((custom[i].items || []).join('\n')) + '</textarea>' +
        '<button type="button" class="rx-task-del" data-del-group="' + i + '" title="删除该组">✕</button>' +
        '</div>'
    }
    return (
      '<div class="rx-row"><label>随机台词</label><input type="checkbox" class="rx-check" data-toggle="randomLines" ' + (toggles.randomLines === false ? '' : 'checked') + '></div>' +
      '<div class="rx-row"><label>每轮消耗提醒</label><input type="checkbox" class="rx-check" data-toggle="turnCost" ' + (toggles.turnCost === false ? '' : 'checked') + '></div>' +
      '<div class="rx-row"><label>余额低提醒</label><input type="checkbox" class="rx-check" data-toggle="balanceLow" ' + (toggles.balanceLow === false ? '' : 'checked') + '></div>' +
      '<div class="rx-sep"></div>' +
      '<div style="font-size:13px;font-weight:700;margin:6px 0">自定义台词（每行一条）</div>' +
      '<div id="rx-custom-lines">' + (customHtml || '<div style="font-size:12px;color:#94a3b8">还没有自定义台词</div>') + '</div>' +
      '<div class="rx-row"><button type="button" class="rx-btn" id="rx-add-line-group">+ 新增台词组</button></div>' +
      '<div class="rx-row"><button type="button" class="rx-btn rx-btn-primary" id="rx-save-speech">保存</button></div>'
    )
  }

  function tabImagesHtml() {
    var expr = state.expressions || FALLBACK.expressions
    var slots = ''
    for (var i = 0; i < EXPR_KEYS.length; i++) {
      var key = EXPR_KEYS[i]
      var v = expr[key] || ''
      var isUser = v.indexOf('user-image/') === 0
      var preview = isUser ? API.userImage + '?name=' + encodeURIComponent(v.slice('user-image/'.length)) : API.image + encodeURIComponent(v)
      slots +=
        '<div class="rx-slot">' +
        '<img src="' + preview + '" alt="' + esc(EXPR_LABELS[key]) + '" loading="lazy">' +
        '<div class="rx-slot-name">' + EXPR_LABELS[key] + '</div>' +
        '<div class="rx-slot-src">' + (isUser ? '自定义' : '默认') + '</div>' +
        '<button type="button" class="rx-btn" style="width:100%;margin-bottom:4px" data-upload-slot="' + key + '">上传</button>' +
        '<button type="button" class="rx-btn" style="width:100%;margin-bottom:4px" data-preview-slot="' + key + '">预览</button>' +
        (isUser ? '<button type="button" class="rx-btn" style="width:100%" data-del-slot="' + key + '" data-name="' + esc(v.slice('user-image/'.length)) + '">恢复默认</button>' : '') +
        '</div>'
    }
    return (
      '<div style="font-size:13px;font-weight:700;margin-bottom:4px">表情槽位（点击上传替换）</div>' +
      '<div class="rx-slot-grid">' + slots + '</div>' +
      '<div style="font-size:11px;color:#94a3b8">支持 PNG / JPEG / WebP，≤2MB，透明背景效果最佳。上传图保存在本机，不会随插件更新丢失。</div>' +
      '<div class="rx-row"><button type="button" class="rx-btn" id="rx-restore-all-images">全部恢复默认</button></div>' +
      '<input type="file" id="rx-file-input" accept="image/png,image/jpeg,image/webp" style="display:none">'
    )
  }

  function tabBehaviorHtml() {
    var p = state.prefs || FALLBACK.prefs
    var bh = state.behavior || FALLBACK.behavior
    return (
      '<div class="rx-row"><label>大小</label><input type="range" class="rx-range" id="rx-scale-range" min="0.6" max="2.5" step="0.1" value="' + (Number(p.scale) || 1) + '"><input type="number" class="rx-number" id="rx-scale-num" min="1" max="20" value="' + (Math.round(((Number(p.scale) || 1) - 0.6) / 0.1) + 1) + '"></div>' +
      '<div class="rx-row"><label>位置</label><select class="rx-number" style="width:auto" id="rx-corner">' +
      '<option value="bottom-right"' + (p.corner === 'bottom-right' ? ' selected' : '') + '>右下</option>' +
      '<option value="bottom-left"' + (p.corner === 'bottom-left' ? ' selected' : '') + '>左下</option>' +
      '<option value="top-right"' + (p.corner === 'top-right' ? ' selected' : '') + '>右上</option>' +
      '<option value="top-left"' + (p.corner === 'top-left' ? ' selected' : '') + '>左上</option>' +
      '</select>' +
      '<button type="button" class="rx-btn" id="rx-reset-pos">恢复默认位置</button></div>' +
      '<div class="rx-row"><label>表情动画</label><input type="checkbox" class="rx-check" id="rx-beh-anim" ' + (p.animationOn === false ? '' : 'checked') + '></div>' +
      '<div class="rx-row"><label>左吸附镜像</label><input type="checkbox" class="rx-check" id="rx-beh-mirror" ' + (p.mirrorOnLeft ? 'checked' : '') + '></div>' +
      '<div class="rx-row"><label>消耗表情反应</label><input type="checkbox" class="rx-check" id="rx-beh-turn" ' + (p.turnCostOn === false ? '' : 'checked') + '></div>' +
      '<div class="rx-row"><label>犯困频率</label><select class="rx-number" style="width:auto" id="rx-beh-sleepy">' +
      '<option value="low"' + (Number(bh.sleepyChance) <= 0.1 ? ' selected' : '') + '>低</option>' +
      '<option value="mid"' + (Number(bh.sleepyChance) > 0.1 && Number(bh.sleepyChance) <= 0.3 ? ' selected' : '') + '>中</option>' +
      '<option value="high"' + (Number(bh.sleepyChance) > 0.3 ? ' selected' : '') + '>高</option>' +
      '</select></div>' +
      '<div class="rx-row"><button type="button" class="rx-btn rx-btn-primary" id="rx-save-behavior">保存</button></div>'
    )
  }

  function bindSettingsTab() {
    if (!settingsDialog) return
    var body = settingsDialog.querySelector('#rx-settings-body')
    if (settingsTab === 'speech') {
      body.querySelector('#rx-add-line-group').addEventListener('click', function () {
        state.speech.customLines = state.speech.customLines || []
        state.speech.customLines.push({ group: 'custom', weight: 10, items: ['新台词'] })
        renderSettingsTab()
      })
      body.querySelector('#rx-save-speech').addEventListener('click', saveSpeechTab)
      var delBtns = body.querySelectorAll('[data-del-group]')
      for (var i = 0; i < delBtns.length; i++) {
        delBtns[i].addEventListener('click', function () {
          var idx = Number(this.getAttribute('data-del-group'))
          state.speech.customLines.splice(idx, 1)
          renderSettingsTab()
        })
      }
    } else if (settingsTab === 'images') {
      var uploadBtns = body.querySelectorAll('[data-upload-slot]')
      for (var j = 0; j < uploadBtns.length; j++) {
        uploadBtns[j].addEventListener('click', function () {
          startUpload(this.getAttribute('data-upload-slot'))
        })
      }
      var delBtns2 = body.querySelectorAll('[data-del-slot]')
      for (var k = 0; k < delBtns2.length; k++) {
        delBtns2[k].addEventListener('click', function () {
          deleteUserImage(this.getAttribute('data-name'))
        })
      }
      // 预览：关掉面板，宠物切换到该表情 3 秒，方便查看每张图的实际效果
      var previewBtns = body.querySelectorAll('[data-preview-slot]')
      for (var m = 0; m < previewBtns.length; m++) {
        previewBtns[m].addEventListener('click', function () {
          var slot = this.getAttribute('data-preview-slot')
          closeSettings()
          setExpression(slot, 3000)
          toast('预览「' + (EXPR_LABELS[slot] || slot) + '」')
        })
      }
      body.querySelector('#rx-restore-all-images').addEventListener('click', restoreAllImages)
    } else {
      var range = body.querySelector('#rx-scale-range')
      var num = body.querySelector('#rx-scale-num')
      range.addEventListener('input', function () {
        root.style.setProperty('--rx-scale', range.value)
        num.value = Math.round((Number(range.value) - 0.6) / 0.1) + 1
        state.prefs.scale = Number(range.value)
        applyScale(Number(range.value))
      })
      num.addEventListener('change', function () {
        var scale = clamp(0.6 + (Number(num.value) - 1) * 0.1, 0.6, 2.5)
        range.value = String(scale)
        state.prefs.scale = scale
        applyScale(scale)
      })
      body.querySelector('#rx-reset-pos').addEventListener('click', function () {
        place(state.prefs.corner || 'bottom-right')
        toast('位置已恢复')
      })
      body.querySelector('#rx-save-behavior').addEventListener('click', saveBehaviorTab)
    }
  }

  function saveSpeechTab() {
    var body = settingsDialog.querySelector('#rx-settings-body')
    var toggles = (state.speech && state.speech.toggles) || {}
    var toggleEls = body.querySelectorAll('[data-toggle]')
    for (var i = 0; i < toggleEls.length; i++) {
      toggles[toggleEls[i].getAttribute('data-toggle')] = toggleEls[i].checked
    }
    var groups = body.querySelectorAll('[data-custom-group]')
    var custom = []
    for (var j = 0; j < groups.length; j++) {
      var weight = Number((groups[j].querySelector('[data-weight]') || {}).value) || 10
      var itemsText = String((groups[j].querySelector('[data-items]') || {}).value || '')
      var items = itemsText.split('\n').map(function (s) { return s.trim() }).filter(Boolean)
      if (items.length) custom.push({ group: 'custom', weight: clamp(weight, 1, 50), items: items })
    }
    state.speech.customLines = custom
    apiFetch(API.prefs, { method: 'PUT', body: JSON.stringify({ speech: state.speech }) }).then(function (r) {
      toast(r && r.ok ? '台词设置已保存' : '保存失败')
    })
    state.speech.toggles = toggles
  }

  function saveBehaviorTab() {
    var body = settingsDialog.querySelector('#rx-settings-body')
    var p = state.prefs
    p.animationOn = body.querySelector('#rx-beh-anim').checked
    p.mirrorOnLeft = body.querySelector('#rx-beh-mirror').checked
    p.turnCostOn = body.querySelector('#rx-beh-turn').checked
    p.corner = body.querySelector('#rx-corner').value
    var sleepy = body.querySelector('#rx-beh-sleepy').value
    state.behavior.sleepyChance = sleepy === 'low' ? 0.05 : sleepy === 'high' ? 0.6 : 0.3
    applyBehaviorPrefs()
    place(p.corner)
    apiFetch(API.prefs, { method: 'PUT', body: JSON.stringify({ prefs: p, behavior: state.behavior }) }).then(function (r) {
      toast(r && r.ok ? '行为设置已保存' : '保存失败')
    })
  }

  function applyBehaviorPrefs() {
    var p = state.prefs || {}
    root.classList.toggle('rx-anim', p.animationOn !== false && !reducedMotion)
    applyMirror()
    if (p.animationOn === false || reducedMotion) {
      stopAllBehavior()
    } else {
      startIdleTimers()
    }
  }

  // ---- 图片上传 ----
  var fileInput = null
  var pendingUploadSlot = null // 每次点击上传时记录目标槽位（change 回调复用共享 input，必须读这个而非闭包旧值）

  function startUpload(slot) {
    pendingUploadSlot = slot
    if (!fileInput) {
      fileInput = document.createElement('input')
      fileInput.type = 'file'
      fileInput.accept = 'image/png,image/jpeg,image/webp'
      fileInput.style.display = 'none'
      document.body.appendChild(fileInput)
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0]
        fileInput.value = ''
        if (!file) return
        if (file.size > 2 * 1024 * 1024) {
          toast('图片超过 2MB 限制')
          return
        }
        var reader = new FileReader()
        reader.onload = function () {
          var dataUrl = String(reader.result || '')
          // 正确解析 dataURL 的 mime（取 "data:" 后到第一个 ";" 之间的部分，避免带上 ";base64" 后缀）
          var m = /^data:([^;,]+)/.exec(dataUrl)
          var mime = m ? m[1] : 'image/png'
          var comma = dataUrl.indexOf(',')
          var base64 = comma > 0 ? dataUrl.slice(comma + 1) : ''
          uploadImage(pendingUploadSlot, mime, base64)
        }
        reader.onerror = function () { toast('读取文件失败') }
        reader.readAsDataURL(file)
      })
    }
    fileInput.click()
  }

  function uploadImage(slot, mime, base64) {
    toast('上传中…')
    apiFetch(API.userImage, { method: 'POST', body: JSON.stringify({ slot: slot, mime: mime, data: base64 }), timeout: 30000 }).then(function (r) {
      if (r && r.ok) {
        state.expressions = state.expressions || {}
        state.expressions[slot] = 'user-image/' + r.fileName
        toast('已更新「' + (EXPR_LABELS[slot] || slot) + '」表情')
        renderSettingsTab()
        if (state.expr === slot) setExpression(slot, 0)
      } else {
        toast('上传失败: ' + ((r && (r.error || r.code)) || '未知错误'))
      }
    })
  }

  function deleteUserImage(name) {
    apiFetch(API.userImage + '?name=' + encodeURIComponent(name), { method: 'DELETE' }).then(function (r) {
      if (r && r.ok) {
        // 重新拉配置，回落默认图
        loadConfig().then(function () {
          toast('已恢复默认表情')
          renderSettingsTab()
        })
      } else {
        toast('删除失败')
      }
    })
  }

  function restoreAllImages() {
    var names = []
    var expr = state.expressions || {}
    for (var i = 0; i < EXPR_KEYS.length; i++) {
      var v = expr[EXPR_KEYS[i]] || ''
      if (v.indexOf('user-image/') === 0) names.push(v.slice('user-image/'.length))
    }
    var chain = Promise.resolve()
    for (var j = 0; j < names.length; j++) {
      ;(function (n) {
        chain = chain.then(function () { return apiFetch(API.userImage + '?name=' + encodeURIComponent(n), { method: 'DELETE' }) })
      })(names[j])
    }
    chain.then(function () {
      return loadConfig()
    }).then(function () {
      toast('已全部恢复默认')
      renderSettingsTab()
    })
  }

  // -------------------------------------------------------------------------
  // ⑧ 统计 Dashboard
  // -------------------------------------------------------------------------
  var dashboardDialog = null
  var dashboardTimer = null

  function buildDashboardDialog() {
    if (dashboardDialog) return dashboardDialog
    dashboardDialog = document.createElement('dialog')
    dashboardDialog.className = 'rx-dialog'
    dashboardDialog.setAttribute('aria-labelledby', 'rx-dash-title')
    dashboardDialog.innerHTML =
      '<div class="rx-dialog-head"><h3 id="rx-dash-title">Roxy 的数据统计</h3><button type="button" class="rx-dialog-close" aria-label="关闭">✕</button></div>' +
      '<div class="rx-panel" id="rx-dash-body"></div>'
    document.body.appendChild(dashboardDialog)
    dashboardDialog.querySelector('.rx-dialog-close').addEventListener('click', closeDashboard)
    return dashboardDialog
  }

  function openDashboard() {
    buildDashboardDialog()
    if (!dashboardDialog.open) dashboardDialog.showModal()
    refreshDashboard()
    if (dashboardTimer) clearInterval(dashboardTimer)
    dashboardTimer = setInterval(refreshDashboard, 5000)
    dashboardDialog.addEventListener('close', function () {
      if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null }
    }, { once: true })
  }

  function closeDashboard() {
    if (dashboardDialog && dashboardDialog.open) dashboardDialog.close()
    if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null }
  }

  function refreshDashboard() {
    apiFetch(API.tasks).then(function (data) {
      if (!data || !data.ok) return
      var body = document.getElementById('rx-dash-body')
      if (!body) return
      // 用户在输入时不重绘，避免打断打字
      var active = document.activeElement
      if (active && body.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(active.tagName) !== -1) return
      var stats = data.today || { total: 0, done: 0, doing: 0, failed: 0 }
      var trend = data.trend || []
      var tasks = data.tasks || []
      body.innerHTML =
        '<div style="font-size:12px;color:#64748b;margin-bottom:2px">' + localDateKey() + '</div>' +
        '<div class="rx-stats-grid">' +
        statCard('今日任务', stats.total, '#3B82F6', stats.total ? '100%' : '—') +
        statCard('已完成', stats.done, '#22C55E', stats.total ? Math.round(stats.done / stats.total * 100) + '%' : '—') +
        statCard('进行中', stats.doing, '#06B6D4', stats.total ? Math.round(stats.doing / stats.total * 100) + '%' : '—') +
        statCard('失败', stats.failed, '#EF4444', stats.total ? Math.round(stats.failed / stats.total * 100) + '%' : '—') +
        '</div>' +
        donutHtml(stats) +
        trendHtml(trend) +
        usageCard() +
        taskListHtml(tasks)
      bindTaskList(body)
    })
  }

  function statCard(label, value, color, pct) {
    return '<div class="rx-stat"><b style="color:' + color + '">' + Number(value || 0) + '</b><span>' + label + '</span><div style="font-size:10px;color:#94a3b8">' + pct + '</div></div>'
  }

  function donutHtml(stats) {
    var total = Math.max(1, Number(stats.total) || 0)
    var done = Number(stats.done) || 0
    var doing = Number(stats.doing) || 0
    var failed = Number(stats.failed) || 0
    var todo = Math.max(0, total - done - doing - failed)
    var C = 2 * Math.PI * 45
    var segs = []
    var offset = 0
    var add = function (value, color) {
      if (value <= 0) return
      var frac = value / total
      var len = frac * C
      segs.push('<circle cx="60" cy="60" r="45" fill="none" stroke="' + color + '" stroke-width="18" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '" stroke-linecap="butt"/>')
      offset += len
    }
    add(done, '#22C55E')
    add(doing, '#06B6D4')
    add(failed, '#EF4444')
    add(todo, '#E2E8F0')
    if (!segs.length) segs.push('<circle cx="60" cy="60" r="45" fill="none" stroke="#E2E8F0" stroke-width="18"/>')
    return (
      '<div class="rx-donut-wrap">' +
      '<div class="rx-donut" role="img" aria-label="任务状态占比">' +
      '<svg viewBox="0 0 120 120">' + segs.join('') + '</svg>' +
      '<div class="rx-donut-center"><b>' + (Number(stats.total) || 0) + '</b>今日任务</div>' +
      '</div>' +
      '<div class="rx-legend">' +
      '<div><span class="rx-dot" style="background:#22C55E"></span>已完成 ' + done + '</div>' +
      '<div><span class="rx-dot" style="background:#06B6D4"></span>进行中 ' + doing + '</div>' +
      '<div><span class="rx-dot" style="background:#EF4444"></span>失败 ' + failed + '</div>' +
      '<div><span class="rx-dot" style="background:#E2E8F0"></span>待开始 ' + todo + '</div>' +
      '</div>' +
      '</div>' +
      (Number(stats.total) === 0 ? '<div style="font-size:12px;color:#94a3b8">今天还没有任务，右键 Roxy 添加一个吧</div>' : '')
    )
  }

  function trendHtml(trend) {
    if (!trend || !trend.length) return ''
    var html = '<div style="font-size:13px;font-weight:700;margin:12px 0 6px">最近 7 天</div>'
    var today = localDateKey()
    for (var i = 0; i < trend.length; i++) {
      var t = trend[i]
      var total = Math.max(1, Number(t.total) || 0)
      var dw = (Number(t.done) || 0) / total * 100
      var dgw = (Number(t.doing) || 0) / total * 100
      var fw = (Number(t.failed) || 0) / total * 100
      var label = t.date === today ? '今天' : String(t.date).slice(5)
      html +=
        '<div class="rx-trend-row"><span style="width:34px;' + (t.date === today ? 'font-weight:700;color:#203170;text-decoration:underline' : '') + '">' + label + '</span>' +
        '<div class="rx-trend-bar" title="' + esc(t.date) + ' 完成 ' + (Number(t.done) || 0) + ' · 进行中 ' + (Number(t.doing) || 0) + ' · 失败 ' + (Number(t.failed) || 0) + '">' +
        (dw > 0 ? '<i style="width:' + dw.toFixed(1) + '%;background:#22C55E"></i>' : '') +
        (dgw > 0 ? '<i style="width:' + dgw.toFixed(1) + '%;background:#06B6D4"></i>' : '') +
        (fw > 0 ? '<i style="width:' + fw.toFixed(1) + '%;background:#EF4444"></i>' : '') +
        '</div><span style="width:22px;text-align:right">' + (Number(t.total) || 0) + '</span></div>'
    }
    return html
  }

  function usageCard() {
    var bal = state.balance
    if (!bal) return ''
    return (
      '<div style="font-size:13px;font-weight:700;margin:12px 0 6px">使用概览</div>' +
      '<div class="rx-stats-grid" style="grid-template-columns:repeat(3,1fr)">' +
      '<div class="rx-stat"><b style="font-size:20px">' + fmtMoney(bal.totalBalance, bal.currency) + '</b><span>余额</span></div>' +
      '<div class="rx-stat"><b style="font-size:20px">' + fmtMoney(bal.todayUsage, bal.currency) + '</b><span>今日已用</span></div>' +
      '<div class="rx-stat"><b style="font-size:20px;color:' + (bal.isPeak ? '#ef4444' : '#22c55e') + '">' + (bal.isPeak ? '高峰' : '空闲') + '</b><span>当前时段</span></div>' +
      '</div>'
    )
  }

  function taskListHtml(tasks) {
    var today = localDateKey()
    var todayTasks = tasks.filter(function (t) { return t.date === today })
    var html = '<div style="font-size:13px;font-weight:700;margin:12px 0 6px">今日任务</div>'
    html += '<div class="rx-add-task"><input type="text" id="rx-new-task" maxlength="80" placeholder="添加一个任务，回车确认"><button type="button" class="rx-btn rx-btn-primary" id="rx-add-task-btn">添加</button></div>'
    if (!todayTasks.length) {
      html += '<div style="font-size:12px;color:#94a3b8;padding:4px 0">今天还没有任务</div>'
    } else {
      html += '<div class="rx-task-list">'
      for (var i = 0; i < todayTasks.length; i++) {
        var t = todayTasks[i]
        var dotColor = t.status === 'done' ? '#22C55E' : t.status === 'doing' ? '#06B6D4' : t.status === 'failed' ? '#EF4444' : '#94A3B8'
        var strike = t.status === 'done' ? ' style="text-decoration:line-through;color:#94a3b8"' : ''
        html +=
          '<div class="rx-task" data-id="' + esc(t.id) + '">' +
          '<span class="rx-dot" style="background:' + dotColor + ';flex:0 0 auto"></span>' +
          '<span class="rx-task-title"' + strike + '>' + esc(t.title) + '</span>' +
          (t.source === 'host' ? '<span style="font-size:10px;color:#94a3b8" title="宿主任务">⌁</span>' : '') +
          '<button type="button" class="rx-task-btn" data-action="done" title="标记完成">✓</button>' +
          '<button type="button" class="rx-task-btn" data-action="doing" title="标记进行中">▶</button>' +
          '<button type="button" class="rx-task-btn" data-action="failed" title="标记失败">✗</button>' +
          '<button type="button" class="rx-task-del" data-action="delete" title="删除">×</button>' +
          '</div>'
      }
      html += '</div>'
    }
    return html
  }

  function bindTaskList(container) {
    var addBtn = container.querySelector('#rx-add-task-btn')
    var input = container.querySelector('#rx-new-task')
    var doAdd = function () {
      var title = (input.value || '').trim()
      if (!title) return
      addTask(title)
      input.value = ''
    }
    if (addBtn) addBtn.addEventListener('click', doAdd)
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd() })
    var rows = container.querySelectorAll('.rx-task')
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]')
        if (!btn) return
        var id = this.getAttribute('data-id')
        var action = btn.getAttribute('data-action')
        if (action === 'delete') deleteTask(id)
        else setTaskStatus(id, action)
      })
    }
  }

  function addTask(title) {
    apiFetch(API.tasks, { method: 'POST', body: JSON.stringify({ title: title }) }).then(function (r) {
      if (r && r.ok) {
        state.taskMap[r.task.id] = r.task.status
        toast('记下了：' + r.task.title)
        refreshDashboard()
      } else {
        toast('添加失败: ' + ((r && r.error) || '未知错误'))
      }
    })
  }

  function setTaskStatus(id, status) {
    state.selfTaskId = id
    state.selfTaskAt = Date.now()
    apiFetch(API.tasks + '?id=' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status: status }) }).then(function (r) {
      if (r && r.ok) {
        state.taskMap[id] = status
        refreshDashboard()
      } else {
        toast('更新失败')
      }
    })
  }

  function deleteTask(id) {
    apiFetch(API.tasks + '?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
      if (r && r.ok) {
        delete state.taskMap[id]
        refreshDashboard()
      } else {
        toast('删除失败')
      }
    })
  }

  function promptAddTask() {
    // 便签样式的快捷添加（黄色便签 + 胶带 + 轻微旋转，贴在宠物上方）
    if (!promptAddTask.note) {
      var note = document.createElement('div')
      note.className = 'rx-note'
      note.innerHTML =
        '<input type="text" id="rx-note-input" maxlength="80" placeholder="写个任务…">' +
        '<div class="rx-note-actions"><button type="button" id="rx-note-cancel">取消</button><button type="button" class="rx-note-add" id="rx-note-add">贴上</button></div>'
      document.body.appendChild(note)
      var input = note.querySelector('#rx-note-input')
      var onNoteOutside = function (e) {
        if (note.parentNode && !note.contains(e.target)) close()
      }
      var close = function () {
        document.removeEventListener('pointerdown', onNoteOutside, true)
        note.remove()
        promptAddTask.note = null
        promptAddTask.input = null
      }
      var add = function () {
        var title = (input.value || '').trim()
        if (title) addTask(title)
        close()
      }
      note.querySelector('#rx-note-cancel').addEventListener('click', close)
      note.querySelector('#rx-note-add').addEventListener('click', add)
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') add()
        else if (e.key === 'Escape') close()
      })
      // 点击便签以外位置关闭
      document.addEventListener('pointerdown', onNoteOutside, true)
      promptAddTask.note = note
      promptAddTask.input = input
    }
    // 定位在宠物上方
    var r = root.getBoundingClientRect()
    var v = viewport()
    var note = promptAddTask.note
    var nw = note.offsetWidth || 250
    var nh = note.offsetHeight || 108
    var nx = clamp(r.left + r.width / 2 - nw / 2, 8, Math.max(8, v.w - nw - 8))
    var ny = Math.max(8, r.top - nh - 10)
    note.style.left = nx + 'px'
    note.style.top = ny + 'px'
    note.style.display = 'block'
    promptAddTask.input.value = ''
    setTimeout(function () { promptAddTask.input.focus() }, 0)
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function loadConfig() {
    return apiFetch(API.config).then(function (data) {
      var cfg = (data && data.config) ? data.config : {}
      state.config = cfg
      state.expressions = deepMerge(FALLBACK.expressions, cfg.expressions || {})
      state.prefs = deepMerge(FALLBACK.prefs, cfg.prefs || {})
      state.behavior = deepMerge(FALLBACK.behavior, cfg.behavior || {})
      state.speech = deepMerge(FALLBACK.speech, cfg.speech || {})
      return data
    })
  }

  function init() {
    buildDom()
    loadConfig().then(function () {
      applyBehaviorPrefs()
      place((state.prefs && state.prefs.corner) || 'bottom-right')
      applyScale(Number(state.prefs.scale) || 1)
      setExpression('default', 0)
      refreshBalance(true)
      startIntervals()
    }).catch(function () {
      // 配置失败：用兜底继续
      state.expressions = FALLBACK.expressions
      state.prefs = FALLBACK.prefs
      state.behavior = FALLBACK.behavior
      state.speech = FALLBACK.speech
      applyBehaviorPrefs()
      place('bottom-right')
      setExpression('default', 0)
      refreshBalance(true)
      startIntervals()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
