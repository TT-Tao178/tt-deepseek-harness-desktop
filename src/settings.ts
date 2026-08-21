import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type CloseBehavior = 'ask' | 'tray' | 'quit';
const VALID: CloseBehavior[] = ['ask', 'tray', 'quit'];

const settingsPath = () => path.join(app.getPath('userData'), 'config', 'app-settings.json');

export interface AppSettings {
  closeBehavior: CloseBehavior;
  pet?: { enabled?: boolean; pos?: { x: number; y: number }; theme?: string; alwaysOnTop?: boolean };
  kernel?: { channel?: string; mirror?: string };
}

const DEFAULTS: AppSettings = { closeBehavior: 'ask' };

export function readAppSettings(): AppSettings {
  try {
    if (!existsSync(settingsPath())) return { ...DEFAULTS };
    const j = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const b = j?.closeBehavior;
    // pet.enabled 默认 true（归一化，防止旧配置缺字段）
    const pet = { enabled: true, ...(j?.pet ?? {}) };
    return { ...DEFAULTS, ...j, closeBehavior: VALID.includes(b) ? b : DEFAULTS.closeBehavior, pet };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeAppSettings(s: AppSettings): void {
  mkdirSync(path.dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
}

export function setCloseBehavior(b: CloseBehavior): void {
  writeAppSettings({ ...readAppSettings(), closeBehavior: b });
}

/** v6.1 §6：浅合并写（不覆盖其他字段）。 */
export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...readAppSettings(), ...patch };
  writeAppSettings(next);
  return next;
}

/** v6.1 §6：桌宠位置合并写（嵌套对象显式展开，防覆盖 closeBehavior）。 */
export function updatePetPos(x: number, y: number): void {
  const s = readAppSettings();
  writeAppSettings({ ...s, pet: { ...(s.pet ?? {}), enabled: s.pet?.enabled ?? true, pos: { x, y } } });
}

export function setPetEnabled(v: boolean): void {
  const s = readAppSettings();
  writeAppSettings({ ...s, pet: { ...(s.pet ?? {}), enabled: v } });
}
