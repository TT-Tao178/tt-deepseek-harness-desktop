// v6.1：把 src/pet/ui 静态资源复制到 dist/pet（tsc 不处理非 TS 文件）
const fs = require('node:fs');
const path = require('node:path');
const src = path.resolve('src/pet/ui');
const dst = path.resolve('dist/pet');
fs.mkdirSync(dst, { recursive: true });
for (const f of ['index.html', 'pet.css', 'pet.js']) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log('pet UI copied to dist/pet');
