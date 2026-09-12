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
/**
 * 解析版本号。按 semver 规范支持**部分版本**：`4` / `4.1` / `4.1.1`
 * （缺失的段补 0）。范围里的 `^4`、`~1.2`、`>=4` 都靠这一条才能匹配到
 * 具体版本——只接受三段式会让 `object-assign@^4` 这类依赖解析直接失败
 * （P21：真实内核闭包解析中断在 E_SEMVER）。
 */
function parseVer(s) {
  if (typeof s !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.') : [];
  if (pre.some((x) => x === '')) return null;
  // partial：显式写出的段数（1=`4`，2=`4.1`，3=`4.1.1`）。
  // `~4` 的 npm 语义只看显式段（=4.x），不能因为补 0 就退化成 ~4.0.0。
  const partial = m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1;
  return {
    major: +m[1],
    minor: m[2] === undefined ? 0 : +m[2],
    patch: m[3] === undefined ? 0 : +m[3],
    pre,
    partial,
    raw: s.trim(),
  };
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

/**
 * 比较子句 `[op]version` 匹配判定。
 *
 * 接受的形态：`^4` `~1.2` `>=1.0.0` `>= 4.11`（操作符与版本之间有空格）、
 * `=1.2.3` `1.2.3`。`*` 由 parseComparator 处理。
 */
function matchComparator(ver, clause) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(clause.trim());
  if (!m) throw new Error(`bad comparator: ${clause}`);
  const op = m[1] || '=';
  const base = parseVer(m[2].trim());
  if (!base) throw new Error(`bad version in range: ${clause}`);
  switch (op) {
    case '=': return eqVer(ver, base);
    case '>': return cmpVer(ver, base) > 0;
    case '<': return ltVer(ver, base);
    case '>=': return gteVer(ver, base);
    case '<=': return cmpVer(ver, base) <= 0;
    case '^': {
      // ^x.y.z → >=x.y.z 且 <上界（x>0: 同主版本；x=0,y>0: 同主.次；0.0.z: 仅补丁位）。
      // 部分版本（partial<3）：缺失段不参与上界判定（^4 → 4.x，^0.1 → 0.1.x）。
      if (!gteVer(ver, base)) return false;
      if (base.major > 0) return ver.major === base.major;
      if (base.minor > 0) return ver.major === 0 && ver.minor === base.minor;
      if (base.partial < 3) return ver.major === 0 && ver.minor === base.minor;
      return ver.major === 0 && ver.minor === 0 && ver.patch === base.patch;
    }
    case '~': {
      // ~x.y.z → 同主.次且 >=x.y.z；部分版本只看显式段（~4 → 4.x，~4.1 → 4.1.x）。
      if (ver.major !== base.major) return false;
      if (base.partial >= 2 && ver.minor !== base.minor) return false;
      return gteVer(ver, base);
    }
    default: return false;
  }
}

/** x-range 形态：`4` / `4.1` / `4.1.1` / `1.x` / `1.2.*`（对齐 semver 的 XRANGEPLAIN）。 */
const XRANGE_RE = /^(\d+|x|X|\*)(?:\.(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?)?$/;

/**
 * x-range 展开（npm 语义）：`4` / `4.1` / `4.x` / `1.2.*` 这类「部分版本」
 * 不是「等于」，而是「该前缀下的任意版本」。
 *
 * 判定依据对齐 semver 的 `XRANGEPLAIN`：只有全部由「数字或 x/X/*」组成的
 * 形式才是 x-range；带预发布（`1.2.3-rc.1`）的仍是精确版本。
 *
 *   4         → >=4.0.0 <5.0.0
 *   4.1       → >=4.1.0 <4.2.0
 *   1.2.x     → >=1.2.0 <1.3.0
 *   >=1.2     → >=1.2.0
 *   >1        → >=2.0.0        （npm：`>1` 意为「大于整个 1.x」）
 *   >1.2      → >=1.3.0
 *   <2 / <=2  → <2.0.0 / <3.0.0
 *   >1.x / <2.x / =1.x / =1.2.x → 空集
 * 返回 null 表示这不是 x-range，交给普通比较子句处理。
 */
function xRangeComparator(op, rest) {
  const m = XRANGE_RE.exec(rest);
  if (!m) return null;
  const isX = (s) => s === undefined || s === null || s === '' || s === 'x' || s === 'X' || s === '*';
  const M = isX(m[1]) ? null : +m[1];
  const mi = isX(m[2]) ? null : +m[2];
  const p = isX(m[3]) ? null : +m[3];
  // 主版本缺失（`x` / `*` / `X`）＝任意版本。
  if (M === null) return { any: true };
  const rel = (major, minor, patch) => ({ major, minor, patch, pre: [], partial: 3, raw: `${major}.${minor}.${patch}` });
  const pre0 = (major, minor, patch) => ({ major, minor, patch, pre: ['0'], partial: 3, raw: `${major}.${minor}.${patch}-0` });
  const miMissing = mi === null;
  // 补丁位「有效通配」= 没写、或显式通配、或次版本位通配（`1.x` / `1.2.x` / `4` / `4.1`）。
  const xp = miMissing || p === null;
  const effectiveOp = !op || op === '=' ? '' : op;

  // 无操作符 / `=`：`4` / `4.1` / `1.x` / `1.2.x` → 前缀闭区间 [前缀.0, 下一段.0-0)。
  // npm 把裸的部分版本（`4` = `4.x`）也按 x-range 处理，不是「等于」。
  if (effectiveOp === '') {
    if (xp) {
      const lo = rel(M, miMissing ? 0 : mi, 0);
      const hi = miMissing ? pre0(M + 1, 0, 0) : pre0(M, mi + 1, 0);
      return { range: [['>=', lo], ['<', hi]] };
    }
    const z = rel(M, mi, p);
    return { range: [['>=', z], ['<=', z]] };
  }

  if (xp) {
    // 统一的展开规则（与 semver `replaceXRange` 等价，但表述更直白）：
    //   ① 通配/缺失的段一律**零填充**成 `M.m.0` 形式；
    //   ② npm 从不保留 `>` / `<=` 这两种形式，而是改写成严格边界：
    //        `>N.m`   ≡ `>=(M.m+1).0`（大于整个 N.m 段）
    //        `>N`     ≡ `>=(M+1).0.0`
    //        `<=N.m`  ≡ `<M.(m+1).0`
    //        `<N.m`   ≡ `<M.m.0-0`（`-0` 上界把 2.0.0-rc 这类预发布挡在外面）
    //   ③ 上界一律用 `<`，天然得到「>= 无上界」的行为。
    const minor = miMissing ? 0 : mi;
    const zero = rel(M, minor, 0);
    const nextMinor = pre0(M, minor + 1, 0);
    const nextMajor = pre0(M + 1, 0, 0);
    // `>=` 没有上界：`>=1.x` → >=1.0.0，`>=9.0` → >=9.0.0，`>=1.2.x` → >=1.2.0。
    switch (effectiveOp) {
      case '>':
        return { range: [['>=', miMissing ? rel(M + 1, 0, 0) : rel(M, minor + 1, 0)]] };
      case '>=':
        return { range: [['>=', zero]] };
      case '<=':
        return { range: [['<', miMissing ? nextMajor : nextMinor]] };
      case '<':
        return { range: [['<', pre0(M, minor, 0)]] };
      default:
        return null;
    }
  }

  // 完整三段版本：普通比较（`<` 用 -0 上界挡预发布，与 npm 一致）。
  const z = rel(M, mi, p);
  if (effectiveOp === '>') return { range: [['>', z]] };
  if (effectiveOp === '>=') return { range: [['>=', z]] };
  if (effectiveOp === '<') return { range: [['<', { ...z, pre: ['0'], raw: `${z.raw}-0` }]] };
  if (effectiveOp === '<=') return { range: [['<=', z]] };
  return null;
}

/** 把 x-range 结果判定到具体版本。 */
function matchXRange(ver, x) {
  if (x.any) return true;
  if (x.empty) return false;
  if (x.prefix) {
    const { major, minor, patch } = x.prefix;
    if (ver.major !== major) return false;
    if (minor !== null && ver.minor !== minor) return false;
    if (patch !== null && ver.patch !== patch) return false;
    return true;
  }
  if (x.range) {
    for (const [op, base] of x.range) {
      const ok = op === '>=' ? gteVer(ver, base) : op === '<=' ? cmpVer(ver, base) <= 0 : op === '<' ? ltVer(ver, base) : cmpVer(ver, base) > 0;
      if (!ok) return false;
    }
    return true;
  }
  return false;
}

/**
 * 把一条比较子句解析成 `{op, base}`；`*` / `x` → `{op:'*'}`；
 * x-range（部分版本/通配）→ `{op:'xrange', xrange}`。
 * 解析不了返回 null（调用方视为该分支不匹配 = fail-closed）。
 */
function parseComparator(clause) {
  const c = String(clause).trim();
  if (c === '') return { op: '*', base: null };
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(c);
  if (!m) return null;
  const op = m[1] || '';
  let rest = m[2].trim();
  if (/^v\d/.test(rest)) rest = rest.slice(1); // `v1.2.3` 前缀
  // `^` / `~` 有自己的展开语义，不走 x-range。
  if (op !== '^' && op !== '~') {
    const x = xRangeComparator(op, rest);
    if (x) return { op: 'xrange', xrange: x };
  }
  const base = parseVer(rest);
  if (!base) return null;
  return { op: op || '=', base };
}

/**
 * 拆分一条范围分支为比较子句列表。
 *
 * npm 允许操作符与版本号之间有空格（`>= 4.11`、`>= 2.1.2 < 3.0.0`——
 * 真实内核闭包里就有这种写法），所以不能简单按空白切分：必须先把
 * 「悬空操作符」与紧随其后的版本粘回去。
 */
function comparatorClauses(branch) {
  const out = [];
  let pendingOp = null;
  for (const part of branch.trim().split(/\s+/).filter(Boolean)) {
    if (/^(\^|~|>=|<=|>|<|=)$/.test(part)) {
      pendingOp = part; // 操作符单独成 token，等下一个 token 拼起来
      continue;
    }
    out.push(pendingOp ? pendingOp + part : part);
    pendingOp = null;
  }
  if (pendingOp) out.push(pendingOp);
  return out;
}

/**
 * npm 预发布准入：版本带预发布时，范围里必须存在一个**同 [M,m,p] 且自身带
 * 预发布**的比较子句，否则不匹配（`^1.0.0` 不接受 `1.1.0-rc.1`）。
 * 对应 semver 包的 `testSet`：`!comparator.semver.prerelease.length` 时直接 false。
 */
function prereleaseAllowed(ver, comparators) {
  if (ver.pre.length === 0) return true;
  return comparators.some((c) => {
    const b = c.base;
    return !!(
      b &&
      b.pre &&
      b.pre.length > 0 &&
      b.major === ver.major &&
      b.minor === ver.minor &&
      b.patch === ver.patch
    );
  });
}

/** `||` 分支匹配（comparators 全部满足 + 预发布准入）。 */
function branchMatches(ver, branch) {
  const clauses = comparatorClauses(branch);
  if (clauses.length === 0) return false;
  const comparators = [];
  for (const c of clauses) {
    const parsed = parseComparator(c);
    if (!parsed) return false; // 不认识的语法 fail-closed：本分支不匹配
    comparators.push(parsed);
  }
  for (const c of comparators) {
    if (c.op === '*') continue;
    if (c.op === 'xrange') {
      if (!matchXRange(ver, c.xrange)) return false;
      continue;
    }
    if (!matchComparator(ver, c.op + c.base.raw)) return false;
  }
  return prereleaseAllowed(ver, comparators);
}

/** range 匹配：支持 || 分支、AND 组合、^ ~ >= <= > < = * 、部分版本、x 通配。 */
function satisfies(version, range) {
  const ver = parseVer(version);
  if (!ver) return false;
  const rangeStr = String(range == null ? '' : range).trim();
  if (rangeStr === '') return false; // 空范围不是合法依赖声明 → fail-closed
  if (rangeStr === '*' || rangeStr === 'x' || rangeStr === 'X') {
    // npm 把 `*` 归一成 `>=0.0.0`，预发布仍要过准入（否则 rc 版本会被误选）。
    return prereleaseAllowed(ver, [{ op: '>=', base: { major: 0, minor: 0, patch: 0, pre: [], partial: 3, raw: '0.0.0' } }]);
  }
  if (rangeStr === 'latest') return true;
  for (const branch of rangeStr.split('||')) {
    if (branchMatches(ver, branch)) return true;
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

// ---------- 解压落位（按解析出的安装路径，扁平或嵌套） ----------
/**
 * 把包解压到 `installPath`（相对 staging 根，例如 `node_modules/express`
 * 或 `node_modules/negotiator/node_modules/content-type`）。
 * 同时做 tar 条目逃逸防护：任何条目都必须落在 installPath 之内。
 */
function extractToStaging(tgzBuf, installPath, stagingDir, counters) {
  const warnings = [];
  const entries = parseTar(tgzBuf, warnings);
  const rel = String(installPath).split('/').filter(Boolean);
  const target = path.join(stagingDir, ...rel);
  const targetNorm = path.normalize(target);
  let files = 0;
  for (const entry of entries) {
    if (entry.name === '') continue;
    const dest = path.join(target, ...entry.name.split('/'));
    const destNorm = path.normalize(dest);
    if (!destNorm.startsWith(targetNorm + path.sep) && destNorm !== targetNorm) {
      throw Object.assign(new Error(`条目逃逸目标目录: ${entry.name}`), { code: 'E_TAR' });
    }
    if (entry.type === 'dir') {
      fs.mkdirSync(dest, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.data);
      files++;
      if (files > MAX_FILES_PER_PACKAGE) {
        throw Object.assign(new Error('包内文件数超上限'), { code: 'E_DISK', pkg: installPath });
      }
    }
  }
  counters.files += files;
  counters.bytes += entries.reduce((s, e) => s + (e.data ? e.data.length : 0), 0);
  return warnings;
}

// ---------- 平台适配（可选依赖过滤） ----------
/**
 * 把 npm 的平台标识归一化到 Node 的取值：npm 平台包有时写 `win32`、
 * 有时写 `windows`。Node 用的是 `process.platform`（`win32` / `darwin` / `linux`）。
 */
const PLATFORM_ALIASES = { windows: 'win32', macos: 'darwin', mac: 'darwin', osx: 'darwin' };
function normalizePlatform(id) {
  const s = String(id).toLowerCase();
  return PLATFORM_ALIASES[s] || s;
}

/**
 * manifest 的 `os` / `cpu` / `libc` 约束是否适配当前平台。
 *
 * 用于**可选依赖**：npm 把 sharp 这类原生模块的二进制包声明为带
 * `os`/`cpu` 的 optionalDependencies（`@img/sharp-win32-x64` 有
 * `os:["win32"] cpu:["x64"]`，约 18MB）。闭包必须收进来，否则内核启动时
 * sharp 加载失败、插件树直接崩（P24）；同时必须**过滤掉其他平台**，
 * 否则会白下上百 MB 用不上的二进制。
 */
function matchesPlatform(manifest) {
  const plat = process.platform;
  const arch = process.arch;
  const libc = process.report && process.report.getReport ? (process.report.getReport().header || {}).glibcVersionRuntime : undefined;
  const ok = (list, want) => {
    if (!Array.isArray(list) || list.length === 0) return true;
    const any = list.some((x) => normalizePlatform(x) === want);
    const negated = list.some((x) => String(x).startsWith('!'));
    if (negated) {
      // `!win32` 形式：命中即排除。
      return !list.some((x) => String(x).startsWith('!') && normalizePlatform(String(x).slice(1)) === want);
    }
    return any;
  };
  if (!ok(manifest.os, plat)) return false;
  if (!ok(manifest.cpu, arch)) return false;
  // libc 只对 Linux 有意义；Windows/macOS 上声明了 libc 的一律不匹配。
  if (Array.isArray(manifest.libc) && manifest.libc.length > 0) {
    if (plat !== 'linux') return false;
    if (libc === undefined && !manifest.libc.includes('glibc')) return false;
  }
  return true;
}

/**
 * 为「被依赖边」决定安装位置，并返回该位置的 key（已装过则返回 null）。
 *
 * 先看**最近的祖先层**（Node 的解析顺序：嵌套副本优先），再看根层；
 * 都没有能满足 range 的版本时，尽量装到根层（它是所有包都能看到的层），
 * 只有在根层已被**同名但版本不兼容**的包占用时才嵌套。
 */
function placeDep(resolution, parentKey, name, range, optional) {
  if (!parentKey) {
    if (resolution.get(name)) return null; // 根层已有（名字层唯一）
    if (resolution.get(`node_modules/${name}`)) return null;
    resolution.set(name, {
      name, range, parent: '', optional, status: 'pending', installed: `${name}`, key: name,
    });
    return name;
  }
  const chain = [parentKey];
  let cur = resolution.get(parentKey);
  while (cur && cur.parent) {
    chain.push(cur.parent);
    cur = resolution.get(cur.parent);
  }
  // 1) 祖先层复用
  for (const k of chain) {
    const hit = resolution.get(`${k}/node_modules/${name}`);
    if (hit && hit.status === 'installed' && satisfies(hit.version, range)) return null;
  }
  // 2) 根层复用
  const atRoot = resolution.get(name);
  if (atRoot && atRoot.status === 'installed' && satisfies(atRoot.version, range)) return null;
  // 3) 装到根层（扁平优先）
  if (!atRoot) {
    resolution.set(name, {
      name, range, parent: '', optional, status: 'pending', installed: `${name}`, key: name,
    });
    return name;
  }
  // 4) 根层版本不兼容 → 嵌套到依赖者自己下面
  const key = `${parentKey}/node_modules/${name}`;
  if (resolution.has(key)) return null;
  resolution.set(key, {
    name, range, parent: parentKey, optional, status: 'pending', installed: key, key,
  });
  return key;
}

/**
 * 解析完整依赖闭包。
 *
 * 布局策略：**能扁平就扁平，冲突才嵌套**。
 * 这不是优化而是正确性要求——内核里存在无法共存的范围冲突，例如
 * `negotiator@1.1.0` 需要 `content-type@^2.1.0`，而 `express@5` 需要
 * `content-type@^1.0.5`。全扁平会让先落位的那份被另一侧误用，装上就崩
 * （P25：新版内核 `gzip` 中间件在 `negotiator.encoding()` 里抛
 * `invalid media type`，因为是 1.x 的 content-type 在做 2.x 的活）。
 *
 * 返回 Map<key, {name, version, manifest, nestedIn}>；
 * `nestedIn` 为空串表示安装在根 node_modules（即扁平那份）。
 */
async function resolveClosure(registry, rootName, rootRange, onEvent) {
  const resolution = new Map(); // key -> 节点
  const fetchErrors = [];
  let skipped = 0;
  placeDep(resolution, '', rootName, rootRange, false);

  const loadNode = async (key) => {
    const node = resolution.get(key);
    if (!node || node.status !== 'pending') return false;
    let packument;
    try {
      packument = await fetchPackument(registry, node.name);
    } catch (e) {
      fetchErrors.push(`${node.name}: ${e.message}`);
      resolution.delete(key);
      return false;
    }
    const pick = pickVersion(packument, node.range);
    if (!pick) {
      if (node.optional) skipped++;
      else {
        throw Object.assign(
          new Error(`找不到满足 ${node.name}@${node.range} 的版本`),
          { code: 'E_SEMVER', pkg: node.name }
        );
      }
      resolution.delete(key);
      return false;
    }
    if (!matchesPlatform(pick.manifest)) {
      if (node.optional) {
        skipped++;
        resolution.delete(key);
        return false;
      }
      onEvent({ t: 'warn', detail: `${node.name}@${pick.version} 声明仅适配 ${pick.manifest.os || '?'}/${pick.manifest.cpu || '?'}，仍按依赖收下` });
    }
    node.version = pick.version;
    node.manifest = pick.manifest;
    node.status = 'installed';
    if (node.parent === '') onEvent({ t: 'resolve', packages: resolution.size, name: node.name });

    const edges = [
      ...Object.entries(pick.manifest.dependencies || {}).map(([n, r]) => ({ name: n, range: r, optional: false })),
      ...Object.entries(pick.manifest.peerDependencies || {}).map(([n, r]) => ({ name: n, range: r, optional: false })),
      // optionalDependencies 也必须收：原生模块（sharp）的真正实现在可选平台包里。
      ...Object.entries(pick.manifest.optionalDependencies || {}).map(([n, r]) => ({ name: n, range: r, optional: true })),
    ];
    for (const edge of edges) {
      placeDep(resolution, key, edge.name, edge.range, edge.optional);
    }
    return true;
  };

  // 反复扫过「待装」节点直到没有进展：placeDep 可能先建了 pending 占位，
  // 而那个包的依赖又要等它自己装好之后才能算出可见层。
  let progress = true;
  while (progress) {
    progress = false;
    for (const key of [...resolution.keys()]) {
      if (await loadNode(key)) progress = true;
    }
  }
  const pendingLeft = [...resolution.values()].filter((n) => n.status === 'pending');
  for (const n of pendingLeft) resolution.delete(n.key);

  if (resolution.size === 0) {
    throw Object.assign(new Error(`闭包解析全失败: ${fetchErrors.join('; ')}`), { code: 'E_NETWORK' });
  }
  // 若根层的版本其实也满足嵌套副本的 range，那个副本就是多余的（扁平优先）。
  for (const [key, node] of [...resolution]) {
    if (node.parent === '') continue;
    const atRoot = resolution.get(node.name);
    if (atRoot && atRoot.status === 'installed' && satisfies(atRoot.version, node.range)) {
      resolution.delete(key);
    }
  }
  if (skipped > 0) onEvent({ t: 'warn', detail: `跳过 ${skipped} 个平台不适配/无匹配版本的可选依赖` });
  if (fetchErrors.length > 0) {
    onEvent({ t: 'warn', detail: `部分包拉取失败（未进闭包）: ${fetchErrors.join('; ')}` });
  }
  const out = new Map();
  for (const [key, node] of resolution) {
    out.set(key, { name: node.name, version: node.version, manifest: node.manifest, nestedIn: node.parent });
  }
  return out;
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
        // 判据是「内核能应答 HTTP」，不是「根路径返回 2xx」：
        // 新版内核对未带 token 的请求回 401（`/?token=...` 鉴权），
        // 旧版直接 200。任何状态码都证明服务已经起来并接管了端口。
        if (res.status > 0) { healthy = true; clearTimeout(timer); break; }
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

  // 1. 闭包解析（能扁平就扁平，冲突才嵌套）
  const resolved = await resolveClosure(registry, '@deepseek-ai/dsh', target, (ev) => emit(ev));
  const rootResolved = resolved.get('@deepseek-ai/dsh');
  if (rootResolved.version !== target) {
    emit({ t: 'warn', detail: `registry 解析为 ${rootResolved.version}（目标 ${target}）` });
  }

  // 2. staging 目录重建
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  // 3. 下载 + 解压落位
  emit({ t: 'phase', phase: 'downloading' });
  const keys = [...resolved.keys()];
  const counters = { files: 0, bytes: 0 };
  let i = 0;
  let nestedCount = 0;
  for (const key of keys) {
    const node = resolved.get(key);
    const { manifest } = node;
    // 安装路径（相对 staging 根）。闭包的 key 是**相对根 node_modules** 的层级：
    //   根层 key = `express`                     → node_modules/express
    //   嵌套 key = `express/node_modules/debug`  → node_modules/express/node_modules/debug
    // 嵌套项必须带上前缀 node_modules/，否则会落到 staging 根下的平级目录里
    // （P25 的第二个坑：文件写对了、位置错了，内核照样解析不到）。
    const installPath = node.nestedIn === ''
      ? `node_modules/${node.name}`
      : `node_modules/${node.nestedIn}/node_modules/${node.name}`;
    if (node.nestedIn !== '') nestedCount++;
    emit({ t: 'dl', name: node.name, ver: manifest.version, i, n: keys.length, pct: Math.round((i / keys.length) * 100) });
    const buf = await downloadTarball(registry, manifest, cacheDir);
    emit({ t: 'phase', phase: 'extracting' });
    const warnings = extractToStaging(buf, installPath, stagingDir, counters);
    for (const w of warnings) emit({ t: 'warn', detail: `${node.name}: ${w}` });
    emit({ t: 'extract', name: node.name, i });
  }
  if (nestedCount > 0) {
    emit({ t: 'warn', detail: `为消解版本冲突嵌套安装 ${nestedCount} 个包` });
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

  emit({ t: 'ok', version: rootResolved.version, packages: keys.length, ms: 0 });
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
  verifyIntegrity, pickVersion, cachePath, matchesPlatform, normalizePlatform,
  resolveClosure, fetchPackument,
  MAX_TOTAL_BYTES, MAX_SINGLE_PACKAGE_BYTES,
};
