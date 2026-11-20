// Boots the single keydown handler and tells it who owns the keyboard.
import { api } from '../api';
import { Dispatcher, type Mode, type Surface } from '../input/dispatcher';
import type { KeyLike } from '../input/keys';
import { canon } from '../input/platform';
import { layoutSurface, tabSurface } from '../input/surfaces';
import * as A from '../state/actions';
import { S, topLayer, update, ws } from '../state/store';
import { run } from './commands';
import { keymap } from './overlays';
import { sidebarSurface } from './Sidebar';

// Every overlay (menu, palette, dialog, picker, viewer) is a popup, so it is modal (VIM-MODEL rule 20) whether or
// not its own surface says so: ctrl-k / ctrl-p move its list or do nothing, they never open a second search on top.
const popupLayout: Surface = { kind: 'layout', mode: () => 'NORMAL', key: k => k.length === 1, local: () => true };
const asPopup = new WeakMap<Surface, Surface>();
export const modal = (s: Surface): Surface => {
  if (s.local) return s.local() ? s : asPopupOf(s);
  return asPopupOf(s);
};
function asPopupOf(s: Surface): Surface {
  let m = asPopup.get(s);
  if (!m) { m = { kind: s.kind, mode: () => s.mode(), key: (k, e) => s.key(k, e), local: () => true, ...(s.imap ? { imap: (f: string) => s.imap!(f) } : {}) }; asPopup.set(s, m); }
  return m;
}

export function owner() {
  const top = topLayer();
  if (top) return top.surface ? modal(top.surface) : popupLayout;
  if (S.sideFocus) return sidebarSurface;
  const w = ws();
  return tabSurface(A.currentTab(w).id) || layoutSurface;
}
export const currentMode = (): Mode => owner().mode();

let d: Dispatcher | null = null;
/** Takes every key before the dispatcher (the keyboard sheet waiting for a new key, leader included). */
let capture: ((e: KeyboardEvent) => boolean) | null = null;
export function captureKeys(f: typeof capture) { capture = f; }
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
    if (capture && capture(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    d.keymap = keymap();
    if (d.handle(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

/** Arm the leader as if its key was pressed (ctrl-w in app NORMAL). */
export function armLeader() {
  if (!d) return;
  const bs = S.settings.leader === 'ctrl-\\';
  d.handle({ key: bs ? '\\' : ' ', code: bs ? 'Backslash' : 'Space', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false });
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
