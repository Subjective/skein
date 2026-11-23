// The code editor: CodeMirror 6 with its Vim mode, Lezer highlighting and Skein's theme. One component for every
// place code is read and edited, so motions, text objects, registers, undo and the selection colour are the same
// everywhere (VIM-MODEL: Field). It is a keyboard surface like any other: the dispatcher runs leader, global and
// popup keys first, the owner gets its own NORMAL keys next (onKey), then ui/editor/route.ts decides between
// Skein's normal layer and Vim, which reads the key from the DOM event itself.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { defaultKeymap, history, historyField, historyKeymap } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, RangeSet, Transaction, type Extension } from '@codemirror/state';
import {
  Decoration, drawSelection, gutters, WidgetType, EditorView, gutterLineClass, GutterMarker, highlightActiveLine, highlightActiveLineGutter,
  keymap as cmKeymap, lineNumbers, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { vim, Vim } from '@replit/codemirror-vim';
import type { Mode, Surface } from '../../input/dispatcher';
import { forPut, getReg } from '../../input/register';
import { registerTab } from '../../input/surfaces';
import { run } from '../../shell/commands';
import { keymap } from '../../shell/overlays';
import { S, update } from '../../state/store';
import { languageFor } from './lang';
import { livePreview } from './markdown';
import { route } from './route';
import { skeinHighlight, skeinTheme } from './theme';
import { cmOf, feed, idle, keepBridge, modeOf, setupVim, vimKey, vimSel } from './vim';

export interface CodeEditorHandle {
  view(): EditorView | null;
  focus(): void;
  /** Put the cursor at an offset in NORMAL, or select from `anchor` in VISUAL or V-LINE. */
  at(pos: number, sel?: { anchor: number; mode: 'VISUAL' | 'V-LINE' }): void;
  mode(): Mode;
  /** The cursor's offset. */
  pos(): number;
  /** Keys for Vim, in its notation ('o', '<Esc>'), as if typed. */
  feed(...keys: string[]): void;
}

export interface CodeEditorProps {
  /** The tab whose keys the editor takes while it has the focus. */
  tabId: string;
  /** Keeps the editor's state (undo history, cursor) when it remounts: a tab moved, popped out, a view switched. */
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** The file's name picks the language. */
  path: string;
  /** Lines changed since the last commit, by line number (1-based): g-add, g-chg or g-del. */
  marks?: Map<number, string> | null;
  /** The diff view: the last commit's removed lines drawn above the line they were before (0-based; the line count
   *  for the end), and added lines marked. */
  diff?: { gone: Map<number, string[]>; added: Set<number> } | null;
  /** Line numbers in the gutter (default on). */
  numbers?: boolean;
  /** Long lines wrap. */
  wrap?: boolean;
  /** Markdown drawn as it reads while it is edited (editor/markdown.ts): the file's Preview. */
  live?: boolean;
  /** Painted as search hits (the shared search popup's query), smart case. */
  find?: string;
  /** For a quote's source (mod-l, Add to Chat). */
  dataSrc?: string;
  /** The owner's own keys, before Vim and Skein's normal layer. `idle`: NORMAL with nothing pending (check it before
   *  taking a plain key); `held`: the first key of a sequence held back on the last press ('g'), so the owner can
   *  finish one of its own (g p). */
  onKey?: (k: string, c: { mode: Mode; idle: boolean; held: string }) => boolean;
  /** The cursor or selection moved. */
  onCursor?: () => void;
  /** A mouse selection settled (its text), or went (null): the owner shows Add to Chat. */
  onMouseSel?: (text: string | null) => void;
  className?: string;
}

const kept = new Map<string, unknown>();   // the editor's state as JSON (doc, selection, undo history), by id
const fields = { history: historyField };

class LineMark extends GutterMarker { constructor(readonly elementClass: string) { super(); } }
const LINE_MARK: Record<string, LineMark> = {};
const lineMark = (c: string) => (LINE_MARK[c] ??= new LineMark(c));

function marksExt(state: EditorState, marks: Map<number, string> | null | undefined): Extension {
  if (!marks?.size) return [];
  const n = state.doc.lines;
  const ranges = [...marks].filter(([l]) => l >= 1 && l <= n).sort((a, b) => a[0] - b[0]).map(([l, c]) => lineMark(c).range(state.doc.line(l).from));
  return gutterLineClass.of(RangeSet.of(ranges));
}
function findExt(q: string | undefined): Extension {
  if (!q) return [];
  const md = new MatchDecorator({ regexp: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (q === q.toLowerCase() ? 'i' : '')), decoration: Decoration.mark({ class: 'hit' }) });
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = md.createDeco(v); }
    update(u: ViewUpdate) { this.decorations = md.updateDeco(u, this.decorations); }
  }, { decorations: v => v.decorations });
}

/** A removed line in the diff view: shown, not part of the text (nothing selects or edits it). */
class Gone extends WidgetType {
  constructor(readonly lines: string[]) { super(); }
  eq(o: Gone) { return o.lines.join('\n') === this.lines.join('\n'); }
  toDOM() {
    const box = document.createElement('div'); box.className = 'cm-gone'; box.setAttribute('aria-hidden', 'true');
    for (const l of this.lines) { const d = document.createElement('div'); d.className = 'del'; d.textContent = l || '\u200b'; box.append(d); }
    return box;
  }
  ignoreEvent() { return true; }
}
const addMark = Decoration.line({ class: 'add' });
function diffExt(state: EditorState, d: CodeEditorProps['diff']): Extension {
  if (!d) return [];
  const doc = state.doc, out = [];
  for (let i = 0; i < doc.lines; i++) {
    const at = doc.line(i + 1).from, g = d.gone.get(i);
    if (g) out.push(Decoration.widget({ widget: new Gone(g), block: true, side: -1 }).range(at));
    if (d.added.has(i)) out.push(addMark.range(at));
  }
  const end = d.gone.get(doc.lines);
  if (end) out.push(Decoration.widget({ widget: new Gone(end), block: true, side: 1 }).range(doc.length));
  return [EditorView.decorations.of(Decoration.set(out, true)), EditorView.editorAttributes.of({ class: 'diffv' })];
}
const gutterExt = (on: boolean | undefined) => (on === false ? EditorView.editorAttributes.of({ class: 'nonum' }) : [numbers, highlightActiveLineGutter(), gutters({ fixed: false })]);

/** V-LINE shades whole lines (the text area, not the gutter), as Vim does, rather than the selection's own shape. */
const vlineMark = Decoration.line({ class: 'vsel' });
const vline = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  on = false;
  constructor(v: EditorView) { this.decorations = this.build(v); }
  update(u: ViewUpdate) { if (u.selectionSet || u.docChanged || u.viewportChanged || u.focusChanged) this.decorations = this.build(u.view); }
  build(v: EditorView): DecorationSet {
    this.on = modeOf(cmOf(v)) === 'V-LINE';
    if (!this.on) return Decoration.none;
    // the lines between Vim's own anchor and cursor (CodeMirror's selection may stop at an empty line's start)
    const doc = v.state.doc, sel = vimSel(cmOf(v));
    const { from, to } = v.state.selection.main;
    const [a, b] = sel ? [Math.min(sel[0], sel[1]) + 1, Math.max(sel[0], sel[1]) + 1] : [doc.lineAt(from).number, doc.lineAt(to).number];
    const out = [];
    for (const r of v.visibleRanges) {
      for (let n = Math.max(a, doc.lineAt(r.from).number); n <= Math.min(b, doc.lineAt(r.to).number); n++) out.push(vlineMark.range(doc.line(n).from));
    }
    return Decoration.set(out, true);
  }
}, {
  decorations: v => v.decorations,
  // the selection's own shape is not drawn under the shaded lines
  provide: p => EditorView.editorAttributes.of(v => (v.plugin(p)?.on ? { class: 'vline' } : null)),
});

/** A click on a line number: the cursor to the line's start, in NORMAL (a selection goes). */
const numbers: Extension = lineNumbers({
  domEventHandlers: {
    mousedown: (v, line) => {
      const cm = cmOf(v);
      if (cm && (modeOf(cm) === 'VISUAL' || modeOf(cm) === 'V-LINE')) feed(cm, '<Esc>');
      v.dispatch({ selection: EditorSelection.cursor(line.from) });
      v.focus();
      return true;
    },
  },
});

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(p, handle) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const props = useRef(p); props.current = p;
  const comp = useRef({ vim: new Compartment(), lang: new Compartment(), marks: new Compartment(), find: new Compartment(), diff: new Compartment(), gutter: new Compartment(), wrap: new Compartment() }).current;
  const outside = useRef(false);   // a change from props.value, not from typing: no onChange back
  const held = useRef('');

  const mode = (): Mode => (S.settings.vim ? modeOf(view.current && cmOf(view.current)) : 'INSERT');

  // ---------- the keyboard surface ----------
  const surface: Surface = {
    kind: 'field',
    mode,
    key: (k, e) => {
      const v = view.current; if (!v) return false;
      const cm = cmOf(v); if (!cm) return false;
      keepBridge();
      const m = mode(), still = idle(cm) && !held.current;
      if (props.current.onKey?.(k, { mode: m, idle: still && m === 'NORMAL', held: held.current })) { held.current = ''; return true; }
      if (!S.settings.vim) return v.hasFocus ? 'native' : false;
      // p / P with the register empty put the system clipboard (input/register: forPut)
      if ((k === 'p' || k === 'P') && m !== 'INSERT' && still && !getReg().text) {
        void forPut().then(r => { if (r.text) feedPut(r.text, r.line, k); });
        return true;
      }
      const r = route(k, m, idle(cm), held.current, keymap());
      held.current = '';
      switch (r.to) {
        case 'skein': return false;
        case 'hold': held.current = k; return true;
        case 'run': run(r.command); return true;
        case 'replay': { if (!v.hasFocus) v.focus(); const vk = vimKey(e); feed(cm, r.keys[0]); if (vk) feed(cm, vk); return true; }
        case 'native': {
          if (v.hasFocus) return 'native';
          // the key arrived while something else in the view had the focus: give the editor both
          v.focus();
          const vk = vimKey(e);
          if (m === 'INSERT' && k.length === 1) { v.dispatch(v.state.replaceSelection(k)); return true; }
          return vk ? feed(cm, vk) || true : true;
        }
      }
    },
    imap: first => {
      const v = view.current; const cm = v && cmOf(v); if (!v || !cm) return;
      const at = v.state.selection.main.head;
      if (v.state.sliceDoc(at - 1, at) === first) v.dispatch({ changes: { from: at - 1, to: at } });
      feed(cm, '<Esc>');
    },
  };
  const feedPut = (text: string, line: boolean, k: string) => {
    const v = view.current; const cm = v && cmOf(v); if (!cm) return;
    // the clipboard's text, as Vim's unnamed register, for this one put (Skein's register stays empty, as in VimField)
    const reg = Vim.getRegisterController().unnamedRegister;
    reg.setText(text + (line ? '\n' : ''), line);
    feed(cm, k);
    reg.setText('', false);
  };
  const sref = useRef(surface); sref.current = surface;
  const proxy = useRef<Surface>({ kind: 'field', mode: () => sref.current.mode(), key: (k, e) => sref.current.key(k, e), imap: f => sref.current.imap!(f) }).current;
  const unreg = useRef<(() => void) | null>(null);
  const own = () => { unreg.current?.(); unreg.current = registerTab(props.current.tabId, proxy); update(x => { x.tick++; }); };
  useEffect(() => () => unreg.current?.(), []);

  // ---------- create the view (before the owner's layout effects, which may put the cursor in it) ----------
  useLayoutEffect(() => {
    setupVim();
    const el = host.current!;
    const ext: Extension[] = [
      comp.vim.of(S.settings.vim ? vim({ status: false }) : []),
      comp.gutter.of(props.current.live ? [] : gutterExt(props.current.numbers)), comp.wrap.of(props.current.wrap ? EditorView.lineWrapping : []), vline, highlightActiveLine(), drawSelection(), history(), bracketMatching(), indentOnInput(),
      EditorState.tabSize.of(4),
      cmKeymap.of([...defaultKeymap, ...historyKeymap]),
      skeinTheme, skeinHighlight,
      comp.lang.of([]), comp.marks.of([]), comp.find.of([]), comp.diff.of([]),
      EditorView.editorAttributes.compute(['selection'], s => ({ class: s.selection.ranges.some(r => !r.empty) ? 'has-sel' : '' })),
      EditorView.contentAttributes.of({ 'aria-label': props.current.path, spellcheck: 'false', 'data-input': '' }),
      EditorView.updateListener.of(u => {
        if (u.docChanged && !outside.current) props.current.onChange(u.state.doc.toString());
        if (u.focusChanged && u.view.hasFocus) own();
        if (u.selectionSet || u.docChanged) props.current.onCursor?.();
      }),
    ];
    const json = kept.get(props.current.id) as { doc?: string } | undefined;
    const state = json && json.doc === props.current.value ? EditorState.fromJSON(json, { extensions: ext }, fields) : EditorState.create({ doc: props.current.value, extensions: ext });
    const v = new EditorView({ state, parent: el });
    view.current = v;
    const cm = cmOf(v);
    cm?.on('vim-mode-change', () => update(x => { x.tick++; }));
    // the mouse (VIM-MODEL rule 10): a drag or double click is VISUAL (Vim does that), a triple click the line in
    // V-LINE; a settled selection offers Add to Chat
    const up = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const d = e.detail;
      setTimeout(() => {
        const cmx = cmOf(v); if (!cmx || !S.settings.vim) return;
        if (d >= 3) {
          const at = v.state.selection.main.from;
          v.dispatch({ selection: EditorSelection.cursor(v.state.doc.lineAt(at).from) });
          feed(cmx, '<Esc>', 'V');
        }
        const sel = v.state.selection.main;
        props.current.onMouseSel?.(sel.empty ? null : v.state.sliceDoc(sel.from, sel.to));
      }, 0);
    };
    v.contentDOM.addEventListener('mouseup', up);
    return () => {
      v.contentDOM.removeEventListener('mouseup', up);
      kept.set(props.current.id, v.state.toJSON(fields));
      v.destroy(); view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- follow the props ----------
  useEffect(() => {
    const v = view.current; if (!v || v.state.doc.toString() === p.value) return;
    outside.current = true;
    try {
      const head = Math.min(v.state.selection.main.head, p.value.length);
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value }, selection: EditorSelection.cursor(head), annotations: Transaction.addToHistory.of(false) });
    } finally { outside.current = false; }
  }, [p.value]);
  useEffect(() => {
    if (p.live) { view.current?.dispatch({ effects: comp.lang.reconfigure(livePreview()) }); return; }
    let ok = true;
    void languageFor(p.path).then(l => { if (ok && view.current) view.current.dispatch({ effects: comp.lang.reconfigure(l ?? []) }); });
    return () => { ok = false; };
  }, [p.path, p.live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const v = view.current; if (v) v.dispatch({ effects: comp.marks.reconfigure(marksExt(v.state, p.marks)) }); }, [p.marks]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { view.current?.dispatch({ effects: comp.find.reconfigure(findExt(p.find)) }); }, [p.find]);
  useEffect(() => { const v = view.current; if (v) v.dispatch({ effects: comp.diff.reconfigure(diffExt(v.state, p.diff)) }); }, [p.diff]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { view.current?.dispatch({ effects: [comp.gutter.reconfigure(p.live ? [] : gutterExt(p.numbers)), comp.wrap.reconfigure(p.wrap ? EditorView.lineWrapping : [])] }); }, [p.numbers, p.wrap, p.live]); // eslint-disable-line react-hooks/exhaustive-deps
  // Vim keys off (Settings): a plain editor, as every other field is then
  const vimOn = S.settings.vim;
  useEffect(() => { view.current?.dispatch({ effects: comp.vim.reconfigure(vimOn ? vim({ status: false }) : []) }); }, [vimOn]); // eslint-disable-line react-hooks/exhaustive-deps // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(handle, () => ({
    view: () => view.current,
    focus: () => { const v = view.current; if (!v) return; v.focus(); own(); },
    mode,
    pos: () => view.current?.state.selection.main.head ?? 0,
    feed: (...keys) => { const v = view.current; const cm = v && cmOf(v); if (cm) feed(cm, ...keys); },
    at: (pos, sel) => {
      const v = view.current; const cm = v && cmOf(v); if (!v || !cm) return;
      const n = v.state.doc.length, c = (x: number) => Math.max(0, Math.min(x, n));
      if (modeOf(cm) !== 'NORMAL') feed(cm, '<Esc>');
      v.dispatch({ selection: EditorSelection.cursor(c(sel ? sel.anchor : pos)), scrollIntoView: true });
      if (sel) {
        feed(cm, sel.mode === 'V-LINE' ? 'V' : 'v');
        const line = v.state.doc.lineAt(c(pos));
        // move the head with Vim's own motion so its idea of the selection matches: to the line, then the column
        feed(cm, ...`${line.number}G`.split(''));
        const col = c(pos) - line.from;
        if (col) feed(cm, ...`${col}l`.split(''));
      }
      v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: 'nearest' }) });
    },
  }));

  return <div ref={host} className={p.className} data-src={p.dataSrc} onMouseDown={() => own()} />;
});
