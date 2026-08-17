import { LOCAL_PRESETS } from './presets';
import { OpenAICompatibleAdapter } from './adapters';

export interface DiscoveredProvider { kind: string; baseUrl: string; models: string[]; latencyMs?: number; }
export async function probeLocal(): Promise<DiscoveredProvider[]> {
  const adapter = new OpenAICompatibleAdapter();
  const out: DiscoveredProvider[] = [];
  for (const p of LOCAL_PRESETS) {
    const cfg = { id: 'probe', label: p.kind, kind: p.kind, baseUrl: p.baseUrl, timeoutMs: 2000 };
    const h = await adapter.health(cfg);
    if (h.ok) {
      const models = await adapter.listModels(cfg).catch(() => []);
      out.push({ kind: p.kind, baseUrl: p.baseUrl, models: models.map(m => m.id), latencyMs: h.latencyMs });
    }
  }
  return out;
}
