// v6.4.2：ui-inject 面板脚本测试（针对 dist 编译产物，无 electron 运行时依赖）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const inject = require('../dist/ui-inject.js');

test('UI_PANEL_SCRIPT 是合法可执行的 JS', () => {
  assert.equal(typeof inject.UI_PANEL_SCRIPT, 'string');
  assert.doesNotThrow(() => new Function(inject.UI_PANEL_SCRIPT));
});

test('脚本包含幂等标记与关键 IPC 通道', () => {
  const s = inject.UI_PANEL_SCRIPT;
  assert.ok(s.includes('__ttPanelInjected'), '应含幂等标记');
  assert.ok(s.includes('getEnabled'), '应含 pet:getEnabled 调用');
  assert.ok(s.includes('setEnabled'), '应含 pet:setEnabled 调用');
  assert.ok(s.includes('theme.set'), '应含 theme:set 调用');
  assert.ok(s.includes('启用桌面桌宠'), '应含桌宠开关文案');
  assert.ok(s.includes('主题（目前为默认）'), '应含主题默认占位文案');
});

test('v6.4.2-4：脚本含背景上传/透明度/背景层', () => {
  const s = inject.UI_PANEL_SCRIPT;
  assert.ok(s.includes('__ttBg'), '应暴露 window.__ttBg');
  assert.ok(s.includes('上传背景图片'), '应含上传入口');
  assert.ok(s.includes('背景透明度'), '应含透明度滑块');
  assert.ok(s.includes('ttbg://bg'), '应使用 ttbg 协议加载本地背景');
  assert.ok(s.includes('16:9'), '应含比例建议说明');
});

test('脚本不含未转义的外层模板占位符（防注入串扰）', () => {
  const s = inject.UI_PANEL_SCRIPT;
  assert.ok(!s.includes('${'), '不应包含 ${（会与外层模板字面量冲突）');
});

test('injectUiPanel 对已销毁窗口安全返回', () => {
  assert.doesNotThrow(() => inject.injectUiPanel({ isDestroyed: () => true }));
  assert.doesNotThrow(() => inject.injectUiPanel(null));
});
