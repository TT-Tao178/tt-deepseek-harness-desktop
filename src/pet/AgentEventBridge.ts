export interface TaskEventSource {
  start(): Promise<void>;
  stop(): void;
  on(ev: 'taskStarted'|'taskProgress'|'taskDone'|'taskError', cb: (p: any) => void): void;
}

/** 事件总线：任何插件可订阅/推送（未来 DSH client 插件直推精确事件）。 */
export class AgentEventBridge {
  private cbs: Record<string, ((p: any) => void)[]> = {};
  private source: TaskEventSource | null = null;

  attach(source: TaskEventSource): void {
    this.source = source;
    source.on('taskStarted', (p) => this.emit('taskStarted', p));
    source.on('taskProgress', (p) => this.emit('taskProgress', p));
    source.on('taskDone', (p) => this.emit('taskDone', p));
    source.on('taskError', (p) => this.emit('taskError', p));
  }
  on(ev: string, cb: (p: any) => void): () => void {
    (this.cbs[ev] ??= []).push(cb);
    return () => { this.cbs[ev] = (this.cbs[ev] ?? []).filter(c => c !== cb); };
  }
  emit(ev: string, p: any): void { for (const cb of this.cbs[ev] ?? []) cb(p); }
  /** 插件直推入口（扩展性关键）。 */
  push(ev: 'taskStarted'|'taskProgress'|'taskDone'|'taskError', p?: any): void { this.emit(ev, p); }
  start(): Promise<void> { return this.source ? this.source.start() : Promise.resolve(); }
  stop(): void { this.source?.stop(); }
}
