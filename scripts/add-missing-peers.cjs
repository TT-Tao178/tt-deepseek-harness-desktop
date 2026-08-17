// 把开发闭包中未被打包的 @deepseek-ai peer 依赖显式加入 package.json dependencies（electron-builder 不收集 peer）
const fs = require('node:fs');
const path = require('node:path');
const pj = path.resolve('package.json');
const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
const dev = new Map();
for (const e of fs.readdirSync(path.resolve('node_modules/.pnpm'))) {
  if (!e.startsWith('@deepseek-ai+')) continue;
  const m = e.slice('@deepseek-ai+'.length).match(/^([^@]+)@(\d[\d.]*(?:-[^_]*)?)(_.*)?$/);
  if (m && !dev.has(m[1])) dev.set(m[1], m[2]);
}
const packedDir = path.resolve('out', 'win-unpacked', 'resources', 'app', 'node_modules', '@deepseek-ai');
const packed = fs.existsSync(packedDir) ? fs.readdirSync(packedDir) : [];
let added = 0;
for (const [name, ver] of dev) {
  const full = '@deepseek-ai/' + name;
  if (!packed.includes(name) && !pkg.dependencies[full]) { pkg.dependencies[full] = ver; added++; }
}
fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + '\n');
console.log('added', added, 'peer deps (total', Object.keys(pkg.dependencies).length, ')');
