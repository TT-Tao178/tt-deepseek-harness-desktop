// 设置窗口逻辑：内核管理 / 通用设置。走 window.__TAURI__ 全局 API（withGlobalTauri）。
/* global window, document */
(() => {
  const { core, event } = window.__TAURI__;
  const $ = (id) => document.getElementById(id);

  let selectedVersion = null;
  let busy = false;

  // ---------- 通用 ----------
  function setBusy(v) {
    busy = v;
    $('btn-check').disabled = v;
    $('btn-install').disabled = v || !selectedVersion;
    $('btn-rollback').disabled = v || currentBackups.length === 0;
    $('btn-restart').disabled = v;
    $('btn-cancel').classList.toggle('hidden', !v);
  }

  function status(text, cls) {
    const el = $('k-status');
    el.textContent = text || '';
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  function progress(phase, pct) {
    const box = $('k-progress');
    const bar = $('k-progress-bar');
    if (!phase) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    const pctMap = { resolving: 2, downloading: pct || 5, extracting: 82, selftest: 92, swapping: 96, restarting: 98, rollback: 50 };
    bar.style.width = (pctMap[phase] ?? 5) + '%';
  }

  // ---------- 内核状态 ----------
  let currentBackups = [];
  async function refreshStatus() {
    try {
      const s = JSON.parse(await core.invoke('kernel_status'));
      $('k-version').textContent = s.installed_version || '未知';
      $('k-registry').value = s.registry || 'npmmirror';
      currentBackups = s.backups || [];
      $('k-backups').textContent = currentBackups.length
        ? `备份：${currentBackups.join('、')}`
        : '备份：暂无（首次更新成功后自动保留一份）';
      $('btn-rollback').disabled = busy || currentBackups.length === 0;
    } catch (e) {
      $('k-version').textContent = '状态读取失败';
      status(String(e), 'err');
    }
  }

  // ---------- 事件（Rust → UI） ----------
  event.listen('kernel://versions', (ev) => {
    setBusy(false);
    const p = ev.payload || {};
    if (p.error) { status(`检查更新失败：${p.error}`, 'err'); return; }
    renderVersions(p);
    status(`已获取版本列表（当前 ${p.current || '?'}），选择一个版本后点「下载并安装」。`, 'ok');
  });

  event.listen('kernel://progress', (ev) => {
    const p = ev.payload || {};
    progress(p.phase, p.pct);
    const extra = p.detail ? ` · ${p.detail}` : '';
    const phaseText = {
      resolving: '解析依赖', downloading: '下载', extracting: '解压摊平',
      selftest: '自检（临时端口试运行）', swapping: '切换目录', restarting: '重启内核',
      rollback: '回滚',
    }[p.phase] || p.phase;
    status(`${phaseText}${extra}`, '');
  });

  event.listen('kernel://done', (ev) => {
    setBusy(false);
    progress(null);
    const p = ev.payload || {};
    if (p.result === 'installed') {
      status(`已更新到 ${p.version}。可随时「回滚到上一版本」。`, 'ok');
    } else if (p.result === 'rolled_back') {
      status(p.restored ? `更新失败已自动回滚（${p.error}）` : `更新失败且回滚后内核未就绪，请查看日志。`, 'err');
    } else if (p.result === 'cancelled') {
      status('已取消。', '');
    } else {
      status(`失败：${p.error || '未知错误'}（详情见 logs/installer-*.log）`, 'err');
    }
    refreshStatus();
  });

  // ---------- 版本列表 ----------
  function renderVersions(data) {
    const list = $('k-versions');
    list.innerHTML = '';
    selectedVersion = null;
    $('btn-install').disabled = true;
    const versions = data.versions || [];
    for (const v of versions) {
      const row = document.createElement('div');
      row.className = 'vitem';
      const tags = [];
      if (v.version === data.current) tags.push('<span class="tag cur">当前</span>');
      if (v.version === data.latest) tags.push('<span class="tag new">latest</span>');
      row.innerHTML = `<span>${v.version}</span>${tags.join('')}<span style="margin-left:auto;color:#98a1ab;font-size:12px;">${(v.time || '').slice(0, 10)}</span>`;
      row.onclick = () => {
        if (busy) return;
        list.querySelectorAll('.vitem').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        selectedVersion = v.version;
        $('btn-install').disabled = false;
      };
      list.appendChild(row);
    }
    list.classList.remove('hidden');
  }

  // ---------- 按钮动作 ----------
  $('btn-check').onclick = async () => {
    // 先保存所选源（下次检查生效）。
    const ok = await core.invoke('kernel_check_updates');
    if (!ok) status('已有更新任务在进行。', 'err');
    else { setBusy(true); status('正在获取版本列表…', ''); }
  };

  $('btn-install').onclick = () => {
    if (!selectedVersion) return;
    if (!confirm(`安装内核 ${selectedVersion}？\n\n下载约 80~120MB；当前会话不受影响；新内核自检通过才会切换，失败自动回滚。`)) return;
    const ok = core.invoke('kernel_install', { version: selectedVersion });
    if (!ok) { status('已有更新任务在进行。', 'err'); return; }
    setBusy(true);
    progress('resolving');
    status('开始安装…', '');
  };

  $('btn-cancel').onclick = () => core.invoke('kernel_cancel');

  $('btn-rollback').onclick = () => {
    const target = currentBackups[0];
    if (!target) return;
    if (!confirm(`回滚到 ${target}？当前内核将被替换，内核会重启（约 5~15 秒）。`)) return;
    const ok = core.invoke('kernel_rollback', { version: target });
    if (!ok) { status('已有更新任务在进行。', 'err'); return; }
    setBusy(true);
    status('回滚中…', '');
  };

  $('btn-restart').onclick = async () => {
    $('btn-restart').disabled = true;
    status('正在重启内核…', '');
    try {
      await core.invoke('service_restart');
      status('内核已重启。', 'ok');
    } catch (e) {
      status(`重启失败：${e}`, 'err');
    }
    await Promise.all([refreshStatus(), refreshService()]);
  };

  $('k-registry').onchange = (e) => {
    status(`更新源已切换为 ${e.target.value}，下次检查更新生效。`, '');
  };

  // ---------- 通用设置 ----------
  async function refreshSettings() {
    try {
      const s = JSON.parse(await core.invoke('settings_get'));
      $('close-behavior').value = s.close_behavior || 'ask';
      const roxy = (s.plugins && s.plugins.enabled && s.plugins.enabled['dsh-pet-roxy']);
      $('roxy-toggle').checked = roxy !== false; // 默认开
    } catch (e) {
      status(`设置读取失败：${e}`, 'err');
    }
  }

  $('close-behavior').onchange = async (e) => {
    const ok = await core.invoke('settings_set_close_behavior', { value: e.target.value });
    if (!ok) status('保存失败。', 'err');
  };

  $('roxy-toggle').onchange = (e) => {
    core.invoke('roxy_set', { enabled: e.target.checked });
  };

  async function refreshService() {
    try {
      const s = JSON.parse(await core.invoke('service_get_status'));
      $('svc-status').textContent = `状态 ${s.state} · 端口 ${s.port ?? '-'}`;
    } catch {
      $('svc-status').textContent = '状态读取失败';
    }
  }

  // ---------- 插件管理 ----------
  async function refreshPlugins() {
    const box = $('p-list');
    let list;
    try {
      list = JSON.parse(await core.invoke('plugin_list'));
    } catch (e) {
      box.innerHTML = `<div class="row"><span class="status err">插件列表读取失败：${e}</span></div>`;
      return;
    }
    if (!list.length) {
      box.innerHTML = '<div class="row"><span class="status">未发现插件。</span></div>';
      return;
    }
    box.innerHTML = '';
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'prow';
      const srcTag = p.source === 'bundled' ? '内置' : '导入';
      const meta = [p.version, srcTag].filter(Boolean).join(' · ');
      if (!p.valid) {
        row.innerHTML = `
          <div>
            <div class="pid">${p.id} <span class="tag bad">异常</span></div>
            <div class="pbad">${p.invalid_reason || '校验失败'}</div>
          </div>
          <div class="spacer"></div>`;
        if (p.source === 'user') {
          const rm = document.createElement('button');
          rm.className = 'danger';
          rm.textContent = '移除';
          rm.onclick = () => removePlugin(p.id);
          row.querySelector('.spacer').appendChild(rm);
        }
      } else {
        row.innerHTML = `
          <div>
            <div class="pid">${p.id}</div>
            <div class="pmeta">${meta}${p.description ? ' — ' + p.description : ''}</div>
          </div>
          <div class="spacer">
            <label class="pmeta"><input type="checkbox" class="pswitch" ${p.enabled ? 'checked' : ''}> 启用</label>
          </div>`;
        const sw = row.querySelector('.pswitch');
        sw.onchange = async () => {
          sw.disabled = true;
          const ok = await core.invoke('plugin_set_enabled', { id: p.id, enabled: sw.checked });
          sw.disabled = false;
          pStatus(ok ? `${p.id} 将${sw.checked ? '启用' : '禁用'}（内核重启后生效，约 3~10 秒）` : '保存失败。', ok ? '' : 'err');
          if (p.id === 'dsh-pet-roxy') $('roxy-toggle').checked = sw.checked;
        };
        if (p.source === 'user') {
          const spacer = row.querySelector('.spacer');
          const rm = document.createElement('button');
          rm.className = 'danger';
          rm.textContent = '移除';
          rm.onclick = () => removePlugin(p.id);
          spacer.insertBefore(rm, spacer.firstChild);
        }
      }
      box.appendChild(row);
    }
  }

  function pStatus(text, cls) {
    const el = $('p-status');
    el.textContent = text || '';
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  async function removePlugin(id) {
    if (!confirm(`移除插件 ${id}？\n\n（目录会移入 plugin-trash，可手工恢复）`)) return;
    const ok = await core.invoke('plugin_remove', { id });
    if (ok) pStatus(`${id} 已移除。`, 'ok');
    else pStatus('移除失败（内置插件不可移除，或文件被占用）。', 'err');
    refreshPlugins();
  }

  $('btn-plugin-import').onclick = async () => {
    const selected = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: '选择插件目录（需含 package.json 与 cordis.patch.yml）',
    });
    if (!selected) return;
    pStatus('导入中…', '');
    const res = JSON.parse(await core.invoke('plugin_import', { path: selected }));
    if (res.ok) pStatus(`已导入 ${res.id}（默认禁用，开启后生效）。`, 'ok');
    else pStatus(`导入失败：${res.error}`, 'err');
    refreshPlugins();
  };

  event.listen('plugin://changed', () => refreshPlugins());
  event.listen('plugin://error', (ev) => pStatus(ev.payload && ev.payload.error || '操作失败。', 'err'));

  // ---------- 启动 ----------
  setBusy(false);
  refreshStatus();
  refreshSettings();
  refreshService();
  refreshPlugins();
})();
