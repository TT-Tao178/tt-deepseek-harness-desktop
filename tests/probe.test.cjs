const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { probeLocal } = require('../dist/provider/probe');

describe('probeLocal', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('returns discovered providers and skips failures', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('11434')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'llama3' }] }) };
      throw new Error('refused');
    };
    const out = await probeLocal();
    assert.ok(out.length >= 1);
    const ollama = out.find(p => p.kind === 'ollama');
    assert.ok(ollama);
    assert.deepEqual(ollama.models, ['llama3']);
    assert.ok(out.every(p => p.latencyMs !== undefined));
  });
});
