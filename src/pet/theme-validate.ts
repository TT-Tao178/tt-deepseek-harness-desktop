import path from 'node:path';

/** 校验主题清单；返回错误数组（空 = 通过）。
 * v6.4.2：支持两种模型——
 *  - css/lottie 模型：animations.{idle,click,working} 为字符串路径（v6.1 兼容）
 *  - video 模型：animations.idle 为非空字符串数组（dsh-pet 式动画池），可选 turn/drag/clicks/working/happy/sad/absorb/release 数组、moves、categories
 */
export function validatePetTheme(manifest: any, rootDir: string): string[] {
  const errors: string[] = [];
  if (!manifest || manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof manifest.id !== 'string' || !/^[a-z0-9.-]+$/.test(manifest.id)) errors.push('bad id');
  if (!['css', 'lottie', 'video'].includes(manifest.renderer)) errors.push('renderer not supported (css|lottie|video)');

  const anims = manifest.animations;
  if (!anims || typeof anims !== 'object') {
    errors.push('missing animations');
    return errors;
  }

  if (manifest.renderer === 'video') {
    // ---- video 模型（dsh-pet 式动画池）----
    if (!Array.isArray(anims.idle) || !anims.idle.length || !anims.idle.every((n: unknown) => typeof n === 'string' && n.length > 0))
      errors.push('video theme requires animations.idle: string[] (non-empty)');
    for (const k of ['turn', 'drag', 'clicks', 'working', 'happy', 'sad', 'absorb', 'release']) {
      if (anims[k] !== undefined && (!Array.isArray(anims[k]) || !anims[k].every((n: unknown) => typeof n === 'string')))
        errors.push('animations.' + k + ' must be string[]');
    }
    if (anims.moves !== undefined) {
      const m = anims.moves;
      if (typeof m !== 'object' || m === null) errors.push('bad animations.moves');
      if (m && m.actions !== undefined && !Array.isArray(m.actions)) errors.push('moves.actions must be array');
      if (m && Array.isArray(m.actions)) {
        for (const a of m.actions) {
          if (typeof a?.name !== 'string') errors.push('moves.actions[].name required');
          if (a.params !== undefined && (typeof a.params !== 'object' || a.params === null)) errors.push('moves.actions[].params must be object');
        }
      }
    }
    if (anims.categories !== undefined) {
      if (!Array.isArray(anims.categories)) errors.push('animations.categories must be array');
      else for (const c of anims.categories) {
        if (typeof c?.id !== 'string' || typeof c?.weight !== 'number' || !Array.isArray(c?.actions)) errors.push('bad category: ' + String(c?.id));
      }
    }
    // 文件名安全：素材名禁止路径分隔符与 ..
    const names: unknown[] = [];
    for (const k of ['idle', 'turn', 'drag', 'clicks', 'working', 'happy', 'sad', 'absorb', 'release']) {
      if (Array.isArray(anims[k])) names.push(...anims[k]);
    }
    for (const n of names) {
      if (typeof n !== 'string' || n.includes('/') || n.includes('\\') || n.includes('..')) errors.push('bad asset name: ' + String(n));
    }
  } else {
    // ---- css/lottie 模型（v6.1 兼容）----
    for (const k of ['idle', 'click', 'working']) {
      if (typeof anims[k] !== 'string') errors.push('missing animations.' + k);
    }
    const root = path.resolve(rootDir);
    const files = [
      manifest.preview,
      ...Object.values(anims),
      manifest.bubbleStyle,
      ...Object.values(manifest.texts ?? {}),
    ];
    for (const f of files.filter(Boolean)) {
      const abs = path.resolve(root, String(f));
      if (abs !== root && !abs.startsWith(root + path.sep)) errors.push('path escape: ' + String(f));
    }
  }
  return errors;
}

/** 状态动画回退链（v6.1 §2.7）。返回应播放的动画键。 */
export function animationFor(state: string, theme: Record<string, string>): string {
  if (theme[state]) return state;
  switch (state) {
    case 'working': case 'sleep': case 'happy': case 'sad': return 'idle';
    case 'absorb': case 'release': case 'dragging': return theme.click ? 'click' : 'idle';
    case 'wander': case 'hover': case 'wake': case 'workingProgress': return theme.idle || 'idle';
    default: return 'idle';
  }
}
