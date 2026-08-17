// Stage 3 core-logic verification: kernel spawn -> ready -> crash auto-restart -> restart guard -> stop
const path = require('node:path');
const { spawnSync } = require('node:child_process');   // stdio ignore 即可

// --- mock electron ---
const Module = require('node:module');
const origLoad = Module._load;
const mockElectron = {
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => path.join(process.cwd(), '.test-user-data'),
  },
};
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return mockElectron;
  return origLoad.apply(this, arguments);
};

process.env.DSH_HOME = path.join(process.cwd(), '.dsh-home');

const { ServiceManager } = require('../dist/service/ServiceManager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 沙箱内 tasklist/taskkill 不可见/无权限（job 隔离），用父进程 ChildProcess 对象状态判断
function childAlive(c) { return !!c && c.exitCode === null && c.signalCode === null; }
function killChild(c) { c.kill(); }
function kernelChild(sm) { return sm.child; }

(async () => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };

  const sm = new ServiceManager();
  let readyUrl = null;
  sm.on('ready', (u) => { readyUrl = u; });

  await sm.start();
  for (let i = 0; i < 60 && !readyUrl; i++) await sleep(500);
  check('kernel starts and reaches ready (health poll)', !!readyUrl, `url=${readyUrl}`);
  const c1 = kernelChild(sm);
  check('kernel child captured', !!c1 && !!c1.pid, `pid=${c1 && c1.pid}`);
  if (readyUrl) {
    try {
      const r = await fetch(`${readyUrl}/`);
      check('GET / returns 200', r.status === 200, `status=${r.status}`);
    } catch (e) { check('GET / returns 200', false, String(e)); }
  }

  await sm.start();
  await sleep(1500);
  check('restart guard: start() while ready does not double-spawn', kernelChild(sm) === c1 && childAlive(c1));

  const oldChild = c1;
  killChild(oldChild);
  readyUrl = null;
  for (let i = 0; i < 90 && !readyUrl; i++) await sleep(500);   // backoff 1s + boot
  check('auto-restart after kill (DoD #3)', !!readyUrl, `newUrl=${readyUrl}`);
  const c2 = kernelChild(sm);
  check('restarted kernel is a new child process', !!c2 && c2 !== oldChild && !!c2.pid, `oldPid=${oldChild && oldChild.pid} newPid=${c2 && c2.pid}`);
  if (readyUrl) {
    try {
      const r = await fetch(`${readyUrl}/`);
      check('restarted kernel serves 200', r.status === 200, `status=${r.status}`);
    } catch (e) { check('restarted kernel serves 200', false, String(e)); }
  }

  const c2ref = c2;
  sm.stop();
  await sleep(3000);
  check('stop() terminates the kernel child', !childAlive(c2ref), `pid=${c2ref && c2ref.pid}`);
  check('stop() clears the child reference', kernelChild(sm) === null);

  const failed = results.filter(r => !r.ok);
  console.log(`\n== ${results.length - failed.length}/${results.length} checks passed ==`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
