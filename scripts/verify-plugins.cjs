/**
 * verify-plugins.cjs — v8 插件机制集成验证（门 6）。
 *
 * 模拟应用真实启动路径，验证「全挂载 + 用户 patch 层禁用」机制：
 *   1. junction（valid 全集）+ --patch（valid 全集）→ / 200 且
 *      /dsh-pet-roxy/config 返回插件 JSON（body 含 config.expressions）
 *   2. 写用户 patch 层禁用 pet-roxy（profiles/web/cordis.patch.yml）→
 *      重启 → / 200 且 roxy 路由返回 SPA HTML（不再是插件 JSON）
 *   3. 移除禁用条目 → 重启 → roxy 恢复插件 JSON（往返稳定）
 *
 * 判据说明：/dsh-pet-roxy/config 在未挂载时也返回 200（SPA 兜底路由），
 * 故以【响应体是否为插件 JSON】为挂载判据（规格 v7.1 的「404」判据已被
 * 实测证伪，见规格 §16 P8）。
 *
 * 运行: node scripts/verify-plugins.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const KERNEL_NODE = path.join(ROOT, 'kernel', 'node.exe');
const BIN_JS = path.join(ROOT, 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const PLUGINS = path.join(ROOT, 'plugins');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

function mklinkJunction(target, source) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execSync(`cmd /c mklink /J "${target}" "${source}"`, { stdio: 'ignore' });
}

function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function getText(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: '' };
  }
}

/** roxy 挂载判据：路由返回的是插件 JSON config（非 SPA 兜底 HTML）。
 *  轮询重试至 8s（插件路由注册可能晚于 web 根就绪）。 */
async function roxyMounted(port, expect, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const { body } = await getText(`http://127.0.0.1:${port}/dsh-pet-roxy/config`);
    const mounted = body.includes('"ok":true') && body.includes('expressions');
    if (mounted === expect) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** 写用户 patch 层（与 shell-core::write_user_patch_layer 同格式）。 */
function writeUserPatchLayer(home, disabledIds) {
  const p = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let body = '# verify-plugins 生成\n';
  body += disabledIds.length
    ? disabledIds.map((id) => `- id: ${id}\n  disabled: true\n`).join('')
    : '[]\n';
  fs.writeFileSync(p, body);
}

/** 启动内核（全插件 --patch）并等待就绪。 */
async function startKernel(home) {
  const port = await freePort();
  const patchTtbg = path.join(PLUGINS, 'tt-bg', 'cordis.patch.yml');
  const patchRoxy = path.join(PLUGINS, 'dsh-pet-roxy', 'cordis.patch.yml');
  const args = [BIN_JS, '--profile', 'web', '--patch', patchTtbg, '--patch', patchRoxy, '--port', String(port)];
  const child = spawn(KERNEL_NODE, args, {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr.on('data', (d) => (stderrTail = (stderrTail + d).slice(-3000)));
  const deadline = Date.now() + 45000;
  let rootOk = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`内核启动即退出 code=${child.exitCode}\n${stderrTail}`);
    const r = await getText(`http://127.0.0.1:${port}/`);
    if (r.status === 200) { rootOk = true; break; }
    await new Promise((r2) => setTimeout(r2, 400));
  }
  if (!rootOk) {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    throw new Error(`内核 45s 未就绪\n${stderrTail}`);
  }
  return { child, port };
}

function stopKernel(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('close', resolve);
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
      setTimeout(resolve, 3000);
    } catch {
      resolve();
    }
  });
}

async function main() {
  check('内核与插件就位', fs.existsSync(KERNEL_NODE) && fs.existsSync(path.join(PLUGINS, 'tt-bg', 'cordis.patch.yml')) && fs.existsSync(path.join(PLUGINS, 'dsh-pet-roxy', 'cordis.patch.yml')));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plugins-'));
  const home = path.join(tmp, 'dsh-home');
  const nm = path.join(home, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });

  // junction：valid 全集（与壳 discover→junction_targets 同布局）。
  mklinkJunction(path.join(nm, 'tt-bg'), path.join(PLUGINS, 'tt-bg'));
  mklinkJunction(path.join(nm, 'dsh-pet-roxy'), path.join(PLUGINS, 'dsh-pet-roxy'));
  check('junction 建立（tt-bg + dsh-pet-roxy）', fs.existsSync(path.join(nm, 'tt-bg')) && fs.existsSync(path.join(nm, 'dsh-pet-roxy')));

  try {
    // ---------- 1. 全启用（无禁用条目） ----------
    writeUserPatchLayer(home, []);
    let k = await startKernel(home);
    let m = await roxyMounted(k.port, true);
    check('全启用：roxy 路由返回插件 JSON', m);
    await stopKernel(k.child);

    // ---------- 2. 用户层禁用 pet-roxy ----------
    writeUserPatchLayer(home, ['pet-roxy']);
    k = await startKernel(home);
    m = await roxyMounted(k.port, false);
    const probe = await getText(`http://127.0.0.1:${k.port}/`);
    check('禁用 pet-roxy（用户层 disabled 条目）：路由降级为 SPA 兜底', !m && probe.status === 200, `root=${probe.status}`);
    await stopKernel(k.child);

    // ---------- 3. 再启用（移除禁用条目，往返稳定） ----------
    writeUserPatchLayer(home, []);
    k = await startKernel(home);
    m = await roxyMounted(k.port, true);
    check('再启用：roxy 恢复插件 JSON', m);
    await stopKernel(k.child);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('verify crashed:', e);
  process.exit(1);
});
