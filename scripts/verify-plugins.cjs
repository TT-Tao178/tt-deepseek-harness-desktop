/**
 * verify-plugins.cjs — v8 插件机制集成验证（门 6，v8.2 随 P46 修订）。
 *
 * 模拟应用真实启动路径，验证「全挂载 + 同 id disabled 一票否决」机制：
 *   1. junction + --patch → / 200 且
 *      /dsh-pet-roxy/config 返回插件 JSON（body 含 config.expressions）
 *   2. 追加**末位** --patch 禁用覆盖层（P46：rc.6 内核叠层顺序为
 *      bundle → 用户层 → --patch 覆盖层，argv 顺序最后者胜；写在用户层的
 *      disabled 条目会被插件自己的 insert 覆盖而失效，故壳以末位覆盖层
 *      投递禁用）→ 重启 → / 200 且 roxy 路由返回 SPA HTML（不再是插件 JSON）
 *   3. 撤掉禁用覆盖层 → 重启 → roxy 恢复插件 JSON（往返稳定）
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

/** 写壳格式的禁用覆盖层文件（与 shell-core::write_user_patch_layer 同格式）。 */
function writeDisableOverlay(home, disabledIds) {
  const p = path.join(home, 'ttshell-disabled.patch.yml');
  let body = '# verify-plugins 生成\n';
  body += disabledIds.length
    ? disabledIds.map((id) => `- id: ${id}\n  disabled: true\n`).join('')
    : '[]\n';
  fs.writeFileSync(p, body);
  return p;
}

/** 启动内核并等待就绪；patchArgs 为 --patch 参数序列（不含 --port）。 */
async function startKernel(home, patchArgs) {
  const port = await freePort();
  const args = [BIN_JS, '--profile', 'web', ...patchArgs, '--port', String(port)];
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
  check('内核与插件就位', fs.existsSync(KERNEL_NODE) && fs.existsSync(path.join(PLUGINS, 'dsh-pet-roxy', 'cordis.patch.yml')));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plugins-'));
  const home = path.join(tmp, 'dsh-home');
  const nm = path.join(home, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  const patchRoxy = path.join(PLUGINS, 'dsh-pet-roxy', 'cordis.patch.yml');

  // junction：valid 全集（与壳 discover→junction_targets 同布局）。
  mklinkJunction(path.join(nm, 'dsh-pet-roxy'), path.join(PLUGINS, 'dsh-pet-roxy'));
  check('junction 建立（dsh-pet-roxy）', fs.existsSync(path.join(nm, 'dsh-pet-roxy')));

  try {
    // ---------- 1. 全启用（无禁用覆盖层） ----------
    let k = await startKernel(home, ['--patch', patchRoxy]);
    let m = await roxyMounted(k.port, true);
    check('全启用：roxy 路由返回插件 JSON', m);
    await stopKernel(k.child);

    // ---------- 2. 末位禁用覆盖层（P46 机制） ----------
    // roxyMounted(port,false) 在「路由已降级=禁用生效」时返回 true；
    // 旧版此处写 !m，等于只有禁用失败（8s 超时）才判 PASS——历史假绿，
    // 掩盖了 rc.6 用户层禁用失效（P46）。已修正。
    const disableLayer = writeDisableOverlay(home, ['pet-roxy']);
    k = await startKernel(home, ['--patch', patchRoxy, '--patch', disableLayer]);
    m = await roxyMounted(k.port, false);
    const probe = await getText(`http://127.0.0.1:${k.port}/`);
    check('末位禁用覆盖层：路由降级为 SPA 兜底', m && probe.status === 200, `root=${probe.status}`);
    await stopKernel(k.child);

    // ---------- 3. 再启用（撤掉禁用覆盖层，往返稳定） ----------
    k = await startKernel(home, ['--patch', patchRoxy]);
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
