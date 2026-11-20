// Command names (input/keymap.ts COMMANDS) to actions. The : line runs these too.
import { S, toast, update, ws } from '../state/store';
import * as A from '../state/actions';
import { cycleWorkspaces } from './switcher';
import { openCmdline, openKeys, openPalette, openPaneSearch, openSettings, openWorkspaces } from './overlays';
import { scrollback } from '../views/terminal/scrollback';
import { tabHook } from '../views/tools/hooks';
import { openTool, saveFile } from '../views/tools/open';
import { quoteSelection } from '../views/chat/threads';

const RUN: Record<string, () => void> = {
  palette: () => openPalette(),
  files: () => openPalette('file'),
  panesearch: () => openPaneSearch(),
  cmdline: () => openCmdline(),
  keys: () => openKeys(),
  settings: () => openSettings(),
  sidebar: () => update(s => { s.sideOpen = !s.sideOpen; if (!s.sideOpen) s.sideFocus = false; }),
  newthread: () => { const p = A.focusedPane(); update(() => A.addTab(p, A.launcherFor(A.currentTab()))); },
  tabnew: () => { const p = A.focusedPane(); update(s => { A.addTab(p, A.launcherFor(A.currentTab())); ws().pf = null; s.tick++; }); A.save(); },
  tabclose: () => A.closeTab(),
  tabnext: () => A.tabStep(1),
  tabprev: () => A.tabStep(-1),
  vsplit: () => A.split('row'),
  split: () => A.split('col'),
  vshell: () => A.split('row', A.shellFor(A.currentTab())),
  shell: () => A.split('col', A.shellFor(A.currentTab())),
  view: () => A.setView(A.currentTab()),
  zoom: () => A.zoom(),
  only: () => A.only(),
  workspaces: () => openWorkspaces(),
  wsnext: () => cycleWorkspaces(1),
  wsprev: () => cycleWorkspaces(-1),
  'focus h': () => A.focusDir('h'), 'focus j': () => A.focusDir('j'), 'focus k': () => A.focusDir('k'), 'focus l': () => A.focusDir('l'),
  'move h': () => A.movePane('h'), 'move j': () => A.movePane('j'), 'move k': () => A.movePane('k'), 'move l': () => A.movePane('l'),
  'resize -': () => A.resizePane(-0.05), 'resize +': () => A.resizePane(0.05),
  swap: () => A.swapNext(),
  scrollback: () => scrollback(A.currentTab().id),
  back: () => { if (tabHook(A.currentTab().id, 'back')) return; const w = ws(); if (w.pf) update(s => { const p = w.pops.find(x => x.tab.id === w.pf); s.tick++; w.pf = null; if (p?.from) w.focus = p.from; }); },
  forward: () => { if (tabHook(A.currentTab().id, 'forward')) return; const w = ws(); const p = w.pops[w.pops.length - 1]; if (p && !w.pf) update(s => { w.pf = p.tab.id; s.tick++; }); },
  popout: () => A.popOut(),
  quote: () => { if (tabHook(A.currentTab().id, 'addr')) return; if (!quoteSelection(false)) toast('Select text in a thread first'); },
  quoteside: () => { if (!quoteSelection(true)) toast('Select text in a thread first'); },
  changes: () => openTool('changes'),
  filesview: () => openTool('files'),
  browser: () => openTool('browser'),
  w: () => saveFile(),
  termall: () => A.allViews('term'),
  chatall: () => A.allViews('chat'),
  only_: () => A.only(),
};

/** Run a command by name. Unknown names (from a vimrc) say so. */
export function run(command: string) {
  const c = command.trim().replace(/^:/, '');
  const f = RUN[c];
  if (f) { f(); return; }
  if (/^\d+$/.test(c)) { const p = A.focusedPane(); const t = p.tabs[+c - 1]; if (t) A.activate(p.id, t.id); return; }
  toast(`Not a command: ${c}`);
}
export const commandNames = () => Object.keys(RUN).filter(k => !k.endsWith('_'));
export { S };
