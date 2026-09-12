// 设置窗口逻辑：内核管理 / 插件管理 / 通用设置 / 服务状态。
// 通过 window.__TAURI__ 全局 API（withGlobalTauri）直接调用壳命令。
/* global window, document */
//
// ⚠ 不要用 window.confirm/alert：wry(WebView2) 不处理脚本对话框，调用会
// **立即返回 undefined 且不弹任何框**（CDP 实证），导致「下载并安装」等
// 按钮静默失效（P27）。确认类交互一律走 tauri-plugin-dialog 的
// dialog.confirm（Rust 原生对话框，经命令通道，不依赖 WebView2 弹窗）。
(() => {
  const { core, event, dialog } = window.__TAURI__;
  const $ = (id) => document.getElementById(id);

  // ---------- 小工具 ----------
  let noteTimer = null;
  /** 统一的状态条：kind ∈ '' | 'ok' | 'warn' | 'err' */
  function note(boxId, textId, msg, kind) {
    const box = $(boxId);
    const el = $(textId);
    if (!box || !el) return;
    if (!msg) {
      box.classList.remove('on', 'ok', 'warn', 'err');
      return;
    }
    el.textContent = msg;
    box.className = 'note on' + (kind ? ' ' + kind : '');
    box.querySelector('.ic').textContent = kind === 'err' ? '!' : kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '•';
    if (noteTimer) clearTimeout(noteTimer);
    if (kind === 'ok') {
      noteTimer = setTimeout(() => box.classList.remove('on'), 6000);
    }
  }

  function relativeTime(epochSeconds) {
    const s = Number(epochSeconds);
    if (!s || Number.isNaN(s)) return '从未';
    const diff = Math.floor(Date.now() / 1000 - s);
    if (diff < 0) return '刚刚';
    if (diff < 60) return `${diff} 秒前`;
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 语义化版本比较（仅用于排序/新旧判断，支持预发布）。 */
  function parseVer(v) {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
    if (!m) return null;
    return { major: +m[1], minor: m[2] ? +m[2] : 0, patch: m[3] ? +m[3] : 0, pre: m[4] ? m[4].split('.') : [] };
  }
  function cmpVer(a, b) {
    const x = parseVer(a); const y = parseVer(b);
    if (!x || !y) return 0;
    if (x.major !== y.major) return x.major - y.major;
    if (x.minor !== y.minor) return x.minor - y.minor;
    if (x.patch !== y.patch) return x.patch - y.patch;
    if (!x.pre.length && !y.pre.length) return 0;
    if (!x.pre.length) return 1;
    if (!y.pre.length) return -1;
    for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
      const p = x.pre[i]; const q = y.pre[i];
      const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
      if (pn && qn) { if (+p !== +q) return +p - +q; } else if (pn) return -1; else if (qn) return 1;
      else if (p !== q) return p < q ? -1 : 1;
    }
    return x.pre.length - y.pre.length;
  }

  // ---------- 侧栏导航 ----------
  function showView(name) {
    document.querySelectorAll('.nav').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.view === name));
    });
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
  }
  document.querySelectorAll('.nav').forEach((b) => {
    b.onclick = () => showView(b.dataset.view);
  });

  // ---------- 内核状态 ----------
  let currentBackups = [];
  let installedVersion = null;
  let busy = false;

  async function refreshStatus() {
    try {
      const s = JSON.parse(await core.invoke('kernel_status'));
      installedVersion = s.installed_version || null;
      if (installedVersion) {
        $('k-version').textContent = `内核 ${installedVersion}`;
        $('k-version-hint').textContent = '内核为官方 @deepseek-ai/dsh；更新来自下方所选 npm 源';
      } else {
        $('k-version').textContent = '未能读取内核版本';
        $('k-version-hint').textContent = '内核目录可能不完整，请查看 logs\\main.log';
      }
      $('k-registry').value = s.registry || 'npmmirror';
      currentBackups = s.backups || [];
      $('k-backups').textContent = currentBackups.length
        ? `可回滚版本：${currentBackups.join('、')}`
        : '暂无备份（首次更新成功后会自动保留一份）';
      $('btn-rollback').disabled = busy || currentBackups.length === 0;
      $('d-checked').textContent = relativeTime(s.last_checked);
      if (s.busy !== undefined) setBusy(s.busy);
    } catch (e) {
      $('k-version').textContent = '状态读取失败';
      note('k-note', 'k-note-text', String(e), 'err');
    }
  }

  // ---------- 忙闲与进度 ----------
  function setBusy(v) {
    busy = v;
    $('btn-check').disabled = v;
    $('btn-rollback').disabled = v || currentBackups.length === 0;
    $('btn-restart').disabled = v;
    $('btn-install').disabled = v || !selectedVersion;
    $('btn-cancel').style.display = v ? '' : 'none';
  }

  const PHASE_TEXT = {
    resolving: '解析依赖闭包',
    downloading: '下载官方包',
    extracting: '校验并解压',
    selftest: '自检（临时端口试运行）',
    swapping: '切换内核目录',
    restarting: '重启内核',
    rollback: '回滚中',
  };
  const PHASE_PCT = { resolving: 2, extracting: 82, selftest: 92, swapping: 96, restarting: 98, rollback: 45 };

  function setProgress(pct, text) {
    $('k-progress-row').style.display = '';
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    $('k-bar').style.width = p + '%';
    $('k-pct').textContent = p + '%';
    if (text) $('k-phase').textContent = text;
  }
  function hideProgress() {
    $('k-progress-row').style.display = 'none';
    $('k-bar').style.width = '0%';
  }

  // ---------- 事件（Rust → UI） ----------
  event.listen('kernel://versions', (ev) => {
    setBusy(false);
    hideProgress();
    const p = ev.payload || {};
    if (p.error) {
      note('k-note', 'k-note-text', `检查更新失败：${p.error}`, 'err');
      return;
    }
    renderVersions(p);
    note('k-note', 'k-note-text', `已获取 ${(p.versions || []).length} 个版本（当前 ${p.current || '未知'}）。`, 'ok');
  });

  event.listen('kernel://progress', (ev) => {
    const p = ev.payload || {};
    if (p.phase === 'downloading') {
      setProgress(p.pct || 5, `下载官方包 ${p.i || 0}/${p.n || 0}`);
      $('k-detail').textContent = p.detail ? String(p.detail) : '';
      return;
    }
    if (p.phase === 'extracting') {
      // 解压阶段报文很密，只在文字上体现进度。
      $('k-phase').textContent = `校验并解压 ${p.i || ''}`.trim();
      $('k-detail').textContent = p.detail ? String(p.detail) : '';
      return;
    }
    setProgress(PHASE_PCT[p.phase] !== undefined ? PHASE_PCT[p.phase] : 5, PHASE_TEXT[p.phase] || p.phase);
    $('k-detail').textContent = p.detail ? String(p.detail) : '';
  });

  event.listen('kernel://done', (ev) => {
    setBusy(false);
    hideProgress();
    const p = ev.payload || {};
    if (p.result === 'installed') {
      note('k-note', 'k-note-text', `已更新到 ${p.version}。可随时回滚到上一版本。`, 'ok');
    } else if (p.result === 'rolled_back') {
      note('k-note', 'k-note-text', p.restored
        ? `新内核启动失败，已自动回滚：${p.error || ''}`
        : '新内核启动失败，且回滚后内核未就绪，请查看 logs\\main.log', 'err');
    } else if (p.result === 'cancelled') {
      note('k-note', 'k-note-text', '已取消，正式内核未被修改。', '');
    } else {
      note('k-note', 'k-note-text', `更新失败：${p.error || '未知错误'}（详见 logs\\installer-*.log）`, 'err');
    }
    refreshStatus();
  });

  // ---------- 版本列表 ----------
  let selectedVersion = null;

  function renderVersions(data) {
    const list = $('k-versions');
    list.innerHTML = '';
    selectedVersion = null;
    $('btn-install').disabled = true;
    $('k-sel').textContent = '未选择版本';
    $('k-panel').style.display = '';

    const current = data.current || installedVersion;
    const versions = (data.versions || []).slice().sort((a, b) => cmpVer(b.version, a.version));
    // latest 取注册表的 dist-tags（镜像可能滞后，仅作标记用）
    const latest = data.latest;

    const head = document.createElement('div');
    head.className = 'vhead';
    head.innerHTML = `<span>版本</span><span style="margin-left:auto">发布时间</span>`;
    list.appendChild(head);

    for (const v of versions) {
      const row = document.createElement('div');
      row.className = 'vitem';
      const tags = [];
      if (v.version === current) tags.push('<span class="tag cur">当前</span>');
      if (v.version === latest) tags.push('<span class="tag new">latest</span>');
      if (current && cmpVer(v.version, current) > 0 && v.version !== latest && v.version !== current) {
        tags.push('<span class="tag old">较新</span>');
      }
      row.innerHTML =
        `<span class="radio"></span>` +
        `<span class="ver">${v.version}</span>` +
        tags.join('') +
        `<span class="when">${fmtDate(v.time) || '-'}</span>`;
      row.onclick = () => {
        if (busy) return;
        list.querySelectorAll('.vitem').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        selectedVersion = v.version;
        $('btn-install').disabled = false;
        $('k-sel').textContent = v.version === current
          ? `已选择 ${v.version}（与当前版本相同，重装将重新下载）`
          : `已选择 ${v.version}`;
      };
      list.appendChild(row);
    }
  }

  // ---------- 内核按钮 ----------
  $('btn-check').onclick = async () => {
    note('k-note', 'k-note-text', '', '');
    setBusy(true);
    setProgress(2, '正在连接注册表…');
    const ok = await core.invoke('kernel_check_updates');
    if (!ok) {
      setBusy(false);
      hideProgress();
      note('k-note', 'k-note-text', '已有更新任务正在进行。', 'warn');
    }
  };

  $('btn-install').onclick = async () => {
    if (!selectedVersion) return;
    const go = await dialog.confirm(
      `安装内核 ${selectedVersion}？下载约 80~120MB，期间当前会话不受影响；` +
      '新内核自检通过才会切换目录，启动失败会自动回滚到上一版本。',
      { title: '安装内核', kind: 'info' }
    );
    if (!go) return;
    setBusy(true);
    note('k-note', 'k-note-text', '', '');
    setProgress(0, '正在提交安装任务…');
    const ok = await core.invoke('kernel_install', { version: selectedVersion });
    if (!ok) {
      setBusy(false);
      hideProgress();
      note('k-note', 'k-note-text', '已有更新任务正在进行。', 'warn');
    }
  };

  $('btn-cancel').onclick = () => core.invoke('kernel_cancel');

  $('btn-rollback').onclick = async () => {
    const target = currentBackups[0];
    if (!target) return;
    const go = await dialog.confirm(
      `回滚到 ${target}？当前内核会被替换，内核将重启（约 5~15 秒）。`,
      { title: '回滚内核', kind: 'warning' }
    );
    if (!go) return;
    setBusy(true);
    note('k-note', 'k-note-text', '', '');
    setProgress(45, `正在回滚到 ${target}…`);
    const ok = await core.invoke('kernel_rollback', { version: target });
    if (!ok) {
      setBusy(false);
      hideProgress();
      note('k-note', 'k-note-text', '已有更新任务正在进行。', 'warn');
    }
  };

  // 更新源：立即写盘（旧实现只改下拉框不保存，切了也没用）
  $('k-registry').onchange = async (e) => {
    const value = e.target.value;
    try {
      await core.invoke('kernel_set_registry', { registry: value });
      note('k-note', 'k-note-text', `更新源已切换为 ${value === 'npmjs' ? 'npmjs.org（官方源）' : 'npmmirror（国内镜像）'}，下次检查更新生效。`, 'ok');
    } catch (err) {
      note('k-note', 'k-note-text', `切换更新源失败：${err}`, 'err');
      refreshStatus();
    }
  };

  // ---------- 通用设置 ----------
  async function refreshSettings() {
    try {
      const s = JSON.parse(await core.invoke('settings_get'));
      $('close-behavior').value = s.close_behavior || 'ask';
      // v8.2：页面宠物常开，开关已移除（设置页与插件列表均为纯展示）。
    } catch (e) {
      note('g-note', 'g-note-text', `设置读取失败：${e}`, 'err');
    }
  }

  $('close-behavior').onchange = async (e) => {
    const ok = await core.invoke('settings_set_close_behavior', { value: e.target.value });
    if (ok) note('g-note', 'g-note-text', '关闭行为已保存。', 'ok');
    else note('g-note', 'g-note-text', '保存失败。', 'err');
  };

  // ---------- 服务状态 ----------
  const STATE_TEXT = {
    Ready: ['运行中', 'ok'], Starting: ['启动中', 'warn'], Crashed: ['已崩溃 · 等待重启', 'err'],
    Stopped: ['已停止', ''], Exhausted: ['重启次数耗尽', 'err'],
  };

  async function refreshService() {
    try {
      const s = JSON.parse(await core.invoke('service_get_status'));
      const [text, kind] = STATE_TEXT[s.state] || [s.state || '未知', ''];
      $('svc-text').textContent = text;
      $('svc-pill').className = 'pill' + (kind ? ' ' + kind : '');
      $('svc-state').innerHTML = `<span class="pill ${kind}"><span class="dot"></span>${text}</span>`;
      $('svc-port').textContent = s.port ? String(s.port) : '-';
    } catch {
      $('svc-text').textContent = '状态读取失败';
      $('svc-pill').className = 'pill err';
      $('svc-state').innerHTML = '<span class="pill err"><span class="dot"></span>读取失败</span>';
    }
  }

  $('btn-restart').onclick = async () => {
    $('btn-restart').disabled = true;
    $('svc-text').textContent = '正在重启…';
    $('svc-pill').className = 'pill warn';
    try {
      await core.invoke('service_restart');
    } catch (e) {
      note('k-note', 'k-note-text', `重启失败：${e}`, 'err');
    }
    // 内核就绪需要几秒，轮询几次把状态刷出来。
    let n = 0;
    const tick = async () => {
      await refreshService();
      n += 1;
      const ready = $('svc-text').textContent === '运行中';
      if (!ready && n < 12) setTimeout(tick, 800);
      else $('btn-restart').disabled = false;
    };
    setTimeout(tick, 600);
  };

  // ---------- 插件管理 ----------
  function pNote(msg, kind) {
    note('p-note', 'p-note-text', msg, kind);
  }

  async function refreshPlugins() {
    const box = $('p-list');
    let list;
    try {
      list = JSON.parse(await core.invoke('plugin_list'));
    } catch (e) {
      box.innerHTML = `<div class="empty">插件列表读取失败：${e}</div>`;
      return;
    }
    if (!list.length) {
      box.innerHTML = '<div class="empty">未发现插件。</div>';
      return;
    }
    box.innerHTML = '';
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'plug' + (p.valid ? '' : ' bad');
      const initial = (p.id.replace(/^@[^/]+\//, '')[0] || '?').toUpperCase();
      const srcTag = p.source === 'bundled' ? '内置' : '导入';
      const meta = [p.version, srcTag].filter(Boolean).join(' · ');

      const info = document.createElement('div');
      info.className = 'grow';
      info.style.minWidth = '0';
      if (p.valid) {
        info.innerHTML =
          `<div class="label">${p.id}</div>` +
          `<div class="meta">${meta}${p.description ? ' — ' + p.description : ''}</div>`;
      } else {
        info.innerHTML =
          `<div class="label">${p.id} <span class="tag bad">异常</span></div>` +
          `<div class="why">${p.invalid_reason || '校验失败'}</div>`;
      }
      row.innerHTML = `<div class="avatar">${initial}</div>`;
      row.appendChild(info);

      const acts = document.createElement('div');
      acts.className = 'acts';
      if (p.valid) {
        if (p.id === 'dsh-pet-roxy') {
          // v8.2：页面宠物常开，不提供开关。
          const tag = document.createElement('span');
          tag.className = 'tag cur';
          tag.textContent = '常开';
          acts.appendChild(tag);
        } else {
          const sw = document.createElement('label');
          sw.className = 'switch';
          sw.title = p.enabled ? '点击禁用' : '点击启用';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!p.enabled;
          const track = document.createElement('span');
          track.className = 'track';
          sw.appendChild(cb);
          sw.appendChild(track);
          cb.onchange = async () => {
            cb.disabled = true;
            const ok = await core.invoke('plugin_set_enabled', { id: p.id, enabled: cb.checked });
            if (!ok) {
              cb.disabled = false;
              cb.checked = !cb.checked;
              pNote('保存失败。', 'err');
              return;
            }
            // 保持禁用直到 kernel://reloaded（内核重启+页面刷新完成）。
            pendingPlugins.set(p.id, cb);
            pNote(`${p.id} 将${cb.checked ? '启用' : '禁用'}，正在重启内核（约 3~10 秒）…`, '');
            waitApplied();
          };
          acts.appendChild(sw);
        }
      }
      if (p.source === 'user') {
        const rm = document.createElement('button');
        rm.className = 'btn sm danger';
        rm.textContent = '移除';
        rm.onclick = () => removePlugin(p.id);
        acts.appendChild(rm);
      }
      row.appendChild(acts);
      box.appendChild(row);
    }
  }

  async function removePlugin(id) {
    const go = await dialog.confirm(
      `移除插件 ${id}？目录会被移动到 plugin-trash，可手工恢复。`,
      { title: '移除插件', kind: 'warning' }
    );
    if (!go) return;
    const ok = await core.invoke('plugin_remove', { id });
    if (ok) pNote(`${id} 已移除（可在 plugin-trash 找回）。`, 'ok');
    else pNote('移除失败（内置插件不可移除，或文件被占用）。', 'err');
    refreshPlugins();
  }

  $('btn-plugin-import').onclick = async () => {
    const selected = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: '选择插件目录（需含 package.json 与 cordis.patch.yml）',
    });
    if (!selected) return;
    pNote('导入中…', '');
    const res = JSON.parse(await core.invoke('plugin_import', { path: selected }));
    if (res.ok) pNote(`已导入 ${res.id}（默认禁用，开启后生效）。`, 'ok');
    else pNote(`导入失败：${res.error}`, 'err');
    refreshPlugins();
  };

  // 「应用中」态登记表：内核重启+主窗刷新完成后统一解除。
  // 双保险：kernel://reloaded 事件到达即解除；同时每秒轮询服务状态兜底
  //（事件通道任何环节异常都不会把开关永久卡在「应用中」，P34）。
  const pendingPlugins = new Map();
  let appliedTimer = null;
  function markApplied() {
    if (appliedTimer) { clearInterval(appliedTimer); appliedTimer = null; }
    for (const [, cb] of pendingPlugins) cb.disabled = false;
    pendingPlugins.clear();
    pNote('已生效。', 'ok');
    Promise.all([refreshSettings(), refreshPlugins()]).catch(() => {});
  }
  function waitApplied() {
    if (appliedTimer) return;
    appliedTimer = setInterval(async () => {
      try {
        const s = JSON.parse(await core.invoke('service_get_status'));
        if (s.state === 'Ready') markApplied();
      } catch { /* 下轮再试 */ }
    }, 1000);
  }
  event.listen('kernel://reloaded', () => markApplied());

  event.listen('plugin://changed', () => refreshPlugins());
  event.listen('plugin://error', (ev) => pNote((ev.payload && ev.payload.error) || '操作失败。', 'err'));

  // ---------- 启动 ----------
  setBusy(false);
  hideProgress();
  refreshStatus();
  refreshSettings();
  refreshService();
  refreshPlugins();
})();
