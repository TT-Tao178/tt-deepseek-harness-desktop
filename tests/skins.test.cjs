// v6.4.2：皮肤注册表（skins.ts）测试——用项目内临时目录，避免依赖 electron
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { scanSkins, resolveSkin, activeSkinId, skinAssetUrl } = require('../dist/pet/skins.js');

const TMP = path.join(__dirname, '.tmp-skins');
const BUILTIN = path.join(TMP, 'builtin');
const USER = path.join(TMP, 'user');

function writeSkin(base, id, renderer, extra) {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  const m = Object.assign(
    { schemaVersion: 1, id, name: '皮肤-' + id, version: '1.0.0', renderer, animations: { idle: ['a.webm'], clicks: ['c.webm'], working: ['w.webm'] } },
    extra || {},
  );
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(m));
  return dir;
}

test('扫描：内置 + 用户目录，用户同名 id 覆盖', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  writeSkin(BUILTIN, 'dshpet', 'video');
  writeSkin(BUILTIN, 'old', 'css', { animations: { idle: 'a', click: 'b', working: 'c' } });
  writeSkin(USER, 'dshpet', 'video', { name: '用户版' });          // 用户覆盖同名
  writeSkin(USER, 'bad', 'video', { animations: { idle: [] } });  // 非法皮肤被跳过
  const skins = scanSkins([BUILTIN], USER);
  assert.equal(skins.length, 2);
  const dshpet = skins.find((s) => s.id === 'dshpet');
  assert.equal(dshpet.name, '用户版');
  assert.equal(dshpet.dir.startsWith(USER), true);
  assert.ok(!skins.some((s) => s.id === 'bad'));
});

test('resolveSkin 按 id 解析', () => {
  assert.ok(resolveSkin([BUILTIN], USER, 'dshpet'));
  assert.equal(resolveSkin([BUILTIN], USER, 'nope'), null);
});

test('activeSkinId：优先指定 → dshpet → 第一个', () => {
  assert.equal(activeSkinId([BUILTIN], USER, 'old'), 'old');
  assert.equal(activeSkinId([BUILTIN], USER, 'missing'), 'dshpet');   // 无效指定回落 dshpet
  assert.equal(activeSkinId([BUILTIN], USER), 'dshpet');
  fs.rmSync(TMP, { recursive: true, force: true });
  writeSkin(BUILTIN, 'onlyone', 'video');
  assert.equal(activeSkinId([BUILTIN], USER), 'onlyone');
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('skinAssetUrl 以 / 结尾（中文名由渲染层编码）', () => {
  const u = skinAssetUrl(path.join('C:', 'themes', 'dshpet'));
  assert.ok(u.endsWith('/'));
  assert.ok(u.startsWith('file:///'));
});
