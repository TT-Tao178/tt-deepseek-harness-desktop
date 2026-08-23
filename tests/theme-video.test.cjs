// v6.4.2：主题校验 video 模型（dsh-pet 素材皮肤）测试
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validatePetTheme } = require('../dist/pet/theme-validate');
const path = require('node:path');

const ROOT = path.resolve('resources/pet/themes/dshpet');
const videoGood = {
  schemaVersion: 1, id: 'dshpet', name: 'x', version: '1.0.0',
  renderer: 'video',
  animations: {
    idle: ['待机呼吸休闲'],
    turn: ['东张西望'],
    clicks: ['点击回应-开心跃动'],
    working: ['写代码'],
    moves: { default: { minDist: 60 }, actions: [{ name: '螃蟹走路' }] },
    categories: [{ id: '小动作', weight: 20, actions: ['写代码'] }],
  },
  animationWeights: { idle: 10, turn: 5, move: 5 },
};

test('video 模型：合法皮肤通过', () => {
  assert.deepEqual(validatePetTheme(videoGood, ROOT), []);
});

test('video 模型：idle 必须为非空字符串数组', () => {
  assert.ok(validatePetTheme({ ...videoGood, animations: { ...videoGood.animations, idle: [] } }, ROOT).length > 0);
  assert.ok(validatePetTheme({ ...videoGood, animations: { ...videoGood.animations, idle: '待机' } }, ROOT).length > 0);
  assert.ok(validatePetTheme({ ...videoGood, animations: { ...videoGood.animations, idle: undefined } }, ROOT).length > 0);
});

test('video 模型：素材名禁止路径穿越', () => {
  const evil = { ...videoGood, animations: { ...videoGood.animations, working: ['../..//evil.webm'] } };
  assert.ok(validatePetTheme(evil, ROOT).some((e) => e.startsWith('bad asset name')));
  const slash = { ...videoGood, animations: { ...videoGood.animations, clicks: ['a/b.webm'] } };
  assert.ok(validatePetTheme(slash, ROOT).length > 0);
});

test('video 模型：moves/categories 结构校验', () => {
  assert.ok(validatePetTheme({ ...videoGood, animations: { ...videoGood.animations, moves: { default: {}, actions: [{ params: 3 }] } } }, ROOT).length > 0);
  assert.ok(validatePetTheme({ ...videoGood, animations: { ...videoGood.animations, categories: [{ id: 'x' }] } }, ROOT).length > 0);
});

test('renderer 白名单：css/lottie/video 通过，其余拒绝', () => {
  assert.equal(validatePetTheme({ ...videoGood, renderer: 'css', animations: { idle: 'a', click: 'b', working: 'c' } }, ROOT).length, 0);
  assert.ok(validatePetTheme({ ...videoGood, renderer: 'live2d' }, ROOT).length > 0);
  assert.ok(validatePetTheme({ ...videoGood, renderer: 'spine' }, ROOT).length > 0);
});

test('css 模型：路径穿越防护仍然生效（回归）', () => {
  const css = { schemaVersion: 1, id: 'x', renderer: 'css', animations: { idle: '../../Windows/win.ini', click: 'b', working: 'c' } };
  assert.ok(validatePetTheme(css, ROOT).some((e) => e.startsWith('path escape')));
});
