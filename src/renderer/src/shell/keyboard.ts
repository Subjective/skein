// Boots the single keydown handler and tells it who owns the keyboard.
import { Dispatcher, type Mode } from '../input/dispatcher';
import { layoutSurface, tabSurface } from '../input/surfaces';
import * as A from '../state/actions';
import { S, topLayer, update, ws } from '../state/store';
import { run } from './commands';
import { keymap } from './overlays';
import { sidebarSurface } from './Sidebar';

export function owner() {
  const top = topLayer();
  if (top) return top.surface || layoutSurface;
  if (S.sideFocus) return sidebarSurface;
  const w = ws();
  return tabSurface(A.currentTab(w).id) || layoutSurface;
}
export const currentMode = (): Mode => owner().mode();

let d: Dispatcher | null = null;
export function startKeyboard() {
  d = new Dispatcher(keymap(), {
    surface: owner,
    run: c => run(c),
    vim: () => S.settings.vim,
    leaderKey: () => S.settings.leader,
    pending: p => update(s => { s.leader = p.leader; s.seq = p.seq; }),
  });
  // capture phase: we decide before xterm or a textarea sees the key (rule 11 is enforced here)
  window.addEventListener('keydown', e => {
    if (!d) return;
    d.keymap = keymap();
    if (d.handle(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
