// The reader: a Vim cursor over a thread's read-only text (VIM-MODEL: Reader).
// NORMAL h j k l w b e 0 $ gg G { } [[ ]] (with counts: 3w, 5j), v / V select, y yanks, esc / q go back to
// the composer. / ? n N search the transcript (ui/search.tsx); esc clears a search before it leaves.
// A line that is one thing (a tool row, a subagent, a request's buttons) is a row: the cursor takes the
// whole row, h / l fold and unfold it, enter opens or presses it. A row of buttons (a request's answers, a
// reply's copy / fork / side chat) is one line too: h / l (w / b, 0 / $) move between its buttons, enter or
// space presses the ringed one. On one of your own messages, i a x c edit it (edit and resend). The mouse
// does the same: click moves the cursor, drag is v, triple-click V.
// A selection (v, V, a mouse drag) stays inside one message: a whole reply (prose, code, tool rows) or
// one of your bubbles; in VISUAL gg / G go to that message's first and last character.
//
// It works on the DOM, not on the events, so whatever the transcript renders can be read.
import type { Mode, Surface } from '../../input/dispatcher';
import { Count, findAll } from '../../input/readerkeys';
import { yank } from '../../input/register';
import { registerTab } from '../../input/surfaces';
import { update } from '../../state/store';
import { ReaderSearch } from '../../ui/search';
import { rawAt, rawLines } from './markdown';

/** Keys a count repeats. */
const COUNTED = new Set(['h', 'l', 'w', 'b', 'e', 'j', 'k', '{', '}', 'left', 'right', 'up', 'down']);

interface Pt { n: Text; o: number }
export interface ReaderHost {
  tabId: string;
  /** Back to the composer: 'normal' keeps NORMAL, 'insert' types, 'end' puts the cursor on its last line. */
  exit(how: 'normal' | 'insert' | 'end'): void;
  /** Edit one of your messages, with the cursor at `offset` in its text, then run `key` there. */
  edit(eventId: string, offset: number, key: string): void;
  /** y with a selection while a request waits is still yank; this is for a bare y / n in NORMAL. */
  answer?(yes: boolean): boolean;
  selection?(text: string | null): void;
}

const HL = typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights : null;
declare const Highlight: { new (...r: Range[]): unknown };

/** Lines that are a single thing rather than prose. */
export const ROWS = '.tool > summary, .tool > .sum, .ag, .sc-link, .sc-anchor, .appr .af, .m-acts, .worked, .err-row, .note-row, .think > summary';
/** Rows of buttons: h / l move between the buttons, enter / space press one. */
const KROWS = '.af, .m-acts';
const BLOCKS = '[data-src], .ag, .sc-link, .sc-anchor';
/** What bounds a selection: one message, a whole reply (everything up to the next message of yours) or one of
 * your bubbles. Code blocks, paragraphs and tool rows inside a reply are not bounds of their own. */
export const SEL_BLOCK = '[data-read] > *';
/** Text a selection may cover: not a reply's action row (copy, fork, side chat and its age). */
export const selectable = (n: Node) => !n.parentElement?.closest('.m-acts');

export class Reader {
  on = false;
  mode: 'n' | 'v' | 'V' = 'n';
  root: HTMLElement | null = null;
  a: Pt | null = null;
  f: Pt | null = null;
  row: HTMLElement | null = null;
  private bound: Element | null = null;
  private x: number | null = null;
  private g = false;
  private br: string | null = null;
  private unreg: (() => void) | null = null;
  private offDown: ((e: MouseEvent) => void) | null = null;
  private count = new Count();
  private nodes: Text[] = [];
  readonly search = new ReaderSearch(() => ({
    items: () => (this.nodes = this.root ? this.texts(this.root) : []).map(n => n.data),
    at: () => { const f = this.f, i = f ? this.nodes.indexOf(f.n) : -1; return i >= 0 ? { i, o: f!.o } : { i: 0, o: -1 }; },
    go: h => {
      const n = this.nodes[h.i]; if (!n || !this.root) return;
      for (let d = n.parentElement?.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) (d as HTMLDetailsElement).open = true;
      if (!this.on) { this.begin(this.root, 'n', { n, o: h.o }); return; }
      this.f = { n, o: h.o }; if (this.mode === 'n') { this.a = this.f; this.bound = null; }
      this.draw();
    },
    paint: q => this.paintHits(q),
    anchor: () => (this.root?.closest('.thread') ?? this.root)?.getBoundingClientRect() ?? null,
  }));
  constructor(private host: ReaderHost) {}

  /** Every match of the search, highlighted (CSS highlight `rsearch`). */
  private paintHits(q: string) {
    if (!HL) return;
    if (!q || !this.root) { HL.delete('rsearch'); return; }
    const ns = this.texts(this.root), rs: Range[] = [];
    for (const h of findAll(ns.map(n => n.data), q, 2000)) { const r = document.createRange(); r.setStart(ns[h.i], h.o); r.setEnd(ns[h.i], h.o + h.len); rs.push(r); }
    HL.set('rsearch', new Highlight(...rs));
  }

  // ---------- where the cursor may go ----------
  inside(n: Node | null): n is Text {
    const root = this.root; if (!n || !root || !root.contains(n)) return false;
    const e = n.parentElement; if (!e) return false;
    if (e.closest('input, textarea, .comp, .dl > .n, .ticks, .tick-pop')) return false;
    if (e.closest('button') && !e.closest('.ag, .sc-link, .sc-anchor, .af')) return false;
    return true;
  }
  texts(el: Node): Text[] {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), out: Text[] = [];
    let n: Node | null;
    while ((n = w.nextNode())) if ((n as Text).data.trim() && this.inside(n)) out.push(n as Text);
    return out;
  }
  private textAt(node: Node, off: number): Pt | null {
    if (node.nodeType === 3) { const t = node as Text; return { n: t, o: Math.max(0, Math.min(off, t.data.length - 1)) }; }
    const kid = node.childNodes[off] || node.childNodes[node.childNodes.length - 1] || node;
    if (kid.nodeType === 3 && (kid as Text).data.trim()) return { n: kid as Text, o: 0 };
    const ns = this.texts(kid); return ns[0] ? { n: ns[0], o: 0 } : null;
  }
  private firstText(el: Element): Pt | null { const n = this.texts(el)[0]; return n ? { n, o: n.data.length - n.data.trimStart().length } : null; }
  private blockOf(p: Pt) { return p.n.parentElement?.closest(SEL_BLOCK) ?? null; }
  private ok(p: Pt) { return this.mode === 'n' || ((!this.bound || this.bound.contains(p.n)) && selectable(p.n)); }
  /** The first or last character a selection can reach in a message. */
  private edge(el: Element, last: boolean): Pt | null {
    const ns = this.texts(el).filter(selectable), n = last ? ns[ns.length - 1] : ns[0]; if (!n) return null;
    return last ? { n, o: Math.max(0, n.data.trimEnd().length - 1) } : { n, o: n.data.length - n.data.trimStart().length };
  }

  // ---------- entering and leaving ----------
  /** From the keyboard: the last line above the composer, so k then j retrace the same lines. */
  enter(root: HTMLElement, where: 'end' | 'top' | 'block' = 'end'): boolean {
    this.root = root;
    const ns = this.texts(root);
    if (!ns.length) return false;
    const n = where === 'top' ? ns[0] : ns[ns.length - 1];
    this.begin(root, 'n', { n, o: where === 'top' ? 0 : Math.max(0, n.data.trimEnd().length - 1) });
    if (where === 'end' && !this.row) this.key('0');
    if (where === 'block') this.key('block-start');
    return true;
  }
  begin(root: HTMLElement, mode: 'n' | 'v' | 'V', f: Pt, a?: Pt) {
    this.clear();
    if (document.activeElement && document.activeElement !== document.body) (document.activeElement as HTMLElement).blur();
    Object.assign(this, { on: true, mode, root, f, a: a || f, bound: null, g: false, br: null });
    if (mode !== 'n') {
      const bd = this.blockOf(this.a!); this.bound = bd;
      if (bd && (!bd.contains(f.n) || !selectable(f.n))) {   // a drag that ran past its message is cut back to the message's edge
        const after = this.a!.n.compareDocumentPosition(f.n) & Node.DOCUMENT_POSITION_FOLLOWING, e = this.edge(bd, !!after);
        if (e) this.f = e;
      }
    }
    this.own();
    this.draw();
  }
  private own() {
    if (!this.offDown) {   // any mousedown outside the quote bar ends reading (the mockup's Reader.off); a click on the text starts it again on mouseup
      this.offDown = (e: MouseEvent) => { if (this.on && !(e.target as Element | null)?.closest?.('.seltb')) this.clear(); };
      document.addEventListener('mousedown', this.offDown, true);
    }
    this.unreg?.(); this.unreg = registerTab(this.host.tabId, this.surface); update(s => { s.tick++; }); }
  /** Stop drawing; the composer or something else takes the keys. */
  clear() {
    if (!this.on) return;
    HL?.delete('vcur');
    this.root?.querySelectorAll('.rowcur, .kcur').forEach(x => x.classList.remove('rowcur', 'kcur'));
    this.root?.classList.remove('rd', 'rv');
    if (this.search.active) { this.search.q = ''; HL?.delete('rsearch'); }
    this.count.clear();
    this.row = null; this.on = false; this.mode = 'n';
    this.unreg?.(); this.unreg = null;
    this.host.selection?.(null);
    update(s => { s.tick++; });
  }
  exit(how: 'normal' | 'insert' | 'end' = 'normal') { this.clear(); getSelection()?.removeAllRanges(); this.host.exit(how); }
  /** The node under the cursor went away (the transcript changed): start again at the end. */
  private alive() { return !!this.f && this.f.n.isConnected && !!this.root?.isConnected; }

  // ---------- painting ----------
  /** Bring the cursor into view. On the conversation's first or last line (gg, G) the transcript goes all the way to
   *  its edge, padding and all: showing just the cursor's line leaves the top of the first message (or the last
   *  reply's actions) a few pixels out of sight. Otherwise just enough, with a line of margin. */
  private reveal(at: Element | Range) {
    const root = this.root; if (!root) return;
    let sc: HTMLElement | null = root;
    while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (!sc) return;
    const ns = this.texts(root), f = this.f;
    if (f && this.mode === 'n' && ns.length) {
      if (f.n === ns[0] || this.row && this.row.contains(ns[0])) { sc.scrollTop = 0; return; }
      if (f.n === ns[ns.length - 1] || this.row && this.row.contains(ns[ns.length - 1])) { sc.scrollTop = sc.scrollHeight; return; }
    }
    const r = at.getBoundingClientRect(), b = sc.getBoundingClientRect(), m = 24;
    if (r.top < b.top + m || r.height > b.height - 2 * m) sc.scrollTop += r.top - b.top - m;
    else if (r.bottom > b.bottom - m) sc.scrollTop += r.bottom - b.bottom + m;
  }
  draw() {
    const s = getSelection()!, { a, f, mode, root } = this; if (!f || !a || !root) return;
    const end = (p: Pt) => Math.min(p.o + 1, p.n.data.length);
    root.classList.add('rd'); root.classList.toggle('rv', mode !== 'n');
    root.querySelectorAll('.rowcur').forEach(x => x.classList.remove('rowcur'));
    const row = mode === 'n' ? f.n.parentElement?.closest<HTMLElement>(ROWS) : null;
    this.row = row && root.contains(row) ? row : null;
    root.querySelectorAll('.af .kcur, .m-acts .kcur').forEach(x => { if (!this.row?.contains(x)) x.classList.remove('kcur'); });
    if (this.row) {
      this.row.classList.add('rowcur'); HL?.delete('vcur'); s.removeAllRanges();
      if (this.row.matches(KROWS) && !this.row.querySelector('.kcur')) (this.row.querySelector('.primary') || this.row.querySelector('button'))?.classList.add('kcur');
      this.reveal(this.row); this.host.selection?.(null); update(x => { x.tick++; }); return;
    }
    if (mode === 'n') { if (HL) s.removeAllRanges(); else s.setBaseAndExtent(f.n, f.o, f.n, end(f)); }
    else {
      const r = document.createRange(); r.setStart(a.n, a.o); r.collapse(true);
      const [st, en] = r.comparePoint(f.n, f.o) >= 0 ? [a, f] : [f, a];
      if (mode === 'v') s.setBaseAndExtent(st.n, st.o, en.n, end(en));
      else {   // whole lines, never outside the block
        const bd = this.bound, within = (n: Node | null) => !!n && (!bd || bd.contains(n));
        s.setBaseAndExtent(st.n, st.o, st.n, st.o); s.modify('move', 'backward', 'lineboundary');
        const [sn, so] = within(s.focusNode) ? [s.focusNode!, s.focusOffset] : [st.n, 0];
        s.setBaseAndExtent(en.n, en.o, en.n, en.o); s.modify('move', 'forward', 'lineboundary');
        const [fn, fo] = within(s.focusNode) ? [s.focusNode!, s.focusOffset] : [en.n, en.n.data.length];
        s.setBaseAndExtent(sn, so, fn, fo);
      }
    }
    { const c = document.createRange(); c.setStart(f.n, f.o); c.setEnd(f.n, end(f)); this.reveal(c); }
    if (HL) { const c = document.createRange(); c.setStart(f.n, f.o); c.setEnd(f.n, end(f)); HL.set('vcur', new Highlight(c)); }
    this.host.selection?.(mode === 'n' ? null : s.toString());
    update(x => { x.tick++; });
  }

  /** V then y in a reply copies the Markdown behind the lines (bullets, numbers, emphasis, links, fences);
   *  tool rows and other rendered parts in the selection come as their text. Null: nothing from Markdown. */
  private markdown(s: Selection): string | null {
    if (!s.rangeCount || !this.bound) return null;
    const r = s.getRangeAt(0), parts: string[] = []; let any = false;
    for (const el of this.bound.children) {
      if (!r.intersectsNode(el) || el.matches('.m-acts')) continue;
      const md = (el as HTMLElement).dataset.md, t = md != null ? rawLines(el, md, r) : null;
      if (t != null) { any = true; parts.push(t); continue; }
      const c = document.createRange(); c.selectNodeContents(el);
      if (r.compareBoundaryPoints(Range.START_TO_START, c) > 0) c.setStart(r.startContainer, r.startOffset);
      if (r.compareBoundaryPoints(Range.END_TO_END, c) < 0) c.setEnd(r.endContainer, r.endOffset);
      const x = c.toString().trim(); if (x) parts.push(x);
    }
    return any ? parts.join('\n\n') : null;
  }

  // ---------- motions ----------
  private land(node: Node | null, off: number) {
    if (!node) return false;
    const p = this.inside(node) || node.nodeType !== 3 ? this.textAt(node, off) : null;
    if (!p || !this.inside(p.n) || !this.ok(p)) return false;
    this.f = p; return true;
  }
  private word(k: 'w' | 'b' | 'e'): Pt | null {
    const w = document.createTreeWalker(this.root!, NodeFilter.SHOW_TEXT), ns: Text[] = []; let n: Node | null;
    while ((n = w.nextNode())) if ((n as Text).data.length && this.inside(n)) ns.push(n as Text);
    const step = (p: Pt, d: number): Pt | null => { const o = p.o + d; if (o >= 0 && o < p.n.data.length) return { n: p.n, o }; const m = ns[ns.indexOf(p.n) + d]; return m ? { n: m, o: d > 0 ? 0 : m.data.length - 1 } : null; };
    const sp = (p: Pt) => (p.n.data[p.o] ?? ' ').trim() === '';
    const blk = (p: Pt) => p.n.parentElement?.closest('p, li, div, summary, pre, h3, h4, h5, figcaption, button');
    const gap = (a: Pt, b: Pt) => blk(a) !== blk(b);
    let q: Pt | null = this.f!, r: Pt | null;
    if (k === 'w') {
      let crossed = sp(q);
      for (;;) { r = step(q, 1); if (!r) return null; if (gap(q, r)) crossed = true; q = r; if (sp(q)) crossed = true; else if (crossed) return q; }
    }
    const d = k === 'e' ? 1 : -1;
    q = step(q, d); if (!q) return null;
    while (sp(q)) { q = step(q, d); if (!q) return null; }
    for (;;) { r = step(q, d); if (!r || sp(r) || gap(q, r)) return q; q = r; }
  }
  /** Up or down a line by geometry, which works on any static text. */
  private vert(d: number): boolean {
    const f = this.f!, root = this.root!;
    const fr = document.createRange(); fr.setStart(f.n, f.o); fr.setEnd(f.n, Math.min(f.o + 1, f.n.data.length));
    const row = this.mode === 'n' ? this.row : null, rect = row ? row.getBoundingClientRect() : fr.getClientRects()[0]; if (!rect) return false;
    const x = row ? (this.x ?? rect.left + 12) : rect.left + 2; if (!row) this.x = x;
    const sc = (root.closest('.thread') as HTMLElement) || root, lh = row ? 18 : Math.max(14, rect.height);
    const probe = (y: number) => {
      const b = sc.getBoundingClientRect(), xs = [x]; for (let px = b.left + 10; px < b.right - 4; px += 18) xs.push(px);
      let best: Range | null = null, bd = Infinity;
      for (const px of xs) {
        const c = caretAt(px, y);
        if (!c || c.startContainer.nodeType !== 3 || !this.inside(c.startContainer) || !(c.startContainer as Text).data.trim()) continue;
        if (row && row.contains(c.startContainer)) continue;
        const cr = c.getClientRects()[0];
        if (cr && ((!row && Math.abs(cr.top - rect.top) < 3) || y < cr.top - 3 || y > cr.bottom + 3)) continue;
        const dist = Math.abs(px - x); if (dist < bd) { bd = dist; best = c; } if (px === x) break;
      }
      return best;
    };
    for (let i = 1; i <= 16; i++) {
      let y = d > 0 ? rect.bottom + i * lh * 0.55 - 3 : rect.top - i * lh * 0.55 + 3;
      const b = sc.getBoundingClientRect();
      if (y > b.bottom - 4 || y < b.top + 4) { const before = sc.scrollTop; sc.scrollTop += d * lh * 4; y -= sc.scrollTop - before; if (y > b.bottom - 4 || y < b.top + 4) return false; }
      const c = probe(y); if (!c) continue;
      return this.land(c.startContainer, c.startOffset);
    }
    return false;
  }
  private jump(list: Element[], d: number) {
    const f = this.f!, rel = d < 0 ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
    const hits = list.filter(el => !el.contains(f.n) && (el.compareDocumentPosition(f.n) & rel)), el = d < 0 ? hits[hits.length - 1] : hits[0], p = el && this.firstText(el);
    if (!p || !this.ok(p)) return false; this.f = p; return true;
  }
  private go(dir: 'backward' | 'forward', gran: 'character' | 'lineboundary') {
    const s = getSelection()!, f = this.f!; s.setBaseAndExtent(f.n, f.o, f.n, f.o); s.modify('move', dir, gran);
    const ok = this.land(s.focusNode, gran === 'lineboundary' && dir === 'forward' ? Math.max(0, s.focusOffset - 1) : s.focusOffset);
    return ok;
  }
  private blocks() { return [...this.root!.querySelectorAll(BLOCKS)].filter(el => !el.parentElement?.closest('[data-src]')); }

  /** The mouse: click moves the cursor, a drag is v, a triple click is V. Called after mouseup. */
  fromMouse(e: MouseEvent, root: HTMLElement) {
    this.root = root;
    const s = getSelection()!;
    const gut = (e.target as Element).closest?.('.diff .dl > .n');   // a diff's line number: the start of that line
    if (gut) { s.removeAllRanges(); const p = gut.nextElementSibling && this.firstText(gut.nextElementSibling); if (p) this.begin(root, 'n', p); return; }
    const actionable = (e.target as Element).closest('button, input, textarea, summary, img, a, [data-act]');
    if (s.isCollapsed && (actionable || !root.contains(e.target as Node))) return;
    const c = caretAt(e.clientX, e.clientY);
    const at = c && c.startContainer.nodeType === 3 && this.inside(c.startContainer) && (c.startContainer as Text).data.trim() ? this.textAt(c.startContainer, c.startOffset) : null;
    // a triple click: the paragraph (or list item, heading, code block) under the pointer, as the browser shows it,
    // in VISUAL; V would keep only the one wrapped line clicked, and the browser's own end runs into the next block
    if (e.detail >= 3 && at) {
      const para = at.n.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, .mt, summary');
      const ns = para ? this.texts(para).filter(n => n.data.trim()) : [];
      if (ns.length) {
        const last = ns[ns.length - 1];
        return this.begin(root, 'v', { n: last, o: Math.max(0, last.data.trimEnd().length - 1) }, { n: ns[0], o: ns[0].data.length - ns[0].data.trimStart().length });
      }
      return this.begin(root, 'V', at);
    }
    if (!s.isCollapsed && s.anchorNode && root.contains(s.anchorNode)) {
      const fwd = !!(s.anchorNode.compareDocumentPosition(s.focusNode!) & Node.DOCUMENT_POSITION_FOLLOWING) || (s.anchorNode === s.focusNode && s.focusOffset >= s.anchorOffset);
      const a = this.textAt(s.anchorNode, fwd ? s.anchorOffset : s.anchorOffset - 1);
      const f = this.textAt(s.focusNode!, fwd ? s.focusOffset - 1 : s.focusOffset);
      if (a && f && e.detail === 2 && fwd) while (f.o > 0 && f.n.data[f.o].trim() === '' && (f.n !== a.n || f.o > a.o)) f.o--;
      if (a && f) return this.begin(root, 'v', f, a);
    }
    if (at) this.begin(root, 'n', at);
  }

  /** Put the cursor at the start of an element (a quote's source, a timeline tick's message). */
  at(el: Element) { const p = this.firstText(el); if (!p || !this.root) return; this.begin(this.root, 'n', p); }

  // ---------- keys ----------
  surface: Surface = {
    kind: 'reader',
    mode: (): Mode => (this.mode === 'v' ? 'VISUAL' : this.mode === 'V' ? 'V-LINE' : 'NORMAL'),
    key: k => { if (!this.on) return false; return this.key(k); },
  };

  /** A key, with a count before it (3w, 5j) and the shared search keys. */
  key(k: string): boolean {
    if (!this.br && !this.g && this.count.feed(k)) return true;
    const n = this.count.take();
    if (this.search.key(k, n)) return true;
    if (n > 1 && COUNTED.has(k)) { let used = false; for (let i = 0; i < n && this.on; i++) used = this.key1(k) || used; return used; }
    return this.key1(k);
  }

  private key1(k: string): boolean {
    if (!this.alive()) { if (!this.root || !this.enter(this.root)) { this.exit(); return true; } }
    const f = this.f!;
    const settle = () => { if (this.mode === 'n') { this.a = this.f; this.bound = null; } this.draw(); return true; };
    if (k === 'block-start') { const b = this.blocks().find(el => el.contains(f.n)), p = b && this.firstText(b); if (p && this.ok(p)) this.f = p; return settle(); }
    if (this.br) {   // [[ and ]]: your messages before / after
      const b = this.br; this.br = null; if (k !== b) return true;
      const mine = [...this.root!.querySelectorAll('[data-user]')];
      if (!this.jump(mine, b === '[' ? -1 : 1) && b === ']' && this.mode === 'n') { this.exit(); return true; }
      return settle();
    }
    if (this.g) {
      this.g = false;
      if (k === 'g') {   // the top; in VISUAL the start of the message the selection is in
        const p = this.mode !== 'n' && this.bound ? this.edge(this.bound, false) : this.firstText(this.root!);
        if (p && this.ok(p)) this.f = p; return settle();
      }
      // g f: open the file named under the cursor (a path in a reply or a tool row)
      const link = k === 'f' ? f.n.parentElement?.closest<HTMLElement>('.flink') || this.row?.querySelector<HTMLElement>('.flink') : null;
      if (link) { this.clear(); getSelection()?.removeAllRanges(); link.click(); }
      return true;
    }
    if (this.row && this.mode === 'n') {
      const row = this.row, det = row.matches('summary') ? row.parentElement as HTMLDetailsElement : null;
      if (row.matches(KROWS)) {   // a row of buttons (a request's answers, a reply's actions): h / l choose, enter presses
        const bs = [...row.querySelectorAll<HTMLButtonElement>('button:not([disabled])')], c = row.querySelector<HTMLButtonElement>('.kcur') || row.querySelector<HTMLButtonElement>('.primary') || bs[0], i = bs.indexOf(c);
        const d = ['l', 'right', 'w', 'e'].includes(k) ? 1 : ['h', 'left', 'b'].includes(k) ? -1 : 0;
        const to = d ? i + d : k === '0' || k === 'home' ? 0 : k === '$' || k === 'end' ? bs.length - 1 : null;
        if (to != null && bs.length) { bs.forEach(b => b.classList.remove('kcur')); bs[Math.max(0, Math.min(bs.length - 1, to))].classList.add('kcur'); return true; }
        if ((k === 'enter' || k === 'o' || k === 'space') && c) {
          if (row.matches('.af')) { this.clear(); c.click(); this.host.exit('normal'); return true; }
          c.click(); if (this.on && this.alive()) this.draw();   // copy keeps the cursor here; fork and side chat move on
          return true;
        }
        if (row.matches('.m-acts') && (k === 'v' || k === 'V')) {   // nothing to select on it: start at the reply's last character
          const bd = row.closest(SEL_BLOCK), p = bd && this.edge(bd, true); if (!p) return true; this.f = p;
        }
      }
      if (k === 'l' || k === 'right') { if (det) det.open = true; this.draw(); return true; }
      if (k === 'h' || k === 'left') { if (det) det.open = false; this.draw(); return true; }
      if (k === 'enter' || k === 'o') {
        if (det) { det.open = !det.open; this.draw(); return true; }
        // nothing to unfold: a row that names a file (Read) opens it; a button row is pressed
        const link = row.querySelector<HTMLElement>('.flink'), b = row.matches('button') ? row as HTMLButtonElement : row.querySelector('button');
        if (link) { this.clear(); getSelection()?.removeAllRanges(); link.click(); }
        else if (b) { this.clear(); b.click(); }
        return true;
      }
      if ('wbe0$'.includes(k) && k.length === 1) return true;
    }
    // on one of your messages, an editing key edits it (edit and resend)
    const mine = this.mode === 'n' && !this.row ? f.n.parentElement?.closest<HTMLElement>('.m-user.can-edit[data-ev]') : null;
    if (mine && ['i', 'a', 'I', 'A', 'c', 'C', 'd', 'D', 'x'].includes(k)) {
      const box = mine.querySelector<HTMLElement>(':scope > .mt') || mine;
      const offset = box.contains(f.n) ? rawAt(box, box.dataset.md ?? box.textContent ?? '', f.n, f.o) : 0;
      this.clear(); getSelection()?.removeAllRanges();
      this.host.edit(mine.dataset.ev!, offset, k);
      return true;
    }
    switch (k) {
      case 'g': this.g = true; return true;
      case '[': case ']': this.br = k; return true;
      case '{': this.jump(this.blocks(), -1); break;
      case '}': if (!this.jump(this.blocks(), 1) && this.mode === 'n') { this.exit(); return true; } break;
      case 'h': case 'left': this.go('backward', 'character'); break;
      case 'l': case 'right': this.go('forward', 'character'); break;
      case 'w': case 'e': case 'b': { const p = this.word(k); if (p && this.ok(p)) this.f = p; break; }
      case '0': case 'home': this.go('backward', 'lineboundary'); break;
      case '$': case 'end': this.go('forward', 'lineboundary'); break;
      case 'k': case 'up': this.vert(-1); break;
      case 'j': case 'down': if (!this.vert(1) && this.mode === 'n') { this.exit(); return true; } break;
      case 'v': case 'V':
        if (this.mode === 'n') this.a = this.f;
        this.mode = this.mode === k ? 'n' : k;
        this.bound = this.mode === 'n' ? null : this.blockOf(this.a!);
        break;
      case 'y':
        if (this.mode === 'n') { if (this.host.answer?.(true)) return true; break; }
        { const s = getSelection()!; yank(this.mode === 'V' ? this.markdown(s) ?? s.toString() : s.toString(), this.mode === 'V'); }
        this.mode = 'n'; break;
      case 'n': if (this.mode === 'n' && this.host.answer?.(false)) return true; return true;
      case 'esc': if (this.mode !== 'n') { this.mode = 'n'; break; } if (this.search.clear()) break; this.exit(); return true;
      case 'q': this.exit(); return true;
      case 'G': {   // the last line of the conversation, just above the composer: the last reply's actions when it has them
        if (this.mode !== 'n') { const p = this.bound ? this.edge(this.bound, true) : null; if (p && this.ok(p)) this.f = p; return settle(); }   // VISUAL: the end of the message
        this.enter(this.root!, 'end'); return true;
      }
      case 'i': case 'a': this.exit('insert'); return true;
      default: return false;   // other keys go on to the app's NORMAL layer (: H L | \\ ?), which drops the rest
    }
    return settle();
  }
}

/** Is the point over a character (not the blank space beside a line, a margin, the gap next to a bubble)? */
export function onText(x: number, y: number): boolean {
  const c = caretAt(x, y), n = c?.startContainer; if (!c || !n || n.nodeType !== 3) return false;
  const t = n as Text, r = document.createRange();
  for (const o of [c.startOffset - 1, c.startOffset]) {
    if (o < 0 || o >= t.data.length || !t.data[o].trim()) continue;
    r.setStart(t, o); r.setEnd(t, o + 1);
    for (const b of r.getClientRects()) if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2) return true;
  }
  return false;
}
function caretAt(x: number, y: number): Range | null {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const p = d.caretPositionFromPoint?.(x, y); if (!p) return null;
  const r = document.createRange(); r.setStart(p.offsetNode, p.offset); return r;
}
