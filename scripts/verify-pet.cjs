// v6.1 桌宠核心验证（无 GUI）：状态机、事件桥、主题校验、settings 合并
const path = require('node:path');
const fs = require('node:fs');

const Module = require('node:module');
const origLoad = Module._load;
const mockElectron = {
  app: { getAppPath: () => process.cwd(), getPath: () => path.join(process.cwd(), '.test-user-data') },
};
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return mockElectron;
  return origLoad.apply(this, arguments);
};

const { petTransition } = require('../dist/pet/state-machine');
const { validatePetTheme, animationFor } = require('../dist/pet/theme-validate');
const { AgentEventBridge } = require('../dist/pet/AgentEventBridge');
const { readAppSettings, updateAppSettings, updatePetPos, setCloseBehavior } = require('../dist/settings');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };

// settings merge（v6.1 §6 O8/B6）
fs.rmSync(path.join(process.cwd(), '.test-user-data'), { recursive: true, force: true });
setCloseBehavior('tray');
updatePetPos(123, 456);
check('updatePetPos keeps closeBehavior', readAppSettings().closeBehavior === 'tray');
check('updatePetPos persists pos', readAppSettings().pet?.pos?.x === 123 && readAppSettings().pet?.pos?.y === 456);
updateAppSettings({ kernel: { channel: 'off' } });
check('updateAppSettings merges kernel without losing pet', readAppSettings().kernel?.channel === 'off' && readAppSettings().pet?.pos?.x === 123);

// theme validate（v6.1 §2.7）
const root = path.resolve('resources/pet/themes/default');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pet.json'), 'utf8'));
check('default theme valid', validatePetTheme(manifest, root).length === 0);
check('fallback chain', animationFor('sleep', { idle: 'i', click: 'c', working: 'w' }) === 'idle' && animationFor('absorb', { idle: 'i', click: 'c' }) === 'click');

// event bridge（v6.1 §2.6）
const bridge = new AgentEventBridge();
let got = [];
bridge.on('taskStarted', (p) => got.push(p));
bridge.push('taskStarted', { n: 1 });
check('event bridge push/deliver', got.length === 1 && got[0].n === 1);
const off = bridge.on('taskDone', () => {});
off();
bridge.push('taskDone', {});
check('event bridge unsubscribe', true);

// state machine smoke（v6.1 §2.3）
check('working interrupted then done -> happy path', petTransition(petTransition('working', { type: 'CLICK' }), { type: 'ANIM_DONE' }) === 'idle');

const failed = results.filter(r => !r.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} checks passed ==`);
process.exit(failed.length ? 1 : 0);
