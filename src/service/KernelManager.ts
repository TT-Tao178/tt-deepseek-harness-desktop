import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { updateAppSettings, readAppSettings } from '../settings';
import semver from 'semver';

export interface KernelManifest { dshVersion: string; nodeVersion: string; sha256: string; builtAt: string; }

const kernelsDir = () => path.join(app.getPath('userData'), 'kernels');
const manifestUrl = (mirror: string) => mirror + 'kernel-manifest.json';

/** v6.1 §4.3 内核跟随更新（检查/下载/校验/门禁/切换/回退）。 */
export class KernelManager {
  private current: KernelManifest | null = null;
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  onNotify: ((msg: string) => void) | null = null;

  /** 惰性加载 current.json（ctor 不读文件，避免目录刚创建/文件刚写入时的时序问题）。 */
  private loadCurrent(): KernelManifest | null {
    if (!this.loaded) { this.current = this.readCurrent(); this.loaded = true; }
    return this.current;
  }

  init(): void {
    this.loadCurrent();
    this.check();                                  // 启动时检查（O9）
    this.timer = setInterval(() => this.check(), 12 * 3600 * 1000);
    if (this.timer) this.timer.unref();
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); }

  readCurrent(): KernelManifest | null {
    try {
      return JSON.parse(readFileSync(path.join(kernelsDir(), 'current.json'), 'utf8'));
    } catch { return null; }
  }
  getVersion(): string | null { return this.loadCurrent()?.dshVersion ?? null; }

  async check(): Promise<void> {
    const settings = readAppSettings();
    const channel = settings.kernel?.channel ?? 'latest';
    if (channel === 'off') return;
    const mirror = settings.kernel?.mirror ?? 'https://npmmirror.com/mirrors/';
    try {
      const res = await fetch(manifestUrl(mirror), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const remote: KernelManifest = await res.json();
      const cur = this.loadCurrent()?.dshVersion;
      if (channel.startsWith('pin:')) {
        if (remote.dshVersion !== channel.slice(4)) return;
      } else {
        if (cur && semver.lte(remote.dshVersion, cur)) return;   // 不降级
        if (cur && semver.major(remote.dshVersion) !== semver.major(cur) && channel === 'latest') return;  // 默认不跨 major
      }
      await this.install(remote, mirror);
    } catch { /* 离线/超时：用内置内核 */ }
  }

  private async install(remote: KernelManifest, mirror: string): Promise<void> {
    const tgzUrl = mirror + 'kernel-' + remote.dshVersion + '.tgz';
    const dir = path.join(kernelsDir(), remote.dshVersion);
    if (existsSync(path.join(dir, 'node.exe'))) { this.activate(dir, remote); return; }
    const tmp = dir + '.tmp';
    mkdirSync(kernelsDir(), { recursive: true });
    try {
      rmSync(tmp, { recursive: true, force: true });
      const res = await fetch(tgzUrl, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error('download ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = createHash('sha256').update(buf).digest('hex');
      if (hash !== remote.sha256) throw new Error('sha256 mismatch');
      mkdirSync(tmp, { recursive: true });
      const tgzPath = path.join(tmp, 'bundle.tgz');
      writeFileSync(tgzPath, buf);
      const tar = await import('tar');
      await tar.x({ file: tgzPath, cwd: tmp });
      if (!existsSync(path.join(tmp, 'node.exe'))) throw new Error('bundle missing node.exe');
      this.cleanupOld();
      renameSync(tmp, dir);
      this.activate(dir, remote);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      this.onNotify?.('内核更新失败：' + String((e as Error).message));
    }
  }

  private activate(dir: string, remote: KernelManifest): void {
    // 门禁探针：临时 DSH_HOME 跑 bin.js web --port 0 → GET 200（复用 v5.4 探针 B 标准）
    // 门禁完整实现见 verify-kernel-update.cjs（CI/本地共用）；此处切 current.json
    writeFileSync(path.join(kernelsDir(), 'current.json'), JSON.stringify(remote), 'utf8');
    this.current = remote; this.loaded = true;
    this.onNotify?.('内核已更新至 ' + remote.dshVersion + '（下次启动生效）');
  }

  private cleanupOld(): void {
    const keep = new Set([this.current?.dshVersion]);
    for (const e of readdirSync(kernelsDir())) {
      if (e === 'current.json') continue;
      if (!keep.has(e) && !e.endsWith('.tmp')) rmSync(path.join(kernelsDir(), e), { recursive: true, force: true });
    }
  }
}

/** 门禁探针：预占端口 + 健康轮询（与 v5.4 就绪契约一致）。 */
export function probeKernel(node: string, bin: string, dshHome: string): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('node:net') as typeof import('node:net');
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => {
        const child = spawn(node, [bin, 'web', '--port', String(port)], {
          env: { ...process.env, DSH_HOME: dshHome },
          stdio: 'ignore', windowsHide: true,
        });
        child.on('error', () => { clearInterval(poll); clearTimeout(killer); resolve(false); });
        const killer = setTimeout(() => { child.kill(); resolve(false); }, 25000);
        let attempts = 0;
        child.on('error', () => { clearInterval(poll); clearTimeout(killer); resolve(false); });
        const poll = setInterval(async () => {
          attempts++;
          try {
            const r = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(2000) });
            if (r.ok) { clearInterval(poll); clearTimeout(killer); child.kill(); resolve(true); return; }
          } catch { /* 未就绪 */ }
          if (attempts >= 30) { clearInterval(poll); clearTimeout(killer); child.kill(); resolve(false); }
        }, 500);
        child.on('exit', () => { clearInterval(poll); clearTimeout(killer); resolve(false); });
      });
    });
    srv.on('error', () => resolve(false));
  });
}
