// v6.1 §4.6 内核闭包打包脚本（CI 与本地共用）
// 用法：node scripts/build-kernel-bundle.cjs <outDir>
// 产出：<outDir>/kernel-<ver>.tgz + <outDir>/kernel-manifest.json
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const outDir = path.resolve(process.argv[2] || 'out-kernel');

(async () => {
  const tags = JSON.parse(execSync('npm view @deepseek-ai/dsh dist-tags --json', { encoding: 'utf8' }));
  const ver = tags.next || tags.latest || JSON.parse(execSync('npm view @deepseek-ai/dsh versions --json', { encoding: 'utf8' })).pop();
  console.log('target dsh version:', ver);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bundle-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'kernel-bundle', private: true, dependencies: { '@deepseek-ai/dsh': ver } }, null, 2));
    execSync('pnpm add "@deepseek-ai/dsh@' + ver + '"', { stdio: 'inherit', cwd: tmp });
    // peer 补齐：复用 add-missing-peers 逻辑（临时目录视角）
    const addMissing = fs.readFileSync(path.resolve('scripts/add-missing-peers.cjs'), 'utf8');
    fs.writeFileSync(path.join(tmp, 'add-missing-peers.cjs'), addMissing);
    execSync('node add-missing-peers.cjs && pnpm install', { stdio: 'inherit', cwd: tmp });
    const nodeExe = path.resolve('resources/node/node.exe');
    if (!fs.existsSync(nodeExe)) throw new Error('resources/node/node.exe missing');
    fs.copyFileSync(nodeExe, path.join(tmp, 'node.exe'));
    fs.mkdirSync(outDir, { recursive: true });
    const tgz = path.join(outDir, 'kernel-' + ver + '.tgz');
    const tar = await import('tar');
    await tar.c({ gzip: true, file: tgz, cwd: tmp }, ['node.exe', 'node_modules']);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
    const manifest = { dshVersion: ver, nodeVersion: '22.21.0', sha256, builtAt: new Date().toISOString() };
    fs.writeFileSync(path.join(outDir, 'kernel-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('bundle written:', tgz, 'sha256:', sha256.slice(0, 16) + '…');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error('bundle failed:', e.message); process.exit(1); });
