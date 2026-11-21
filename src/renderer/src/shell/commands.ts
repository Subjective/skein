// Command names (input/keymap.ts COMMANDS) to actions. The : line, the palette, menus and vimrc maps all run these.
import { createElement as h } from 'react';
import { api } from '../api';
import { ALIASES, COMMANDS } from '../input/keymap';
import { S, toast, update, ws } from '../state/store';
import * as A from '../state/actions';
import { cycleWorkspaces } from './switcher';
import { armLeader, owner } from './keyboard';
import { pathTo, resize } from '../state/layout';
import { here, knownDirs, openCmdline, openKeys, openMachines, openPalette, openPaneSearch, openSettings, openWorkspaces } from './overlays';
import { scrollback } from '../views/terminal/scrollback';
import { tabHook } from '../views/tools/hooks';
import { searchSidebar } from './Sidebar';
import { openTool, saveFile } from '../views/tools/open';
import { liveTab, quoteSelection } from '../views/chat/threads';

const setSetting = async (patch: Partial<typeof S.settings>) => { const v = await api.app.setSettings(patch); update(st => { st.settings = v; }); };
const themeNow = () => S.settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : S.settings.theme;

/** Every command by name. Some take arguments from the : line (or a vimrc line): `new linux ~/repo`, `workspace x`. */
const resizeBy = (axis: 'row' | 'col', d: number) => { update(s => { const w = ws(); resize(w.tree, w.focus, axis, d); s.tick++; }); A.save(); };
const blurField = () => (document.activeElement as HTMLElement | null)?.blur?.();
/** App NORMAL: whatever is typing stops (the surface gets esc), and the field lets go of the focus. */
function toNormal() {
  const o = owner();
  if (o.mode() === 'INSERT' || o.mode() === 'TERMINAL') o.key('esc', { key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
  blurField(); update(s => { s.tick++; });
}

/** A command returns false when it had nothing to do, so its key goes on to the surface (ctrl-o with no jump). */
const RUN: Record<string, (args: string[]) => void | boolean> = {
  palette: () => openPalette(),
  find: () => openPalette('file'),
  panesearch: () => openPaneSearch(),
  cmdline: () => openCmdline(),
  keys: () => openKeys(),
  settings: () => openSettings(),
  machines: () => openMachines(),
  sidebar: () => update(s => { s.sideOpen = !s.sideOpen; if (!s.sideOpen) s.sideFocus = false; }),
  newthread: () => { const p = A.focusedPane(); update(() => A.addTab(p, A.launcherFor(A.currentTab()))); },
  // every + (and ldr c) opens another new-thread tab, so several can be started side by side (Josh, 2026-11-20;
  // the mockup refocused a new tab that was already in front instead)
  tabnew: () => {
    const p = A.focusedPane(), cur = A.currentTab();
    update(s => { A.addTab(p, A.launcherFor(cur)); ws().pf = null; s.tick++; }); A.save();
  },
  // a new thread to the right; on another machine and folder when named (by id or name)
  new: ([m, dir]) => {
    const t = A.launcherFor(A.currentTab());
    if (m) {
      const mc = S.machines.find(x => x.id === m || x.name.toLowerCase() === m.toLowerCase());
      if (!mc) { toast(h('span', null, 'No machine called ', h('b', null, m)), { icon: 'host' }); return; }
      t.machine = mc.id; t.dir = dir || knownDirs(mc.id)[0] || '~';
    } else if (dir) t.dir = dir;
    A.split('row', t);
  },
  q: () => A.closeTab(),
  tabnext: () => A.tabStep(1),
  tabprev: () => A.tabStep(-1),
  vsplit: () => A.split('row'),
  split: () => A.split('col'),
  vshell: () => A.split('row', A.shellFor(A.currentTab())),
  shell: () => A.split('col', A.shellFor(A.currentTab())),
  view: () => A.setView(A.currentTab()),
  chat: () => A.setView(A.currentTab(), 'chat'),
  term: () => A.setView(A.currentTab(), 'term'),
  zoom: () => A.zoom(),
  only: () => A.only(),
  workspace: args => {
    if (!args.length) { openWorkspaces(); return; }
    const n = args.join(' '), hit = S.workspaces.find(x => x.name === n);
    if (hit) A.switchWorkspace(hit.id); else { const c = here(); A.newWorkspace(n, c.machine, c.dir); }
  },
  wsnext: () => cycleWorkspaces(1),
  wsprev: () => cycleWorkspaces(-1),
  'focus h': () => A.focusDir('h'), 'focus j': () => A.focusDir('j'), 'focus k': () => A.focusDir('k'), 'focus l': () => A.focusDir('l'),
  'move h': () => A.movePane('h'), 'move j': () => A.movePane('j'), 'move k': () => A.movePane('k'), 'move l': () => A.movePane('l'),
  'resize -': () => resizeBy('row', -0.06), 'resize +': () => resizeBy('row', 0.06),
  shorter: () => resizeBy('col', -0.06), taller: () => resizeBy('col', 0.06),
  rotate: () => { const w = ws(), path = pathTo(w.tree, A.focusedPane(w).id); const sp = path?.[path.length - 1]?.s; if (sp) { update(s => { sp.dir = sp.dir === 'row' ? 'col' : 'row'; s.tick++; }); A.save(); } },
  // each popup in turn, then back to the panes
  peek: () => { if (!ws().pops.length) return; blurField(); A.popNext(); },
  dock: () => { const w = ws(); if (w.pf) A.dock(w.pf); },
  popclose: () => { blurField(); A.closeFocusedPopup(); },
  leader: () => armLeader(),
  normal: () => toNormal(),
  escape: () => { const t = A.currentTab(); if (t.kind === 'shell' || (t.kind === 'thread' && t.view === 'term')) scrollback(t.id); else toNormal(); },
  swap: () => A.swapNext(),
  // `/` is always a search where you are (rule 22): surfaces with their own search take it first; here is the rest
  search: () => {
    if (S.sideFocus) { searchSidebar(); return; }
    const t = A.currentTab();
    const slash = { key: '/', code: 'Slash', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    if (t.kind === 'thread' && t.view !== 'term') { if (liveTab(t.id)?.enter?.()) { requestAnimationFrame(() => owner().key('/', slash)); return; } }
    if (t.kind === 'shell' || t.kind === 'thread') { scrollback(t.id); requestAnimationFrame(() => owner().key('/', slash)); return; }
    toast('Nothing to search here');
  },
  scrollback: () => { const t = A.currentTab(); if (t.kind === 'thread' && t.view !== 'term' && liveTab(t.id)?.enter?.()) return; scrollback(t.id); },   // a chat tab: its reader
  // ctrl-o from a popup: back to the pane it came from (the popup stays); ctrl-i: to that same popup again
  // (places are kept per popup in state/actions: rule 15)
  back: () => { if (tabHook(A.currentTab().id, 'back')) return; if (!A.canPopBack()) return false; blurField(); A.popBack(); },
  forward: () => { if (tabHook(A.currentTab().id, 'forward')) return; if (!A.canPopForward()) return false; blurField(); A.popForward(); },
  popout: () => A.popOut(),
  quote: () => { if (tabHook(A.currentTab().id, 'addr')) return; if (!quoteSelection(false)) toast('Select text in a thread first'); },
  quoteside: () => { if (!quoteSelection(true)) toast('Select text in a thread first'); },
  changes: () => openTool('changes'),
  files: () => openTool('files'),
  browser: () => openTool('browser'),
  w: () => saveFile(),
  // every thread tab, and new threads from now on (Settings > General)
  termall: () => { A.allViews('term'); void setSetting({ defaultView: 'term' }); },
  chatall: () => { A.allViews('chat'); void setSetting({ defaultView: 'chat' }); },
  compact: () => void setSetting({ density: 'compact' }),
  balanced: () => void setSetting({ density: 'balanced' }),
  detailed: () => void setSetting({ density: 'detailed' }),
  recent: () => void setSetting({ sideView: 'recent' }),
  grouped: () => void setSetting({ sideView: 'grouped' }),
  theme: () => void setSetting({ theme: themeNow() === 'dark' ? 'light' : 'dark' }),
  novim: () => void setSetting({ vim: !S.settings.vim }),
};

/** Run a command by name, with any arguments after it (`new linux ~/repo`). Unknown names (from a vimrc) say so. */
export function run(command: string): boolean {
  const c = command.trim().replace(/^:/, '');
  const exact = RUN[c] || RUN[ALIASES[c]];
  if (exact) return exact([]) !== false;
  const [name, ...args] = c.split(/\s+/);
  const f = RUN[name] || RUN[ALIASES[name]];
  if (f) return f(args) !== false;
  if (/^\d+$/.test(c)) { const p = A.focusedPane(); const t = p.tabs[+c - 1]; if (t) A.activate(p.id, t.id); return true; }
  toast(h('span', null, 'Not a command: ', h('b', null, c)));
  return true;
}
export const commandNames = () => Object.keys(RUN);
export const takesArgs = (name: string) => /\[/.test(COMMANDS[name] || '');
export { S };
