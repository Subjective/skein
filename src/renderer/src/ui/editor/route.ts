// Who gets a key pressed in a code editor: Skein's normal layer or the editor's Vim (VIM-MODEL rule 22).
// Leader, global and popup keys never get here: the dispatcher runs them first. Of the rest, Vim has every key
// while it is typing, selecting or in the middle of a command (2d, "a, f). With nothing pending in NORMAL,
// Skein's NORMAL keys win (H L tab switching, | \ splits, : the command line, / ? search, esc), so a key means the
// same thing in a file as in a thread. A two-key Skein sequence (g t, g v) is held at its first key: if the second
// does not finish it, both go to Vim (gg, gj).
import type { Mode } from '../../input/dispatcher';
import type { Keymap } from '../../input/keymap';

export type Route = { to: 'native' } | { to: 'skein' } | { to: 'hold' } | { to: 'run'; command: string } | { to: 'replay'; keys: string[] };

/**
 * @param held the first key of a Skein sequence, held back on the last key press ('' when none)
 * @returns `native`: the editor's Vim reads the DOM event; `skein`: the dispatcher's normal layer takes it; `hold`: keep it, it may start a Skein sequence; `run`: a held
 *   sequence finished, run its command; `replay`: it did not, send the held key and this one to Vim.
 */
export function route(k: string, mode: Mode, idle: boolean, held: string, km: Pick<Keymap, 'normal' | 'prefixes'>): Route {
  if (held) {
    const seq = `${held} ${k}`, b = km.normal.get(seq);
    return b ? { to: 'run', command: b.command } : { to: 'replay', keys: [held, k] };
  }
  if (mode !== 'NORMAL') return { to: 'native' };
  if (!idle) return { to: 'native' };
  if (km.normal.has(k)) return { to: 'skein' };
  if (km.prefixes.has(k)) return { to: 'hold' };
  return { to: 'native' };
}

/** The NORMAL keys Skein takes from Vim in an editor, with why. A new normal binding that shadows a Vim key must be
 *  added here on purpose (input/keyclash.test.ts checks). */
export const TAKEN_FROM_VIM: Record<string, string> = {
  H: 'previous tab, as everywhere (Vim: top of the screen)',
  L: 'next tab, as everywhere (Vim: bottom of the screen)',
  '|': 'split right (Vim: go to a column)',
  '\\': 'split down (unused in Vim)',
  ':': "Skein's : line, which also has :w (Vim's own ex line is not shown)",
  '?': 'search backwards, through the shared search popup (the editor maps it there before the keymap)',
  '/': 'search, through the shared search popup',
  esc: 'nothing pending in NORMAL: closes a popup, as everywhere (Vim: nothing)',
  'ctrl-w': "arms the leader, which has Vim's window keys (ctrl-w v, ctrl-w h ...)",
  'g t': 'next tab (Vim: the same)',
  'g T': 'previous tab (Vim: the same)',
  'g v': 'thread as chat or terminal (Vim: reselect the last visual area)',
};
