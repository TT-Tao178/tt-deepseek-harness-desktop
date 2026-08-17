// Stage 4/5 verification: provider store (encrypted keys), DSH settings sync, theme settings
const path = require('node:path');
const fs = require('node:fs');

const Module = require('node:module');
const origLoad = Module._load;
const mockElectron = {
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => path.join(process.cwd(), '.test-user-data'),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
  },
  BrowserWindow: { getAllWindows: () => [] },
};
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return mockElectron;
  return origLoad.apply(this, arguments);
};

process.env.DSH_HOME = path.join(process.cwd(), '.dsh-home-test');

const { saveProvider, loadProvider, removeProvider, listProviders, collectKernelKeys } = require('../dist/provider/store');
const { syncProvidersToDsh, readSettings, kernelKeyEnv } = require('../dist/provider/dshSync');
const { setTheme, getTheme } = require('../dist/theme/themeManager');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };

(async () => {
  fs.rmSync(path.join(process.cwd(), '.test-user-data'), { recursive: true, force: true });
  fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });

  saveProvider({ id: 'my-ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'sk-secret-1234567890' });
  const providersJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.test-user-data', 'config', 'providers.json'), 'utf8'));
  check('providers.json has no plaintext apiKey', !providersJson[0].apiKey && providersJson[0].id === 'my-ollama');
  const loaded = loadProvider('my-ollama');
  check('loadProvider decrypts apiKey', loaded.apiKey === 'sk-secret-1234567890');
  const secretFile = path.join(process.cwd(), '.test-user-data', 'secrets', 'my-ollama.enc');
  check('secret stored encrypted on disk', fs.existsSync(secretFile) && fs.readFileSync(secretFile, 'utf8').startsWith('enc:'));

  syncProvidersToDsh();
  const settings = readSettings();
  const p = settings['llm-pi-ai']?.providers?.['my-ollama'];
  check('settings.yaml llm-pi-ai.my-ollama written', !!p && p.baseURL === 'http://127.0.0.1:11434/v1' && p.api === 'openai-completions', JSON.stringify(p));
  check('apiKeyEnv maps to kernel env name', p && p.apiKeyEnv === 'TT_DSH_KEY_MY_OLLAMA');
  const keys = collectKernelKeys();
  check('collectKernelKeys yields TT_DSH_KEY_MY_OLLAMA', keys['TT_DSH_KEY_MY_OLLAMA'] === 'sk-secret-1234567890');
  check('kernelKeyEnv naming', kernelKeyEnv('my-ollama') === 'TT_DSH_KEY_MY_OLLAMA');

  removeProvider('my-ollama');
  syncProvidersToDsh();
  const settings2 = readSettings();
  check('remove clears provider from settings.yaml', !settings2['llm-pi-ai']?.providers?.['my-ollama']);
  check('remove deletes secret file', !fs.existsSync(secretFile));
  check('remove clears providers.json', listProviders().length === 0);

  await setTheme('dark');
  const s = readSettings();
  check('theme:set(dark) writes ui-theme.preference', s['ui-theme']?.preference === 'dark', JSON.stringify(s['ui-theme']));
  check('theme:get returns dark', getTheme().mode === 'dark');
  await setTheme('system');
  check('theme:get returns system after set', getTheme().mode === 'system');
  await setTheme('light');
  syncProvidersToDsh();
  const s3 = readSettings();
  check('settings.yaml keeps both sections', s3['ui-theme']?.preference === 'light' && !!s3['llm-pi-ai']);

  const failed = results.filter(r => !r.ok);
  console.log(`\n== ${results.length - failed.length}/${results.length} checks passed ==`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
