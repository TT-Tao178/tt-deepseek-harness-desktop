// v6.4.2：桌宠皮肤注册表（主进程侧）。
// 扫描内置目录 + 用户目录（用户目录优先，同名 id 覆盖），解析 pet.json 并校验。
// 设计为"目录即皮肤"：无上传 UI，用户把皮肤文件夹放进 userData/themes/ 即被识别。
// 本模块不依赖 electron（目录由调用方传入），可 node:test 直接测。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePetTheme } from './theme-validate';

export interface SkinInfo {
  id: string;
  name: string;
  renderer: string;
  version: string;
  dir: string;
  manifest: any;
}

function listDirs(base: string): string[] {
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(base, d.name));
  } catch {
    return [];
  }
}

function readManifest(dir: string): { id: string; manifest: any } | null {
  try {
    const p = path.join(dir, 'pet.json');
    if (!fs.existsSync(p)) return null;
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (validatePetTheme(m, dir).length > 0) return null;   // 非法皮肤静默跳过（不崩）
    return { id: m.id, manifest: m };
  } catch {
    return null;
  }
}

/** 扫描全部皮肤：内置目录按顺序加入，用户目录同名 id 覆盖（用户优先）。 */
export function scanSkins(builtinDirs: string[], userDir: string): SkinInfo[] {
  const out = new Map<string, SkinInfo>();
  const put = (dir: string) => {
    const r = readManifest(dir);
    if (!r) return;
    out.set(r.id, {
      id: r.id,
      name: r.manifest.name || r.id,
      renderer: r.manifest.renderer,
      version: r.manifest.version || '',
      dir,
      manifest: r.manifest,
    });
  };
  for (const base of builtinDirs) for (const sub of listDirs(base)) put(sub);
  for (const sub of listDirs(userDir)) put(sub);
  return [...out.values()];
}

/** 按 id 解析皮肤。 */
export function resolveSkin(builtinDirs: string[], userDir: string, id: string): SkinInfo | null {
  return scanSkins(builtinDirs, userDir).find((s) => s.id === id) ?? null;
}

/** 活动皮肤 id：优先用户指定（有效时）；否则默认 dshpet（dsh-pet 素材皮肤）；否则第一个；否则内置 css。 */
export function activeSkinId(builtinDirs: string[], userDir: string, preferred?: string): string {
  const all = scanSkins(builtinDirs, userDir);
  if (preferred && all.some((s) => s.id === preferred)) return preferred;
  if (all.some((s) => s.id === 'dshpet')) return 'dshpet';
  return all[0]?.id ?? 'css';
}

/** 皮肤目录 → 资源 URL 基址（保证以 / 结尾；中文素材名由渲染层 encodeURIComponent）。 */
export function skinAssetUrl(dir: string): string {
  const u = pathToFileURL(dir.endsWith(path.sep) ? dir : dir + path.sep);
  return u.href.endsWith('/') ? u.href : u.href + '/';
}
