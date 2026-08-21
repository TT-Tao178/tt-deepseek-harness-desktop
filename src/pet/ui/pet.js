// v6.1 桌宠渲染进程逻辑（状态规则与 src/pet/state-machine.ts 保持一致）
(function () {
  const petEl = document.getElementById('pet');
  const bubble = document.getElementById('bubble');
  let state = 'idle';
  let bubbleTimer = null;
  let down = null, rafId = 0;
  let pos = { x: window.screenX, y: window.screenY };

  const TEXTS = {
    idle: ['摸鱼中…', '盯——', '需要帮忙吗？'],
    click: ['嘿！', '干嘛戳我~', '(*￣︶￣)'],
    wake: ['哈…醒了', '嗯？怎么了？'],
    working: ['认真工作中…', '别打扰我！'],
    progress: ['正在处理 ({pct})…', '快了快了…'],
    done: ['搞定啦！', '任务完成！'],
    error: ['失败了…看下日志？', '呜…出错了'],
    absorb: ['我先揣兜里啦', '收工！'],
    release: ['回来啦！', '好久不见~'],
  };
  const EMOJIS = { click: ['👀', '✨'], happy: ['🎉'], sad: ['💧'], working: ['💦'] };

  function setState(name, opts) {
    state = name;
    petEl.className = 'pet pet-' + name;
    if (opts && opts.bubble) showBubble(opts.bubble);
    if (opts && opts.emoji) showBubble(opts.bubble ? opts.bubble + ' ' + opts.emoji : opts.emoji);
  }
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
    if (opts && opts.pct != null && kind === 'progress') text = t.replace('{pct}', opts.pct);
    setState(state, { bubble: text, emoji: (EMOJIS[kind] || []).length ? pick(EMOJIS[kind]) : undefined });
  }

  const core = {
    play(name, opts) {
      if (name === 'dragging') { setState('dragging'); return; }
      setState(name, opts);
      // 瞬态动画结束后回 idle（absorb→absorbed、release→idle 由主进程事件维持）
      if (['click', 'wake', 'happy', 'sad'].includes(name)) {
        setTimeout(() => { if (state === name) setState('idle'); }, 700);
      }
    },
    click() { core.play('click'); say('click'); },
    idle() { setState('idle'); },
  };
  window.core = core;

  // ---- 主进程事件（任务/收放） ----
  petApi.onEvent((e) => {
    switch (e.type) {
      case 'taskStarted': core.play('working'); say('working'); break;
      case 'taskProgress': core.play('workingProgress'); say('progress', { pct: e.payload?.pct }); break;
      case 'taskDone': core.play('happy'); say('done'); break;
      case 'taskError': core.play('sad'); say('error'); break;
      case 'absorb': core.play('absorb'); say('absorb'); setTimeout(() => setState('absorbed'), 350); break;
      case 'release': core.play('release'); say('release'); break;
    }
  });

  // ---- 视线跟随 ----
  document.addEventListener('mousemove', (e) => {
    const r = petEl.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const lookX = Math.max(-5, Math.min(5, dx / 8));
    const lookY = Math.max(-4, Math.min(4, dy / 8));
    petEl.style.setProperty('--look-x', lookX + 'px');
    petEl.style.setProperty('--look-y', lookY + 'px');
  });

  // ---- 手动拖拽（禁用 -webkit-app-region: drag；rAF 节流） ----
  function scheduleMove(x, y) {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      pos.x = x; pos.y = y;
      petApi.move(Math.round(x), Math.round(y));
    });
  }
  window.addEventListener('pointerdown', (e) => {
    down = { x: e.screenX, y: e.screenY, wx: pos.x, wy: pos.y, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.screenX - down.x, dy = e.screenY - down.y;
    if (!down.moved && Math.hypot(dx, dy) >= 5) { down.moved = true; core.play('dragging'); }
    if (down.moved) scheduleMove(down.wx + dx, down.wy + dy);
  });
  window.addEventListener('pointerup', () => {
    if (!down) return;
    if (down.moved) core.idle();
    else core.click();
    down = null;
  });

  // ---- 双击：收/放主窗口（主进程执行） ----
  let lastClick = 0;
  document.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastClick < 350) { petApi.toggle(); lastClick = 0; }
    else lastClick = now;
  });
  // 右键菜单
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); petApi.menu(); });

  // ---- 睡眠/游荡定时（简版；行为参数由主题/设置控制） ----
  let idleMs = 0;
  setInterval(() => {
    if (state !== 'idle') { idleMs = 0; return; }
    idleMs += 5000;
    if (idleMs >= 120000) { core.play('sleep'); setTimeout(() => { if (state === 'sleep') setState('idle'); }, 6000); idleMs = 0; }
  }, 5000);
  document.addEventListener('pointerenter', () => { idleMs = 0; if (state === 'sleep') { core.play('wake'); say('wake'); } });
})();
