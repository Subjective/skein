// The keymap: every app command has a name (its ex-command, VIM-MODEL rule 12) and default keys in one of
// three layers. Surfaces (fields, readers, lists, terminals) handle their own motions; this file only holds
// what is shared. The vimrc adds to or replaces these defaults, and the keyboard sheet reads from here,
// so the two always agree.
import { canon, OS, type OS as Os } from './platform';

export type Layer = 'global' | 'leader' | 'normal';

export interface Binding {
  layer: Layer;
  /** As written: 'mod-k', 'alt-h', 'H', 'g t' (a sequence), leader layer keys without the leader. */
  keys: string;
  command: string;
  /** Also works while a terminal has the keys (VIM-MODEL rule 11). Every cmd key does, on a Mac. */
  term?: boolean;
  /** Only on this OS. */
  os?: Os[];
}

/** Command names and what the keyboard sheet calls them. Order is the sheet's order. */
export const COMMANDS: Record<string, string> = {
  palette: 'Search',
  files: 'Find a file',
  panesearch: 'Search this pane',
  cmdline: 'Command line',
  keys: 'Keyboard shortcuts',
  settings: 'Settings',
  sidebar: 'Show or hide the sidebar',
  newthread: 'New thread',
  tabnew: 'New tab',
  tabclose: 'Close tab',
  tabnext: 'Next tab',
  tabprev: 'Previous tab',
  vsplit: 'Split right',
  split: 'Split down',
  vshell: 'Shell to the right',
  shell: 'Shell below',
  view: 'Chat ⇄ terminal',
  zoom: 'Zoom pane',
  only: 'Close other panes',
  workspaces: 'Workspaces',
  wsnext: 'Last workspace',
  'focus h': 'Focus left', 'focus j': 'Focus down', 'focus k': 'Focus up', 'focus l': 'Focus right',
  'move h': 'Move pane left', 'move j': 'Move pane down', 'move k': 'Move pane up', 'move l': 'Move pane right',
  'resize -': 'Narrower', 'resize +': 'Wider',
  swap: 'Swap with next pane',
  scrollback: 'Read the terminal scrollback',
  back: 'Back (jump list)',
  forward: 'Forward (jump list)',
  popout: 'Pop the tab out',
  quote: 'Quote selection to chat',
  quoteside: 'Quote selection to a side chat',
  termall: 'Every thread as terminal',
  chatall: 'Every thread as chat',
};

export const DEFAULTS: Binding[] = [
  { layer: 'global', keys: 'mod-k', command: 'palette' },
  { layer: 'global', keys: 'mod-p', command: 'files' },
  { layer: 'global', keys: 'mod-shift-a', command: 'panesearch', term: true },
  { layer: 'global', keys: 'mod-l', command: 'quote' },
  { layer: 'global', keys: 'mod-shift-s', command: 'quoteside' },
  { layer: 'global', keys: 'mod-w', command: 'tabclose', term: true, os: ['mac'] },
  { layer: 'global', keys: 'mod-t', command: 'tabnew', term: true, os: ['mac'] },
  { layer: 'global', keys: 'mod-n', command: 'newthread', term: true, os: ['mac'] },
  { layer: 'global', keys: 'mod-,', command: 'settings', term: true, os: ['mac'] },
  { layer: 'global', keys: 'alt-h', command: 'focus h', term: true },
  { layer: 'global', keys: 'alt-j', command: 'focus j', term: true },
  { layer: 'global', keys: 'alt-k', command: 'focus k', term: true },
  { layer: 'global', keys: 'alt-l', command: 'focus l', term: true },
  { layer: 'global', keys: 'ctrl-tab', command: 'wsnext', term: true },
  { layer: 'global', keys: 'ctrl-o', command: 'back' },
  { layer: 'global', keys: 'ctrl-i', command: 'forward' },

  { layer: 'leader', keys: 'v', command: 'vsplit' },
  { layer: 'leader', keys: 's', command: 'split' },
  { layer: 'leader', keys: '%', command: 'vshell' },
  { layer: 'leader', keys: '"', command: 'shell' },
  { layer: 'leader', keys: 'c', command: 'tabnew' },
  { layer: 'leader', keys: 'q', command: 'tabclose' },
  { layer: 'leader', keys: 'n', command: 'tabnext' },
  { layer: 'leader', keys: 'p', command: 'tabprev' },
  { layer: 'leader', keys: 't', command: 'view' },
  { layer: 'leader', keys: 'z', command: 'zoom' },
  { layer: 'leader', keys: 'o', command: 'only' },
  { layer: 'leader', keys: 'w', command: 'workspaces' },
  { layer: 'leader', keys: 'b', command: 'sidebar' },
  { layer: 'leader', keys: 'f', command: 'popout' },
  { layer: 'leader', keys: 'h', command: 'focus h' },
  { layer: 'leader', keys: 'j', command: 'focus j' },
  { layer: 'leader', keys: 'k', command: 'focus k' },
  { layer: 'leader', keys: 'l', command: 'focus l' },
  { layer: 'leader', keys: 'H', command: 'move h' },
  { layer: 'leader', keys: 'J', command: 'move j' },
  { layer: 'leader', keys: 'K', command: 'move k' },
  { layer: 'leader', keys: 'L', command: 'move l' },
  { layer: 'leader', keys: '<', command: 'resize -' },
  { layer: 'leader', keys: '>', command: 'resize +' },
  { layer: 'leader', keys: 'x', command: 'swap' },
  { layer: 'leader', keys: '[', command: 'scrollback' },
  { layer: 'leader', keys: 'esc', command: 'scrollback' },
  { layer: 'leader', keys: ':', command: 'cmdline' },

  { layer: 'normal', keys: 'H', command: 'tabprev' },
  { layer: 'normal', keys: 'L', command: 'tabnext' },
  { layer: 'normal', keys: 'g t', command: 'tabnext' },
  { layer: 'normal', keys: 'g T', command: 'tabprev' },
  { layer: 'normal', keys: '|', command: 'vsplit' },
  { layer: 'normal', keys: '\\', command: 'split' },
  { layer: 'normal', keys: ':', command: 'cmdline' },
  { layer: 'normal', keys: '?', command: 'keys' },
  { layer: 'normal', keys: 'ctrl-w v', command: 'vsplit' },
  { layer: 'normal', keys: 'ctrl-w s', command: 'split' },
  { layer: 'normal', keys: 'ctrl-w h', command: 'focus h' },
  { layer: 'normal', keys: 'ctrl-w j', command: 'focus j' },
  { layer: 'normal', keys: 'ctrl-w k', command: 'focus k' },
  { layer: 'normal', keys: 'ctrl-w l', command: 'focus l' },
  { layer: 'normal', keys: 'ctrl-w q', command: 'tabclose' },
  { layer: 'normal', keys: 'ctrl-w o', command: 'only' },
  { layer: 'normal', keys: 'ctrl-w x', command: 'swap' },
];

// ---------------- vimrc ----------------
// Honoured forms: `inoremap xy <Esc>`, `nnoremap X :command<CR>`, `nnoremap <leader>X :command<CR>`.
// Comments start with ". Anything else is kept as is and ignored.

export interface Vimrc { imap: string[]; normal: Binding[]; leader: Binding[]; errors: string[] }

const VKEY: Record<string, string> = { '<space>': 'space', '<bar>': '|', '<bslash>': '\\', '<lt>': '<', '<esc>': 'esc', '<cr>': 'enter', '<tab>': 'tab' };
/** Vim key notation to ours: <C-w>v -> 'ctrl-w v', gt -> 'g t'. */
export function fromVimKeys(s: string): string {
  const out: string[] = [];
  for (const m of s.matchAll(/<[^>]+>|./g)) {
    const t = m[0];
    if (t.length > 1) {
      const lower = t.toLowerCase();
      if (VKEY[lower]) { out.push(VKEY[lower]); continue; }
      const mod = /^<([CMAS])-(.+)>$/i.exec(t);
      if (mod) { const name = { c: 'ctrl', m: 'alt', a: 'alt', s: 'shift' }[mod[1].toLowerCase()]!; out.push(`${name}-${mod[2].length === 1 ? mod[2].toLowerCase() : fromVimKeys('<' + mod[2] + '>')}`); continue; }
      out.push(t);
    } else out.push(t);
  }
  return out.join(' ');
}
export function toVimKeys(k: string): string {
  return k.split(' ').map(x => {
    const rev = Object.entries(VKEY).find(([, v]) => v === x)?.[0];
    if (rev) return rev.replace(/^<(\w)/, (_, c) => '<' + c.toUpperCase());
    const m = /^(ctrl|alt|shift)-(.+)$/.exec(x);
    return m ? `<${{ ctrl: 'C', alt: 'M', shift: 'S' }[m[1]]}-${m[2]}>` : x;
  }).join('');
}

export function parseVimrc(text: string): Vimrc {
  const r: Vimrc = { imap: [], normal: [], leader: [], errors: [] };
  text.split(/\r?\n/).forEach((line, n) => {
    const l = line.trim();
    if (!l || l.startsWith('"')) return;
    let m;
    if ((m = /^inoremap\s+(\S\S)\s+<Esc>$/i.exec(l))) r.imap.push(m[1]);
    else if ((m = /^nnoremap\s+<leader>(\S+)\s+:(.+?)<CR>$/i.exec(l))) r.leader.push({ layer: 'leader', keys: fromVimKeys(m[1]), command: m[2].trim() });
    else if ((m = /^nnoremap\s+(\S+)\s+:(.+?)<CR>$/i.exec(l))) r.normal.push({ layer: 'normal', keys: fromVimKeys(m[1]), command: m[2].trim() });
    else r.errors.push(`line ${n + 1}: not understood`);
  });
  return r;
}

/** Bind `keys` to `command` in the vimrc. A key means one thing: an existing line for that key is replaced. */
export function bindInVimrc(text: string, layer: 'normal' | 'leader', keys: string, command: string): string {
  const lhs = (layer === 'leader' ? '<leader>' : '') + toVimKeys(keys);
  const line = `nnoremap ${lhs} :${command}<CR>`;
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex(l => { const m = /^\s*nnoremap\s+(\S+)\s+/i.exec(l); return !!m && m[1] === lhs; });
  if (i >= 0) lines[i] = line; else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push(line, ''); }
  return lines.join('\n');
}

// ---------------- the resolved keymap ----------------

export class Keymap {
  global = new Map<string, Binding>();
  leader = new Map<string, Binding>();
  normal = new Map<string, Binding>();
  /** Prefixes of normal-layer sequences ('g', 'ctrl-w'), so a first key waits for the second. */
  prefixes = new Set<string>();
  imap: string[] = [];
  constructor(public os: Os = OS) {}

  static build(vimrc: string, os: Os = OS): Keymap {
    const k = new Keymap(os);
    for (const b of DEFAULTS) if (!b.os || b.os.includes(os)) k.add(b);
    const rc = parseVimrc(vimrc);
    for (const b of [...rc.normal, ...rc.leader]) k.add(b);
    k.imap = rc.imap;
    return k;
  }
  add(b: Binding) {
    const keys = canon(b.keys, this.os);
    const map = this[b.layer];
    map.set(keys, { ...b, keys });
    if (b.layer === 'normal') { const ps = keys.split(' '); for (let i = 1; i < ps.length; i++) this.prefixes.add(ps.slice(0, i).join(' ')); }
  }
  /** Keys bound to a command, for menus and the keyboard sheet. */
  keysFor(command: string): Binding[] {
    return [...this.global.values(), ...this.leader.values(), ...this.normal.values()].filter(b => b.command === command);
  }
}
