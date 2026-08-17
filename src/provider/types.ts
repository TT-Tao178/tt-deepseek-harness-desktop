export interface ProviderConfig {
  id: string; label: string; kind: string; baseUrl: string;
  apiKey?: string; apiKeyEnv?: string; defaultModel?: string;
  extraHeaders?: Record<string, string>; timeoutMs?: number; enabled?: boolean;
}
export interface ModelInfo { id: string; name: string; ownedBy?: string; }
export interface Health { ok: boolean; latencyMs?: number; error?: string; }
export interface ProviderAdapter {
  kind: string;
  listModels(cfg: ProviderConfig): Promise<ModelInfo[]>;
  chatStream(cfg: ProviderConfig, req: any, signal?: AbortSignal): AsyncIterable<string>;
  health(cfg: ProviderConfig): Promise<Health>;
}
