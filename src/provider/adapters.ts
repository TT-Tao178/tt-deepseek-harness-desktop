import { ProviderConfig, ModelInfo, Health, ProviderAdapter } from './types';

export class OpenAICompatibleAdapter implements ProviderAdapter {
  kind = 'openai-compatible';
  private authHeaders(cfg: ProviderConfig): Record<string, string> {
    const h: Record<string, string> = {};
    const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : cfg.apiKey;
    if (key) h.Authorization = `Bearer ${key}`;
    return { ...h, ...(cfg.extraHeaders ?? {}) };
  }
  private base(cfg: ProviderConfig): string { return cfg.baseUrl.replace(/\/+$/, ''); }

  async listModels(cfg: ProviderConfig): Promise<ModelInfo[]> {
    const r = await fetch(`${this.base(cfg)}/models`, { headers: this.authHeaders(cfg) });
    if (!r.ok) throw new Error(`listModels ${r.status}`);
    const j: any = await r.json();
    return (j.data ?? []).map((m: any) => ({ id: m.id, name: m.id, ownedBy: m.owned_by }));
  }

  async *chatStream(cfg: ProviderConfig, req: any, signal?: AbortSignal): AsyncIterable<string> {
    const r = await fetch(`${this.base(cfg)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders(cfg) },
      body: JSON.stringify({ ...req, stream: true }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`chat ${r.status}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch { /* 忽略非 JSON 心跳行 */ }
      }
    }
  }

  async health(cfg: ProviderConfig): Promise<Health> {
    const t = Date.now();
    try {
      const r = await fetch(`${this.base(cfg)}/models`, {
        headers: this.authHeaders(cfg), signal: AbortSignal.timeout(cfg.timeoutMs ?? 3000),
      });
      return { ok: r.ok, latencyMs: Date.now() - t };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t, error: String(e) }; }
  }
}
