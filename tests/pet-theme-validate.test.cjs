const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validatePetTheme, animationFor } = require('../dist/pet/theme-validate');
const path = require('node:path');

const ROOT = path.resolve('resources/pet/themes/default');
const good = {
  schemaVersion: 1, id: 'com.example.pet-01', name: 'x', version: '1.0.0', author: 'a',
  renderer: 'css', size: { width: 120, height: 130 },
  animations: { idle: 'animations/idle', click: 'animations/click', working: 'animations/working' },
};

describe('validatePetTheme', () => {
  it('accepts a valid theme', () => {
    assert.deepEqual(validatePetTheme(good, ROOT), []);
  });
  it('rejects bad schemaVersion / id / renderer', () => {
    assert.ok(validatePetTheme({ ...good, schemaVersion: 2 }, ROOT).length > 0);
    assert.ok(validatePetTheme({ ...good, id: 'BAD ID!' }, ROOT).length > 0);
    assert.ok(validatePetTheme({ ...good, renderer: 'live2d' }, ROOT).length > 0);   // 未实现 renderer 拒绝
    assert.ok(validatePetTheme({ ...good, renderer: 'spine' }, ROOT).length > 0);
  });
  it('rejects missing required animations', () => {
    assert.ok(validatePetTheme({ ...good, animations: { idle: 'a' } }, ROOT).length > 0);
  });
  it('rejects path escape', () => {
    const evil = { ...good, animations: { ...good.animations, idle: '../../../../Windows/win.ini' } };
    assert.ok(validatePetTheme(evil, ROOT).some(e => e.startsWith('path escape')));
  });
});

describe('animationFor fallback chain', () => {
  const theme = { idle: 'idle.json', click: 'click.json', working: 'working.json' };
  it('direct hit', () => { assert.equal(animationFor('idle', theme), 'idle'); });
  it('fallback to idle', () => { assert.equal(animationFor('sleep', theme), 'idle'); });
  it('fallback to click then idle', () => { assert.equal(animationFor('absorb', theme), 'click'); });
  it('unknown state defaults to idle', () => { assert.equal(animationFor('nope', theme), 'idle'); });
});
