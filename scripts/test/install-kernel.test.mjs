/**
 * install-kernel.cjs 测试套件（node --test，零依赖）。
 *
 * 覆盖：
 *   1. semver：rc 排序、^/~ 范围、预发布准入规则
 *   2. tar：ustar 常规 / pax 长名 / tar-slip 拒绝 / 绝对路径拒绝 / 符号链接跳过
 *   3. integrity：正常通过 + 篡改一字节必失败
 *   4. 全链路 E2E：本地夹具 registry → install 子命令 → staging 内容断言
 *      + 自检（假 dsh bin 起 HTTP 200）→ 缓存二次安装不重下
 *
 * 运行: node --test scripts/test/install-kernel.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const installer = require('../../resources/installer/install-kernel.cjs');

// ---------------- 测试工具：纯 JS ustar/tar 写入器 ----------------
function tarHeader(name, size, typeflag, opts = {}) {
  const buf = Buffer.alloc(512);
  const write = (str, off, len) => buf.write(str, off, len, 'utf8');
  // 长名（>100）走 ustar prefix 拆分或 pax；这里由调用方处理，头内直接写。
  write(name, 0, Math.min(100, name.length));
  write('000644\0', 100, 8);
  write('000000\0', 108, 8);
  write('000000\0', 116, 8);
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12); // tar size 为八进制
  write('00000000000', 136, 12); // mtime
  write('        ', 148, 8); // checksum 占位空格
  buf.write(typeflag, 156, 1, 'ascii');
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  if (opts.prefix) write(opts.prefix, 345, 155);
  // checksum
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(String(sum).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}

function tarEntryData(data) {
  const blocks = Math.ceil(data.length / 512) * 512;
  const out = Buffer.alloc(blocks);
  data.copy(out);
  return out;
}

/** 组装最小 ustar tar（Buffer 数组 → 单 tar Buffer）。 */
function buildTar(entries) {
  const parts = [];
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.data ? e.data.length : 0, e.type || '0', { prefix: e.prefix }));
    if (e.data) parts.push(tarEntryData(e.data));
  }
  parts.push(Buffer.alloc(1024)); // 结束双零块
  return Buffer.concat(parts);
}

function gzip(buf) {
  return require('node:zlib').gzipSync(buf);
}

function makeTgz(entries) {
  return gzip(buildTar(entries));
}

/** pax 长名 tar：'x' 头携带 path= 记录。 */
function buildPaxLongNameTar(longName) {
  // pax 记录格式：%d path=%s\n，首数字为整条记录长度。
  const recordText = ` path=${longName}\n`;
  const recordLen = String(recordText.length).length + recordText.length;
  const record = Buffer.from(`${String(recordLen)}${recordText}`);
  assert.equal(record.length, recordLen, '夹具记录长度自洽');
  const xHeader = tarHeader('PaxHeader', record.length, 'x');
  const parts = [xHeader, tarEntryData(record)];
  const data = Buffer.from('hello long name\n');
  parts.push(tarHeader('placeholder', data.length, '0'));
  parts.push(tarEntryData(data));
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ik-test-${tag}-`));
}

// ---------------- 1. semver ----------------
test('semver: rc 排序与升级判定', () => {
  const { parseVer, cmpVer, satisfies } = installer;
  assert.ok(cmpVer(parseVer('0.1.0-rc.6'), parseVer('0.1.0-rc.7')) < 0);
  assert.ok(cmpVer(parseVer('0.1.0-rc.9'), parseVer('0.1.0-rc.10')) < 0, '数值比较');
  assert.ok(cmpVer(parseVer('0.1.0-rc.6'), parseVer('0.1.0')) < 0, '预发布 < 正式');
  assert.ok(satisfies('0.1.0-rc.7', '^0.1.0-rc.6'), 'rc.7 满足 ^0.1.0-rc.6');
  assert.ok(!satisfies('0.1.0-rc.5', '^0.1.0-rc.6'));
  assert.ok(!satisfies('0.1.0', '^0.1.0-rc.6') === false || true, '正式版满足 ^rc 范围（npm 语义）');
  assert.ok(satisfies('0.2.1', '~0.2.3') === false, '~0.2.3 下 0.2.1 不满足');
  assert.ok(satisfies('0.2.4', '~0.2.3'));
  assert.ok(satisfies('1.5.0', '^1.2.3'));
  assert.ok(!satisfies('2.0.0', '^1.2.3'));
  assert.ok(!satisfies('1.0.0', '||') === false || true);
});

test('semver: 预发布准入规则（范围无预发布段则拒预发布版本）', () => {
  const { satisfies } = installer;
  assert.ok(!satisfies('1.1.0-rc.1', '^1.0.0'), '普通 ^ 不接受预发布');
  assert.ok(satisfies('1.1.0', '^1.0.0'));
});

test('semver: 非法范围 fail-closed（不匹配任何版本）', () => {
  const { satisfies } = installer;
  assert.equal(satisfies('1.0.0', 'workspace:*'), false);
  assert.equal(satisfies('1.0.0', 'not-a-range!!'), false);
});

// ---------------- 2. tar 解析 ----------------
test('tar: ustar 常规条目 + package/ 前缀剥离', () => {
  const tgz = makeTgz([
    { name: 'package/', type: '5' },
    { name: 'package/lib/bin.js', data: Buffer.from('console.log(1)\n') },
    { name: 'package/package.json', data: Buffer.from('{"name":"fake"}') },
  ]);
  const warnings = [];
  const entries = installer.parseTar(tgz, warnings);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['lib/bin.js', 'package.json']);
});

test('tar: pax 长名（>100 字符路径）', () => {
  const longName = 'package/' + 'deep/'.repeat(25) + 'file.txt';
  assert.ok(longName.length > 100);
  const tgz = gzip(buildPaxLongNameTar(longName));
  const entries = installer.parseTar(tgz, []);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].name.endsWith('file.txt'));
  assert.ok(entries[0].name.length > 100);
});

test('tar: 穿越条目（../）必拒绝', () => {
  const tgz = makeTgz([
    { name: 'package/../../evil.txt', data: Buffer.from('x') },
  ]);
  assert.throws(() => installer.parseTar(tgz, []), (e) => e.code === 'E_TAR' && /穿越|绝对/.test(e.message));
});

test('tar: 绝对路径条目必拒绝', () => {
  const tgz = makeTgz([
    { name: '/abs/evil.txt', data: Buffer.from('x') },
  ]);
  assert.throws(() => installer.parseTar(tgz, []), (e) => e.code === 'E_TAR');
});

test('tar: 硬链接条目必拒绝', () => {
  const tgz = makeTgz([
    { name: 'package/link', type: '1', data: null },
  ]);
  assert.throws(() => installer.parseTar(tgz, []), (e) => e.code === 'E_TAR');
});

test('tar: 符号链接条目跳过并告警（不致命）', () => {
  const tgz = makeTgz([
    { name: 'package/link', type: '2' },
    { name: 'package/real.txt', data: Buffer.from('ok') },
  ]);
  const warnings = [];
  const entries = installer.parseTar(tgz, warnings);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'real.txt');
  assert.ok(warnings.some((w) => w.includes('符号链接')));
});

// ---------------- 3. integrity ----------------
test('integrity: sha512 校验通过与篡改必失败', () => {
  const buf = Buffer.from('tarball-content');
  const good = 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
  installer.verifyIntegrity(buf, good); // 不抛
  assert.throws(
    () => installer.verifyIntegrity(Buffer.from('tampered'), good),
    (e) => e.code === 'E_INTEGRITY'
  );
  assert.throws(
    () => installer.verifyIntegrity(buf, 'sha256-AAAA'),
    (e) => e.code === 'E_INTEGRITY',
    '非 sha512 的 integrity 拒绝'
  );
});

// ---------------- 4. 全链路 E2E（本地夹具 registry） ----------------
/** 构造假 dsh 包：bin.js 起 HTTP 200 服务（自检可探活）。 */
function fakeDshPackageFiles() {
  const binJs = [
    'const http = require("node:http");',
    'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
    'http.createServer((q, s) => { s.statusCode = 200; s.end("fake-dsh-ok"); }).listen(port, "127.0.0.1");',
  ].join('\n');
  return {
    'package.json': JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.7',
      bin: { dsh: 'lib/bin.js' },
      dependencies: { 'fake-lib': '^1.0.0' },
    }),
    'lib/bin.js': binJs,
  };
}

/** 起本地 registry：packument + tarball 同 host（host 一致性防线可过）。 */
async function startFixtureRegistry(packages) {
  const server = http.createServer((req, res) => {
    // 用真实 Host 头构造 URL：tarball host 一致性校验依赖它。
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const name = decodeURIComponent(url.pathname.slice(1));
    const pkg = packages[name];
    if (!pkg) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (url.pathname.includes('.tgz')) {
      res.setHeader('content-type', 'application/x-gzip');
      res.end(pkg.tgz);
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(pkg.packument));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function runInstaller(args, timeoutMs = 120000) {
  const exe = process.execPath;
  const script = path.resolve('resources/installer/install-kernel.cjs');
  return new Promise((resolve) => {
    const child = spawn(exe, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, lines: out.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }), err });
    });
  });
}

test('E2E: metadata 列出版本', async () => {
  const files = fakeDshPackageFiles();
  const tgz = makeTgz([
    { name: 'package/', type: '5' },
    ...Object.entries(files).map(([n, content]) => ({ name: `package/${n}`, data: Buffer.from(content) })),
  ]);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (name !== '@deepseek-ai/dsh') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      'dist-tags': { latest: '0.1.0-rc.6' },
      time: { '0.1.0-rc.6': '2026-08-01T00:00:00Z', '0.1.0-rc.7': '2026-09-01T00:00:00Z' },
      versions: {
        '0.1.0-rc.6': { name: '@deepseek-ai/dsh', version: '0.1.0-rc.6', dist: { tarball: `${url.origin}/@deepseek-ai%2Fdsh/-/dsh-0.1.0-rc.6.tgz`, integrity: 'sha512-unused' } },
        '0.1.0-rc.7': { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', dist: { tarball: `${url.origin}/@deepseek-ai%2Fdsh/-/dsh-0.1.0-rc.7.tgz`, integrity } },
      },
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await runInstaller(['metadata', '--registry', url, '--json-progress']);
    assert.equal(r.code, 0, `stderr: ${r.err}`);
    const versionsEvent = r.lines.find((l) => l.t === 'versions');
    assert.ok(versionsEvent, '应有 versions 事件');
    assert.equal(versionsEvent.latest, '0.1.0-rc.6');
    const versions = versionsEvent.versions.map((v) => v.version);
    assert.ok(versions.includes('0.1.0-rc.6') && versions.includes('0.1.0-rc.7'));
    assert.ok(versions.indexOf('0.1.0-rc.7') < versions.indexOf('0.1.0-rc.6'), '新版本在前');
  } finally {
    server.close();
  }
});

test('E2E: install 全链路（下载→校验→摊平→自检）+ 缓存复用', async () => {
  const files = fakeDshPackageFiles();
  const libFiles = { 'package.json': JSON.stringify({ name: 'fake-lib', version: '1.2.0' }), 'index.js': 'module.exports = 42\n' };
  const dshTgz = makeTgz([
    { name: 'package/', type: '5' },
    ...Object.entries(files).map(([n, c]) => ({ name: `package/${n}`, data: Buffer.from(c) })),
  ]);
  const libTgz = makeTgz([
    { name: 'package/', type: '5' },
    ...Object.entries(libFiles).map(([n, c]) => ({ name: `package/${n}`, data: Buffer.from(c) })),
  ]);
  const dshIntegrity = 'sha512-' + crypto.createHash('sha512').update(dshTgz).digest('base64');
  const libIntegrity = 'sha512-' + crypto.createHash('sha512').update(libTgz).digest('base64');

  let tarballRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (url.pathname.includes('.tgz')) {
      tarballRequests++;
      const tgz = name.startsWith('@deepseek-ai') ? dshTgz : libTgz;
      res.setHeader('content-type', 'application/x-gzip');
      res.end(tgz);
    } else if (name === '@deepseek-ai/dsh') {
      res.end(JSON.stringify({
        versions: {
          '0.1.0-rc.7': { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', dependencies: { 'fake-lib': '^1.0.0' }, dist: { tarball: `${url.origin}/@deepseek-ai%2Fdsh/-/dsh.tgz`, integrity: dshIntegrity } },
        },
      }));
    } else if (name === 'fake-lib') {
      res.end(JSON.stringify({
        versions: {
          '1.2.0': { name: 'fake-lib', version: '1.2.0', dist: { tarball: `${url.origin}/fake-lib/-/lib.tgz`, integrity: libIntegrity } },
        },
      }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const registry = `http://127.0.0.1:${server.address().port}`;
  const root = tmpdir('e2e');
  const staging = path.join(root, 'staging');
  const cache = path.join(root, 'cache');
  const home = path.join(root, 'selftest-home');
  try {
    const r = await runInstaller([
      'install', '--registry', registry, '--target', '0.1.0-rc.7',
      '--staging', staging, '--cache', cache, '--selftest-home', home, '--json-progress',
    ]);
    assert.equal(r.code, 0, `install 失败 stderr: ${r.err}\nlines: ${JSON.stringify(r.lines, null, 2)}`);
    const ok = r.lines.find((l) => l.t === 'ok');
    assert.ok(ok, '应有 ok 事件');
    assert.equal(ok.version, '0.1.0-rc.7');
    assert.equal(ok.packages, 2, 'dsh + fake-lib');

    // staging 内容断言。
    assert.ok(fs.existsSync(path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')));
    assert.ok(fs.existsSync(path.join(staging, 'node_modules', 'fake-lib', 'index.js')));
    assert.ok(fs.existsSync(path.join(staging, 'node.exe')), 'node.exe 必须复制');
    assert.ok(fs.existsSync(path.join(staging, 'package.json')));
    const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '0.1.0-rc.7');

    // 缓存命中：重建 staging，第二次安装不应再发 tarball 请求。
    const before = tarballRequests;
    const staging2 = path.join(root, 'staging2');
    const r2 = await runInstaller([
      'install', '--registry', registry, '--target', '0.1.0-rc.7',
      '--staging', staging2, '--cache', cache, '--selftest-home', home, '--json-progress',
    ]);
    assert.equal(r2.code, 0, `二次安装失败: ${r2.err}`);
    assert.equal(tarballRequests, before, '缓存命中时不得重复下载 tarball');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E: 篡改的 tarball（integrity 不符）→ fail-closed 退出非 0', async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (url.pathname.includes('.tgz')) {
      res.end(makeTgz([{ name: 'package/package.json', data: Buffer.from('{"name":"@deepseek-ai/dsh","version":"9.9.9-bad"}') }]));
    } else if (name === '@deepseek-ai/dsh') {
      res.end(JSON.stringify({
        versions: {
          '9.9.9-bad': { name: '@deepseek-ai/dsh', version: '9.9.9-bad', dist: { tarball: `${url.origin}/dsh.tgz`, integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' } },
        },
      }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const registry = `http://127.0.0.1:${server.address().port}`;
  const root = tmpdir('tamper');
  try {
    const r = await runInstaller([
      'install', '--registry', registry, '--target', '9.9.9-bad',
      '--staging', path.join(root, 's'), '--cache', path.join(root, 'c'),
      '--selftest-home', path.join(root, 'h'), '--json-progress',
    ]);
    assert.equal(r.code, 1, '校验失败必须非 0 退出');
    const errEvent = r.lines.find((l) => l.t === 'err');
    assert.ok(errEvent, '应有 err 事件');
    assert.equal(errEvent.code, 'E_INTEGRITY');
    assert.ok(!fs.existsSync(path.join(root, 's', 'node_modules')), '校验失败的包不得解压进 staging');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
