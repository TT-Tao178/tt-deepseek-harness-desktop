import { watch, statSync, openSync, readSync, closeSync } from 'node:fs';
import type { TaskEventSource } from './AgentEventBridge';

export class KernelLogTailSource implements TaskEventSource {
  private watcher: any = null;
  private fd: number | null = null;
  private lastSize = 0;
  private cbs: Record<string, (p: any) => void> = {};
  constructor(private logPath: string, private rules: { re: RegExp; ev: string }[]) {}

  start(): Promise<void> {
    this.fd = openSync(this.logPath, 'r');
    this.lastSize = statSync(this.logPath).size;   // 只处理启动后新增内容
    this.watcher = watch(this.logPath, () => this.drain());
    return Promise.resolve();
  }
  stop(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
  }
  on(ev: string, cb: (p: any) => void): void { this.cbs[ev] = cb; }

  private drain(): void {
    if (this.fd === null) return;
    try {
      const size = statSync(this.logPath).size;
      if (size < this.lastSize) this.lastSize = 0;   // 日志轮转（应用重启）→ 重置偏移
      const buf = Buffer.alloc(size - this.lastSize);
      readSync(this.fd, buf, 0, buf.length, this.lastSize);
      this.lastSize = size;
      this.parse(buf.toString('utf8'));
    } catch { /* 文件被占用/轮转中，跳过本次 */ }
  }
  private parse(text: string): void {
    for (const line of text.split('\n')) {
      for (const r of this.rules) {
        const m = line.match(r.re);
        if (m) this.cbs[r.ev]?.({ match: m, line });
      }
    }
  }
}
