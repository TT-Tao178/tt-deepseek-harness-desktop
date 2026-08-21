import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface KernelLocation { node: string; bin: string; version: string | null; }

/** v6.1 §4.5：优先 userData/kernels/current.json（更新内核），否则内置。 */
export function resolveKernelLocation(): KernelLocation {
  try {
    const cur = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'kernels', 'current.json'), 'utf8'));
    const dir = path.join(app.getPath('userData'), 'kernels', String(cur.version));
    const node = path.join(dir, 'node.exe');
    const bin = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(node) && existsSync(bin)) return { node, bin, version: String(cur.version) };
  } catch { /* 无 current.json 或损坏 → 内置 */ }
  const dev = path.join(app.getAppPath(), 'resources', 'node', 'node.exe');
  if (existsSync(dev)) return { node: dev, bin: path.join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: null };
  const packed = path.join(process.resourcesPath, 'node', 'node.exe');
  if (existsSync(packed)) return { node: packed, bin: path.join(process.resourcesPath, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: null };
  throw new Error('kernel not found');
}
