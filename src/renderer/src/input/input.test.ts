import { describe, expect, it } from 'vitest';
import { Dispatcher, type Surface } from './dispatcher';
import { keyOf } from './keys';
import { bindInVimrc, fromVimKeys, Keymap, parseVimrc, toVimKeys } from './keymap';
import { kb } from './platform';
import { init, step, type TextState } from './vimtext';

const ev = (key: string, code: string, m: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) =>
  ({ key, code, ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: !!m.shift, metaKey: !!m.meta });

describe('keyOf', () => {
  it('names keys the same way everywhere', () => {
    expect(keyOf(ev('j', 'KeyJ'))).toBe('j');
    expect(keyOf(ev('J', 'KeyJ', { shift: true }))).toBe('J');
    expect(keyOf(ev('|', 'Backslash', { shift: true }))).toBe('|');
    expect(keyOf(ev(' ', 'Space', { ctrl: true }))).toBe('ctrl-space');
    expect(keyOf(ev('˙', 'KeyH', { alt: true }))).toBe('alt-h');          // option-h on a Mac
    expect(keyOf(ev('A', 'KeyA', { ctrl: true, shift: true }))).toBe('ctrl-shift-a');
    expect(keyOf(ev('k', 'KeyK', { meta: true }))).toBe('cmd-k');
    expect(keyOf(ev('Tab', 'Tab', { shift: true }))).toBe('shift-tab');
    expect(keyOf(ev('Escape', 'Escape'))).toBe('esc');
    expect(keyOf(ev('Shift', 'ShiftLeft', { shift: true }))).toBeNull();
  });
  it('writes keys per OS', () => {
    expect(kb('mod-shift-a', 'mac')).toBe('⌘⇧A');
    expect(kb('mod-shift-a', 'win')).toBe('ctrl-shift-a');
    expect(kb('ctrl-space', 'mac')).toBe('⌃Space');
  });
});

describe('vimrc', () => {
  it('parses the three forms and converts key notation', () => {
    const r = parseVimrc('" c\ninoremap jk <Esc>\nnnoremap T :termall<CR>\nnnoremap <leader>g :workspaces<CR>\nnnoremap <C-w>v :vsplit<CR>\nset nu');
    expect(r.imap).toEqual(['jk']);
    expect(r.normal.map(b => b.keys)).toEqual(['T', 'ctrl-w v']);
    expect(r.leader[0]).toMatchObject({ keys: 'g', command: 'workspaces' });
    expect(r.errors).toHaveLength(1);
    expect(fromVimKeys('gt')).toBe('g t');
    expect(toVimKeys('ctrl-w v')).toBe('<C-w>v');
  });
  it('replaces the line of a key that is already bound (rule 12)', () => {
    let t = 'inoremap jk <Esc>\nnnoremap T :termall<CR>\n';
    t = bindInVimrc(t, 'normal', 'T', 'zoom');
    expect(t.match(/nnoremap T/g)).toHaveLength(1);
    expect(t).toContain('nnoremap T :zoom<CR>');
    t = bindInVimrc(t, 'leader', 'g', 'workspaces');
    expect(t).toContain('nnoremap <leader>g :workspaces<CR>');
  });
  it('vimrc overrides defaults and resolves mod per OS', () => {
    const mac = Keymap.build('nnoremap H :zoom<CR>', 'mac');
    expect(mac.normal.get('H')?.command).toBe('zoom');
    expect(mac.global.get('cmd-k')?.command).toBe('palette');
    const win = Keymap.build('', 'win');
    expect(win.global.get('ctrl-k')?.command).toBe('palette');
    expect(win.global.has('ctrl-w')).toBe(false);           // ctrl-w is Vim's window prefix on Windows
    expect(mac.global.get('cmd-w')?.command).toBe('tabclose');
  });
});

function harness(mode: Surface['mode'] extends () => infer M ? M : never, kind: Surface['kind'] = 'reader', consume: string[] = []) {
  const ran: string[] = [];
  const seen: string[] = [];
  const surface: Surface = { kind, mode: () => mode, key: k => { seen.push(k); return consume.includes(k); }, imap: f => ran.push('imap:' + f) };
  const d = new Dispatcher(Keymap.build('inoremap jk <Esc>', 'win'), { surface: () => surface, run: c => ran.push(c), vim: () => true, leaderKey: () => 'ctrl-space', pending: () => {} });
  const press = (key: string, code: string, m?: Parameters<typeof ev>[2]) => d.handle(ev(key, code, m));
  return { ran, seen, press };
}

describe('dispatcher', () => {
  it('leader then a key runs the leader command', () => {
    const h = harness('NORMAL');
    expect(h.press(' ', 'Space', { ctrl: true })).toBe(true);
    h.press('v', 'KeyV');
    expect(h.ran).toEqual(['vsplit']);
  });
  it('normal layer runs only when the surface does not take the key, with sequences', () => {
    const h = harness('NORMAL', 'reader', ['j']);
    h.press('j', 'KeyJ'); h.press('L', 'KeyL', { shift: true }); h.press('g', 'KeyG'); h.press('T', 'KeyT', { shift: true });
    expect(h.ran).toEqual(['tabnext', 'tabprev']);
  });
  it('in INSERT plain keys type, and jk leaves INSERT in a field', () => {
    const h = harness('INSERT', 'field');
    expect(h.press('L', 'KeyL', { shift: true })).toBe(false);
    h.press('j', 'KeyJ'); h.press('k', 'KeyK');
    expect(h.ran).toEqual(['imap:j']);
  });
  it('a terminal keeps ctrl-k / ctrl-o but not alt-h (rule 11)', () => {
    const h = harness('TERMINAL', 'terminal');
    h.press('k', 'KeyK', { ctrl: true });
    h.press('o', 'KeyO', { ctrl: true });
    h.press('˙', 'KeyH', { alt: true });
    h.press('A', 'KeyA', { ctrl: true, shift: true });
    expect(h.ran).toEqual(['focus h', 'panesearch']);
    expect(h.seen).toContain('ctrl-k');
    expect(h.seen).toContain('ctrl-o');
  });
});

const run = (s: TextState, keys: string) => { for (const k of keys.split(' ')) s = step(s, k).s; return s; };

describe('vim text engine', () => {
  const n = (t: string, pos = 0) => ({ ...init(t, 'NORMAL'), pos });
  it('moves by words and line ends', () => {
    expect(run(n('foo bar baz'), 'w').pos).toBe(4);
    expect(run(n('foo bar baz'), 'w w b').pos).toBe(4);
    expect(run(n('foo bar baz'), 'e').pos).toBe(2);
    expect(run(n('foo bar baz'), '$').pos).toBe(10);
    expect(run(n('  foo', 4), '^').pos).toBe(2);
    expect(run(n('foo bar baz'), '2 w').pos).toBe(8);
  });
  it('deletes, changes and yanks with motions', () => {
    expect(run(n('foo bar baz'), 'd w').text).toBe('bar baz');
    expect(run(n('foo bar baz', 4), 'd i w').text).toBe('foo  baz');
    const c = run(n('foo bar'), 'c w');
    expect(c.text).toBe(' bar'); expect(c.mode).toBe('INSERT');
    expect(run(n('a\nb\nc', 2), 'd d').text).toBe('a\nc');
    expect(run(n('a\nb\nc', 4), 'd d').text).toBe('a\nb');
    expect(run(n('abc'), 'x').text).toBe('bc');
    expect(run(n('abc def'), 'D').text).toBe('');
    expect(run(n('a\nb', 0), 'y y p').text).toBe('a\na\nb');
    expect(run(n('ab'), 'y l p').text).toBe('aab');
  });
  it('j and k leave the field at its edges (rule 7)', () => {
    expect(step(n('one\ntwo', 0), 'k').fx).toContain('leave-up');
    expect(step(n('one\ntwo', 5), 'j').fx).toContain('leave-down');
    expect(run(n('one\ntwo', 1), 'j').pos).toBe(5);
  });
  it('u and ctrl-r undo one NORMAL edit or one INSERT stretch (rule 17)', () => {
    let s = n('abc');
    s = run(s, 'x x');
    expect(s.text).toBe('c');
    s = run(s, 'u'); expect(s.text).toBe('bc');
    s = run(s, 'ctrl-r'); expect(s.text).toBe('c');
    s = run(s, 'A'); s = { ...s, text: 'c hello', pos: 7 }; s = run(s, 'esc');
    expect(s.text).toBe('c hello');
    s = run(s, 'u'); expect(s.text).toBe('c');
  });
  it('visual selects within the field and operates', () => {
    expect(run(n('foo bar'), 'v e d').text).toBe(' bar');
    expect(run(n('a\nb\nc', 2), 'V d').text).toBe('a\nc');
    expect(run(n('foo'), 'v esc').mode).toBe('NORMAL');
  });
  it('esc from NORMAL leaves, enter sends', () => {
    expect(step(n('x'), 'esc').fx).toEqual(['leave']);
    expect(step(n('x'), 'enter').fx).toEqual(['enter']);
    expect(step(init('x'), 'esc').s.mode).toBe('NORMAL');
  });
});
