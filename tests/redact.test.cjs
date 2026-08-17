const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../dist/core/redact');

describe('redact', () => {
  it('redacts Bearer tokens', () => {
    assert.ok(!redact('Authorization: Bearer sk-abcd1234').includes('sk-abcd1234'));
    assert.ok(redact('Authorization: Bearer sk-abcd1234').includes('***'));
  });
  it('redacts bare sk- keys of 8+ chars', () => {
    assert.ok(!redact('key=sk-abcdefghij').includes('sk-abcdefghij'));
  });
  it('redacts api_key= values but keeps the label', () => {
    const out = redact('api_key=supersecretvalue123');
    assert.ok(out.includes('api_key='));
    assert.ok(!out.includes('supersecretvalue123'));
    assert.ok(out.includes('***'));
  });
  it('does not touch plain text', () => {
    const s = 'hello world, port 8080, GET /api/models 200';
    assert.equal(redact(s), s);
  });
});
