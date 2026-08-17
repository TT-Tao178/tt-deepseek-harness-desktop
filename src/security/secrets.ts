import { safeStorage } from 'electron';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function saveSecret(id: string, value: string, dir: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
  writeFileSync(path.join(dir, `${id}.enc`), safeStorage.encryptString(value));
}
export function readSecret(id: string, dir: string): string | null {
  const p = path.join(dir, `${id}.enc`);
  if (!existsSync(p)) return null;
  return safeStorage.decryptString(readFileSync(p));
}
export function deleteSecret(id: string, dir: string) {
  const p = path.join(dir, `${id}.enc`);
  if (existsSync(p)) unlinkSync(p);
}
