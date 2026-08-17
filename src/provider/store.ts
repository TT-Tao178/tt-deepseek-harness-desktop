import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ProviderConfig } from './types';
import { readSecret, saveSecret, deleteSecret } from '../security/secrets';

const configDir = () => path.join(app.getPath('userData'), 'config');
const providersPath = () => path.join(configDir(), 'providers.json');
export const secretsDir = () => path.join(app.getPath('userData'), 'secrets');

function ensureDirs() { mkdirSync(configDir(), { recursive: true }); mkdirSync(secretsDir(), { recursive: true }); }

export function listProviders(): ProviderConfig[] {
  if (!existsSync(providersPath())) return [];
  return JSON.parse(readFileSync(providersPath(), 'utf8'));
}

export function loadProvider(id: string): ProviderConfig {
  const cfg = listProviders().find(p => p.id === id);
  if (!cfg) throw new Error(`provider not found: ${id}`);
  const key = readSecret(id, secretsDir());
  return key ? { ...cfg, apiKey: key } : cfg;
}

export function saveProvider(cfg: ProviderConfig): void {
  ensureDirs();
  const { apiKey, ...rest } = cfg;                       // Key 不落明文
  const all = listProviders().filter(p => p.id !== cfg.id);
  all.push(rest);
  writeFileSync(providersPath(), JSON.stringify(all, null, 2));
  if (apiKey) saveSecret(cfg.id, apiKey, secretsDir());
  else deleteSecret(cfg.id, secretsDir());
}

export function removeProvider(id: string): void {
  const all = listProviders().filter(p => p.id !== id);
  writeFileSync(providersPath(), JSON.stringify(all, null, 2));
  deleteSecret(id, secretsDir());
}

/** §12.2 凭据闭环：收集全部 provider 的解密 Key，注入内核 env（TT_DSH_KEY_<ROUTE>）。 */
export function collectKernelKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(secretsDir())) return out;
  for (const file of readdirSync(secretsDir())) {
    if (!file.endsWith('.enc')) continue;
    const id = file.slice(0, -4);
    const key = readSecret(id, secretsDir());
    if (key) out[`TT_DSH_KEY_${id.toUpperCase().replace(/-/g, '_')}`] = key;
  }
  return out;
}
