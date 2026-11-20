// The window: sidebar, workspace, status bar, overlays. Loads state from the main process and keeps it fresh.
import { useEffect } from 'react';
import { api } from '../api';
import type { ThreadMeta } from '@shared/types';
import { currentTab } from '../state/actions';
import { leaves, type Workspace as Ws } from '../state/layout';
import { S, toast, update, useApp } from '../state/store';
import { loadDirs } from './overlays';
import { cx } from '../ui/primitives';
import { retheme } from '../views/terminal/TerminalView';
import { Layers, Toasts } from './Layers';
import { watchAuth } from './AuthDialog';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Workspace } from './Workspace';
import { run } from './commands';

function applyTheme() {
  const t = S.settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : S.settings.theme;
  if (document.documentElement.dataset.theme !== t) {
    document.documentElement.dataset.theme = t;
    api.setTheme?.(t === 'dark');
    requestAnimationFrame(retheme);
  }
}

/** G13: tell the OS when a thread waits on you (or replies, if asked), only while it is out of sight. */
function notifyStatus(t: ThreadMeta) {
  const pref = S.settings.notify;
  if (pref === 'off') return;
  const want = t.status === 'wait' || (pref === 'replies' && t.status === 'unread');
  if (!want) return;
  const visible = document.hasFocus() && currentTab().thread === t.id;
  if (!visible) void api.app.notify(t.title, t.status === 'wait' ? 'Waiting on you' : 'Replied', t.id);
}

const signing = new Set<string>();

export async function boot() {
  void loadDirs();
  const [info, settings, machines, threads, ui] = await Promise.all([api.app.info(), api.app.settings(), api.machines.list(), api.threads.list(), api.app.load('ui')]);
  update(s => {
    s.info = info; s.settings = settings; s.machines = machines; s.threads = threads;
    const u = ui as { workspaces?: Ws[]; wid?: string; sideOpen?: boolean; collapsed?: Record<string, boolean>; projects?: Record<string, string[]>; names?: Record<string, string>; dirOrder?: Record<string, string[]> } | undefined;
    s.projects = u?.projects || {}; s.names = u?.names || {}; s.dirOrder = u?.dirOrder || {};
    // Settings > General > On launch: Start empty keeps one blank workspace (projects and names still come back)
    if (u?.workspaces?.length && settings.launch !== 'empty') {
      // drop tabs whose thread is gone; a thread tab comes back as it was (G12)
      for (const w of u.workspaces) { w.pops = w.pops || []; w.pf = null; for (const p of leaves(w.tree)) if (!p.tabs.length) p.tabs = []; }
      s.workspaces = u.workspaces; s.wid = u.wid && u.workspaces.some(w => w.id === u.wid) ? u.wid : u.workspaces[0].id;
      s.sideOpen = u.sideOpen ?? true; s.collapsed = u.collapsed || {};
    } else if (u) { s.sideOpen = u.sideOpen ?? true; s.collapsed = u.collapsed || {}; }
  });
  document.documentElement.dataset.os = info.platform;
  applyTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
  api.on(e => {
    if (e.type === 'machine') {
      // after a sign-in (the link went through auth), say when it is up: "Connected to <b>X</b>"
      const m = e.machine;
      if (m.link === 'auth') signing.add(m.id);
      else if (m.link === 'up' && signing.delete(m.id)) toast(<span>Connected to <b>{m.name}</b></span>, { icon: 'host' });
      else if (m.link === 'down') signing.delete(m.id);
      update(s => { const i = s.machines.findIndex(x => x.id === m.id); if (i >= 0) s.machines[i] = m; else s.machines = [...s.machines, m]; });
    }
    if (e.type === 'thread') {
      const before = S.threads.find(t => t.id === e.thread.id);
      update(s => { const i = s.threads.findIndex(t => t.id === e.thread.id); if (i >= 0) s.threads[i] = e.thread; else s.threads = [e.thread, ...s.threads]; });
      if (before && before.status !== e.thread.status) notifyStatus(e.thread);
    }
    if (e.type === 'thread.status') { const t = S.threads.find(x => x.id === e.id); if (t && t.status !== e.status) { update(() => { t.status = e.status; }); notifyStatus(t); } }
    if (e.type === 'menu') { if (e.command.startsWith('open:')) import('../state/actions').then(A => A.openThread(e.command.slice(5))); else run(e.command); }
  });
  watchAuth();
  // existing sessions on this computer, then remote machines in the background
  void api.threads.discover('local').then(found => { if (found.length) update(s => { const known = new Set(s.threads.map(t => t.id)); s.threads = [...s.threads, ...found.filter(t => !known.has(t.id))]; }); });
  for (const m of machines) if (m.ssh) void api.machines.connect(m.id);
}

let sideAuto = false;
/** G10: below 900px the sidebar hides itself; opened there, it floats over the panes. */
function narrow() {
  const n = innerWidth < 900;
  if (n && S.sideOpen && !sideAuto) { sideAuto = true; update(s => { s.sideOpen = false; }); }
  else if (!n && sideAuto) { sideAuto = false; update(s => { s.sideOpen = true; }); }
}

export function App() {
  const s = useApp();
  useEffect(() => { applyTheme(); }, [s.settings.theme]);
  useEffect(() => { narrow(); addEventListener('resize', narrow); return () => removeEventListener('resize', narrow); }, []);
  return (
    <>
      <div id="app" className={cx(!s.sideOpen && 'noside', innerWidth < 900 && s.sideOpen && 'float-side')}>
        {s.info.platform === 'mac' && <span className="lights-space" aria-hidden="true" />}
        <Sidebar />
        <main id="main"><Workspace /><StatusBar /></main>
      </div>
      <Layers />
      <Toasts />
    </>
  );
}
