// Markdown edited as it reads (the file's Preview): the text stays the file's own Markdown, byte for byte, and only
// its look changes. Headings, emphasis, inline code, links, lists, task boxes, quotes and rules draw rendered while
// you edit; the syntax marks (`**`, `#`, `- [ ]`, `](url)`) show only on the cursor's line, with the styling kept
// (Josh, 2026-11-23), so they can be changed or deleted in place. A table draws as a table until the cursor is in it,
// then shows its source in the code font, where it can be edited; fenced code always stays raw. Every key is still
// Vim's; nothing here takes one.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';

class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'md-bullet'; s.textContent = '•'; return s; }
}
class Check extends WidgetType {
  constructor(readonly on: boolean, readonly at: number) { super(); }
  eq(o: Check) { return o.on === this.on && o.at === this.at; }
  toDOM(view: EditorView) {
    const b = document.createElement('span');
    b.className = 'md-check' + (this.on ? ' on' : '');
    b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', String(this.on));
    // a click ticks the box: one character of the file changes ([ ] and [x]), nothing else
    b.onmousedown = e => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.on ? ' ' : 'x' } });
    };
    return b;
  }
  ignoreEvent() { return false; }
}
class Rule extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'md-rule'; return s; }
}

/** Lines whose cursor (or one of several) is on them. */
const cursorLines = (st: EditorState) => st.selection.ranges.map(r => st.doc.lineAt(r.head).number);

/** A table's whole lines, and whether a cursor is in them (then it shows raw). */
function tableSpan(st: EditorState, from: number, to: number) {
  const doc = st.doc, a = doc.lineAt(from);
  let b = doc.lineAt(to);
  if (b.from === to && to > from) b = doc.lineAt(to - 1);
  const ls = cursorLines(st);
  return { from: a.from, to: b.to, a: a.number, b: b.number, raw: ls.some(l => l >= a.number && l <= b.number) };
}

/** A table row's cells: each one's text and where it starts in the file (pipes split it; `\|` does not). */
function cellsOf(text: string, at: number): { text: string; from: number }[] {
  const out: { text: string; from: number }[] = [];
  let i = 0;
  const end = text.replace(/\s+$/, '').length;
  while (i < end && /\s/.test(text[i])) i++;
  if (text[i] === '|') i++;
  let start = i;
  const push = (j: number) => {
    const raw = text.slice(start, j), lead = raw.length - raw.trimStart().length;
    out.push({ text: raw.trim(), from: at + start + lead });
  };
  for (; i < end; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '|') { push(i); start = i + 1; }
  }
  if (start < end) push(end);
  return out;
}

/** A cell's inline Markdown, drawn as DOM text (never HTML from the file): code, bold, italics, strikethrough, links. */
function inline(parent: HTMLElement, s: string) {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]*\))/g;
  let last = 0, m: RegExpExecArray | null;
  const span = (c: string, t: string, inner = false) => { const e = document.createElement('span'); e.className = c; if (inner) inline(e, t); else e.textContent = t; parent.appendChild(e); };
  while ((m = re.exec(s))) {
    if (m.index > last) parent.append(s.slice(last, m.index).replace(/\\\|/g, '|'));
    const t = m[0];
    if (m[1]) span('md-code', t.slice(1, -1));
    else if (m[2]) span('md-strong', t.slice(2, -2), true);
    else if (m[3]) span('md-em', t.slice(1, -1), true);
    else if (m[4]) span('md-s', t.slice(2, -2), true);
    else span('md-link', /^\[([^\]]+)\]/.exec(t)![1], true);
    last = m.index + t.length;
  }
  if (last < s.length) parent.append(s.slice(last).replace(/\\\|/g, '|'));
}

/** A GFM table, drawn as one: a click on a cell puts the cursor there, which shows the table's source. */
class Table extends WidgetType {
  constructor(readonly src: string, readonly at: number) { super(); }
  eq(o: Table) { return o.src === this.src && o.at === this.at; }
  get estimatedHeight() { return this.src.split('\n').length * 31; }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div'), t = document.createElement('table');
    wrap.className = 'md-tbl'; wrap.appendChild(t);
    const lines = this.src.split('\n');
    let at = this.at;
    const offs = lines.map(l => { const o = at; at += l.length + 1; return o; });
    const align = cellsOf(lines[1] ?? '', 0).map(c => /^:-+:$/.test(c.text) ? 'center' : /-:$/.test(c.text) ? 'right' : '');
    const head = cellsOf(lines[0], offs[0]), n = head.length;
    const row = (sec: HTMLElement, cs: { text: string; from: number }[], tag: 'th' | 'td', lineAt: number) => {
      const tr = document.createElement('tr');
      for (let j = 0; j < n; j++) {
        const c = document.createElement(tag), cell = cs[j];
        if (align[j]) c.style.textAlign = align[j];
        if (cell) inline(c, cell.text);
        c.dataset.pos = String(cell ? cell.from : lineAt);
        tr.appendChild(c);
      }
      sec.appendChild(tr);
    };
    const th = document.createElement('thead'); row(th, head, 'th', offs[0]); t.appendChild(th);
    if (lines.length > 2) {
      const tb = document.createElement('tbody');
      for (let i = 2; i < lines.length; i++) row(tb, cellsOf(lines[i], offs[i]), 'td', offs[i]);
      t.appendChild(tb);
    }
    wrap.onmousedown = e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const c = (e.target as HTMLElement).closest<HTMLElement>('[data-pos]');
      view.dispatch({ selection: { anchor: c ? Number(c.dataset.pos) : this.at } });
      view.focus();
    };
    return wrap;
  }
  ignoreEvent() { return true; }
}

/** The tables the cursor is not in, drawn as tables (a block widget, so it comes from state, not a view plugin). */
function tables(st: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  syntaxTree(st).iterate({
    enter: n => {
      if (n.name === 'Table') {
        const sp = tableSpan(st, n.from, n.to);
        if (!sp.raw) out.push(Decoration.replace({ widget: new Table(st.sliceDoc(sp.from, sp.to), sp.from), block: true }).range(sp.from, sp.to));
        return false;
      }
      // only block containers can hold a table
      if (!/^(Document|Blockquote|BulletList|OrderedList|ListItem)$/.test(n.name)) return false;
    },
  });
  return Decoration.set(out, true);
}

const tableField = StateField.define<DecorationSet>({
  create: tables,
  update(v, tr) {
    return tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? tables(tr.state) : v;
  },
  provide: f => EditorView.decorations.from(f),
});

const hide = Decoration.replace({});
const cls = (c: string) => Decoration.mark({ class: c });
const line = (c: string) => Decoration.line({ class: c });
const MARK: Record<string, string> = { Emphasis: 'md-em', StrongEmphasis: 'md-strong', Strikethrough: 'md-s', InlineCode: 'md-code' };
const INLINE_MARK = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark']);

function build(view: EditorView): DecorationSet {
  const st: EditorState = view.state, doc = st.doc, out: Range<Decoration>[] = [];
  // the lines the cursor (or each cursor) is on: their marks show
  const lines = cursorLines(st);
  const on = (from: number, to: number) => { const a = doc.lineAt(from).number, b = doc.lineAt(to).number; return lines.some(l => l >= a && l <= b); };
  /** Hide a syntax mark unless the cursor is on its line. A selection keeps the look too: y still copies the Markdown. */
  const mark = (from: number, to: number) => { if (from < to) out.push((on(from, to) ? cls('md-dim') : hide).range(from, to)); };
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(st).iterate({
      from, to,
      enter: n => {
        const name = n.name;
        const h = /^(ATX|Setext)Heading(\d)$/.exec(name);
        if (h) { out.push(line('md-h md-h' + h[2]).range(doc.lineAt(n.from).from)); return; }
        if (name === 'HeaderMark') {
          const ln = doc.lineAt(n.from);
          // the leading #s and their space; a Setext underline (=== / ---) stays visible, dimmed
          if (n.from === ln.from) mark(n.from, Math.min(ln.to, n.to + 1)); else if (ln.text.trim().match(/^[=-]+$/)) out.push(cls('md-dim').range(n.from, n.to));
          return;
        }
        if (MARK[name]) { if (n.from < n.to) out.push(cls(MARK[name]).range(n.from, n.to)); return; }
        if (INLINE_MARK.has(name)) {
          // a fence's ``` is a CodeMark too: leave fenced code raw
          if (n.node.parent?.name === 'FencedCode') return;
          mark(n.from, n.to); return;
        }
        if (name === 'Link') {
          const marks = n.node.getChildren('LinkMark');
          if (marks.length >= 2) {
            const open = marks[0], close = marks[1];
            if (close.from > open.to) out.push(cls('md-link').range(open.to, close.from));
            mark(open.from, open.to);
            // ](url "title") as one mark: it shows while the cursor is anywhere on it, so the address can be edited
            mark(close.from, n.to);
          }
          return false;
        }
        if (name === 'ListMark') {
          const p = n.node.parent?.parent?.name;
          if (p === 'BulletList' && !on(n.from, n.to)) out.push(Decoration.replace({ widget: new Bullet() }).range(n.from, n.to));
          else out.push(cls('md-dim').range(n.from, n.to));
          return;
        }
        if (name === 'TaskMarker') {
          if (!on(n.from, n.to)) out.push(Decoration.replace({ widget: new Check(/x/i.test(st.sliceDoc(n.from, n.to)), n.from) }).range(n.from, n.to));
          return;
        }
        if (name === 'Blockquote') {
          for (let l = doc.lineAt(n.from).number; l <= doc.lineAt(n.to).number; l++) out.push(line('md-quote').range(doc.line(l).from));
          return;
        }
        if (name === 'QuoteMark') { const ln = doc.lineAt(n.from); mark(n.from, Math.min(ln.to, n.to + (st.sliceDoc(n.to, n.to + 1) === ' ' ? 1 : 0))); return; }
        if (name === 'HorizontalRule') {
          const ln = doc.lineAt(n.from);
          if (!on(ln.from, ln.to)) out.push(Decoration.replace({ widget: new Rule() }).range(n.from, n.to));
          return;
        }
        if (name === 'Table') {
          // drawn as a table by the state field; its source, in the code font, while the cursor is in it
          const sp = tableSpan(st, n.from, n.to);
          if (sp.raw) for (let l = sp.a; l <= sp.b; l++) out.push(line('md-table' + (l === sp.a ? ' md-first' : '') + (l === sp.b ? ' md-last' : '')).range(doc.line(l).from));
          return false;
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const a = doc.lineAt(n.from).number, b = doc.lineAt(n.to).number, c = 'md-fence';
          for (let l = a; l <= b; l++) out.push(line(c + (l === a ? ' md-first' : '') + (l === b ? ' md-last' : '')).range(doc.line(l).from));
          return false;
        }
      },
    });
    // a blank line between blocks is a paragraph's gap, not a whole line of space (not inside code, where it is text)
    for (let pos = from; pos <= to;) {
      const ln = doc.lineAt(pos);
      if (!ln.text.trim()) {
        let inCode = false;
        for (let x: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(st).resolveInner(ln.from, 1); x; x = x.parent) if (x.name === 'FencedCode' || x.name === 'CodeBlock') { inCode = true; break; }
        if (!inCode) out.push(line('md-blank').range(ln.from));
      }
      pos = ln.to + 1;
    }
  }
  return Decoration.set(out, true);
}

const live = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(v: EditorView) { this.decorations = build(v); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
  }
}, { decorations: v => v.decorations });

/** The live Preview: Markdown (with GFM tables, tasks, strikethrough) drawn as it reads. */
export const livePreview = (): Extension => [
  markdown({ base: markdownLanguage }),
  live,
  tableField,
  EditorView.editorAttributes.of({ class: 'md-live' }),
  EditorView.lineWrapping,
];

/** The file's links, in order: the text's range and where it goes. */
export function mdLinks(state: EditorState): { from: number; to: number; href: string }[] {
  const out: { from: number; to: number; href: string }[] = [];
  syntaxTree(state).iterate({
    enter: n => {
      if (n.name === 'Autolink') { const u = n.node.getChild('URL'); if (u) out.push({ from: n.from, to: n.to, href: state.sliceDoc(u.from, u.to) }); return false; }
      if (n.name !== 'Link') return;
      const u = n.node.getChild('URL');
      if (u) out.push({ from: n.from, to: n.to, href: state.sliceDoc(u.from, u.to) });
      return false;
    },
  });
  return out;
}

/** The file's ATX headings, in order: where each starts and its text as read (marks and link addresses dropped).
 *  Read from the lines, not the syntax tree, so it works before the Markdown parser has run (a link that opened the
 *  file at a heading). */
export function mdHeadings(state: EditorState): { pos: number; text: string }[] {
  const out: { pos: number; text: string }[] = [];
  let fence = '';
  for (let i = 1; i <= state.doc.lines; i++) {
    const l = state.doc.line(i), f = /^\s*(```|~~~)/.exec(l.text);
    if (f) { fence = fence ? (f[1] === fence ? '' : fence) : f[1]; continue; }
    const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l.text);
    if (m) out.push({ pos: l.from, text: m[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '') });
  }
  return out;
}
