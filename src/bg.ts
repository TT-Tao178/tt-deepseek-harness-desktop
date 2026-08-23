// v6.4.2-4：应用背景系统（主进程侧）。
// - ttbg:// 自定义协议（bypassCSP）：DSH 页面（http）安全加载本地背景图
// - 上传小窗口：比例/分辨率说明 + 预览 + 设为背景（magic bytes 校验 + ≤20MB）
// - 透明度滑块：settings.background.opacity（10%~100%）
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, Notification, protocol } from 'electron';
import { readFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAppSettings, setBackground } from './settings';

const BG_DIR = () => path.join(app.getPath('userData'), 'backgrounds');
const ALLOWED = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/** v6.4.2-5：bg 模块日志（写 main.log，诊断"按钮没反应"类问题）。 */
function blog(msg: string): void {
  try {
    mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true });
    appendFileSync(path.join(app.getPath('userData'), 'logs', 'main.log'), `[${new Date().toISOString()}] [bg] ${msg}\n`);
  } catch { /* 忽略 */ }
}

/** 必须在 app ready 之前调用（注册 ttbg 协议特权：绕过页面 CSP）。 */
export function registerBgSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'ttbg', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
  ]);
}

function magicOk(buf: Buffer, ext: string): boolean {
  if (ext === 'png') return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === 'jpg' || ext === 'jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
  if (ext === 'webp') return buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  if (ext === 'gif') return buf.length > 4 && buf.toString('latin1', 0, 4) === 'GIF8';
  return false;
}

function activeBgPath(): string | null {
  const p = readAppSettings().background?.path;
  return p && existsSync(p) ? p : null;
}

let uploadWin: BrowserWindow | null = null;

/** 当前背景缩略图 dataURL（120px 宽；失败返回 null）。 */
function bgThumb(): string | null {
  const p = activeBgPath();
  if (!p) return null;
  try {
    const img = nativeImage.createFromPath(p);
    return img.isEmpty() ? null : img.resize({ width: 120 }).toDataURL();
  } catch {
    return null;
  }
}

/** 把背景状态应用到主窗口（注入脚本暴露的 window.__ttBg.update）。 */
function applyToWindow(winGetter: () => BrowserWindow | null): void {
  const win = winGetter();
  if (!win || win.isDestroyed()) return;
  const st = { path: activeBgPath() ? 'ttbg://bg' : null, opacity: readAppSettings().background?.opacity ?? 1, thumb: bgThumb() };
  win.webContents.executeJavaScript('window.__ttBg && window.__ttBg.update(' + JSON.stringify(st) + ')').catch(() => {});
}

export function registerBackground(winGetter: () => BrowserWindow | null): void {
  // ttbg://bg → 当前背景图片文件流（带日志，确认请求是否到达）
  protocol.handle('ttbg', (req) => {
    const f = activeBgPath();
    if (!f) { blog('ttbg 404 (no bg path)'); return new Response('', { status: 404 }); }
    blog('ttbg serve -> ' + f);
    return net.fetch(pathToFileURL(f).toString());
  });

  ipcMain.handle('bg:get', () => {
    const st = { path: activeBgPath() ? 'ttbg://bg' : null, opacity: readAppSettings().background?.opacity ?? 1, thumb: bgThumb() };
    blog('bg:get -> ' + JSON.stringify({ path: st.path, opacity: st.opacity, thumb: !!st.thumb }));
    return st;
  });
  ipcMain.handle('bg:setOpacity', (_e, v: number) => {
    const o = Math.min(1, Math.max(0.05, Number(v) || 1));
    setBackground({ opacity: o });
    applyToWindow(winGetter);
    blog('bg:setOpacity -> ' + o);
  });
  ipcMain.handle('bg:clear', () => {
    const p = readAppSettings().background?.path;
    if (p) { try { unlinkSync(p); } catch { /* 忽略 */ } }
    setBackground({ path: undefined as any, opacity: 1 });
    applyToWindow(winGetter);
    blog('bg:clear');
  });
  ipcMain.handle('bg:upload', () => {
    blog('bg:upload -> openUploadWindow');
    try { openUploadWindow(); return { ok: true }; } catch (e) { blog('bg:upload error: ' + String(e)); return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('bg:pick', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ALLOWED }],
    });
    const p = r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    // 主进程生成缩略图 dataURL（不依赖 file:// 加载；GIF/WebP 失败时回退 file:// 预览）
    let thumb: string | null = null;
    if (p) {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) thumb = img.resize({ width: 200 }).toDataURL();
      } catch { /* 缩略图失败不阻塞 */ }
    }
    blog('bg:pick -> ' + (p ?? 'cancel') + (thumb ? ' (thumb ok)' : ''));
    return { path: p, thumb };
  });
  ipcMain.handle('bg:apply', (_e, file: string) => {
    try {
      const ext = path.extname(file).toLowerCase().replace('.', '');
      if (!ALLOWED.includes(ext)) throw new Error('不支持的图片格式');
      const buf = readFileSync(file);
      if (buf.length > 20 * 1024 * 1024) throw new Error('图片超过 20MB');
      if (!magicOk(buf, ext)) throw new Error('文件内容不是有效图片');
      mkdirSync(BG_DIR(), { recursive: true });
      const dest = path.join(BG_DIR(), 'bg.' + (ext === 'jpeg' ? 'jpg' : ext));
      copyFileSync(file, dest);
      setBackground({ path: dest, opacity: readAppSettings().background?.opacity ?? 1 });
      applyToWindow(winGetter);
      closeUploadWindow();
      new Notification({ title: '背景已更新', body: '图片已设为应用背景，可在「主题与桌宠」里调透明度。' }).show();
      blog('bg:apply OK -> ' + dest);
      return { ok: true };
    } catch (e) {
      blog('bg:apply error: ' + String(e));
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('bg:cancel', () => closeUploadWindow());
}

function openUploadWindow(): void {
  if (uploadWin && !uploadWin.isDestroyed()) { uploadWin.focus(); return; }
  const page = app.isPackaged
    ? path.join(process.resourcesPath, 'bg-upload', 'index.html')
    : path.join(app.getAppPath(), 'resources', 'bg-upload', 'index.html');
  uploadWin = new BrowserWindow({
    width: 460, height: 580, resizable: false, minimizable: false, maximizable: false,
    title: '上传背景图片',
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      preload: path.join(__dirname, 'bg-upload-preload.js'),
    },
  });
  void uploadWin.loadFile(page);
  uploadWin.on('closed', () => { uploadWin = null; });
}
function closeUploadWindow(): void {
  if (uploadWin && !uploadWin.isDestroyed()) uploadWin.close();
}
