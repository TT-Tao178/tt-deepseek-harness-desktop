import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { listProviders } from './store';

/** 桌面壳与内核共用的 DSH_HOME（应用运行时由 main.ts 设为 userData/dsh-home；测试可覆盖）。 */
export function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
export const settingsPath = () => path.join(dshHome(), 'settings.yaml');

export function readSettings(): Record<string, any> {
  if (!existsSync(settingsPath())) return {};
  const text = readFileSync(settingsPath(), 'utf8').trim();
  if (text === '') return {};
  const doc: any = yamlLoad(text);
  if (doc === null || typeof doc !== 'object') throw new Error('settings.yaml: expected a mapping at top level');
  return doc;
}

export function writeSettings(doc: Record<string, any>): void {
  mkdirSync(path.dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), yamlDump(doc, { noRefs: true }), 'utf8');
}

export function kernelKeyEnv(id: string): string {
  return `TT_DSH_KEY_${id.toUpperCase().replace(/-/g, '_')}`;
}

export function syncProvidersToDsh(): void {
  const doc = readSettings();
  const providers: Record<string, any> = {};
  for (const cfg of listProviders()) {
    const entry: Record<string, any> = {
      displayName: cfg.label,
      api: 'openai-completions',
      baseURL: cfg.baseUrl,
      apiKeyEnv: kernelKeyEnv(cfg.id),
    };
    if (cfg.defaultModel) entry.models = [{ id: cfg.defaultModel, name: cfg.defaultModel }];
    providers[cfg.id] = entry;
  }
  doc['llm-pi-ai'] = { providers };
  writeSettings(doc);
}
