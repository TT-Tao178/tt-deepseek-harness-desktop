const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { transition } = require('../dist/service/state-machine');

describe('service state machine', () => {
  it('full transition table', () => {
    assert.equal(transition('idle', { type: 'START' }), 'starting');
    assert.equal(transition('starting', { type: 'READY' }), 'ready');
    assert.equal(transition('ready', { type: 'CRASH' }), 'crashed');
    assert.equal(transition('crashed', { type: 'START' }), 'starting');
    assert.equal(transition('ready', { type: 'STOP' }), 'stopped');
  });
  it('illegal transitions keep state', () => {
    assert.equal(transition('idle', { type: 'CRASH' }), 'idle');
    assert.equal(transition('idle', { type: 'READY' }), 'idle');
    assert.equal(transition('starting', { type: 'START' }), 'starting');
    assert.equal(transition('stopped', { type: 'START' }), 'stopped');
    assert.equal(transition('stopped', { type: 'READY' }), 'stopped');
  });
});
