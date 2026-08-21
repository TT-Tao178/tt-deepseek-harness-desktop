// v6.1 §4 V6-S6 内核更新验证（mock fetch + 本地假 bundle）
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const Module = require('node:module');
const origLoad = Module._load;
const mockElectron = {
  app: { getAppPath: () => process.cwd(), getPath: () => path.join(process.cwd(), '.test-user-data') },
};
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return mockElectron;
  return origLoad.apply(this, arguments);
};

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };

(async () => {
  const { KernelManager, probeKernel } = require('../dist/pet/KernelManager');
  const { updateAppSettings } = require('../dist/settings');
  const userData = path.join(process.cwd(), '.test-user-data');
  fs.rmSync(userData, { recursive: true, force: true });

  // --- 准备假 bundle（真 node.exe + 假 bin + 假闭包目录） ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbundle-'));
  fs.copyFileSync(path.resolve('resources/node/node.exe'), path.join(tmp, 'node.exe'));
  fs.mkdirSync(path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'require("http").createServer((q,s)=>{s.end("ok")}).listen(Number(process.argv[process.argv.indexOf("--port")+1]))');
  // 假内核版本号：用 semver 高的假版本
  const fakeVer = '99.0.0-test';

  // --- mock fetch：manifest + tgz ---
  const tgz = path.join(tmp, 'kernel.tgz');
  const tar = await import('tar');
  await tar.c({ gzip: true, file: tgz, cwd: tmp }, ['node.exe', 'node_modules']);
  const tgzBuf = fs.readFileSync(tgz);
  const sha = crypto.createHash('sha256').update(tgzBuf).digest('hex');

  let manifestCalls = 0;
  globalThis.fetch = async (url) => {
    manifestCalls++;
    if (String(url).includes('kernel-manifest.json')) {
      return { ok: true, json: async () => ({ dshVersion: fakeVer, nodeVersion: '22.21.0', sha256: sha, builtAt: new Date().toISOString() }) };
    }
    return { ok: true, arrayBuffer: async () => tgzBuf.buffer.slice(tgzBuf.byteOffset, tgzBuf.byteOffset + tgzBuf.byteLength) };
  };

  // 1) 版本比较：当前版本高于远程 → 不下载/不解压（fetch manifest 仍会调用，但不会安装）
  updateAppSettings({ kernel: { channel: 'latest', mirror: 'http://x/' } });
  fs.mkdirSync(path.join(userData, 'kernels'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'kernels', 'current.json'), JSON.stringify({ dshVersion: '99.0.1', nodeVersion: '22.21.0', sha256: 'x', builtAt: '' }));
  const km1 = new KernelManager();
  await km1.check();
  check('no downgrade install when current >= remote', !fs.existsSync(path.join(userData, 'kernels', fakeVer)));

  // 2) sha256 不符 → 拒绝
  fs.rmSync(path.join(userData, 'kernels'), { recursive: true, force: true });
  globalThis.fetch = async (url) => {
    if (String(url).includes('kernel-manifest.json')) {
      return { ok: true, json: async () => ({ dshVersion: fakeVer, nodeVersion: '22.21.0', sha256: '0'.repeat(64), builtAt: '' }) };
    }
    return { ok: true, arrayBuffer: async () => tgzBuf.buffer.slice(tgzBuf.byteOffset, tgzBuf.byteOffset + tgzBuf.byteLength) };
  };
  let notified = '';
  const km2 = new KernelManager();
  km2.onNotify = (m) => { notified = m; };
  await km2.check();
  check('sha256 mismatch rejected', notified.includes('sha256'), notified);

  // 3) 正常链路：下载→解压→current.json
  globalThis.fetch = async (url) => {
    if (String(url).includes('kernel-manifest.json')) {
      return { ok: true, json: async () => ({ dshVersion: fakeVer, nodeVersion: '22.21.0', sha256: sha, builtAt: '' }) };
    }
    return { ok: true, arrayBuffer: async () => tgzBuf.buffer.slice(tgzBuf.byteOffset, tgzBuf.byteOffset + tgzBuf.byteLength) };
  };
  notified = '';
  const km3 = new KernelManager();
  km3.onNotify = (m) => { notified = m; };
  await km3.check();
  const cur = km3.readCurrent();
  check('bundle installed and current.json written', !!cur && cur.dshVersion === fakeVer);
  check('notify on update', notified.includes(fakeVer));

  // 4) 门禁探针：假 bin（HTTP 200）应通过
  const probeHome = path.join(userData, 'probe-home');
  fs.mkdirSync(probeHome, { recursive: true });
  const ok = await probeKernel(path.join(userData, 'kernels', fakeVer, 'node.exe'),
    path.join(userData, 'kernels', fakeVer, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), probeHome);
  check('gate probe passes on healthy bundle', ok === true);

  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok);
  console.log(`\n== ${results.length - failed.length}/${results.length} checks passed ==`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
