export async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(3000) });
    return r.ok;   // frontend dist 由 fallback 服务，200 即就绪
  } catch { return false; }
}
