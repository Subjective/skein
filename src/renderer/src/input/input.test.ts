import { describe, expect, it } from 'vitest';
import { Dispatcher, type Surface } from './dispatcher';
import { keyOf } from './keys';
import { bindInVimrc, fromVimKeys, Keymap, parseVimrc, toVimKeys } from './keymap';
import { kb } from './platform';
import { init, step, tokAt, vrange, type TextState } from './vimtext';
import { Count, findAll, fromHere, nextHit, repeat, wrapNotice } from './readerkeys';
import { forPut, fromClipboard, setReg } from './register';

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

function harness(mode: Surface['mode'] extends () => infer M ? M : never, kind: Surface['kind'] = 'reader', consume: string[] = [], local = false) {
  const ran: string[] = [];
  const seen: string[] = [];
  const surface: Surface = { kind, mode: () => mode, key: k => { seen.push(k); return consume.includes(k); }, imap: f => ran.push('imap:' + f), local: () => local };
  const d = new Dispatcher(Keymap.build('inoremap jk <Esc>', 'win'), { surface: () => surface, run: c => { ran.push(c); }, vim: () => true, leaderKey: () => 'ctrl-space', pending: () => {} });
  const press = (key: string, code: string, m?: Parameters<typeof ev>[2]) => d.handle(ev(key, code, m));
  return { ran, seen, press };
}

describe('dispatcher', () => {
  it('a focused popup (local surface) is modal: its keys win and global bindings wait', () => {
    const h = harness('INSERT', 'field', ['ctrl-p'], true);
    h.press('p', 'KeyP', { ctrl: true });
    expect(h.ran).toEqual([]);
    h.press('k', 'KeyK', { ctrl: true });
    h.press(' ', 'Space', { ctrl: true }); h.press('v', 'KeyV');
    expect(h.ran).toEqual([]);                                // modal: no palette, no leader behind it
    h.press('Tab', 'Tab', { ctrl: true });
    expect(h.ran).toEqual(['wsnext']);                        // the workspace switcher still cycles
    const plain = harness('INSERT', 'field', ['ctrl-p']);
    plain.press('p', 'KeyP', { ctrl: true });
    expect(plain.ran).toEqual(['find']);
  });
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
  it('treats a quote (U+2063 … U+2063) as one item', () => {
    const Q = '\u2063“seven days”\u2063', t = `ab ${Q} cd`, q0 = 3, q1 = 3 + Q.length;
    expect(tokAt(t, q0 + 4)).toEqual([q0, q1]);
    expect(run(n(t, 1), 'l l').pos).toBe(q0);          // onto the quote: its start
    expect(run(n(t, q0), 'l').pos).toBe(q1);           // off it in one step
    expect(run(n(t, q1), 'h').pos).toBe(q0);           // back onto it: its start
    expect(run(n(t, 0), 'w').pos).toBe(q0);
    expect(run(n(t, q0), 'w').pos).toBe(q1 + 1);
    expect(run(n(t, q1 + 1), 'b').pos).toBe(q0);
    expect(run(n(t, q0), 'x').text).toBe('ab  cd');    // deleted whole
    expect(run(n(t, 0), 'd w').text).toBe(`${Q} cd`);
    expect(run(n(t, 1), 'd 2 w').text).toBe('a cd');   // an operator over part of it takes all of it
    expect(run(n(t, q0), 'a').pos).toBe(q1);           // append after it, not inside
    expect(run(n(t, q0), 'r z').text).toBe(t);         // r and ~ leave it alone
    const v = run(n(t, 1), 'v l l');
    expect(vrange(v)).toEqual([1, q1]);                // VISUAL takes it whole
  });
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

describe('fields: counts, yank and put', () => {
  const n = (t: string, pos = 0) => ({ ...init(t, 'NORMAL'), pos });
  it('5G and 5gg go to line 5, G alone to the last line', () => {
    const t = 'a\nb\nc\nd\ne\nf';
    expect(run(n(t), '5 G').pos).toBe(8);
    expect(run(n(t, 10), '2 g g').pos).toBe(2);
    expect(run(n(t), 'G').pos).toBe(10);
    expect(run(n(t), '9 9 G').pos).toBe(10);       // past the end: the last line
    expect(run(n(t, 4), 'd 1 G').text).toBe('d\ne\nf');
    expect(run(n(t, 4), 'd g g').text).toBe('d\ne\nf');
  });
  it('a count before or after the operator (or both) multiplies', () => {
    expect(run(n('a b c d e f g'), 'd 2 w').text).toBe('c d e f g');
    expect(run(n('a b c d e f g'), '2 d w').text).toBe('c d e f g');
    expect(run(n('a b c d e f g'), '2 d 2 w').text).toBe('e f g');
    expect(run(n('a\nb\nc\nd'), 'd 2 d').text).toBe('c\nd');
    expect(run(n('abc'), 'r 5').text).toBe('5bc');
  });
  it('y yy p P put the register, with counts', () => {
    expect(run(n('ab'), 'y l 3 p').text).toBe('aaaab');
    expect(run(n('ab'), 'y l P').text).toBe('aab');
    expect(run(n('one\ntwo'), 'y y j p').text).toBe('one\ntwo\none');
    expect(run(n('one\ntwo', 4), 'y y k P').text).toBe('two\none\ntwo');
    expect(run(n('one'), 'y y 2 p').text).toBe('one\none\none');
    expect(run(n('foo bar'), 'd w $ p').text).toBe('barfoo ');
  });
  it('p with an empty register does nothing and clears a count', () => {
    const s = run(n('abc'), '3 p');
    expect(s.text).toBe('abc'); expect(s.pending).toBe('');
  });
  it('the register can come from outside (another field, the clipboard)', () => {
    const s = { ...n('x'), reg: fromClipboard('hello') };
    expect(run(s, 'p').text).toBe('xhello');
    const l = { ...n('x'), reg: fromClipboard('line one\n') };
    expect(l.reg).toEqual({ text: 'line one', line: true });
    expect(run(l, 'p').text).toBe('x\nline one');
  });
});

describe('the shared register', () => {
  it('p takes the system clipboard only while the register is empty', async () => {
    setReg({ text: '', line: false });
    expect(await forPut(async () => 'from the clipboard')).toEqual({ text: 'from the clipboard', line: false });
    expect(await forPut(async () => 'a\r\nb\r\n')).toEqual({ text: 'a\nb', line: true });
    expect(await forPut(async () => { throw new Error('denied'); })).toEqual({ text: '', line: false });
    setReg({ text: 'yanked', line: false });
    expect(await forPut(async () => 'from the clipboard')).toEqual({ text: 'yanked', line: false });
    setReg({ text: '', line: false });
  });
});

describe('reader keys: counts and search', () => {
  it('a count gathers digits; 0 is a motion until a count starts', () => {
    const c = new Count();
    expect(c.feed('0')).toBe(false);
    expect(c.feed('1')).toBe(true); expect(c.feed('0')).toBe(true);
    expect(c.explicit).toBe(true);
    expect(c.take()).toBe(10);
    expect(c.take()).toBe(1);
    expect(c.explicit).toBe(false);
    let at = 0;
    expect(repeat(5, () => (at < 3 ? (at++, true) : false))).toBe(3);
  });
  it('finds every match, smart case, literally', () => {
    const items = ['Foo foo', 'bar', 'a.b foo'];
    expect(findAll(items, 'foo')).toEqual([{ i: 0, o: 0, len: 3 }, { i: 0, o: 4, len: 3 }, { i: 2, o: 4, len: 3 }]);
    expect(findAll(items, 'Foo')).toEqual([{ i: 0, o: 0, len: 3 }]);
    expect(findAll(items, '.')).toEqual([{ i: 2, o: 1, len: 1 }]);
    expect(findAll(items, '')).toEqual([]);
  });
  it('n and N go to the next match from the cursor and wrap at the ends', () => {
    const hits = findAll(['x', 'foo', 'x', 'foo foo'], 'foo');
    expect(nextHit(hits, { i: 0, o: 0 }, 1)).toMatchObject({ hit: { i: 1, o: 0 }, wrapped: false });
    expect(nextHit(hits, { i: 3, o: 0 }, 1)).toMatchObject({ hit: { i: 3, o: 4 }, wrapped: false });
    expect(nextHit(hits, { i: 3, o: 4 }, 1)).toMatchObject({ hit: { i: 1, o: 0 }, wrapped: true });
    expect(nextHit(hits, { i: 1, o: 0 }, -1)).toMatchObject({ hit: { i: 3, o: 4 }, wrapped: true });
    expect(nextHit(hits, { i: 2, o: 0 }, -1)).toMatchObject({ hit: { i: 1, o: 0 }, wrapped: false });
    expect(nextHit([], { i: 0, o: 0 }, 1)).toBeNull();
    expect(wrapNotice(1)).toMatch(/BOTTOM/);
  });
  it('lists matches nearest first in the search direction, marking the wrapped ones', () => {
    const hits = findAll(['a', 'b', 'a', 'b', 'a'], 'a');   // lines 0 2 4
    expect(fromHere(hits, { i: 1, o: 0 }, 1).map(x => [x.hit.i, x.wrapped])).toEqual([[2, false], [4, false], [0, true]]);
    expect(fromHere(hits, { i: 3, o: 0 }, -1).map(x => [x.hit.i, x.wrapped])).toEqual([[2, false], [0, false], [4, true]]);
    expect(fromHere(hits, { i: 4, o: 0 }, 1).map(x => [x.hit.i, x.wrapped])).toEqual([[0, true], [2, true], [4, true]]);
  });
});
