// A text field driven by the Vim engine (input/vimtext.ts). Composers, the vimrc editor and other editable
// text all use this, so a key means the same thing in each (VIM-MODEL: Field).
// The NORMAL cursor is drawn as a one-character selection (class `vn`), VISUAL as the selection itself.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { KeyLike } from '../input/keys';
import type { Mode, Surface } from '../input/dispatcher';
import { registerTab } from '../input/surfaces';
import { init, setText, step, typed, vrange, type Effect, type TextState } from '../input/vimtext';
import { S, update } from '../state/store';
import { cx } from './primitives';

export interface VimFieldHandle { focus(insert?: boolean): void; set(text: string, pos?: number): void; state(): TextState; el(): HTMLTextAreaElement | null }

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
}

export const VimField = forwardRef<VimFieldHandle, VimFieldProps>(function VimField(p, handle) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const st = useRef<TextState>(init(p.value, p.startMode || 'INSERT'));
  const props = useRef(p); props.current = p;

  const paint = () => {
    const el = ta.current, s = st.current; if (!el) return;
    if (el.value !== s.text) el.value = s.text;
    const vim = S.settings.vim;
    el.classList.toggle('vn', vim && s.mode !== 'INSERT');
    el.classList.toggle('vv', vim && (s.mode === 'VISUAL' || s.mode === 'V-LINE'));
    if (document.activeElement !== el) return;
    if (!vim || s.mode === 'INSERT') el.setSelectionRange(s.pos, s.pos);
    else if (s.mode === 'NORMAL') el.setSelectionRange(s.pos, Math.min(s.text.length, s.pos + 1) || s.pos);
    else { const [a, b] = vrange(s); el.setSelectionRange(a, b); }
  };
  const grow = () => { const el = ta.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, p.maxHeight ?? 180) + 'px'; };

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
      if (f === 'yank') void navigator.clipboard?.writeText(s.reg.text).catch(() => {});
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
      const r = step(s, k);
      if (r.handled) apply(r.s, r.fx);
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
  const surfaceRef = useRef(surface); surfaceRef.current = surface;
  const proxy: Surface = { kind: 'field', mode: () => surfaceRef.current.mode(), key: (k, e) => surfaceRef.current.key(k, e), imap: f => surfaceRef.current.imap!(f) };

  const own = () => { unreg.current?.(); unreg.current = registerTab(props.current.tabId, proxy); update(x => { x.tick++; }); };
  const unreg = useRef<(() => void) | null>(null);
  useEffect(() => () => unreg.current?.(), []);

  const focus = (insert?: boolean) => {
    const el = ta.current; if (!el) return;
    if (insert !== undefined && S.settings.vim) {
      const s = st.current;
      st.current = insert ? { ...s, mode: 'INSERT', insertFrom: { text: s.text, pos: s.pos } } : { ...s, mode: 'NORMAL', pos: Math.max(0, Math.min(s.pos, s.text.length - 1)) };
    }
    el.focus({ preventScroll: true }); own(); paint();
  };
  useImperativeHandle(handle, () => ({ focus, set: (t, pos) => { st.current = setText(st.current, t, pos); paint(); grow(); }, state: () => st.current, el: () => ta.current }));
  useEffect(() => { if (p.autoFocus) focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <textarea
      ref={ta}
      data-input
      rows={1}
      spellCheck={false}
      className={cx(p.className, p.mono && 'mono')}
      placeholder={p.placeholder}
      defaultValue={p.value}
      onFocus={() => own()}
      onMouseDown={() => { if (S.settings.vim && st.current.mode !== 'INSERT') { st.current = { ...st.current, mode: 'INSERT', insertFrom: { text: st.current.text, pos: st.current.pos } }; update(x => { x.tick++; }); } }}
      onMouseUp={e => { const el = e.currentTarget; if (el.selectionStart === el.selectionEnd) st.current = { ...st.current, pos: el.selectionStart }; }}
      onInput={e => { const el = e.currentTarget; st.current = typed(st.current, el.value, el.selectionStart); grow(); props.current.onChange(el.value); }}
      onSelect={e => { if (st.current.mode === 'INSERT') st.current = { ...st.current, pos: e.currentTarget.selectionStart }; }}
      onPaste={p.onPaste}
    />
  );
});
