const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { KernelLogTailSource } = require('../dist/pet/KernelLogTailSource');

describe('KernelLogTailSource', () => {
  let dir, log;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klog-')); log = path.join(dir, 'kernel.log'); fs.writeFileSync(log, 'old line\n'); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('only parses content appended after start() (offset)', async () => {
    const events = [];
    const src = new KernelLogTailSource(log, [{ re: /TASK (started|done)/, ev: 'taskStarted' }]);
    src.on('taskStarted', (p) => events.push(p.line));
    await src.start();               // lastSize = 当前大小（旧行被跳过）
    fs.appendFileSync(log, 'TASK started\n');
    await new Promise(r => setTimeout(r, 400));
    src.stop();
    assert.equal(events.length, 1);
    assert.ok(events[0].includes('TASK started'));
  });

  it('resets offset on rotation (size shrink)', async () => {
    const events = [];
    const src = new KernelLogTailSource(log, [{ re: /ROT/, ev: 'taskProgress' }]);
    src.on('taskProgress', (p) => events.push(p.line));
    await src.start();
    fs.writeFileSync(log, 'ROT mark\n');       // 文件变小（轮转）→ lastSize 重置
    await new Promise(r => setTimeout(r, 400));
    src.stop();
    assert.equal(events.length, 1);
  });
});
