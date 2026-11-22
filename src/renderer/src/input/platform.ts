// Which keyboard this is (VIM-MODEL section 5) and how a key is written for it.
// App commands use cmd on a Mac and ctrl elsewhere; Vim's own ctrl keys and the leader are ctrl on both.
export type OS = 'mac' | 'win' | 'linux';

export const OS: OS = (() => {
  const p = typeof navigator === 'undefined' ? '' : navigator.platform || '';
  return /Mac/i.test(p) ? 'mac' : /Win/i.test(p) ? 'win' : 'linux';
})();

/** 'mod' is cmd on a Mac and ctrl elsewhere. */
export const modName = (os: OS = OS) => (os === 'mac' ? 'cmd' : 'ctrl');

const ORDER = ['ctrl', 'alt', 'shift', 'cmd'];
/** A binding as written in the keymap ('mod-k') to the form keyOf() produces on this OS ('cmd-k' / 'ctrl-k'), with
 *  the modifiers in keyOf()'s order: 'mod-shift-a' is 'shift-cmd-a' on a Mac (written as is, it never matched). */
export const canon = (k: string, os: OS = OS) => k.split(' ').map(x => {
  const ps = x.split('-'), mods: string[] = [];
  while (ps.length > 1 && (ORDER.includes(ps[0]) || ps[0] === 'mod')) { const m = ps.shift()!; mods.push(m === 'mod' ? modName(os) : m); }
  return [...ORDER.filter(m => mods.includes(m)), ps.join('-')].join('-');
}).join(' ');

const GLYPH: Record<string, string> = { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
/** A key as this OS writes it: kb('mod-shift-a') is ⌘⇧A on a Mac and ctrl-shift-a on Windows. */
export function kb(str: string, os: OS = OS): string {
  return str.split(' ').map(x => {
    // shown in the order written (⌘⇧A, as the mockup writes it), not keyOf()'s
    const c = x.replace(/(^|-)mod-/, `$1${modName(os)}-`);
    if (os !== 'mac') return c.replace(/^ldr$/, 'ctrl-space');
    const ps = c.split('-');
    if (ps.length < 2 || c === '-') return c;
    const key = ps.pop()!;
    return ps.every(m => GLYPH[m]) ? ps.map(m => GLYPH[m]).join('') + (key === 'space' ? 'Space' : key === 'tab' ? 'Tab' : key.length === 1 ? key.toUpperCase() : key) : c;
  }).join(' ');
}
