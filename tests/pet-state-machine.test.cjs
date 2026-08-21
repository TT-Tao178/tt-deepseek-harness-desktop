const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { petTransition } = require('../dist/pet/state-machine');

describe('pet state machine', () => {
  it('idle transitions', () => {
    assert.equal(petTransition('idle', { type: 'TIMER_WANDER' }), 'wander');
    assert.equal(petTransition('idle', { type: 'HOVER' }), 'hover');
    assert.equal(petTransition('idle', { type: 'CLICK' }), 'click');
    assert.equal(petTransition('idle', { type: 'DRAG_START' }), 'dragging');
    assert.equal(petTransition('idle', { type: 'IDLE_TIMEOUT' }), 'sleep');
    assert.equal(petTransition('idle', { type: 'TASK_STARTED' }), 'working');
    assert.equal(petTransition('idle', { type: 'ABSORB' }), 'absorb');
    assert.equal(petTransition('idle', { type: 'RELEASE' }), 'release');
  });
  it('working family', () => {
    assert.equal(petTransition('working', { type: 'TASK_PROGRESS' }), 'workingProgress');
    assert.equal(petTransition('working', { type: 'TASK_DONE' }), 'happy');
    assert.equal(petTransition('working', { type: 'TASK_ERROR' }), 'sad');
    assert.equal(petTransition('workingProgress', { type: 'TASK_DONE' }), 'happy');
    assert.equal(petTransition('workingProgress', { type: 'TASK_ERROR' }), 'sad');
  });
  it('working interrupted by interaction (pending handled by caller)', () => {
    assert.equal(petTransition('working', { type: 'CLICK' }), 'click');
    assert.equal(petTransition('working', { type: 'DRAG_START' }), 'dragging');
    assert.equal(petTransition('workingProgress', { type: 'CLICK' }), 'click');
  });
  it('sleep/wake', () => {
    assert.equal(petTransition('sleep', { type: 'HOVER' }), 'wake');
    assert.equal(petTransition('sleep', { type: 'CLICK' }), 'wake');
    assert.equal(petTransition('sleep', { type: 'TASK_STARTED' }), 'working');
    assert.equal(petTransition('wake', { type: 'CLICK' }), 'click');
    assert.equal(petTransition('wake', { type: 'ANIM_DONE' }), 'idle');
  });
  it('absorb/release flow', () => {
    assert.equal(petTransition('absorb', { type: 'ANIM_DONE' }), 'absorbed');
    assert.equal(petTransition('absorbed', { type: 'RELEASE' }), 'release');
    assert.equal(petTransition('absorbed', { type: 'CLICK' }), 'release');
    assert.equal(petTransition('release', { type: 'ANIM_DONE' }), 'idle');
  });
  it('transient states return to idle', () => {
    for (const s of ['hover', 'click', 'happy', 'sad']) {
      assert.equal(petTransition(s, { type: 'ANIM_DONE' }), 'idle');
    }
  });
  it('illegal transitions keep state', () => {
    assert.equal(petTransition('idle', { type: 'ANIM_DONE' }), 'idle');
    assert.equal(petTransition('dragging', { type: 'CLICK' }), 'dragging');
    assert.equal(petTransition('dragging', { type: 'TASK_STARTED' }), 'dragging');
    assert.equal(petTransition('sleep', { type: 'DRAG_END' }), 'sleep');
    assert.equal(petTransition('absorbed', { type: 'ANIM_DONE' }), 'absorbed');
    assert.equal(petTransition('workingProgress', { type: 'ANIM_DONE' }), 'workingProgress');
  });
});
