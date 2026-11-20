// The window: sidebar, workspace, status bar, overlays. Loads state from the main process and keeps it fresh.
import { useEffect } from 'react';
import { api } from '../api';
import { leaves, type Workspace as Ws } from '../state/layout';
import { S, update, useApp } from '../state/store';
import { cx } from '../ui/primitives';
import { retheme } from '../views/terminal/TerminalView';
import { Layers, Toasts } from './Layers';
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

export async function boot() {
  const [info, settings, machines, threads, ui] = await Promise.all([api.app.info(), api.app.settings(), api.machines.list(), api.threads.list(), api.app.load('ui')]);
  update(s => {
    s.info = info; s.settings = settings; s.machines = machines; s.threads = threads;
    const u = ui as { workspaces?: Ws[]; wid?: string; sideOpen?: boolean; collapsed?: Record<string, boolean> } | undefined;
    if (u?.workspaces?.length) {
      // drop tabs whose thread is gone; a thread tab comes back as it was (G12)
      for (const w of u.workspaces) { w.pops = w.pops || []; w.pf = null; for (const p of leaves(w.tree)) if (!p.tabs.length) p.tabs = []; }
      s.workspaces = u.workspaces; s.wid = u.wid && u.workspaces.some(w => w.id === u.wid) ? u.wid : u.workspaces[0].id;
      s.sideOpen = u.sideOpen ?? true; s.collapsed = u.collapsed || {};
    }
  });
  document.documentElement.dataset.os = info.platform;
  applyTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
  api.on(e => {
    if (e.type === 'machine') update(s => { const i = s.machines.findIndex(m => m.id === e.machine.id); if (i >= 0) s.machines[i] = e.machine; else s.machines = [...s.machines, e.machine]; });
    if (e.type === 'thread') update(s => { const i = s.threads.findIndex(t => t.id === e.thread.id); if (i >= 0) s.threads[i] = e.thread; else s.threads = [e.thread, ...s.threads]; });
    if (e.type === 'thread.status') update(s => { const t = s.threads.find(x => x.id === e.id); if (t) t.status = e.status; });
    if (e.type === 'menu') { if (e.command.startsWith('open:')) import('../state/actions').then(A => A.openThread(e.command.slice(5))); else run(e.command); }
  });
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
