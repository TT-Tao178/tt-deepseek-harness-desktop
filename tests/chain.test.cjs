// v6.4.2：PetChain（dsh-pet 移植的纯选择/几何逻辑）测试
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const PetChain = require('../dist/pet/chain.js');

test('rollKind 按权重分档（idle10/turn5/move5）', () => {
  assert.equal(PetChain.rollKind(0.00, { idle: 10, turn: 5, move: 5 }), 'idle');
  assert.equal(PetChain.rollKind(0.099, { idle: 10, turn: 5, move: 5 }), 'idle');
  assert.equal(PetChain.rollKind(0.10, { idle: 10, turn: 5, move: 5 }), 'turn');
  assert.equal(PetChain.rollKind(0.149, { idle: 10, turn: 5, move: 5 }), 'turn');
  assert.equal(PetChain.rollKind(0.15, { idle: 10, turn: 5, move: 5 }), 'move');
  assert.equal(PetChain.rollKind(0.199, { idle: 10, turn: 5, move: 5 }), 'move');
  assert.equal(PetChain.rollKind(0.20, { idle: 10, turn: 5, move: 5 }), 'action');
  assert.equal(PetChain.rollKind(0.99, { idle: 10, turn: 5, move: 5 }), 'action');
});

test('pick 排除连续重复；单元素池回退', () => {
  const pool = ['a', 'b'];
  for (let i = 0; i < 50; i++) assert.notEqual(PetChain.pick(pool, 'a'), 'a');
  assert.equal(PetChain.pick(['only'], 'only'), 'only');   // 宁可重复不返回 undefined
});

test('pickWeightedCategory 在 facing=right 时排除 noMirror 分类', () => {
  const cats = [
    { id: '小动作', weight: 20, actions: ['x'] },
    { id: '文字', weight: 10, noMirror: true, actions: ['y'] },
  ];
  for (let i = 0; i < 30; i++) assert.equal(PetChain.pickWeightedCategory(cats, 'right').id, '小动作');
  // 左侧时两类都可能
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(PetChain.pickWeightedCategory(cats, 'left').id);
  assert.equal(seen.size, 2);
});

test('pickCategoryAction 无分类时回退 idle 池', () => {
  const r = PetChain.pickCategoryAction([], ['idle1'], 'left', 'idle1');
  assert.equal(r.id, 'FALLBACK');
  assert.equal(r.name, 'idle1');
});

test('planMove 越界返回 null，合法返回比例坐标', () => {
  const p = PetChain.planMove({ cx: 500, cy: 300, W: 1000, H: 800, dir: -1, minDist: 60, maxDist: 240, margin: 20, halfW: 100 });
  assert.ok(p === null || (p.startRatio === 0.5 && p.totalRatio > 0 && p.targetRatio < 0.5));
  // 右边没有空间 → 必须 null
  const p2 = PetChain.planMove({ cx: 900, cy: 300, W: 1000, H: 800, dir: 1, minDist: 60, maxDist: 240, margin: 20, halfW: 100 });
  assert.equal(p2, null);
});

test('HIT_BOX / DRAG_THRESHOLD 常量存在', () => {
  assert.ok(PetChain.HIT_BOX.x0 < PetChain.HIT_BOX.x1);
  assert.equal(PetChain.DRAG_THRESHOLD, 5);
});
