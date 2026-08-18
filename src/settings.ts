import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type CloseBehavior = 'ask' | 'tray' | 'quit';
const VALID: CloseBehavior[] = ['ask', 'tray', 'quit'];

const settingsPath = () => path.join(app.getPath('userData'), 'config', 'app-settings.json');

export interface AppSettings { closeBehavior: CloseBehavior; }

const DEFAULTS: AppSettings = { closeBehavior: 'ask' };

export function readAppSettings(): AppSettings {
  try {
    if (!existsSync(settingsPath())) return { ...DEFAULTS };
    const j = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const b = j?.closeBehavior;
    return { closeBehavior: VALID.includes(b) ? b : DEFAULTS.closeBehavior };
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
