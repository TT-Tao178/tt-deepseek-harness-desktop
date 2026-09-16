'use strict';
/**
 * selfcheck-uninstall.cjs — 卸载链端到端自检(P14/P39 红线验证)。
 *
 * 流程:
 *   A. 预检:无运行实例;正式数据目录在
 *   B. 保险:robocopy /XJ 备份 %APPDATA%\com.tt.deepharness(不跟随 junction)
 *   C. 快照:注册表卸载键(.reg)、开始菜单/桌面快捷方式、junction 目标文件数
 *   D. 静默安装 out 包到临时目录
 *   E. 静默卸载(NSIS 卸载器自复制到 TEMP 再执行,需轮询等待)
 *   F. 断言:临时安装目录消失、卸载键消失、正式数据完好、
 *          junction 目标(E:\应用 与项目 plugins/)完好
 *   G. 恢复:注册表键、快捷方式(临时安装与正式版共用产品名,会互相覆盖)
 *
 * 用法: node scripts/selfcheck-uninstall.cjs <setup.exe>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const installer = process.argv[2];
if (!installer || !fs.existsSync(installer)) {
  console.error('usage: node scripts/selfcheck-uninstall.cjs <setup.exe>');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-uninst-'));
const app = path.join(work, 'app');
const realData = path.join(process.env.APPDATA, 'com.tt.deepharness');
const UNINST_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TT DeepSeek Harness Desktop';
const PRODUCT_LNK = 'TT DeepSeek Harness Desktop.lnk';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'pipe', ...opts }).toString();

function countFiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return -1;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}
function regKeyExists() {
  try { sh('reg', ['query', UNINST_KEY]); return true; } catch { return false; }
}

async function main() {
  // ---------- A. 预检 ----------
  const tl = sh('tasklist', ['/FI', 'IMAGENAME eq tt-dsh-desktop.exe']).toString();
  check('A1 无运行实例', !tl.toLowerCase().includes('tt-dsh-desktop.exe'));
  check('A2 正式数据目录存在', fs.existsSync(path.join(realData, 'settings.json')), realData);

  // ---------- B. 数据备份(robocopy /XJ 不跟随 junction) ----------
  // robocopy 退出码 0~7 都是成功(1=有文件被复制),≥8 才是错误。
  const backup = path.join(work, 'appdata-backup');
  const rc = spawn('robocopy', [realData, backup, '/E', '/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'ignore' });
  await new Promise((r) => { rc.on('exit', () => r()); rc.on('error', () => r()); });
  check('B1 备份含 settings.json', fs.existsSync(path.join(backup, 'settings.json')));
  check('B2 备份含 dsh-home/profiles', fs.existsSync(path.join(backup, 'dsh-home', 'profiles', 'web', 'cordis.yml')));

  // ---------- C. 快照 ----------
  const keyBackup = path.join(work, 'uninst-key.reg');
  sh('reg', ['export', UNINST_KEY, keyBackup, '/y']);
  check('C1 卸载键已导出', fs.existsSync(keyBackup) && regKeyExists());

  const shortcutDirs = [
    path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.USERPROFILE, 'Desktop'),
    path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop'),
  ];
  const shortcutsFound = [];
  for (const d of shortcutDirs) {
    const lnk = path.join(d, PRODUCT_LNK);
    if (fs.existsSync(lnk)) shortcutsFound.push(lnk);
  }
  const shortcutBackup = path.join(work, 'shortcuts');
  fs.mkdirSync(shortcutBackup, { recursive: true });
  for (const lnk of shortcutsFound) fs.copyFileSync(lnk, path.join(shortcutBackup, path.basename(lnk) + '.' + shortcutsFound.indexOf(lnk)));
  check('C2 快捷方式已快照', true, shortcutsFound.length ? shortcutsFound.join(' ; ') : '未发现快捷方式(不恢复,属正常)');

  // junction 目标 = 正式安装的插件目录(本机 E:\应用)+ 项目插件目录(P14 历史受害者)。
  let junctionTarget = null;
  const realNm = path.join(realData, 'dsh-home', 'node_modules');
  const realJunction = path.join(realNm, 'dsh-pet-roxy');
  if (fs.existsSync(realJunction)) {
    try { junctionTarget = fs.readlinkSync(realJunction); } catch {}
  }
  const targetCountBefore = junctionTarget ? countFiles(junctionTarget) : -1;
  const projectPlugins = path.resolve(__dirname, '..', 'plugins', 'dsh-pet-roxy');
  const projectCountBefore = countFiles(projectPlugins);
  check('C3 junction 目标与项目插件已计数',
    projectCountBefore === 14 && (junctionTarget ? targetCountBefore > 0 : true),
    `junction→${junctionTarget || '(无 junction)'} 文件数=${targetCountBefore}; 项目 plugins 文件数=${projectCountBefore}`);

  // ---------- D. 静默安装到临时目录 ----------
  await new Promise((resolve, reject) => {
    const c = spawn(installer, ['/S', '/D=' + app], { stdio: 'ignore' });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('installer exit ' + code))));
    c.on('error', reject);
  });
  check('D1 临时安装完成', fs.existsSync(path.join(app, 'tt-dsh-desktop.exe')) && fs.existsSync(path.join(app, 'uninstall.exe')));

  // ---------- E. 静默卸载 ----------
  const parent = spawn(path.join(app, 'uninstall.exe'), ['/S'], { stdio: 'ignore', cwd: app });
  await new Promise((r) => { parent.on('exit', r); parent.on('error', r); });
  // NSIS 卸载器自复制(Au_.exe)后父进程即退;轮询真正完成,上限 60s。
  let done = false;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (!fs.existsSync(app) && !regKeyExists()) { done = true; break; }
  }
  check('E1 卸载流程完成(目录+注册表键消失)', done);

  // ---------- F. 断言 ----------
  const appLeft = fs.existsSync(app) ? countFiles(app) : 0;
  check('F1 临时安装目录已删除(或仅空壳)', appLeft <= 0, `残留文件=${appLeft}`);
  check('F2 注册表卸载键已删除', !regKeyExists());
  check('F3 正式 settings.json 完好且与备份一致',
    fs.existsSync(path.join(realData, 'settings.json')) &&
    fs.readFileSync(path.join(realData, 'settings.json'), 'utf8') === fs.readFileSync(path.join(backup, 'settings.json'), 'utf8'));
  check('F4 正式 dsh-home/profiles 完好',
    fs.existsSync(path.join(realData, 'dsh-home', 'profiles', 'web', 'cordis.yml')));
  const projectCountAfter = countFiles(projectPlugins);
  check('F5 项目 plugins 完好(P14 红线)', projectCountAfter === projectCountBefore, `${projectCountBefore}→${projectCountAfter}`);
  if (junctionTarget) {
    const targetCountAfter = countFiles(junctionTarget);
    check('F6 junction 目标(正式安装插件)完好(P14 红线)', targetCountAfter === targetCountBefore, `${targetCountBefore}→${targetCountAfter}`);
  }
  const realNmAfter = fs.existsSync(realNm) ? fs.readdirSync(realNm) : [];
  check('F7 dsh-home/node_modules junction 已摘除或自愈在即', realNmAfter.filter((n) => !n.startsWith('@')).length <= 1,
    `现存=${realNmAfter.join(',') || '(空)'};下次启动 ensure_junctions 重建`);

  // ---------- G. 恢复(临时安装与正式版共用产品名) ----------
  sh('reg', ['import', keyBackup]);
  for (let i = 0; i < shortcutsFound.length; i++) {
    fs.copyFileSync(path.join(shortcutBackup, path.basename(shortcutsFound[i]) + '.' + i), shortcutsFound[i]);
  }
  const vals = regKeyExists() ? sh('reg', ['query', UNINST_KEY]).toString() : '';
  check('G1 注册表键已恢复且指向正式安装',
    vals.includes('E:') && vals.includes('0.4.2'),
    vals.match(/InstallLocation.*|DisplayVersion.*/gm)?.join(' '));

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed  (工作目录含备份: ${work})`);
  if (failed.length === 0) {
    spawn('cmd', ['/c', 'rd', '/s', '/q', work], { stdio: 'ignore', detached: true });
    console.log('[cleanup] 全部通过,备份与临时目录异步清除');
  } else {
    console.log('[keep] 存在失败项,保留工作目录供排查');
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('selfcheck crashed:', e); process.exit(1); });
