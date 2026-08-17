const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { OpenAICompatibleAdapter } = require('../dist/provider/adapters');

const cfg = { id: 't', label: 'T', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-1234567890' };

function mockFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('OpenAICompatibleAdapter', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('listModels parses .data[]', async () => {
    globalThis.fetch = mockFetch(200, { data: [{ id: 'm1', owned_by: 'x' }, { id: 'm2' }] });
    const models = await new OpenAICompatibleAdapter().listModels(cfg);
    assert.deepEqual(models, [
      { id: 'm1', name: 'm1', ownedBy: 'x' },
      { id: 'm2', name: 'm2', ownedBy: undefined },
    ]);
  });

  it('listModels throws on non-ok', async () => {
    globalThis.fetch = mockFetch(401, {});
    await assert.rejects(() => new OpenAICompatibleAdapter().listModels(cfg), /listModels 401/);
  });

  it('chatStream yields SSE deltas until [DONE]', async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"\u4f60"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"\u597d"}}]}\n\n', 'data: [DONE]\n\n'];
    const reader = {
      read: () => {
        const c = chunks.shift();
        return Promise.resolve(c === undefined ? { done: true } : { done: false, value: new TextEncoder().encode(c) });
      },
    };
    globalThis.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => reader } });
    const out = [];
    for await (const delta of new OpenAICompatibleAdapter().chatStream(cfg, { model: 'm1', messages: [] })) out.push(delta);
    assert.deepEqual(out, ['你', '好']);
  });

  it('chatStream skips non-JSON heartbeat lines', async () => {
    const chunks = ['data: ping\n\n', 'data: [DONE]\n\n'];
    const reader = {
      read: () => {
        const c = chunks.shift();
        return Promise.resolve(c === undefined ? { done: true } : { done: false, value: new TextEncoder().encode(c) });
      },
    };
    globalThis.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => reader } });
    const out = [];
    for await (const delta of new OpenAICompatibleAdapter().chatStream(cfg, { model: 'm1', messages: [] })) out.push(delta);
    assert.deepEqual(out, []);
  });

  it('health reports ok on 200', async () => {
    globalThis.fetch = mockFetch(200, { data: [] });
    const h = await new OpenAICompatibleAdapter().health(cfg);
    assert.equal(h.ok, true);
    assert.equal(typeof h.latencyMs, 'number');
  });

  it('health returns ok:false on network error', async () => {
    globalThis.fetch = async () => { throw new Error('fetch failed'); };
    const h = await new OpenAICompatibleAdapter().health(cfg);
    assert.equal(h.ok, false);
  });
});
