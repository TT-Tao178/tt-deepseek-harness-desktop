import { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

export type ThemeMode = 'light' | 'dark' | 'system';
const MODES: string[] = ['light', 'dark', 'system'];

const settingsPath = () => path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'settings.yaml',
);

function readSettings(): Record<string, any> {
  if (!existsSync(settingsPath())) return {};
  const text = readFileSync(settingsPath(), 'utf8').trim();
  if (text === '') return {};
  const doc: any = yamlLoad(text);
  if (doc === null || typeof doc !== 'object') throw new Error('settings.yaml: expected a mapping at top level');
  return doc;
}

function writeSettings(doc: Record<string, any>): void {
  mkdirSync(path.dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), yamlDump(doc, { noRefs: true }), 'utf8');
}

export function getTheme(): { mode: ThemeMode } {
  const preference = readSettings()['ui-theme']?.preference;
  return { mode: MODES.includes(preference) ? preference as ThemeMode : 'system' };
}

export async function setTheme(mode: ThemeMode): Promise<void> {
  const doc = readSettings();                    // 解析失败抛错，不覆盖原文件
  doc['ui-theme'] = { preference: mode };
  writeSettings(doc);
  // settings 热重载通常即时生效；reload 兜底，让 index bootstrap 以新偏好注入
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.reload();
  }
}

export function listCustom(): string[] { return []; }   // 自定义主题 P1
