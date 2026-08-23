// v6.4.2 桌宠渲染进程逻辑
// - css 渲染器（内置兜底，v6.1 行为保留）
// - video 渲染器（dsh-pet 素材：双缓冲 <video> + 权重动画链 + 朝向镜像 + 桌面漫游）
// 状态规则与 src/pet/state-machine.ts 保持一致；纯选择/几何逻辑在 chain.js（PetChain）。
(function () {
  const petEl = document.getElementById('pet');
  const bubble = document.getElementById('bubble');
  let state = 'idle';
  let bubbleTimer = null;
  let down = null, rafId = 0;
  let pos = { x: window.screenX, y: window.screenY };

  // ================= 皮肤/渲染器状态 =================
  let skin = null;                       // { renderer, manifest, baseUrl }
  let vstage = null;                     // video 舞台（动态创建）
  const V = {                            // video 引擎状态
    elA: null, elB: null, front: 0, gen: 0, ft: null,
    current: '', overlay: false, facing: 'left',
    moveBusy: false, moveToken: 0, moveRaf: null, pendingMove: null,
  };

  // video 舞台样式（动态注入，避免改 pet.css）
  const VCSS = '' +
    '#vstage{position:absolute;left:0;right:0;bottom:0;height:180px;display:none;pointer-events:none;overflow:hidden}' +
    '#vstage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .18s ease;pointer-events:none}' +
    '#vstage video.is-front{opacity:1}';

  const TEXTS = {
    idle: ['摸鱼中…', '盯——', '需要帮忙吗？'],
    click: ['嘿！', '干嘛戳我~', '(*￣︶￣)'],
    wake: ['哈…醒了', '嗯？怎么了？'],
    sleep: ['Zzz…', '呼……'],
    working: ['认真工作中…', '别打扰我！'],
    progress: ['正在处理 ({pct})…', '快了快了…'],
    done: ['搞定啦！', '任务完成！'],
    error: ['失败了…看下日志？', '呜…出错了'],
    absorb: ['我先揣兜里啦', '收工！'],
    release: ['回来啦！', '好久不见~'],
  };
  const EMOJIS = { click: ['👀', '✨'], happy: ['🎉'], sad: ['💧'], working: ['💦'] };

  function setState(name) { state = name; if (!(skin && skin.renderer === 'video')) petEl.className = 'pet pet-' + name; }
  function showBubble(text) {
    bubble.textContent = text;
    bubble.classList.remove('hidden');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), 2600);
  }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function say(kind, opts) {
    const t = pick(TEXTS[kind] || []);
    let text = t;
    if (opts && opts.pct != null && kind === 'progress') text = String(text).replace('{pct}', opts.pct);
    const em = (EMOJIS[kind] || []).length ? pick(EMOJIS[kind]) : '';
    showBubble(em ? text + ' ' + em : text);
  }

  // ================= video 引擎（dsh-pet 动画链移植） =================
  function playVideo(name, once) {
    if (!name) return;
    const next = V.front === 0 ? V.elB : V.elA;
    const url = skin.baseUrl + encodeURIComponent(name) + '.webm';
    const gen = ++V.gen;
    V.current = name;
    next.src = url;
    next.loop = false;                       // 链与覆盖态都靠 onended 驱动
    next.muted = true; next.autoplay = true; next.playsInline = true;
    next.onloadeddata = () => {
      if (gen !== V.gen) return;
      const old = V.front === 0 ? V.elA : V.elB;
      next.classList.add('is-front');
      if (old && old !== next) old.classList.remove('is-front');
      V.front = 1 - V.front;
      next.style.transform = V.facing === 'right' ? 'scaleX(-1)' : '';
      next.play().catch(() => {});
      if (V.pendingMove) startMoveDrive(next);
    };
    next.onerror = () => { if (gen === V.gen) setTimeout(() => { if (gen === V.gen) onAnimEnded(); }, 1500); };  // A2：素材失败跳过
    next.onended = () => { if (gen === V.gen) onAnimEnded(); };
    next.load();
    clearTimeout(V.ft);
    V.ft = setTimeout(() => { if (gen === V.gen && V.current === name) onAnimEnded(); }, 10000);   // A2：10s 超时强切
  }
  function onAnimEnded() {
    if (V.overlay) { V.overlay = false; V.pendingMove = null; pickNext(); return; }
    const a = (skin.manifest.animations) || {};
    if ((a.turn || []).includes(V.current)) flipFacing();   // 转向动画播完翻转朝向
    pickNext();
  }
  function flipFacing() { V.facing = V.facing === 'left' ? 'right' : 'left'; }
  function pickNext() {
    const m = skin.manifest;
    const a = m.animations || {};
    const w = m.animationWeights || { idle: 10, turn: 5, move: 5 };
    const k = PetChain.rollKind(Math.random(), w);
    if (k === 'idle') playVideo(PetChain.pick(a.idle || [], V.current), false);
    else if (k === 'turn') playVideo(PetChain.pick(a.turn || [], V.current), false);
    else if (k === 'move') { if (!tryMove()) { const act = PetChain.pickCategoryAction(a.categories || [], a.idle || [], V.facing, V.current); playVideo(act.name, false); } }
    else { const act = PetChain.pickCategoryAction(a.categories || [], a.idle || [], V.facing, V.current); playVideo(act.name, false); }
  }
  // 桌面漫游：窗口级位移（dsh-pet 页面内漫游 → 我们的窗口移动；屏幕 workArea 由主进程提供）
  function tryMove() {
    if (V.moveBusy || V.pendingMove) return true;
    const m = skin.manifest.animations.moves;
    if (!m || !Array.isArray(m.actions) || !m.actions.length) return false;
    const chosen = m.actions[Math.floor(Math.random() * m.actions.length)];
    const mp = Object.assign({ minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, m.default || {}, chosen.params || {});
    const dir = V.facing === 'right' ? 1 : -1;
    V.moveBusy = true;
    Promise.all([petApi.getBounds(), petApi.screen()]).then(([b, wa]) => {
      V.moveBusy = false;
      if (!b || !wa) return;
      const halfW = b.width / 2;
      const plan = PetChain.planMove({
        cx: b.x + halfW - wa.x, cy: b.y + b.height / 2 - wa.y,
        W: wa.width, H: wa.height, dir,
        minDist: mp.minDist, maxDist: mp.maxDist, margin: mp.margin, halfW,
      });
      if (!plan) {
        const act = PetChain.pickCategoryAction(skin.manifest.animations.categories || [], skin.manifest.animations.idle || [], V.facing, V.current);
        playVideo(act.name, false);
        return;
      }
      V.pendingMove = {
        plan, startX: b.x, startY: b.y,
        targetX: wa.x + plan.targetRatio * wa.width - halfW,
        leadSec: mp.leadSec, tailSec: mp.tailSec,
      };
      V.overlay = true;
      playVideo(chosen.name, true);
    }).catch(() => { V.moveBusy = false; });
    return true;
  }
  function startMoveDrive(el) {
    const pm = V.pendingMove;
    if (!pm || V.moveRaf !== null) return;
    V.pendingMove = null;
    const token = ++V.moveToken;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10;
    const travelWindow = Math.max(0.1, duration - pm.leadSec - pm.tailSec);
    const step = () => {
      if (V.moveToken !== token) return;
      const t = el.currentTime || 0;
      let x;
      if (t <= pm.leadSec) x = pm.startX;
      else if (t >= duration - pm.tailSec) x = pm.targetX;
      else x = pm.startX + (pm.targetX - pm.startX) * ((t - pm.leadSec) / travelWindow);
      petApi.move(Math.round(x), Math.round(pm.startY));
      if (t < duration - pm.tailSec) V.moveRaf = requestAnimationFrame(step);
      else V.moveRaf = null;
    };
    V.moveRaf = requestAnimationFrame(step);
  }
  function cancelMove() {
    V.moveToken++; V.moveBusy = false; V.pendingMove = null;
    if (V.moveRaf !== null) { cancelAnimationFrame(V.moveRaf); V.moveRaf = null; }
  }
  // 覆盖态 → 视频池映射（状态机事件；无对应素材则只气泡）
  function videoOverlay(name) {
    const a = (skin.manifest.animations) || {};
    let target = null;
    if (name === 'click') target = PetChain.pick(a.clicks || [], V.current);
    else if (name === 'dragging') target = (a.drag || a.clicks || [])[0] || null;
    else if (name === 'working') target = (a.working || [])[0] || null;
    else if (name === 'happy') target = (a.happy || [])[0] || null;
    else if (name === 'sad') target = (a.sad || [])[0] || null;
    else if (name === 'absorb') target = (a.absorb || [])[0] || null;
    else if (name === 'release') target = (a.release || [])[0] || null;
    if (target) { V.overlay = true; playVideo(target, true); }
  }

  // ================= 皮肤加载 =================
  function loadSkin(s) {
    if (skin && skin.renderer === 'video') { cancelMove(); clearTimeout(V.ft); V.gen++; }
    skin = s;
    const isVideo = !!(s && s.renderer === 'video');
    petEl.style.display = isVideo ? 'none' : '';
    if (isVideo) {
      if (!vstage) {
        vstage = document.createElement('div');
        vstage.id = 'vstage';
        const style = document.createElement('style');
        style.textContent = VCSS;
        document.head.appendChild(style);
        vstage.innerHTML = '<video class="a"></video><video class="b"></video>';
        document.body.appendChild(vstage);
      }
      vstage.style.display = '';
      V.elA = vstage.querySelector('video.a');
      V.elB = vstage.querySelector('video.b');
      V.front = 0; V.overlay = false; V.current = ''; V.facing = 'left';
      bubble.style.top = (window.innerHeight - 180 - 44) + 'px';   // 气泡移到视频舞台上方
      pickNext();
    } else {
      if (vstage) vstage.style.display = 'none';
      bubble.style.top = '';
      petEl.className = 'pet pet-idle';
    }
  }

  // ================= 状态核心 =================
  const core = {
    play(name, opts) {
      if (name === 'dragging') { state = 'dragging'; if (skin && skin.renderer === 'video') { videoOverlay('dragging'); } return; }
      state = name;
      if (skin && skin.renderer === 'video') { videoOverlay(name, opts); return; }
      petEl.className = 'pet pet-' + name;
      if (['click', 'wake', 'happy', 'sad'].includes(name)) {
        setTimeout(() => { if (state === name) setState('idle'); }, 700);
      }
    },
    click() { core.play('click'); say('click'); },
    idle() { setState('idle'); },
  };
  window.core = core;

  // ================= 主进程事件（皮肤/任务/收放） =================
  petApi.onEvent((e) => {
    switch (e.type) {
      case 'skin': loadSkin(e.payload); break;
      case 'taskStarted': core.play('working'); say('working'); break;
      case 'taskProgress': core.play('workingProgress'); say('progress', { pct: e.payload?.pct }); break;
      case 'taskDone': core.play('happy'); say('done'); break;
      case 'taskError': core.play('sad'); say('error'); break;
      case 'absorb': core.play('absorb'); say('absorb'); setTimeout(() => setState('absorbed'), 350); break;
      case 'release': core.play('release'); say('release'); break;
    }
  });

  // ================= 透明区域点击穿透（角色区域判定，css/video 通用） =================
  function roleRect() {
    if (skin && skin.renderer === 'video' && vstage) {
      const r = vstage.getBoundingClientRect();
      const hb = PetChain.HIT_BOX;
      return {
        left: r.left + r.width * (hb.x0 / 640), right: r.left + r.width * (hb.x1 / 640),
        top: r.top + r.height * (hb.y0 / 360), bottom: r.top + r.height * (hb.y1 / 360),
      };
    }
    return petEl.getBoundingClientRect();
  }
  function updateClickThrough(e) {
    const r = roleRect();
    const inRole = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    petApi.setClickThrough(!inRole);
  }
  document.addEventListener('mousemove', updateClickThrough, true);
  document.addEventListener('pointermove', updateClickThrough, true);
  window.addEventListener('blur', () => petApi.setClickThrough(false));

  // ================= 视线跟随（css 渲染器专属；视频素材不适用） =================
  document.addEventListener('mousemove', (e) => {
    if (skin && skin.renderer === 'video') return;
    const r = petEl.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const lookX = Math.max(-5, Math.min(5, dx / 8));
    const lookY = Math.max(-4, Math.min(4, dy / 8));
    petEl.style.setProperty('--look-x', lookX + 'px');
    petEl.style.setProperty('--look-y', lookY + 'px');
  });

  // ================= 手动拖拽（禁用 -webkit-app-region: drag；rAF 节流） =================
  function scheduleMove(x, y) {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      pos.x = x; pos.y = y;
      petApi.move(Math.round(x), Math.round(y));
    });
  }
  window.addEventListener('pointerdown', (e) => {
    cancelMove();
    down = { x: e.screenX, y: e.screenY, wx: pos.x, wy: pos.y, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.screenX - down.x, dy = e.screenY - down.y;
    if (!down.moved && Math.hypot(dx, dy) >= PetChain.DRAG_THRESHOLD) { down.moved = true; core.play('dragging'); }
    if (down.moved) scheduleMove(down.wx + dx, down.wy + dy);
  });
  window.addEventListener('pointerup', () => {
    if (!down) return;
    if (down.moved) core.idle();
    else core.click();
    down = null;
  });

  // ================= 双击：收/放主窗口（主进程执行） =================
  let lastClick = 0;
  document.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastClick < 350) { petApi.toggle(); lastClick = 0; }
    else lastClick = now;
  });
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); petApi.menu(); });

  // ================= 睡眠（video 模式：气泡 + 链继续；css 模式：原状态） =================
  let idleMs = 0;
  setInterval(() => {
    if (state !== 'idle') { idleMs = 0; return; }
    idleMs += 5000;
    if (idleMs >= 120000) {
      if (skin && skin.renderer === 'video') { say('sleep'); }
      else { core.play('sleep'); }
      setTimeout(() => { if (state === 'sleep') setState('idle'); }, 6000);
      idleMs = 0;
    }
  }, 5000);
  document.addEventListener('pointerenter', () => {
    idleMs = 0;
    if (state === 'sleep') { core.play('wake'); say('wake'); }
  });
})();
