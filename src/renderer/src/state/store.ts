// App state for the renderer. One mutable object, one version counter: components read `S` and re-render
// when `update` bumps the version. Simple and fast enough for a window's worth of UI.
import { useSyncExternalStore } from 'react';
import type { AppInfo } from '@shared/api';
import type { AuthPrompt, Machine, Settings, ThreadMeta } from '@shared/types';
import type { Surface } from '../input/dispatcher';
import { mkPane, mkTab, newId, type Workspace } from './layout';

export interface Layer { id: number; render: (close: () => void) => import('react').ReactNode; close: () => void; surface?: Surface; onClose?: () => void }

/** One toast at a time (the mockup's toast()): an icon, rich text (bold names as <b>), and an inline action like Undo. */
export interface Toast { id: number; icon?: string; text: import('react').ReactNode; action?: { label: string; run: () => void } }

export interface AppState {
  info: AppInfo;
  settings: Settings;
  machines: Machine[];
  threads: ThreadMeta[];
  workspaces: Workspace[];
  wid: string;
  sideOpen: boolean;
  /** The sidebar has the keys (it is a pane: VIM-MODEL section 4). */
  sideFocus: boolean;
  /** Sidebar cursor: a thread id, or 'fold:<key>' for a heading. */
  sideCursor: string | null;
  collapsed: Record<string, boolean>;
  /** Sidebar projects: folders added with a machine's + (no threads yet), names given by double-click, and
   *  the order projects were dragged into, all keyed '<machine>:<dir>' or by machine. */
  projects: Record<string, string[]>;
  names: Record<string, string>;
  dirOrder: Record<string, string[]>;
  /** The sidebar row being renamed in place: 'thread:<id>' or 'dir:<machine>:<dir>'. */
  sideEdit: string | null;
  archiveOpen: boolean;
  leader: boolean;
  seq: string;
  toasts: Toast[];
  auth: AuthPrompt[];
  /** Open overlays (menus, palette, settings, dialogs), topmost last. The topmost owns the keys. */
  layers: Layer[];
  /** Bumped when the keyboard owner changes, so the status pill redraws. */
  tick: number;
}

const blankWs = (machine = 'local', dir = '~'): Workspace => {
  const p = mkPane(mkTab('new', { machine, dir }));
  return { id: newId('w'), name: 'Workspace', machine, dir, tree: p, focus: p.id, zoom: false, pops: [], usedAt: Date.now() };
};

export const S: AppState = {
  info: { platform: 'win', version: '', home: '', pty: true },
  settings: { theme: 'system', vim: true, leader: 'ctrl-space', sideView: 'grouped', defaultView: 'term', notify: 'waiting', vimrc: '' },
  machines: [], threads: [], workspaces: [blankWs()], wid: '',
  sideOpen: true, sideFocus: false, sideCursor: null, collapsed: {}, projects: {}, names: {}, dirOrder: {}, sideEdit: null, archiveOpen: false,
  leader: false, seq: '', toasts: [], auth: [], layers: [], tick: 0,
};
S.wid = S.workspaces[0].id;
export { blankWs };

let version = 0;
const subs = new Set<() => void>();
let queued = false;
/** Change state and redraw. Several updates in one tick redraw once. */
export function update(fn?: (s: AppState) => void) {
  fn?.(S);
  version++;
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; for (const f of subs) f(); });
}
export const subscribe = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
/** Re-render this component on every state change. */
export function useApp(): AppState { useSyncExternalStore(subscribe, () => version); return S; }

export const ws = (): Workspace => S.workspaces.find(w => w.id === S.wid) || S.workspaces[0];
export const thread = (id?: string) => (id ? S.threads.find(t => t.id === id) : undefined);
export const machine = (id?: string) => S.machines.find(m => m.id === (id || 'local'));

let toastN = 0;
export function toast(text: Toast['text'], o: Partial<Omit<Toast, 'id' | 'text'>> = {}, ms = 3200) {
  const t: Toast = { id: ++toastN, text, ...o };
  update(s => { s.toasts = [t]; });   // a new toast replaces the one showing
  if (ms) setTimeout(() => dismissToast(t.id), ms);
  return t.id;
}
export function dismissToast(id: number) { if (S.toasts.some(x => x.id === id)) update(s => { s.toasts = s.toasts.filter(x => x.id !== id); }); }

let layerN = 0;
/** Open an overlay. Its component registers its keyboard surface with `layerSurface`. Returns close. */
export function openLayer(render: Layer['render'], onClose?: () => void): () => void {
  const id = ++layerN;
  const close = () => {
    const l = S.layers.find(x => x.id === id);
    if (!l) return;
    update(s => { s.layers = s.layers.filter(x => x.id !== id); s.tick++; });
    l.onClose?.();
  };
  update(s => { s.layers = [...s.layers, { id, render, close, onClose }]; s.tick++; });
  return close;
}
export const topLayer = () => S.layers[S.layers.length - 1];
