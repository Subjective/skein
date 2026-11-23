// Markdown edited as it reads (the file's Preview): the text stays the file's own Markdown, byte for byte, and only
// its look changes. Headings, emphasis, inline code, links, lists, task boxes, quotes and rules draw rendered while
// you edit; a syntax mark (`**`, `#`, `[`, `](url)`) shows only while the cursor is on it, so it can still be
// changed or deleted in place. Tables and fenced code stay raw, in the code font: their rendered form cannot be
// edited sanely. Every key is still Vim's; nothing here takes one.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range } from '@codemirror/state';
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

const hide = Decoration.replace({});
const cls = (c: string) => Decoration.mark({ class: c });
const line = (c: string) => Decoration.line({ class: c });
const MARK: Record<string, string> = { Emphasis: 'md-em', StrongEmphasis: 'md-strong', Strikethrough: 'md-s', InlineCode: 'md-code' };
const INLINE_MARK = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark']);

function build(view: EditorView): DecorationSet {
  const st: EditorState = view.state, doc = st.doc, out: Range<Decoration>[] = [];
  const heads = st.selection.ranges.map(r => r.head);
  const on = (from: number, to: number) => heads.some(h => h >= from && h <= to);
  /** Hide a syntax mark unless the cursor is on it. A selection keeps the look too: y still copies the Markdown. */
  const mark = (from: number, to: number) => { if (from < to && !on(from, to)) out.push(hide.range(from, to)); };
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
        if (name === 'FencedCode' || name === 'CodeBlock' || name === 'Table') {
          const a = doc.lineAt(n.from).number, b = doc.lineAt(n.to).number, c = name === 'Table' ? 'md-table' : 'md-fence';
          for (let l = a; l <= b; l++) out.push(line(c + (l === a ? ' md-first' : '') + (l === b ? ' md-last' : '')).range(doc.line(l).from));
          return false;
        }
      },
    });
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
