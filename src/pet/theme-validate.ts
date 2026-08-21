import path from 'node:path';

/** 校验主题清单；返回错误数组（空 = 通过）。 */
export function validatePetTheme(manifest: any, rootDir: string): string[] {
  const errors: string[] = [];
  if (!manifest || manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof manifest.id !== 'string' || !/^[a-z0-9.-]+$/.test(manifest.id)) errors.push('bad id');
  if (!['css', 'lottie'].includes(manifest.renderer)) errors.push('renderer not supported in v6.1 (css|lottie)');
  for (const k of ['idle', 'click', 'working']) {
    if (typeof manifest.animations?.[k] !== 'string') errors.push('missing animations.' + k);
  }
  const root = path.resolve(rootDir);
  const files = [
    manifest.preview,
    ...Object.values(manifest.animations ?? {}),
    manifest.bubbleStyle,
    ...Object.values(manifest.texts ?? {}),
  ];
  for (const f of files.filter(Boolean)) {
    const abs = path.resolve(root, String(f));
    if (abs !== root && !abs.startsWith(root + path.sep)) errors.push('path escape: ' + String(f));
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
