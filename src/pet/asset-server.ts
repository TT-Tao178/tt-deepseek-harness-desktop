// v6.4.2-5：桌宠素材静态服务器（主进程侧）。
// 背景：file:// 加载 webm 在本机 Electron 环境失败（日志实锤 video error），
// 而 dsh-pet 原方案走 HTTP 可播——故主进程起 127.0.0.1 随机端口静态服务器，
// 素材统一经 http://127.0.0.1:<port>/assets/<皮肤id>/<文件> 提供（同 dsh-pet 通道）。
// 仅绑定 loopback；路径防穿越；皮肤目录映射启动时缓存一次。
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { scanSkins } from './skins';

const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export class AssetServer {
  private server: ReturnType<typeof createServer> | null = null;
  private dirs = new Map<string, string>();   // skinId → 皮肤目录（启动时缓存）
  port = 0;

  constructor(
    private builtinDirs: () => string[],
    private userDir: () => string,
  ) {}

  start(): Promise<void> {
    this.refresh();
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => this.handle(req, res));
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        this.port = (srv.address() as { port: number }).port;
        resolve();
      });
    });
  }

  refresh(): void {
    this.dirs.clear();
    for (const s of scanSkins(this.builtinDirs(), this.userDir())) this.dirs.set(s.id, s.dir);
  }

  stop(): void {
    try { this.server?.close(); } catch { /* 忽略 */ }
    this.server = null;
  }

  /** 皮肤资源 URL 基址（http 通道，替代 file://）。 */
  urlFor(skinId: string): string {
    return `http://127.0.0.1:${this.port}/assets/${encodeURIComponent(skinId)}/`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = /^\/assets\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      const skinId = decodeURIComponent(m[1]);
      const file = decodeURIComponent(m[2]);
      if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) { res.writeHead(400); res.end(); return; }
      const dir = this.dirs.get(skinId);
      if (!dir) { res.writeHead(404); res.end(); return; }
      const p = path.join(dir, 'assets', file);
      if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
      const type = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      createReadStream(p).pipe(res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  }
}
