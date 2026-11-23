// A text field driven by the Vim engine (input/vimtext.ts). Composers, the vimrc editor and other editable
// text all use this, so a key means the same thing in each (VIM-MODEL: Field).
// The NORMAL cursor is drawn as a one-character selection (class `vn`), VISUAL as the selection itself. Where
// there is no character to sit on (an empty field, an empty line) the caret itself is the cursor (`hollow`); a
// field with a layer behind its text (the composer's .bk) draws it there as a block (`onCursor`, as the mockup's
// Vim.block does). Only the focused field draws a cursor: on blur the classes go (one cursor on screen, ever).
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { KeyLike } from '../input/keys';
import type { Mode, Surface } from '../input/dispatcher';
import { registerTab } from '../input/surfaces';
import { forPut, getReg, setReg } from '../input/register';
import { init, opPending, setText, step, tokAt, typed, vrange, type Effect, type TextState } from '../input/vimtext';
import { opCursor } from './opcursor';
import { S, toast, update } from '../state/store';
import { cx } from './primitives';
import { revealCaret } from './caret';

export interface VimFieldHandle { focus(insert?: boolean): void; set(text: string, pos?: number): void; state(): TextState; el(): HTMLTextAreaElement | null; /** Put the cursor at an offset, in NORMAL or with a VISUAL selection (a reader handing over to the editor). */ at(pos: number, vis?: { anchor: number; mode: 'VISUAL' | 'V-LINE' }): void }

export interface VimFieldProps {
  /** Register as the keyboard owner of this tab while focused. */
  tabId: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  /** enter (INSERT or NORMAL) sends; shift-enter is a newline. Without it enter types a newline. */
  onEnter?: () => void;
  /** esc from NORMAL (or from INSERT with Vim off) */
  onLeave?: () => void;
  onLeaveUp?: () => void;
  onLeaveDown?: () => void;
  /** Keys the owner wants first (the / menu, the @ menu, composer controls). */
  onKey?: (k: string, mode: Mode, e: KeyLike) => boolean;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  autoFocus?: boolean;
  /** Grow up to this many pixels, then scroll. */
  maxHeight?: number;
  mono?: boolean;
  startMode?: 'INSERT' | 'NORMAL';
  /** Where the layer behind the text should draw the cursor: `hollow` the block where there is no character,
   *  `vcur` the moving end of a VISUAL selection. null when the field has no cursor to draw (INSERT, blurred). */
  /** A popup of the owner's is open (the / or @ list): keys come here before the global bindings. */
  local?: () => boolean;
  onCursor?: (c: { hollow: number; vcur: number; op?: boolean } | null) => void;
}

const history = new Map<string, { text: string; undo: TextState['undo']; redo: TextState['redo'] }>();

// The last mousedown anywhere (capture), so a field focused because of a click elsewhere (a sidebar row opening a
// thread) can tell it was the mouse, not the keys.
let down = { at: 0, on: null as Element | null };
if (typeof document !== 'undefined') document.addEventListener('mousedown', e => { down = { at: Date.now(), on: e.target as Element | null }; }, true);
/** What the mouse went down on in the last `ms` milliseconds (null when it was the keyboard). */
export const recentMouse = (ms = 500): Element | null => (Date.now() - down.at < ms ? down.on : null);
/** A mousedown on any of these keeps a typing field in INSERT (the mockup's app.js 2038: fields, menus, dialogs, the
 *  composer and its controls, the edit box, the quote bar); terminals and pages keep their own keys (rule 11). */
const KEEPS = '[data-input], input, textarea, select, [contenteditable], .menu, .scrim, .comp, .newp, .m-edit, .seltb, .xterm, webview, iframe';

export const VimField = forwardRef<VimFieldHandle, VimFieldProps>(function VimField(p, handle) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const st = useRef<TextState>(null as unknown as TextState);
  if (!st.current) {   // undo history outlives a remount (tab moved, popped out, view switched), per field
    const kept = history.get(p.tabId), fresh = init(p.value, p.startMode || 'INSERT');
    st.current = kept && kept.text === p.value ? { ...fresh, undo: kept.undo, redo: kept.redo } : fresh;
  }
  useEffect(() => () => { history.set(props.current.tabId, { text: st.current.text, undo: st.current.undo, redo: st.current.redo }); }, []);
  const props = useRef(p); props.current = p;
  const first = useRef(p.value);

  const lastCur = useRef('');
  const cursor = (c: { hollow: number; vcur: number; op?: boolean } | null) => {
    const key = c ? `${c.hollow}:${c.vcur}:${!!c.op}` : '';
    if (key !== lastCur.current) { lastCur.current = key; props.current.onCursor?.(c); }
  };
  const paint = () => {
    const el = ta.current, s = st.current; if (!el) return;
    if (el.value !== s.text) el.value = s.text;
    const vim = S.settings.vim, focused = document.activeElement === el;
    const normal = vim && focused && s.mode !== 'INSERT', vis = s.mode === 'VISUAL' || s.mode === 'V-LINE';
    const hollow = normal && !vis && (s.pos >= s.text.length || s.text[s.pos] === '\n');
    el.classList.toggle('vn', normal);
    el.classList.toggle('vv', normal && vis);
    el.classList.toggle('hollow', hollow);
    el.classList.toggle('drawn', hollow && !!props.current.onCursor);
    // an operator waiting for its motion (d, c, y): the half block, drawn behind the text or floating over it
    const op = normal && !vis && opPending(s);
    el.classList.toggle('op', op);
    // keep the cursor in view: the browser only scrolls a textarea to its caret while typing, not for a NORMAL
    // motion (j, G, w, a search), so a long draft would leave the cursor (and the block drawn behind) out of sight
    if (focused && vim && s.mode !== 'INSERT') revealCaret(el, s.pos);
    cursor(normal ? { hollow: hollow ? s.pos : -1, vcur: (vis || op) && s.pos < s.text.length && s.text[s.pos] !== '\n' ? s.pos : -1, op } : null);
    if (op && !props.current.onCursor && focused) opCursor(el, s.pos); else if (!op || !focused) opCursor(null);
    if (!focused) return;
    if (!vim || s.mode === 'INSERT' || hollow) el.setSelectionRange(s.pos, s.pos);
    else if (s.mode === 'NORMAL') el.setSelectionRange(s.pos, tokAt(s.text, s.pos)?.[1] ?? Math.min(s.text.length, s.pos + 1));   // a quote is one block
    else { const [a, b] = vrange(s); el.setSelectionRange(a, b); }
  };
  // height: auto for a moment collapses the field, which clamps its scroll to the top: put the scroll back after
  const grow = () => {
    const el = ta.current; if (!el) return;
    const top = el.scrollTop;
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, p.maxHeight ?? 180) + 'px';
    el.scrollTop = top;
    if (document.activeElement === el && S.settings.vim && st.current.mode !== 'INSERT') revealCaret(el, st.current.pos);
  };

  // outside changes to value (send cleared it, a / pick replaced a word)
  useLayoutEffect(() => { if (p.value !== st.current.text) { st.current = setText(st.current, p.value); paint(); } grow(); }, [p.value]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (s: TextState, fx: Effect[]) => {
    const was = st.current.mode;
    st.current = s; paint(); grow();
    if (s.text !== props.current.value) props.current.onChange(s.text);
    if (s.mode !== was) update(x => { x.tick++; });
    for (const f of fx) {
      if (f === 'enter') props.current.onEnter?.();
      if (f === 'leave') props.current.onLeave?.();
      if (f === 'leave-up') props.current.onLeaveUp?.();
      if (f === 'leave-down') props.current.onLeaveDown?.();
      if (f === 'oldest' || f === 'newest') toast(f === 'oldest' ? 'Already at oldest change' : 'Already at newest change');   // Vim's own words
      if (f === 'yank') void navigator.clipboard?.writeText(s.reg.text + (s.reg.line ? '\n' : '')).catch(() => {});
    }
  };

  const surface: Surface = {
    kind: 'field',
    mode: () => (S.settings.vim ? st.current.mode : 'INSERT'),
    key: (k, e) => {
      const s = st.current, vim = S.settings.vim;
      const mode: Mode = vim ? s.mode : 'INSERT';
      if (props.current.onKey?.(k, mode, e)) return true;
      if (mode === 'INSERT') {
        if (k === 'enter' && props.current.onEnter) { props.current.onEnter(); return true; }
        if (k === 'esc') { if (!vim) { props.current.onLeave?.(); return true; } const r = step(s, 'esc'); apply(r.s, r.fx); return true; }
        return false;
      }
      // one register for every field (input/register); p / P with it empty put the system clipboard
      const shared = getReg();
      const before = { ...s, reg: shared };
      if ((k === 'p' || k === 'P') && s.mode === 'NORMAL' && /^\d*$/.test(s.pending) && !shared.text) {
        void forPut().then(reg => { if (!reg.text) { st.current = { ...st.current, pending: '' }; return; } const r = step({ ...st.current, reg }, k); apply(r.s, r.fx); });
        return true;
      }
      const r = step(before, k);
      if (r.handled) { if (r.s.reg !== before.reg) setReg(r.s.reg); apply(r.s, r.fx); }
      return r.handled; // unhandled plain keys go on to the app's normal layer (H L | \\ :); the dispatcher stops them typing
    },
    imap: first => {
      const s = st.current, el = ta.current; if (!el) return;
      const pos = el.selectionStart;
      const text = s.text[pos - 1] === first ? s.text.slice(0, pos - 1) + s.text.slice(pos) : s.text;
      const r = step(typed(s, text, pos - (text === s.text ? 0 : 1)), 'esc');
      apply(r.s, r.fx);
    },
  };
  const fromMouse = (detail: number) => {
    const el = ta.current; if (!el || document.activeElement !== el || !S.settings.vim) return;
    const a = el.selectionStart, b = el.selectionEnd;
    if (detail < 3 && a === b) return;
    const back = el.selectionDirection === 'backward', from = st.current.insertFrom;
    const changed = !!from && from.text !== st.current.text;
    st.current = { ...st.current, mode: detail >= 3 ? 'V-LINE' : 'VISUAL', anchor: back ? Math.max(a, b - 1) : a, pos: back ? a : Math.max(a, b - 1), pending: '',
      insertFrom: undefined, undo: changed ? [...st.current.undo, from!].slice(-200) : st.current.undo };
    paint(); update(x => { x.tick++; });
  };
  const surfaceRef = useRef(surface); surfaceRef.current = surface;
  const proxy: Surface = { kind: 'field', local: () => !!props.current.local?.(), mode: () => surfaceRef.current.mode(), key: (k, e) => surfaceRef.current.key(k, e), imap: f => surfaceRef.current.imap!(f) };

  const own = () => { unreg.current?.(); unreg.current = registerTab(props.current.tabId, proxy); update(x => { x.tick++; }); };
  const unreg = useRef<(() => void) | null>(null);
  useEffect(() => () => unreg.current?.(), []);
  // a click anywhere else while typing drops to NORMAL, so the pill and the field agree (VIM-MODEL rule 10)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ta.current, t = e.target as Element | null;
      if (!el || !S.settings.vim || st.current.mode !== 'INSERT' || document.activeElement !== el || !t?.closest) return;
      if (el.contains(t) || t.closest(KEEPS)) return;
      const r = step(st.current, 'esc'); apply(r.s, r.fx);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const focus = (insert?: boolean) => {
    const el = ta.current; if (!el) return;
    if (insert !== undefined && S.settings.vim) {
      const s = st.current;
      st.current = insert ? { ...s, mode: 'INSERT', insertFrom: { text: s.text, pos: s.pos } } : { ...s, mode: 'NORMAL', pos: Math.max(0, Math.min(s.pos, s.text.length - 1)) };
    }
    el.focus({ preventScroll: true }); own(); paint();
  };
  useImperativeHandle(handle, () => ({ focus, set: (t, pos) => { st.current = setText(st.current, t, pos); paint(); grow(); }, state: () => st.current, el: () => ta.current,
    at: (pos, vis) => { const n = st.current.text.length; st.current = { ...st.current, mode: !S.settings.vim ? 'INSERT' : vis ? vis.mode : 'NORMAL', anchor: vis ? Math.max(0, Math.min(vis.anchor, n)) : st.current.anchor, pending: '', insertFrom: undefined, col: undefined, pos: Math.max(0, Math.min(pos, n)) }; paint(); } }));
  useEffect(() => { if (p.autoFocus) focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <textarea
      ref={ta}
      data-input
      rows={1}
      spellCheck={false}
      className={cx(p.className, p.mono && 'mono')}
      placeholder={p.placeholder}
      // the first value only: a later defaultValue rewrites the textarea's text node, which puts the caret at 0
      defaultValue={first.current}
      onFocus={() => { own(); requestAnimationFrame(() => { if (document.activeElement === ta.current && st.current.mode !== 'INSERT') paint(); }); }}
      onBlur={() => { const el = ta.current; if (el) el.classList.remove('vn', 'vv', 'hollow', 'drawn', 'op'); cursor(null); opCursor(null); }}
      // a click places the caret and types there (VIM-MODEL rule: clicking a field enters INSERT); the NORMAL
      // classes go at once, so the browser's caret shows where the click put it
      onMouseDown={e => {
        // the release decides (VIM-MODEL rule 10): a click types there, a drag or double-click is VISUAL, a triple-click V-LINE
        if (e.button === 0) addEventListener('mouseup', ev => setTimeout(() => fromMouse(ev.detail), 0), { once: true, capture: true });
        if (!S.settings.vim || st.current.mode === 'INSERT') return;
        st.current = { ...st.current, mode: 'INSERT', pending: '', insertFrom: { text: st.current.text, pos: st.current.pos } };
        e.currentTarget.classList.remove('vn', 'vv', 'hollow', 'drawn', 'op'); cursor(null); opCursor(null);
        update(x => { x.tick++; });
      }}
      onMouseUp={e => { const el = e.currentTarget; if (el.selectionStart === el.selectionEnd) st.current = { ...st.current, pos: el.selectionStart }; }}
      onInput={e => { const el = e.currentTarget; st.current = typed(st.current, el.value, el.selectionStart); if (el.classList.contains('vn')) paint(); grow(); props.current.onChange(el.value); }}
      onSelect={e => { const a = getSelection()?.anchorNode; if (a && !e.currentTarget.parentNode?.contains(a)) return;   // a selection made elsewhere (the transcript) zeroes ours; keep the caret
        if (st.current.mode === 'INSERT') st.current = { ...st.current, pos: e.currentTarget.selectionStart }; }}
      onPaste={p.onPaste}
    />
  );
});
