// A text field on the code editor: CodeMirror 6 with its Vim mode, so a composer's motions, text objects, registers,
// undo and selection are the file editor's own (VIM-MODEL: Field). It has a field's habits on top: it grows with its
// text, enter sends (shift-enter is a newline), esc from NORMAL leaves, k on the first line and j on the last move out
// of it, a click types where it lands, and the mode it was left in comes back when it remounts. Quoted selections
// (`chips`) are single items: the cursor steps over one, and a change that touches one takes all of it.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { defaultKeymap, history, historyField, historyKeymap, redoDepth, undoDepth } from '@codemirror/commands';
import { Annotation, Compartment, EditorSelection, Prec, EditorState, RangeSetBuilder, Transaction, type ChangeSpec, type Extension, type TransactionSpec } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, keymap as cmKeymap, placeholder as cmPlaceholder, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { vim, Vim } from '@replit/codemirror-vim';
import type { Mode, Surface } from '../../input/dispatcher';
import type { KeyLike } from '../../input/keys';
import { forPut, getReg } from '../../input/register';
import { registerTab } from '../../input/surfaces';
import { run } from '../../shell/commands';
import { keymap } from '../../shell/overlays';
import { S, toast, update } from '../../state/store';
import { KEEPS } from '../VimField';
import { route } from './route';
import { skeinTheme } from './theme';
import { cmOf, feed, idle, keepBridge, modeOf, setupVim, vimKey } from './vim';

/** What the owner reads and sets: the text, the cursor and the mode (VimField's shape, so callers need not care). */
export interface FieldState { text: string; pos: number; anchor: number; mode: Mode }
export interface CodeFieldHandle {
  focus(insert?: boolean): void;
  /** Replace the text (no onChange: the caller has it) and put the cursor at `pos`, the end by default. */
  set(text: string, pos?: number): void;
  state(): FieldState;
  /** Put the cursor at an offset in NORMAL, or select from `vis.anchor` in VISUAL or V-LINE. */
  at(pos: number, vis?: { anchor: number; mode: 'VISUAL' | 'V-LINE' }): void;
  view(): EditorView | null;
}

export interface CodeFieldProps {
  /** The tab whose keys the field takes while it has the focus. */
  tabId: string;
  /** Keeps its state (undo history, cursor, mode) across a remount: a split, a tab moved, the view switched. */
  id: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  className?: string;
  /** enter (INSERT or NORMAL) sends; shift-enter is a newline. */
  onEnter?(): void;
  /** esc from NORMAL (or from INSERT with Vim off). */
  onLeave?(): void;
  /** k on the first line, j on the last, in NORMAL. */
  onLeaveUp?(): void;
  onLeaveDown?(): void;
  /** Keys the owner wants first (its / and @ lists, its own NORMAL keys). */
  onKey?(k: string, mode: Mode, e: KeyLike): boolean;
  /** A popup of the owner's is open: keys come here before the global bindings. */
  local?(): boolean;
  onPaste?(e: ClipboardEvent): void;
  autoFocus?: boolean;
  startMode?: 'INSERT' | 'NORMAL';
  /** Text that reads as one item (a quote): drawn as a chip, `hot` lit. Group 0 is the whole item. */
  chips?: { re: RegExp; lead?: string; hot: number };
  /** The cursor moved or the text changed. */
  onCursor?(): void;
}

/** Marks a transaction that only says Vim's mode changed (the chip under the NORMAL cursor draws as the block). */
const modeAnn = Annotation.define<boolean>();

// ---------- chips ----------
/** The chips' ranges in a text. */
function chipRanges(text: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [], g = new RegExp(re.source, 'g');
  for (let m; (m = g.exec(text));) { out.push([m.index, m.index + m[0].length]); if (!m[0].length) g.lastIndex++; }
  return out;
}
class Lead extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: Lead) { return o.text === this.text; }
  toDOM() {
    const s = document.createElement('span'); s.className = 'qi'; s.textContent = this.text;
    s.insertAdjacentHTML('beforeend', '<svg class="i i-chat" aria-hidden="true"><use href="#i-chat"/></svg>');
    return s;
  }
  ignoreEvent() { return false; }
}
const chipCfg = (c: CodeFieldProps['chips']) => c && { re: c.re, lead: c.lead, hot: c.hot };
function chipsExt(c: CodeFieldProps['chips']): Extension {
  if (!c) return [];
  const build = (v: EditorView): DecorationSet => {
    const b = new RangeSetBuilder<Decoration>(), text = v.state.doc.toString(), head = v.state.selection.main;
    const block = v.hasFocus && S.settings.vim && head.empty && modeOf(cmOf(v)) === 'NORMAL';
    chipRanges(text, c.re).forEach(([a, z], i) => {
      const on = block && head.head === a;
      b.add(a, z, Decoration.mark({ class: 'tok' + (i === c.hot ? ' hot' : '') + (on ? ' on' : ''), attributes: { 'data-q': String(i) } }));
      if (c.lead) { const at = text.indexOf(c.lead, a); if (at >= 0 && at < z) b.add(at, at + c.lead.length, Decoration.replace({ widget: new Lead(c.lead) })); }
    });
    return b.finish();
  };
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.focusChanged || u.transactions.some(t => t.annotation(modeAnn))) this.decorations = build(u.view); }
  }, { decorations: p => p.decorations });
  return [
    plugin,
    EditorView.atomicRanges.of(v => { const b = new RangeSetBuilder<Decoration>(); for (const [a, z] of chipRanges(v.state.doc.toString(), c.re)) b.add(a, z, Decoration.mark({})); return b.finish(); }),
    // a change that touches a chip takes it whole (x on one, dw across one, a backspace into one)
    EditorState.transactionFilter.of(tr => {
      if (!tr.docChanged || tr.annotation(Transaction.remote)) return tr;
      const toks = chipRanges(tr.startState.doc.toString(), c.re);
      if (!toks.length) return snap(tr, c.re);
      let grew = false;
      const changes: ChangeSpec[] = [];
      tr.changes.iterChanges((fA, tA, _fB, _tB, ins) => {
        let f = fA, t = tA;
        for (const [a, z] of toks) if (f < z && t > a && (f > a || t < z)) { f = Math.min(f, a); t = Math.max(t, z); grew = true; }
        changes.push({ from: f, to: t, insert: ins });
      });
      if (!grew) return snap(tr, c.re);
      const spec: TransactionSpec = { changes, annotations: [Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? 'delete')], scrollIntoView: true };
      const first = (changes[0] as { from: number; insert: { length: number } });
      spec.selection = EditorSelection.cursor(first.from + first.insert.length);
      return spec;
    }),
    EditorState.transactionFilter.of(tr => (tr.docChanged ? tr : snap(tr, c.re))),
  ];
}
/** A cursor that lands inside a chip goes to its edge: the far one when moving forward (l, w), the near one back. */
function snap(tr: Transaction, re: RegExp): Transaction | TransactionSpec[] {
  const sel = tr.selection; if (!sel) return tr;
  const st = tr.state.doc.toString(), h = sel.main.head, was = tr.startState.selection.main.head;
  const hit = chipRanges(st, re).find(([a, z]) => h > a && h < z); if (!hit) return tr;
  const [a, z] = hit;
  const pointer = tr.isUserEvent('select.pointer');
  let to = pointer ? (h - a < z - h ? a : z) : h > was ? z : a;
  if (sel.main.empty && to === z && !pointer && h > was && (z >= st.length || st[z] === '\n')) to = a;   // NORMAL can't rest past the last character
  // VISUAL: the moving end goes over the chip and the other stays, so the selection takes it whole (never to nothing)
  if (!sel.main.empty && to === sel.main.anchor) to = to === a ? z : a;
  return [tr, { selection: sel.main.empty ? EditorSelection.cursor(to) : EditorSelection.single(sel.main.anchor, to), sequential: true }];
}

// ---------- the field's look: the composer's text, not code ----------
const fieldTheme = EditorView.theme({
  '&': { height: 'auto', font: 'inherit' },
  '.cm-scroller': { overflow: 'auto', scrollbarWidth: 'none' },
  '.cm-content': { padding: '4px 0', minHeight: 'inherit' },
  '.cm-line': { padding: '0 2px' },
  '.cm-placeholder': { color: 'var(--fg-3)' },
});

const kept = new Map<string, { json: unknown; mode: Mode }>();
const fields = { history: historyField };
/** A tab's field starts over (the launcher became a brand-new thread, whose composer opens in INSERT). */
export const forgetCodeField = (tabId: string) => { for (const k of [...kept.keys()]) if (k === tabId || k.startsWith(tabId + '|')) kept.delete(k); };


export const CodeField = forwardRef<CodeFieldHandle, CodeFieldProps>(function CodeField(p, handle) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const props = useRef(p); props.current = p;
  const comp = useRef({ vim: new Compartment(), ph: new Compartment(), chips: new Compartment() }).current;
  const outside = useRef(false);   // a change made here for the owner (set, a new value): no onChange back
  const held = useRef('');

  const cm = () => (view.current ? cmOf(view.current) : null);
  const mode = (): Mode => (S.settings.vim ? modeOf(cm()) : 'INSERT');
  const quiet = (f: () => void) => { outside.current = true; try { f(); } finally { outside.current = false; } };

  // ---------- the keyboard surface ----------
  const lineOf = () => { const v = view.current!; const h = v.state.selection.main.head; return { n: v.state.doc.lineAt(h).number, last: v.state.doc.lines }; };
  const surface: Surface = {
    kind: 'field',
    mode,
    key: (k, e) => {
      const v = view.current; if (!v) return false;
      const c = cmOf(v);
      keepBridge();
      const m = mode(), still = !c || (idle(c) && !held.current);
      if (props.current.onKey?.(k, m, e)) {
        // the owner took the second key of something Vim had started (g g into the reader): Vim forgets the first
        if (c && m === 'NORMAL' && !idle(c)) feed(c, '<Esc>');
        held.current = ''; return true;
      }
      if (!S.settings.vim || !c) {
        if (k === 'enter' && props.current.onEnter) { props.current.onEnter(); return true; }
        if (k === 'esc') { props.current.onLeave?.(); return true; }
        return v.hasFocus ? 'native' : false;
      }
      if (m === 'INSERT') {
        if (k === 'enter' && props.current.onEnter) { props.current.onEnter(); return true; }
        return native(k, e, m);
      }
      if (m === 'NORMAL' && still) {
        if (k === 'enter' && props.current.onEnter) { props.current.onEnter(); return true; }
        if (k === 'esc') { props.current.onLeave?.(); return true; }
        const { n, last } = lineOf();
        if ((k === 'k' || k === 'up') && n === 1 && props.current.onLeaveUp) { props.current.onLeaveUp(); return true; }
        if ((k === 'j' || k === 'down') && n === last && props.current.onLeaveDown) { props.current.onLeaveDown(); return true; }
        // ctrl-d / ctrl-u page the draft, as in Vim (not Skein's half-page of the pane)
        if (k === 'ctrl-d' || k === 'ctrl-u') return native(k, e, m);
        // u and ctrl-r with nothing left to undo or redo say so, in Vim's words
        if (k === 'u' && !undoDepth(v.state)) { toast('Already at oldest change'); return true; }
        if (k === 'ctrl-r' && !redoDepth(v.state)) { toast('Already at newest change'); return true; }
        // p / P with the register empty put the system clipboard (input/register: forPut)
        if ((k === 'p' || k === 'P') && !getReg().text) { void forPut().then(r => { if (r.text) feedPut(r.text, r.line, k); }); return true; }
      }
      if (m !== 'NORMAL' && (k === 'ctrl-d' || k === 'ctrl-u')) return native(k, e, m);
      const r = route(k, m, idle(c), held.current, keymap());
      held.current = '';
      switch (r.to) {
        case 'skein': return false;
        case 'hold': held.current = k; return true;
        case 'run': run(r.command); return true;
        case 'replay': { if (!v.hasFocus) v.focus(); const vk = vimKey(e); feed(c, r.keys[0]); if (vk) feed(c, vk); return true; }
        case 'native': return native(k, e, m);
      }
    },
    imap: first => {
      const v = view.current; const c = v && cmOf(v); if (!v || !c) return;
      const at = v.state.selection.main.head;
      if (v.state.sliceDoc(at - 1, at) === first) v.dispatch({ changes: { from: at - 1, to: at } });
      feed(c, '<Esc>');
    },
  };
  /** The key goes to the editor as typed: from the DOM event while it has the focus and the event is on its way,
   *  else given to it here (a key sent on by the owner, or one held while the field was not there yet). */
  const native = (k: string, e: KeyLike, m: Mode): boolean | 'native' => {
    const v = view.current!; const c = cmOf(v);
    const live = typeof Event !== 'undefined' && e instanceof Event && e.eventPhase !== Event.NONE;
    if (v.hasFocus && live) return 'native';
    if (!v.hasFocus) { v.focus(); own(); }
    if (m === 'INSERT' && k.length === 1) { v.dispatch(v.state.replaceSelection(k)); return true; }
    const vk = vimKey(e);
    if (c && vk) feed(c, vk);
    return true;
  };
  const feedPut = (text: string, line: boolean, k: string) => {
    const c = cm(); if (!c) return;
    const reg = Vim.getRegisterController().unnamedRegister;
    reg.setText(text + (line ? '\n' : ''), line);
    feed(c, k);
    reg.setText('', false);
  };
  const sref = useRef(surface); sref.current = surface;
  const proxy = useRef<Surface>({ kind: 'field', local: () => !!props.current.local?.(), mode: () => sref.current.mode(), key: (k, e) => sref.current.key(k, e), imap: f => sref.current.imap!(f) }).current;
  const unreg = useRef<(() => void) | null>(null);
  const own = () => { unreg.current?.(); unreg.current = registerTab(props.current.tabId, proxy); update(x => { x.tick++; }); };
  useEffect(() => () => unreg.current?.(), []);

  // ---------- the view ----------
  useLayoutEffect(() => {
    setupVim();
    const ext: Extension[] = [
      comp.vim.of(S.settings.vim ? vim({ status: false }) : []),
      drawSelection(), history(), EditorView.lineWrapping,
      cmKeymap.of([...defaultKeymap.filter(b => b.key !== 'Enter' && b.key !== 'Mod-Enter'), ...historyKeymap]),
      skeinTheme, Prec.highest(fieldTheme),
      comp.ph.of(cmPlaceholder(props.current.placeholder ?? '')),
      comp.chips.of(chipsExt(chipCfg(props.current.chips))),
      EditorView.contentAttributes.of({ spellcheck: 'false', 'data-input': '', 'aria-multiline': 'true', role: 'textbox' }),
      EditorView.editorAttributes.compute(['selection'], s => ({ class: s.selection.ranges.some(r => !r.empty) ? 'has-sel' : '' })),
      EditorView.domEventHandlers({ paste: e => { props.current.onPaste?.(e); return e.defaultPrevented; } }),
      // shift-enter (and enter with no owner to send) is a newline, in INSERT
      cmKeymap.of([{ key: 'Shift-Enter', run: v => { v.dispatch(v.state.replaceSelection('\n'), { scrollIntoView: true, userEvent: 'input' }); return true; } }]),
      EditorView.updateListener.of(u => {
        if (u.docChanged && !outside.current) props.current.onChange(u.state.doc.toString());
        if (u.focusChanged && u.view.hasFocus) own();
        if (u.selectionSet || u.docChanged) props.current.onCursor?.();
      }),
    ];
    const k = kept.get(props.current.id), json = k?.json as { doc?: string } | undefined;
    const same = !!json && json.doc === props.current.value;
    const state = same ? EditorState.fromJSON(json, { extensions: ext }, fields)
      : EditorState.create({ doc: props.current.value, extensions: ext, selection: EditorSelection.cursor(props.current.value.length) });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    const c = cmOf(v);
    // Vim says so in the middle of an update: the chips redraw after it
    c?.on('vim-mode-change', () => { update(x => { x.tick++; }); queueMicrotask(() => { if (view.current === v) v.dispatch({ annotations: modeAnn.of(true) }); }); });
    // the mode it was left in comes back (a selection as NORMAL); a new field starts in startMode
    const start = same && k ? (k.mode === 'INSERT' ? 'INSERT' : 'NORMAL') : (props.current.startMode ?? 'INSERT');
    if (c && S.settings.vim && start === 'INSERT') feed(c, 'i');

    // the mouse (VIM-MODEL rule 10): a click types where it lands; a drag or a double click is VISUAL, a triple
    // click the line in V-LINE
    const down = (e: MouseEvent) => {
      const cx = cmOf(v); if (e.button !== 0 || !cx || !S.settings.vim) return;
      const m = modeOf(cx);
      if (m === 'VISUAL' || m === 'V-LINE') feed(cx, '<Esc>');
      if (modeOf(cx) === 'NORMAL') feed(cx, 'i');
    };
    const up = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const d = e.detail;
      setTimeout(() => {
        const cx = cmOf(v); if (!cx || !S.settings.vim) return;
        const sel = v.state.selection.main;
        if (d >= 3) {
          const ln = v.state.doc.lineAt(sel.from);
          feed(cx, '<Esc>');
          v.dispatch({ selection: EditorSelection.cursor(ln.from) });
          feed(cx, 'V');
        } else if (!sel.empty && modeOf(cx) === 'INSERT') {
          // leave INSERT, then give Vim the selection back: it takes a selection made outside it as VISUAL
          const { anchor, head } = sel;
          feed(cx, '<Esc>');
          v.dispatch({ selection: EditorSelection.single(anchor, head) });
        }
      }, 0);
    };
    v.contentDOM.addEventListener('mousedown', down, true);
    v.contentDOM.addEventListener('mouseup', up);
    return () => {
      v.contentDOM.removeEventListener('mousedown', down, true);
      v.contentDOM.removeEventListener('mouseup', up);
      kept.set(props.current.id, { json: v.state.toJSON(fields), mode: modeOf(cmOf(v)) });
      v.destroy(); view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // a click anywhere else while typing drops to NORMAL, so the pill and the field agree (VIM-MODEL rule 10)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const v = view.current, t = e.target as Element | null; const c = v && cmOf(v);
      if (!v || !c || !S.settings.vim || modeOf(c) !== 'INSERT' || !v.hasFocus || !t?.closest) return;
      if (v.dom.contains(t) || t.closest(KEEPS)) return;
      feed(c, '<Esc>');
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []);

  // ---------- follow the props ----------
  useLayoutEffect(() => {
    const v = view.current; if (!v || v.state.doc.toString() === p.value) return;
    quiet(() => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value }, selection: EditorSelection.cursor(Math.min(v.state.selection.main.head, p.value.length)), annotations: Transaction.addToHistory.of(false) }));
  }, [p.value]);
  useEffect(() => { view.current?.dispatch({ effects: comp.ph.reconfigure(cmPlaceholder(p.placeholder ?? '')) }); }, [p.placeholder]); // eslint-disable-line react-hooks/exhaustive-deps
  const chipKey = p.chips ? `${p.chips.re.source}|${p.chips.lead}|${p.chips.hot}` : '';
  useEffect(() => { view.current?.dispatch({ effects: comp.chips.reconfigure(chipsExt(chipCfg(props.current.chips))) }); }, [chipKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const vimOn = S.settings.vim;
  useEffect(() => { view.current?.dispatch({ effects: comp.vim.reconfigure(vimOn ? vim({ status: false }) : []) }); }, [vimOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const focus = (insert?: boolean) => {
    const v = view.current; if (!v) return;
    v.focus(); own();
    const c = cmOf(v); if (!c || !S.settings.vim || insert === undefined) return;
    const m = modeOf(c);
    if (insert && m !== 'INSERT') { if (m !== 'NORMAL') feed(c, '<Esc>'); feed(c, 'i'); }
    else if (!insert && m !== 'NORMAL') feed(c, '<Esc>');
  };
  useImperativeHandle(handle, () => ({
    view: () => view.current,
    focus,
    state: () => {
      const v = view.current; if (!v) return { text: props.current.value, pos: props.current.value.length, anchor: props.current.value.length, mode: 'INSERT' };
      const s = v.state.selection.main;
      return { text: v.state.doc.toString(), pos: s.head, anchor: s.anchor, mode: mode() };
    },
    set: (text, pos) => {
      const v = view.current; if (!v) return;
      const at = Math.max(0, Math.min(pos ?? text.length, text.length));
      quiet(() => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: EditorSelection.cursor(at), annotations: Transaction.addToHistory.of(false), scrollIntoView: true }));
    },
    at: (pos, vis) => {
      const v = view.current; const c = v && cmOf(v); if (!v) return;
      const n = v.state.doc.length, cl = (x: number) => Math.max(0, Math.min(x, n));
      if (!c || !S.settings.vim) { v.dispatch({ selection: EditorSelection.cursor(cl(pos)), scrollIntoView: true }); return; }
      if (modeOf(c) !== 'NORMAL') feed(c, '<Esc>');
      v.dispatch({ selection: EditorSelection.cursor(cl(vis ? vis.anchor : pos)), scrollIntoView: true });
      if (vis) {
        feed(c, vis.mode === 'V-LINE' ? 'V' : 'v');
        const line = v.state.doc.lineAt(cl(pos));
        feed(c, ...`${line.number}G`.split(''));
        const col = cl(pos) - line.from;
        if (col) feed(c, ...`${col}l`.split(''));
      }
    },
  }));
  useEffect(() => { if (p.autoFocus) focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className={p.className} />;
});
