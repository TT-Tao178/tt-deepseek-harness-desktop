#!/usr/bin/env node
/**
 * install-kernel.cjs — DSH 内核安装器（零 npm 依赖，随包 node.exe 执行）。
 *
 * 子命令:
 *   metadata --registry <url>
 *       输出 {"t":"versions","latest":..,"versions":[{version,time}]} 后退出。
 *   install --registry <url> --target <ver> --staging <dir> --cache <dir>
 *           [--selftest-home <dir>] [--selftest-port <port>] --json-progress
 *       闭包解析 → 下载(sha512 fail-closed) → 解压摊平 → 复制 node.exe →
 *       staging 自检 → {"t":"ok"} 退出码 0。
 *
 * 安全立场（fail-closed）:
 *   - tarball host 必须与 registry host 一致（防元数据投毒导流）；
 *   - dist.integrity sha512-base64 校验不过不落盘不解压；
 *   - tar 条目拒绝绝对路径 / ".." / 硬链接；符号链接跳过并 warn；
 *   - 不执行任何包生命周期脚本（纯解压）；
 *   - 单包 ≤300MB、包内文件 ≤50000、总量 ≤1.5GB。
 *
 * 进度协议: stdout 每行一个 JSON（--json-progress 开启时）。
 * 错误码: E_REGISTRY E_NETWORK E_SEMVER E_INTEGRITY E_TAR E_DISK E_SELFTEST E_TIMEOUT
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// ---------- 常量与上限 ----------
const MAX_SINGLE_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1536 * 1024 * 1024;
const MAX_FILES_PER_PACKAGE = 50000;
const FETCH_TIMEOUT_MS = 30000;
const SELFTEST_TIMEOUT_MS = 60000;

// ---------- 进度输出 ----------
let JSON_PROGRESS = false;
function emit(obj) {
  if (JSON_PROGRESS) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
}
function emitErr(code, detail, pkg) {
  const o = { t: 'err', code, detail };
  if (pkg) o.pkg = pkg;
  emit(o);
  process.stderr.write(`install-kernel: ${code}${pkg ? ' (' + pkg + ')' : ''}: ${detail}\n`);
}

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------- semver（解析 / 比较 / 范围） ----------
function parseVer(s) {
  if (typeof s !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.') : [];
  if (pre.some((x) => x === '')) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre, raw: s.trim() };
}

function cmpVer(a, b) {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  const ap = a.pre, bp = b.pre;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // 正式 > 预发布
  if (bp.length === 0) return -1;
  for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i];
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    let c;
    if (xn && yn) c = +x - +y;
    else if (xn) c = -1; // 数字 < 字母
    else if (yn) c = 1;
    else c = x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return c;
  }
  return ap.length - bp.length;
}

function eqVer(a, b) { return cmpVer(a, b) === 0; }
function gteVer(a, b) { return cmpVer(a, b) >= 0; }
function ltVer(a, b) { return cmpVer(a, b) < 0; }

/** 单比较子句（[op]version）匹配判定。 */
function matchComparator(ver, clause) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(.+)$/.exec(clause.trim());
  if (!m) throw new Error(`bad comparator: ${clause}`);
  const op = m[1] || '=';
  const base = parseVer(m[2]);
  if (!base) throw new Error(`bad version in range: ${clause}`);
  if (op === '*') return true;
  switch (op) {
    case '=': return eqVer(ver, base);
    case '>': return cmpVer(ver, base) > 0;
    case '<': return ltVer(ver, base);
    case '>=': return gteVer(ver, base);
    case '<=': return cmpVer(ver, base) <= 0;
    case '^': {
      // ^x.y.z → >=x.y.z 且 <上界（x>0: 同主版本；x=0,y>0: 同主.次；0.0.z: 仅补丁位）。
      if (!gteVer(ver, base)) return false;
      if (base.major > 0) return ver.major === base.major;
      if (base.minor > 0) return ver.major === 0 && ver.minor === base.minor;
      return ver.major === 0 && ver.minor === 0 && ver.patch === base.patch;
    }
    case '~': {
      if (ver.major !== base.major || ver.minor !== base.minor) return false;
      return gteVer(ver, base);
    }
    default: return false;
  }
}

/** npm 语义：版本带预发布时，范围必须含同 [M,m,p] 的预发布比较子句。 */
function prereleaseAllowed(ver, clauses) {
  if (ver.pre.length === 0) return true;
  return clauses.some((c) => {
    const m = /^(?:\^|~|>=|<=|>|<|=)?\s*v?(.+)$/.exec(c.trim());
    if (!m) return false;
    const base = parseVer(m[1]);
    return !!(base && base.pre.length > 0 && base.major === ver.major && base.minor === ver.minor && base.patch === ver.patch);
  });
}

/** range 匹配：支持 || 分支、AND 组合、^ ~ >= <= > < = * latest。 */
function satisfies(version, range) {
  const ver = parseVer(version);
  if (!ver) return false;
  const rangeStr = String(range).trim();
  if (rangeStr === '' || rangeStr === '*' || rangeStr === 'latest' || rangeStr === 'x') return !ver.pre.length || true;
  for (const branch of rangeStr.split('||')) {
    const tokens = branch.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    try {
      const all = tokens.every((tk) => matchComparator(ver, tk === '*' ? '=' + version : tk));
      if (all && prereleaseAllowed(ver, tokens)) return true;
    } catch {
      /* 本分支语法不识别 → 视为不匹配 */
    }
  }
  return false;
}

// ---------- registry 客户端 ----------
function registryHost(registryUrl) {
  return new URL(registryUrl).host;
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取包的完整 packument（全部版本元数据）。 */
async function fetchPackument(registry, name) {
  const url = `${registry.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
  return fetchJson(url);
}

/** 在 packument 中挑满足 range 的最大版本清单；无 → null。 */
function pickVersion(packument, range) {
  const versions = packument && packument.versions;
  if (!versions || typeof versions !== 'object') return null;
  let best = null;
  for (const [v, manifest] of Object.entries(versions)) {
    const parsed = parseVer(v);
    if (!parsed) continue;
    if (!satisfies(v, range)) continue;
    if (best === null || cmpVer(parsed, parseVer(best.version)) > 0) {
      best = { version: v, manifest };
    }
  }
  return best;
}

// ---------- 完整性校验（SRI sha512-base64，fail-closed） ----------
function verifyIntegrity(buf, integrity) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw Object.assign(new Error('manifest 缺少 sha512 integrity'), { code: 'E_INTEGRITY' });
  }
  const expected = integrity.slice('sha512-'.length);
  const actual = crypto.createHash('sha512').update(buf).digest('base64');
  if (actual !== expected) {
    throw Object.assign(new Error(`sha512 不匹配 (期望 ${expected.slice(0, 12)}.., 实得 ${actual.slice(0, 12)}..)`), { code: 'E_INTEGRITY' });
  }
}

// ---------- tar 解析（ustar / gnu longname / pax；fail-closed） ----------
/**
 * 解析 .tgz Buffer，返回条目数组 [{header, name, type, data:Buffer|null}]。
 * 拒绝：绝对路径、`..`、反斜杠、硬链接；符号链接跳过（warn）。
 */
function parseTar(tgzBuf, warnings) {
  let buf;
  try {
    buf = zlib.gunzipSync(tgzBuf);
  } catch (e) {
    throw Object.assign(new Error(`gzip 解压失败: ${e.message}`), { code: 'E_TAR' });
  }
  const entries = [];
  let off = 0;
  let pendingName = null; // gnu 'L' / pax 'x' 的覆盖名
  let totalBytes = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) {
      off += 512;
      continue; // 结束块填充
    }
    let name = pendingName !== null ? pendingName : readTarString(header, 0, 100);
    pendingName = null;
    const prefix = readTarString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = readTarOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    off += 512;

    if (typeflag === 'x' || typeflag === 'X') {
      // pax 扩展头：提取 path= 记录覆盖下一个条目名。
      const content = buf.subarray(off, off + size);
      const text = content.toString('utf8');
      const pm = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(text);
      if (pm) pendingName = pm[1];
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeflag === 'L') {
      // gnu 长名：内容即下一个条目名。
      pendingName = buf.subarray(off, off + size).toString('utf8').replace(/\0+$/, '');
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeflag === 'g') { // pax 全局头，忽略
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeflag === '1') {
      throw Object.assign(new Error(`tar 含硬链接条目 ${name}（拒绝）`), { code: 'E_TAR' });
    }
    if (typeflag === '2') {
      warnings.push(`符号链接 ${name} 跳过`);
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    const isDir = typeflag === '5';
    const data = isDir ? null : buf.subarray(off, off + size);
    if (!isDir && data.length !== size) {
      throw Object.assign(new Error(`tar 截断: ${name}`), { code: 'E_TAR' });
    }
    off += Math.ceil(size / 512) * 512;
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw Object.assign(new Error('tar 总量超上限'), { code: 'E_DISK' });
    }
    const norm = normalizeTarName(name);
    if (norm === '') continue; // 包根目录条目（package/）→ 无需落盘
    entries.push({ name: norm, type: isDir ? 'dir' : 'file', data });
  }
  return entries;
}

function readTarString(header, offset, length) {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8').trim();
}

function readTarOctal(header, offset, length) {
  const raw = header.subarray(offset, offset + length).toString('ascii').replace(/[\0 ]+$/g, '').trim();
  if (raw === '') return 0;
  return parseInt(raw, 8) || 0;
}

/** 净化 tar 条目名：拒绝穿越/绝对路径；正常返回去 `package/` 前缀的相对路径。 */
function normalizeTarName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (path.posix.isAbsolute(n) || /^[a-zA-Z]:/.test(n)) {
    throw Object.assign(new Error(`tar 条目为绝对路径: ${name}`), { code: 'E_TAR' });
  }
  let rel = n;
  // npm 包 tarball 顶层固定为 package/，去掉该公共前缀。
  if (rel === 'package' || rel.startsWith('package/')) rel = rel.slice('package'.length).replace(/^\//, '');
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw Object.assign(new Error(`tar 条目穿越: ${name}`), { code: 'E_TAR' });
  }
  return parts.join('/');
}

// ---------- 下载（缓存 + 校验，全部 fail-closed） ----------
function cachePath(cacheDir, name, version) {
  return path.join(cacheDir, name.replace(/[^A-Za-z0-9._@/-]/g, '_'), version, 'package.tgz');
}

async function downloadTarball(registry, manifest, cacheDir, onProgress) {
  const name = manifest.name;
  const version = manifest.version;
  const tarballUrl = manifest.dist && manifest.dist.tarball;
  const integrity = manifest.dist && manifest.dist.integrity;
  if (!tarballUrl || !integrity) {
    throw Object.assign(new Error('manifest 缺少 dist.tarball/integrity'), { code: 'E_REGISTRY', pkg: name });
  }
  // 投毒防线：tarball 必须与 registry 同 host。
  if (new URL(tarballUrl).host !== registryHost(registry)) {
    throw Object.assign(
      new Error(`tarball host 与 registry 不一致: ${tarballUrl}`),
      { code: 'E_REGISTRY', pkg: name }
    );
  }
  const cPath = cachePath(cacheDir, name, version);
  let buf = null;
  if (fs.existsSync(cPath)) {
    buf = fs.readFileSync(cPath);
    try {
      verifyIntegrity(buf, integrity); // 缓存命中也要过校验
    } catch (e) {
      buf = null; // 缓存损坏 → 重下
    }
  }
  if (buf === null) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS * 4);
    try {
      const res = await fetch(tarballUrl, { signal: ctrl.signal });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'E_NETWORK', pkg: name });
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (e.code) throw e;
      throw Object.assign(new Error(`下载失败: ${e.message}`), { code: 'E_NETWORK', pkg: name });
    } finally {
      clearTimeout(timer);
    }
    if (buf.length > MAX_SINGLE_PACKAGE_BYTES) {
      throw Object.assign(new Error(`包体积超上限 (${buf.length})`), { code: 'E_DISK', pkg: name });
    }
    verifyIntegrity(buf, integrity); // 不过不落盘
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(cPath, buf);
  }
  if (onProgress) onProgress();
  return buf;
}

// ---------- 摊平（解压到 node_modules/<name>） ----------
function extractToStaging(tgzBuf, name, stagingDir, counters) {
  const warnings = [];
  const entries = parseTar(tgzBuf, warnings);
  const target = path.join(stagingDir, 'node_modules', ...name.split('/'));
  let files = 0;
  for (const entry of entries) {
    if (entry.name === '') continue;
    const dest = path.join(target, ...entry.name.split('/'));
    const destNorm = path.normalize(dest);
    if (!destNorm.startsWith(path.normalize(target) + path.sep) && destNorm !== path.normalize(target)) {
      throw Object.assign(new Error(`条目逃逸目标目录: ${entry.name}`), { code: 'E_TAR' });
    }
    if (entry.type === 'dir') {
      fs.mkdirSync(dest, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.data);
      files++;
      if (files > MAX_FILES_PER_PACKAGE) {
        throw Object.assign(new Error('包内文件数超上限'), { code: 'E_DISK', pkg: name });
      }
    }
  }
  counters.files += files;
  counters.bytes += entries.reduce((s, e) => s + (e.data ? e.data.length : 0), 0);
  return warnings;
}

// ---------- 依赖闭包 BFS ----------
async function resolveClosure(registry, rootName, rootRange, onEvent) {
  const resolved = new Map(); // name -> {version, manifest}
  const queue = [{ name: rootName, range: rootRange }];
  const fetchErrors = [];
  while (queue.length > 0) {
    const { name, range } = queue.shift();
    if (resolved.has(name)) {
      const r = resolved.get(name);
      if (!satisfies(r.version, range)) {
        onEvent({ t: 'warn', detail: `${name} 已解析 ${r.version} 不满足新范围 ${range}（扁平布局保留先解析版本）` });
      }
      continue;
    }
    let packument;
    try {
      packument = await fetchPackument(registry, name);
    } catch (e) {
      fetchErrors.push(`${name}: ${e.message}`);
      continue;
    }
    const pick = pickVersion(packument, range);
    if (!pick) {
      throw Object.assign(
        new Error(`找不到满足 ${name}@${range} 的版本`),
        { code: 'E_SEMVER', pkg: name }
      );
    }
    resolved.set(name, { version: pick.version, manifest: pick.manifest });
    onEvent({ t: 'resolve', packages: resolved.size, name });
    const deps = {
      ...(pick.manifest.dependencies || {}),
      ...(pick.manifest.peerDependencies || {}),
    };
    for (const [depName, depRange] of Object.entries(deps)) {
      if (!resolved.has(depName)) queue.push({ name: depName, range: depRange });
    }
  }
  if (resolved.size === 0) {
    throw Object.assign(new Error(`闭包解析全失败: ${fetchErrors.join('; ')}`), { code: 'E_NETWORK' });
  }
  if (fetchErrors.length > 0) {
    onEvent({ t: 'warn', detail: `部分包拉取失败（未进闭包）: ${fetchErrors.join('; ')}` });
  }
  return resolved;
}

// ---------- 自检（staging 内核在临时端口自举） ----------
function reservePort() {
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

async function selfTest(stagingDir, homeDir, port) {
  const binJs = path.join(stagingDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(binJs)) {
    throw Object.assign(new Error(`staging 缺少内核入口 ${binJs}`), { code: 'E_SELFTEST' });
  }
  const child = spawn(process.execPath, [binJs, '--profile', 'web', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: homeDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });
  const deadline = Date.now() + SELFTEST_TIMEOUT_MS;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break; // 进程先退了 → 起不来
    try {
      // 手动 AbortController（部分 node 版本 AbortSignal.timeout 在退出期有 libuv 崩溃前科）。
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
        if (res.ok) { healthy = true; clearTimeout(timer); break; }
      } finally {
        clearTimeout(timer);
      }
    } catch { /* 未就绪继续轮询 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  // 清理进程树（Windows 下 node 可能再拉子进程，用 taskkill 兜底）。
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 100)); // 让 taskkill 启动后再退出
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 尽力而为 */ }
  if (!healthy) {
    throw Object.assign(
      new Error(`自检未通过（进程退出码 ${child.exitCode}）\n${stderrTail}`),
      { code: 'E_SELFTEST' }
    );
  }
}

// ---------- 子命令实现 ----------
async function cmdMetadata(registry) {
  emit({ t: 'phase', phase: 'resolving' });
  const packument = await fetchPackument(registry, '@deepseek-ai/dsh');
  const versions = Object.keys(packument.versions || {})
    .map((v) => ({ version: v, time: (packument.time && packument.time[v]) || undefined }))
    .sort((a, b) => cmpVer(parseVer(b.version), parseVer(a.version)));
  if (versions.length === 0) {
    throw Object.assign(new Error('registry 无版本数据'), { code: 'E_REGISTRY' });
  }
  const latest = (packument['dist-tags'] && packument['dist-tags'].latest) || versions[0].version;
  emit({ t: 'versions', latest, versions });
  emit({ t: 'ok', version: latest, packages: versions.length, ms: 0 });
}

async function cmdInstall(args) {
  const registry = args.registry;
  const target = args.target;
  const stagingDir = args.staging;
  const cacheDir = args.cache;
  const selftestHome = args['selftest-home'];
  if (!parseVer(target)) {
    throw Object.assign(new Error(`非法目标版本 ${target}`), { code: 'E_SEMVER' });
  }
  emit({ t: 'phase', phase: 'resolving' });

  // 1. 闭包解析
  const resolved = await resolveClosure(registry, '@deepseek-ai/dsh', target, (ev) => emit(ev));
  const rootResolved = resolved.get('@deepseek-ai/dsh');
  if (rootResolved.version !== target) {
    emit({ t: 'warn', detail: `registry 解析为 ${rootResolved.version}（目标 ${target}）` });
  }

  // 2. staging 目录重建
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  // 3. 下载 + 解压摊平
  emit({ t: 'phase', phase: 'downloading' });
  const names = [...resolved.keys()];
  const counters = { files: 0, bytes: 0 };
  let i = 0;
  for (const name of names) {
    i++;
    const { manifest } = resolved.get(name);
    emit({ t: 'dl', name, ver: manifest.version, i, n: names.length, pct: Math.round((i / names.length) * 100) });
    const buf = await downloadTarball(registry, manifest, cacheDir);
    emit({ t: 'phase', phase: 'extracting' });
    const warnings = extractToStaging(buf, name, stagingDir, counters);
    for (const w of warnings) emit({ t: 'warn', detail: `${name}: ${w}` });
    emit({ t: 'extract', name, i });
  }

  // 4. node.exe + package.json（自当前进程可执行文件与正式内核标记）
  try {
    fs.copyFileSync(process.execPath, path.join(stagingDir, 'node.exe'));
  } catch (e) {
    throw Object.assign(new Error(`复制 node.exe 失败: ${e.message}`), { code: 'E_DISK' });
  }
  const pkgJson = { name: 'tt-dsh-kernel', private: true, version: rootResolved.version };
  fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  // 5. 自检
  emit({ t: 'phase', phase: 'selftest' });
  const port = args['selftest-port'] ? Number(args['selftest-port']) : await reservePort();
  emit({ t: 'selftest', port });
  fs.mkdirSync(selftestHome, { recursive: true });
  await selfTest(stagingDir, selftestHome, port);

  emit({ t: 'ok', version: rootResolved.version, packages: names.length, ms: 0 });
}

// ---------- 入口 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  JSON_PROGRESS = !!args['json-progress'];
  const cmd = args._[0];
  try {
    if (cmd === 'metadata') {
      if (!args.registry) throw Object.assign(new Error('缺少 --registry'), { code: 'E_REGISTRY' });
      await cmdMetadata(args.registry);
    } else if (cmd === 'install') {
      for (const k of ['registry', 'target', 'staging', 'cache']) {
        if (!args[k]) throw Object.assign(new Error(`缺少 --${k}`), { code: 'E_REGISTRY' });
      }
      await cmdInstall(args);
    } else {
      throw Object.assign(new Error(`未知子命令 ${cmd}`), { code: 'E_REGISTRY' });
    }
    process.exit(0);
  } catch (e) {
    emitErr(e.code || 'E_NETWORK', e.message);
    process.exit(1);
  }
}

// 直接执行时才跑 CLI（被测试/工具 require 时不执行）。
if (require.main === module) {
  main();
}

module.exports = {
  parseVer, cmpVer, satisfies, parseTar, normalizeTarName,
  verifyIntegrity, pickVersion, cachePath,
  MAX_TOTAL_BYTES, MAX_SINGLE_PACKAGE_BYTES,
};
