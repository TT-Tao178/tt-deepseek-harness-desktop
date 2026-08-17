const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateTheme, tokensToCssVars } = require('../dist/theme/tokens');

describe('theme tokens', () => {
  it('throws when a required key is missing', () => {
    assert.throws(() => validateTheme({ id: 'x', name: 'X', type: 'light', colors: { 'bg.base': '#fff' } }), /theme missing colors\.bg\.surface/);
  });
  it('accepts a complete token set', () => {
    const t = {
      id: 'light', name: 'Light', type: 'light',
      colors: {
        'bg.base': '#ffffff', 'bg.surface': '#f5f6f8', 'text.primary': '#1a1d21',
        'text.secondary': '#5b6470', 'accent.base': '#4d7cfe', 'border': '#e5e7eb',
      },
    };
    assert.equal(validateTheme(t), true);
  });
  it('tokensToCssVars emits --tt-<dot key> vars', () => {
    const css = tokensToCssVars({ id: 'light', name: 'Light', type: 'light', colors: { 'bg.base': '#ffffff', 'border': '#eee' } });
    assert.ok(css.includes('--tt-bg.base: #ffffff;'));
    assert.ok(css.includes('--tt-border: #eee;'));
    assert.ok(css.startsWith(':root {'));
  });
});
