import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { existsSync, openSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { app } from 'electron';
import { redact } from '../core/redact';
import { isHealthy } from './health';
import { collectKernelKeys } from '../provider/store';

const nodeRequire = createRequire(__filename);

function resolveDshBin(): string {
  const pkgJson = nodeRequire.resolve('@deepseek-ai/dsh/package.json');
  return path.join(path.dirname(pkgJson), 'lib', 'bin.js');
}

// §1.2：Electron 内置 Node 20.18 无法加载 web profile（zstd/stripTypeScriptTypes 缺失）→ 捆绑 Node 22
function resolveKernelNode(): string {
  const dev = path.join(app.getAppPath(), 'resources', 'node', 'node.exe');
  if (existsSync(dev)) return dev;
  const packed = path.join(process.resourcesPath, 'node', 'node.exe');
  if (existsSync(packed)) return packed;
  throw new Error('kernel node.exe not found: resources/node/node.exe (dev) or resourcesPath/node/node.exe (packaged)');
}

// 就绪契约：预占空闲端口 + isHealthy 轮询（等价 --port 0；打包后无控制台亦可靠）
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

// 内核日志落盘 userData（打包后 app 目录只读）
function kernelLogFd(): number {
  const dir = path.join(app.getPath('userData'), 'logs');
  mkdirSync(dir, { recursive: true });
  return openSync(path.join(dir, 'kernel.log'), 'a');
}

export class ServiceManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;      // V5-3：重启定时器句柄
  private port = 0;
  private restartAttempts = 0;
  private readonly backoffMs = [1000, 4000, 16000];
  state: 'idle' | 'starting' | 'ready' | 'crashed' | 'stopped' = 'idle';

  async start(): Promise<void> {
    if (this.state === 'starting' || this.state === 'ready') return;  // P1-C：防双开
    this.state = 'starting';
    this.emit('state', this.state);
    const dshBin = resolveDshBin();
    const kernelNode = resolveKernelNode();
    const port = await getFreePort();
    this.port = port;
    const child = spawn(kernelNode, [dshBin, 'web', '--port', String(port)], {
      env: { ...process.env, ...collectKernelKeys() },  // §12.2：注入 provider Key
      stdio: ['ignore', kernelLogFd(), kernelLogFd()],  // 内核 stdout/stderr 落盘，不走管道
      windowsHide: true,  // 不弹黑色控制台窗口（console 子系统子进程默认会弹窗）
    });
    this.child = child;
    child.on('exit', (code) => {
      if (child !== this.child) return;                     // 防重启竞态
      this.onExit(code);
    });
    void this.confirmReady();
  }

  restart(): Promise<void> { this.stop(); return this.start(); }   // P1-C

  private async confirmReady() {
    for (let i = 0; i < 30; i++) {
      if (this.state !== 'starting') return;               // V5-2：stop/restart 后放弃
      if (await isHealthy(this.baseUrl)) {
        if (this.state !== 'starting') return;             // V5-2：await 后再查一次
        this.state = 'ready';
        this.restartAttempts = 0;
        this.emit('ready', this.baseUrl);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.state === 'starting') this.killChildTree(this.child);  // 6 秒不健康 → 视为失败走重启
  }

  private onExit(code: number | null) {
    if (this.state === 'stopped') return;
    if (this.restartAttempts < 3) {
      this.state = 'crashed';
      this.emit('state', this.state);
      const delay = this.backoffMs[Math.min(this.restartAttempts, this.backoffMs.length - 1)];
      this.restartAttempts++;
      this.restartTimer = setTimeout(() => {               // V5-3：定时器带状态守卫
        if (this.state === 'crashed') void this.start();
      }, delay);
    } else {
      this.state = 'stopped';
      this.emit('exhausted', { code });
    }
  }

  stop(): void {
    this.state = 'stopped';
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }  // V5-3
    const c = this.child;
    this.child = null;
    this.killChildTree(c);
  }

  private killChildTree(c: ChildProcess | null) {
    if (!c || !c.pid) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });  // V5-5
      c.kill();  // 兜底：taskkill 可能因权限/环境失败，父进程句柄保证内核本体退出
    } else {
      c.kill('SIGTERM');
      setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL'); }, 5000).unref();
    }
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}`; }
}