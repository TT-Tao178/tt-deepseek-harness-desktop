// v6.4.2 移植自 dsh-pet（PC2005-cloud/dsh-pet，MIT）：纯选择/几何逻辑，无 DOM 依赖。
// UMD-lite：浏览器挂 window.PetChain；node:test 可 require（dist/pet/chain.js 由 copy-pet-ui.cjs 复制）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetChain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 素材几何常量（与 dsh-pet thumb 640×360 播放变体强耦合） */
  const CANVAS_H = 360;
  const FEET_Y = 330;
  const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
  const DRAG_THRESHOLD = 5;

  /** 从字符串池等概率随机抽一个；exclude 排除某名字（避免连续重复）；池空回退原池。 */
  function pick(pool, exclude) {
    const entries = exclude ? pool.filter(function (n) { return n !== exclude; }) : pool;
    const src = entries.length ? entries : pool;
    return src[Math.floor(Math.random() * src.length)];
  }

  /** [min, max) 区间随机整数 */
  function randomBetween(min, max) { return Math.floor(min + Math.random() * (max - min)); }

  /** 按权重选分类；noMirror 分类在 facing=right（镜像）时排除，剩余权重归一化。 */
  function pickWeightedCategory(categories, facing) {
    const cats = (categories || []).filter(function (c) { return c.actions && c.actions.length > 0; });
    if (!cats.length) return null;
    const filtered = cats.filter(function (c) { return !(c.noMirror && facing === 'right'); });
    const eligible = filtered.length ? filtered : cats;
    const totalW = eligible.reduce(function (s, c) { return s + (c.weight || 0); }, 0) || 1;
    let t = Math.random() * totalW;
    for (const c of eligible) { t -= c.weight || 0; if (t <= 0) return c; }
    return eligible[eligible.length - 1];
  }

  /** 掷骰：roll ∈ [0,1) → idle/turn/move/action（纯函数）。 */
  function rollKind(roll, w) {
    const idle = (w && w.idle) || 10;
    const turn = (w && w.turn) || 5;
    const move = (w && w.move) || 5;
    const topEnd = (idle + turn + move) / 100;
    if (roll < idle / 100) return 'idle';
    if (roll < (idle + turn) / 100) return 'turn';
    if (roll < topEnd) return 'move';
    return 'action';
  }

  /** 分类抽动作；无可用分类回退 idle 池。 */
  function pickCategoryAction(categories, idlePool, facing, current) {
    const cat = pickWeightedCategory(categories, facing);
    if (!cat) return { id: 'FALLBACK', name: pick(idlePool || [], current) };
    return { id: cat.id, name: pick(cat.actions, current) };
  }

  /** 移动几何：目标越出视口边缘（含边距）返回 null。坐标比例化，px 换算由调用方完成。 */
  function planMove(o) {
    const distance = randomBetween(o.minDist, o.maxDist);
    const target = o.cx + o.dir * distance;
    const leftBound = o.margin + o.halfW;
    const rightBound = o.W - o.margin - o.halfW;
    if (target < leftBound || target > rightBound) return null;
    return {
      startRatio: o.cx / o.W,
      startYRatio: o.cy / o.H,
      targetRatio: target / o.W,
      totalRatio: Math.abs(target - o.cx) / o.W,
    };
  }

  return { pick, randomBetween, pickWeightedCategory, rollKind, pickCategoryAction, planMove, CANVAS_H, FEET_Y, HIT_BOX, DRAG_THRESHOLD };
});
