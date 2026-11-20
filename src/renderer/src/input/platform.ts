// Which keyboard this is (VIM-MODEL section 5) and how a key is written for it.
// App commands use cmd on a Mac and ctrl elsewhere; Vim's own ctrl keys and the leader are ctrl on both.
export type OS = 'mac' | 'win' | 'linux';

export const OS: OS = (() => {
  const p = typeof navigator === 'undefined' ? '' : navigator.platform || '';
  return /Mac/i.test(p) ? 'mac' : /Win/i.test(p) ? 'win' : 'linux';
})();

/** 'mod' is cmd on a Mac and ctrl elsewhere. */
export const modName = (os: OS = OS) => (os === 'mac' ? 'cmd' : 'ctrl');

/** A binding as written in the keymap ('mod-k') to the form keyOf() produces on this OS ('cmd-k' / 'ctrl-k'). */
export const canon = (k: string, os: OS = OS) => k.split(' ').map(x => x.replace(/(^|-)mod-/, `$1${modName(os)}-`)).join(' ');

const GLYPH: Record<string, string> = { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
/** A key as this OS writes it: kb('mod-shift-a') is ⌘⇧A on a Mac and ctrl-shift-a on Windows. */
export function kb(str: string, os: OS = OS): string {
  return str.split(' ').map(x => {
    const c = canon(x, os);
    if (os !== 'mac') return c.replace(/^ldr$/, 'ctrl-space');
    const ps = c.split('-');
    if (ps.length < 2 || c === '-') return c;
    const key = ps.pop()!;
    return ps.every(m => GLYPH[m]) ? ps.map(m => GLYPH[m]).join('') + (key === 'space' ? 'Space' : key === 'tab' ? 'Tab' : key.length === 1 ? key.toUpperCase() : key) : c;
  }).join(' ');
}
