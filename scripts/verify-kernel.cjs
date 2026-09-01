'use strict';
/**
 * verify-kernel.cjs — start the kernel standalone and confirm it serves HTTP 200.
 *
 *   1. grab a free port via node:net (listen 0 -> read port -> close)
 *   2. fresh DSH_HOME at <root>/.kernel-test-home (removed first)
 *   3. spawn kernel/node.exe kernel/node_modules/@deepseek-ai/dsh/lib/bin.js
 *      --profile web --port <port>, stdio = [ignore, logFd, logFd]
 *      (logFd = append fd to .kernel-test-home/kernel.log), windowsHide: true
 *   4. poll GET http://127.0.0.1:<port>/ until HTTP 200 (max 60 x 500 ms)
 *   5. always: taskkill /T /F /PID <pid>, delete .kernel-test-home
 *   6. on failure: print last 40 lines of kernel.log
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const homeDir = path.join(root, '.kernel-test-home');
const logPath = path.join(homeDir, 'kernel.log');
const nodeExe = path.join(root, 'kernel', 'node.exe');
const binJs = path.join(root, 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

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

function httpGet(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 4000 }, (res) => {
      const status = res.statusCode;
      res.resume();
      res.on('end', () => resolve(status));
      res.on('error', () => resolve(-1));
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => { req.destroy(); resolve(-1); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastLines(fp, n) {
  try {
    const txt = fs.readFileSync(fp, 'utf8');
    const lines = txt.split(/\r?\n/);
    return lines.slice(-n).join('\n');
  } catch { return '(log unreadable)'; }
}

async function main() {
  if (!fs.existsSync(nodeExe)) { console.error(`FAIL: missing ${nodeExe}`); process.exit(1); }
  if (!fs.existsSync(binJs)) { console.error(`FAIL: missing ${binJs}`); process.exit(1); }

  const port = await getFreePort();
  console.log(`[verify] free port: ${port}`);

  // fresh DSH_HOME
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const logFd = fs.openSync(logPath, 'a');

  const t0 = Date.now();
  const child = spawn(nodeExe, [binJs, '--profile', 'web', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, DSH_HOME: homeDir },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  const pid = child.pid;
  let settled = false;
  child.on('error', (err) => {
    if (!settled) console.error(`[verify] spawn error: ${err.message}`);
  });
  child.on('exit', (code, sig) => {
    if (!settled) console.error(`[verify] process exited early: code=${code} sig=${sig}`);
  });

  const kill = () => new Promise((resolve) => {
    if (settled) return resolve();
    settled = true;
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => resolve());
  });

  let status = -1;
  let attempts = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    attempts++;
    status = await httpGet(port);
    if (status === 200) break;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  try { fs.closeSync(logFd); } catch {}

  if (status === 200) {
    console.log(`[verify] OK: HTTP 200 on port ${port} after ${elapsed}s (${attempts} polls)`);
  } else {
    console.error(`[verify] FAIL: last HTTP status=${status === -1 ? 'no-response' : status} after ${elapsed}s (${attempts} polls), port=${port}`);
    console.error('--- last 40 lines of kernel.log ---');
    console.error(lastLines(logPath, 40));
  }

  await kill();
  fs.rmSync(homeDir, { recursive: true, force: true });
  process.exit(status === 200 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[verify] unexpected error: ${err && err.stack ? err.stack : err}`);
  try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
