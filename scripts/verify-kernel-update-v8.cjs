/**
 * verify-kernel-update-v8.cjs — v8 内核更新管线集成验证（门 5）。
 *
 * 覆盖：
 *   1. 用【内核自带 node.exe】（真实运行时，非开发机 node）跑 install 全链路：
 *      本地夹具 registry → 下载 → sha512 → 摊平 → 自检（HTTP 200）→ ok
 *   2. 篡改 tarball → fail-closed（退出非 0，staging 无残留包）
 *   3. 真网 npmmirror metadata：版本列表包含当前已装版本（可跳过 --offline）
 *
 * 运行: node scripts/verify-kernel-update-v8.cjs [--offline]
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const KERNEL_NODE = path.join(ROOT, 'kernel', 'node.exe');
const INSTALLER = path.join(ROOT, 'resources', 'installer', 'install-kernel.cjs');
const OFFLINE = process.argv.includes('--offline');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

// ---- 最小 ustar 写入器（size 八进制） ----
function tarHeader(name, size, typeflag) {
  const buf = Buffer.alloc(512);
  const w = (s, o, l) => buf.write(s, o, l, 'utf8');
  w(name, 0, Math.min(100, name.length));
  w('000644\0', 100, 8);
  w('000000\0', 108, 8);
  w('000000\0', 116, 8);
  w(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  w('00000000000', 136, 12);
  w('        ', 148, 8);
  buf.write(typeflag, 156, 1, 'ascii');
  w('ustar\0', 257, 6);
  w('00', 263, 2);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(String(sum).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}
function makeTgz(files) {
  const parts = [];
  parts.push(tarHeader('package/', 0, '5'));
  for (const [n, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    parts.push(tarHeader(`package/${n}`, data.length, '0'));
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    parts.push(padded);
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
const sha512sri = (buf) => 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');

function runInstaller(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(KERNEL_NODE, [INSTALLER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      const lines = out.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      resolve({ code, lines, err });
    });
  });
}

async function main() {
  check('kernel node.exe 存在', fs.existsSync(KERNEL_NODE), KERNEL_NODE);

  // ---------- 夹具 registry（假 dsh：自检可探活 + 一个依赖包） ----------
  const binJs = [
    'const http = require("node:http");',
    'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
    'http.createServer((q, s) => { s.statusCode = 200; s.end("fake-dsh-ok"); }).listen(port, "127.0.0.1");',
  ].join('\n');
  const dshFiles = {
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.9', dependencies: { 'fake-lib': '^1.0.0' } }),
    'lib/bin.js': binJs,
    'lib/index.js': 'module.exports = {}\n',
  };
  const libFiles = { 'package.json': JSON.stringify({ name: 'fake-lib', version: '1.4.2' }), 'index.js': 'module.exports=1\n' };
  const dshTgz = makeTgz(dshFiles);
  const libTgz = makeTgz(libFiles);
  const dshIri = sha512sri(dshTgz);
  const libIri = sha512sri(libTgz);

  let tarballReqs = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (url.pathname.includes('.tgz')) {
      tarballReqs++;
      res.setHeader('content-type', 'application/x-gzip');
      res.end(name.startsWith('@deepseek-ai') ? dshTgz : libTgz);
    } else if (name === '@deepseek-ai/dsh') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        'dist-tags': { latest: '0.1.0-rc.9' },
        versions: {
          '0.1.0-rc.9': { name: '@deepseek-ai/dsh', version: '0.1.0-rc.9', dependencies: { 'fake-lib': '^1.0.0' }, dist: { tarball: `${url.origin}/@deepseek-ai%2Fdsh/-/dsh.tgz`, integrity: dshIri } },
        },
      }));
    } else if (name === 'fake-lib') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        versions: { '1.4.2': { name: 'fake-lib', version: '1.4.2', dist: { tarball: `${url.origin}/fake-lib/-/lib.tgz`, integrity: libIri } } },
      }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const registry = `http://127.0.0.1:${server.address().port}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-kupdate-'));
  const staging = path.join(tmp, 'kernel-staging', '0.1.0-rc.9');
  const cache = path.join(tmp, 'kernel-cache');
  const home = path.join(tmp, 'selftest-home');

  try {
    // ---------- 1. 全链路（内核 node.exe 运行时） ----------
    const r1 = await runInstaller([
      'install', '--registry', registry, '--target', '0.1.0-rc.9',
      '--staging', staging, '--cache', cache, '--selftest-home', home, '--json-progress',
    ]);
    const ok1 = r1.code === 0 && r1.lines.some((l) => l.t === 'ok' && l.version === '0.1.0-rc.9');
    check('全链路 install（内核 node.exe + 自检 200）', ok1, ok1 ? '' : `code=${r1.code} err=${r1.err.slice(0, 300)}`);
    check('staging 布局完整（bin.js / 依赖 / node.exe / package.json）',
      fs.existsSync(path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      && fs.existsSync(path.join(staging, 'node_modules', 'fake-lib', 'index.js'))
      && fs.existsSync(path.join(staging, 'node.exe'))
      && fs.existsSync(path.join(staging, 'package.json')));

    // ---------- 2. 缓存复用 ----------
    const before = tarballReqs;
    const staging2 = path.join(tmp, 'staging2');
    const r2 = await runInstaller([
      'install', '--registry', registry, '--target', '0.1.0-rc.9',
      '--staging', staging2, '--cache', cache, '--selftest-home', home, '--json-progress',
    ]);
    check('缓存命中（二次安装 0 tarball 请求 + 成功）', r2.code === 0 && tarballReqs === before, `tarballReqs=${tarballReqs}`);

    // ---------- 3. 篡改 → fail-closed ----------
    const badServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const name = decodeURIComponent(url.pathname.slice(1));
      if (url.pathname.includes('.tgz')) {
        res.end(makeTgz({ 'package.json': '{"name":"@deepseek-ai/dsh","version":"9.9.9"}', 'evil.js': 'payload' }));
      } else if (name === '@deepseek-ai/dsh') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          versions: { '9.9.9': { name: '@deepseek-ai/dsh', version: '9.9.9', dist: { tarball: `${url.origin}/dsh.tgz`, integrity: dshIri } } },
        }));
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise((r) => badServer.listen(0, '127.0.0.1', r));
    const badRegistry = `http://127.0.0.1:${badServer.address().port}`;
    const r3 = await runInstaller([
      'install', '--registry', badRegistry, '--target', '9.9.9',
      '--staging', path.join(tmp, 'staging-bad'), '--cache', path.join(tmp, 'cache-bad'),
      '--selftest-home', path.join(tmp, 'home-bad'), '--json-progress',
    ], 60000);
    const errEv = r3.lines.find((l) => l.t === 'err');
    check('篡改 tarball → E_INTEGRITY fail-closed（非 0 退出）',
      r3.code !== 0 && errEv && errEv.code === 'E_INTEGRITY',
      errEv ? errEv.code : `code=${r3.code}`);
    check('校验失败无解压残留', !fs.existsSync(path.join(tmp, 'staging-bad', 'node_modules')));
    badServer.close();

    // ---------- 4. 真网 metadata（可选） ----------
    if (!OFFLINE) {
      const r4 = await runInstaller(['metadata', '--registry', 'https://registry.npmmirror.com', '--json-progress'], 30000);
      const vEv = r4.lines.find((l) => l.t === 'versions');
      const cur = '0.1.0-rc.6';
      const has = vEv && (vEv.versions || []).some((v) => v.version === cur);
      check('真网 npmmirror metadata（版本列表含当前已装版本）', r4.code === 0 && has,
        vEv ? `${(vEv.versions || []).length} 个版本, latest=${vEv.latest}` : 'no versions');
    } else {
      console.log('SKIP  真网 metadata（--offline）');
    }
  } finally {
    server.close();
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
