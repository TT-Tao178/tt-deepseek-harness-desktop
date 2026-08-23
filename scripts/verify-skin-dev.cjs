// v6.4.2-3 诊断：dev 路径下桌宠皮肤扫描/校验/素材存在性（本地实锤用）
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { scanSkins, resolveSkin, activeSkinId, skinAssetUrl } = require('../dist/pet/skins.js');

const builtin = [path.resolve('resources/pet/themes')];
const user = path.resolve('NOT_EXIST_USER_DIR');

console.log('== 1. 皮肤扫描（dev 路径）==');
const skins = scanSkins(builtin, user);
console.log('found:', skins.map((s) => s.id + '[' + s.renderer + '] ' + s.dir).join('\n  '));

console.log('\n== 2. activeSkinId ==');
console.log('default(无偏好):', activeSkinId(builtin, user));
console.log('preferred=dshpet:', activeSkinId(builtin, user, 'dshpet'));

console.log('\n== 3. resolveSkin(dshpet) ==');
const info = resolveSkin(builtin, user, 'dshpet');
if (!info) { console.log('FAIL: dshpet 未找到'); process.exit(1); }
console.log('OK:', info.id, info.renderer, info.dir);
console.log('assetUrl:', skinAssetUrl(info.dir));

console.log('\n== 4. 素材名 ↔ 文件存在性 ==');
const a = info.manifest.animations || {};
const names = [];
for (const k of ['idle', 'turn', 'drag', 'clicks', 'working', 'happy', 'sad', 'absorb', 'release']) {
  if (Array.isArray(a[k])) names.push(...a[k].map((n) => n));
}
if (a.moves && Array.isArray(a.moves.actions)) names.push(...a.moves.actions.map((x) => x.name));
for (const c of a.categories || []) names.push(...(c.actions || []));
let missing = 0;
for (const n of names) {
  const f = path.join(info.dir, 'assets', n + '.webm');
  if (!fs.existsSync(f)) { console.log('  MISSING:', n); missing++; }
}
console.log('checked', names.length, 'names, missing:', missing, '=>', missing === 0 ? 'PASS' : 'FAIL');

console.log('\n== 5. pet.json 素材目录实际文件 ==');
const files = fs.readdirSync(path.join(info.dir, 'assets'));
console.log(files.length, 'files:', files.slice(0, 5).join(', '), '...');
