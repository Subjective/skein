// Boots the single keydown handler and tells it who owns the keyboard.
import { api } from '../api';
import { Dispatcher, type Mode } from '../input/dispatcher';
import type { KeyLike } from '../input/keys';
import { canon } from '../input/platform';
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

/** A key that reached Skein some other way than the window's keydown (a Browser tab's page kept it back). */
export function dispatchKey(e: KeyLike) {
  if (!d) return;
  d.keymap = keymap();
  d.handle(e);
}

/** The keys Skein keeps while a Browser tab's page has the keyboard (VIM-MODEL rule 11, as for a terminal):
 *  esc (back to NORMAL), the leader, the global bindings that work in a terminal (every cmd key on a Mac), and
 *  mod-l for the address bar. */
let kept: { src: string; keys: Set<string> } | null = null;
export function keptKeys(): Set<string> {
  const src = S.settings.vimrc + '|' + S.settings.leader + '|' + S.info.platform;
  if (kept?.src === src) return kept.keys;
  const keys = new Set(['esc', canon(S.settings.leader), canon('mod-l')]);
  for (const [k, b] of keymap().global) if (b.term || k.includes('cmd-')) keys.add(k);
  kept = { src, keys };
  return keys;
}
let sent = '';
/** Tell main which keys to keep from pages, when that changed. */
export function syncKeptKeys() {
  const list = [...keptKeys()].sort(), key = list.join(' ');
  if (key !== sent) { sent = key; api.browser.keys(list); }
}
