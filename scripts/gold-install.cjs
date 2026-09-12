'use strict';
/**
 * gold-install.cjs — 金标准安装验证(P41,0.4.2 重打包复测)。
 *   1. NSIS 静默安装到临时目录(/S /D=,免管理员)
 *   2. 递归统计安装产物文件数(基线 47,526)
 *   3. 从安装产物启动内核(temp DSH_HOME),探活(任何合法 HTTP=活,P26)
 *   4. 清理(taskkill + 原生 rd /s /q,不碰 git-bash rm -rf)
 * 用法: node scripts/gold-install.cjs <setup.exe 路径>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

const installer = process.argv[2];
if (!installer || !fs.existsSync(installer)) {
  console.error('usage: node scripts/gold-install.cjs <setup.exe>');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-gold-'));
const installDir = path.join(work, 'app'); // 无空格,NSIS /D 要求
const homeDir = path.join(work, 'dsh-home');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}
function httpStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 4000 }, (res) => {
      const s = res.statusCode; res.resume();
      res.on('end', () => resolve(s));
      res.on('error', () => resolve(-1));
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => { req.destroy(); resolve(-1); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

async function main() {
  console.log('[gold] installer:', installer);
  console.log('[gold] install dir:', installDir);

  // ---- 1. 静默安装(/S /D= 必须是最后一个参数,路径不加引号) ----
  await new Promise((resolve, reject) => {
    const child = spawn(installer, ['/S', '/D=' + installDir], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('installer exit ' + code))));
    child.on('error', reject);
  });
  if (!fs.existsSync(path.join(installDir, 'tt-dsh-desktop.exe'))) {
    console.error('[gold] FAIL: tt-dsh-desktop.exe 未落盘');
    process.exit(1);
  }
  console.log('[gold] PASS: 静默安装完成');

  // ---- 2. 文件数 ----
  // 完整安装产物 = kernel 47,526 + 宠物插件 14 + install-kernel.cjs 1 +
  // WebView2Loader.dll 1 + tt-dsh-desktop.exe 1 + uninstall.exe 1(NSIS 生成)
  // = 47,544。历史文档里的「47,526」只指内核目录,勿混用。
  const n = countFiles(installDir);
  const BASE = 47544;
  console.log(`[gold] ${n === BASE ? 'PASS' : 'WARN'}: 文件数 ${n}(基线 ${BASE}${n === BASE ? ',一致' : ',有差异,需核对'})`);

  // ---- 3. 从安装产物启动内核并探活 ----
  const nodeExe = path.join(installDir, 'kernel', 'node.exe');
  const binJs = path.join(installDir, 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(nodeExe) || !fs.existsSync(binJs)) {
    console.error('[gold] FAIL: 安装产物缺 kernel/node.exe 或 bin.js');
    process.exit(1);
  }
  fs.mkdirSync(homeDir, { recursive: true });
  const logFd = fs.openSync(path.join(homeDir, 'kernel.log'), 'a');
  const port = await getFreePort();
  const child = spawn(nodeExe, [binJs, '--profile', 'web', '--port', String(port)], {
    cwd: installDir,
    env: { ...process.env, DSH_HOME: homeDir },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  let status = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    status = await httpStatus(port);
    if (status >= 200) break;
    if (child.exitCode !== null) break;
  }
  if (status >= 200) {
    console.log(`[gold] PASS: 从安装产物启动内核,HTTP ${status} on ${port}(任何合法 HTTP=活,P26)`);
  } else {
    console.error(`[gold] FAIL: 内核未就绪,last status=${status}`);
    try {
      const tail = fs.readFileSync(path.join(homeDir, 'kernel.log'), 'utf8').split(/\r?\n/).slice(-30).join('\n');
      console.error(tail);
    } catch {}
  }
  try { fs.closeSync(logFd); } catch {}
  await new Promise((r) => execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], () => r()));

  // ---- 4. 清理(原生 rd,不用 git-bash rm) ----
  await new Promise((r) => setTimeout(r, 1200));
  const rd = spawn('cmd', ['/c', 'rd', '/s', '/q', work], { stdio: 'ignore' });
  rd.on('exit', () => console.log('[gold] 清理完成:', work));

  process.exit(status >= 200 ? 0 : 1);
}

main().catch((e) => { console.error('[gold] crashed:', e); process.exit(1); });
