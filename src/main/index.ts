// Electron shell: one window, our own menu (so no default accelerator swallows a Vim key, G3), IPC wiring.
// Everything else lives in src/core and is reached through services.ts.
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, Notification, session, shell } from 'electron';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { API_SHAPE, FIRE_AND_FORGET, type SkeinEvent } from '../shared/api';
import { keyOf } from '../shared/keys';
import { loadLoginEnv } from '../core/env';
import { setSink } from '../core/events';
import { log } from '../core/log';
import { Store } from '../core/store';
import { createHarnesses } from '../core/harness';
import { buildMenu } from './menu';
import { createServices } from './services';

loadLoginEnv();
// Rubber-band overscroll. Stock Electron turns Chromium's elastic overscroll off on macOS unless a window
// asks for scrollBounce (below); Windows needs this feature, and bounces only on precision touchpads and touch.
if (process.platform === 'win32') app.commandLine.appendSwitch('enable-features', 'ElasticOverscroll');

const store = new Store(join(app.getPath('userData'), 'skein.db'));
let win: BrowserWindow | null = null;
const send = (e: SkeinEvent) => { if (win && !win.isDestroyed()) win.webContents.send('skein.event', e); };

// Browser tabs (<webview>): which keys Skein keeps while a page has focus, set by the renderer (browser.keys)
let keptKeys = new Set<string>();
const BROWSER_PARTITION = 'persist:skein-browser';
const webUrl = (u: string) => /^https?:\/\//i.test(u);

const harnesses = createHarnesses();
const { api, dispose } = createServices(store, {
  version: app.getVersion(),
  home: homedir(),
  openExternal: url => shell.openExternal(url),
  reveal: p => shell.showItemInFolder(p),
  browserKeys: keys => { keptKeys = new Set(keys); },
  notify: (title, body, thread) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { win?.show(); win?.focus(); if (thread) send({ type: 'menu', command: 'open:' + thread }); });
    n.show();
  },
}, harnesses);

// IPC: `ns.method` handlers from API_SHAPE.
for (const [ns, methods] of Object.entries(API_SHAPE)) {
  for (const m of methods as string[]) {
    const ch = `${ns}.${m}`;
    const fn = (api as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[ns][m];
    if (FIRE_AND_FORGET.has(ch)) ipcMain.on(ch, (_e, ...a) => { try { fn(...a); } catch (err) { log('ipc', ch, err); } });
    else ipcMain.handle(ch, async (_e, ...a) => fn(...a));
  }
}
setSink(send);

function createWindow() {
  const mac = process.platform === 'darwin';
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 560, minHeight: 400, show: false,
    backgroundColor: dark ? '#212121' : '#fdfdfd',
    titleBarStyle: 'hidden',
    ...(mac ? { trafficLightPosition: { x: 14, y: 14 } } : { titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#b6b6b6' : '#4a4a4a', height: 40 } }),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, spellcheck: false, webviewTag: true, scrollBounce: true },
  });
  win.once('ready-to-show', () => win?.show());
  // launch check (CI): report when the renderer has drawn, or any error it hits
  if (process.env.SKEIN_LAUNCH_CHECK) {
    // stdout from a GUI app is unreliable on Windows, so the result also goes to a file when one is named
    const say = (s: string) => { console.log(s); const f = process.env.SKEIN_LAUNCH_CHECK_FILE; if (f) appendFileSync(f, s + '\n'); };
    win.webContents.on('console-message', (e) => { const m = (e as unknown as { message: string; level: string }); if (m.level === 'error') say('skein: renderer error ' + m.message); });
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      const n = await win?.webContents.executeJavaScript('document.querySelectorAll("#side .s-top").length');
      say(n ? 'skein: ready' : 'skein: renderer error (no sidebar)');
    }, 1500));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  // A Browser tab's page is an ordinary web page: no preload, no Node, sandboxed, in its own session, http(s) only
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false });
    params.partition = BROWSER_PARTITION;
    delete params.preload;
    if (!webUrl(params.src || '')) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => { win = null; });
}

/** The renderer tells us its theme so the Windows caption buttons match. */
ipcMain.on('shell.theme', (_e, dark: boolean) => {
  if (win && process.platform !== 'darwin') win.setTitleBarOverlay?.({ color: '#00000000', symbolColor: dark ? '#b6b6b6' : '#4a4a4a', height: 40 });
});

/** A webview's page: links that open windows go to the system browser; navigation stays on http(s); Skein's own
 *  keys (esc, the leader, alt-hjkl, its modifier shortcuts) come back to the app instead of reaching the page. */
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  wc.setWindowOpenHandler(({ url }) => { if (webUrl(url)) void shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!webUrl(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!webUrl(url)) e.preventDefault(); });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = { key: input.key, code: input.code, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta, isComposing: input.isComposing };
    const k = keyOf(key);
    if (!k || !keptKeys.has(k)) return;
    e.preventDefault();
    send({ type: 'browser.key', contents: wc.id, key });
  });
});

app.whenReady().then(() => {
  // pages in Browser tabs ask for nothing: no camera, notifications, geolocation...
  session.fromPartition(BROWSER_PARTITION).setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write' || perm === 'fullscreen'));
  Menu.setApplicationMenu(buildMenu(cmd => send({ type: 'menu', command: cmd })));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { dispose(); harnesses.dispose?.(); store.close(); });
