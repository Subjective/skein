// `/` and `?` in every Reader (VIM-MODEL: Reader): one prompt and one n / N for the terminal scrollback, the chat
// transcript, the open file and the diff. The prompt is the shared Menu: typing highlights every match in the
// reader and lists them nearest first (in the search's direction, wrapping), enter jumps to the one picked.
// n / N repeat the search forwards / backwards from the cursor; going past an end wraps with a short notice.
// esc in the reader clears the search (one level) before it does anything else. The matching is in
// input/readerkeys.ts, which is pure and unit-tested.
import { findAll, fromHere, nextHit, wrapNotice, type Hit, type Pos } from '../input/readerkeys';
import { openLayer, toast } from '../state/store';
import { Menu } from './Menu';

/** What a reader gives the search. */
export interface Searchable {
  /** The reader's text: lines, rows or text nodes, in reading order. */
  items(): string[];
  /** The cursor, as a place in items(). */
  at(): Pos;
  /** Put the cursor on a match. */
  go(h: Hit): void;
  /** Highlight every match of q ('' clears). */
  paint(q: string): void;
  /** Where the prompt opens (it hangs from the top right of this rect). */
  anchor(): DOMRect | null;
  /** A line number for the prompt's list, where the reader has them. */
  num?(h: Hit): number | null;
}

const context = (s: string, h: Hit) => {
  const a = Math.max(0, h.o - 30), t = s.slice(a, h.o + h.len + 60).replace(/\s+/g, ' ').trim();
  return (a > 0 ? '…' : '') + t || ' ';
};

export class ReaderSearch {
  q = '';
  dir: 1 | -1 = 1;
  constructor(private r: () => Searchable) {}
  get active() { return !!this.q; }

  /** `/` (dir 1) or `?` (dir -1): open the prompt. */
  prompt(dir: 1 | -1) {
    const r = this.r(), items = r.items(), from = r.at(), before = this.q;
    let picked = false;
    const a = r.anchor();
    const anchor = a ? new DOMRect(a.right - 8, a.top + 4, 0, 0) : null;
    const list = (q: string) => {
      queueMicrotask(() => { if (!picked) r.paint(q || before); });
      const hits = fromHere(findAll(items, q || before), from, dir).slice(0, 200);
      return hits.map(({ hit, wrapped }) => {
        const n = r.num?.(hit);
        return { label: context(items[hit.i], hit), right: <span className="age">{wrapped ? '↻ ' : ''}{n != null ? n : ''}</span>, data: { hit, wrapped } };
      });
    };
    openLayer(close => (
      <Menu<{ hit: Hit; wrapped: boolean }> anchor={anchor} place="bottom-end" width={420} className="rsearch" ranked
        search={{ prefix: dir > 0 ? '/' : '?' }} empty={q => (q || before ? 'Pattern not found' : undefined)} items={list}
        onClose={close}
        onPick={(it, q) => {
          picked = true; this.q = q || before; this.dir = dir;
          r.paint(this.q);
          if (it.data) { r.go(it.data.hit); if (it.data.wrapped) toast(wrapNotice(dir)); }
        }} />
    ), () => queueMicrotask(() => { if (!picked) r.paint(this.q); }));
  }

  /** n (d 1) / N (d -1), `count` times. */
  next(d: 1 | -1, count = 1) {
    const r = this.r();
    if (!this.q) { toast('No previous search: press / or ?'); return; }
    const hits = findAll(r.items(), this.q), dir = (this.dir * d) as 1 | -1;
    let at: Pos = r.at(), wrapped = false, hit: Hit | null = null;
    for (let k = 0; k < count; k++) { const n = nextHit(hits, at, dir); if (!n) break; hit = n.hit; at = n.hit; wrapped ||= n.wrapped; }
    if (!hit) { toast(`Pattern not found: ${this.q}`); return; }
    r.paint(this.q); r.go(hit);
    if (wrapped) toast(wrapNotice(dir));
  }

  /** esc: clear the search. false when there was none (esc goes on to its next meaning). */
  clear(): boolean { if (!this.q) return false; this.q = ''; this.r().paint(''); return true; }

  /** The keys every reader shares. true when the key was taken. */
  key(k: string, count = 1): boolean {
    if (k === '/') { this.prompt(1); return true; }
    if (k === '?') { this.prompt(-1); return true; }
    if (k === 'n' && this.q) { this.next(1, count); return true; }
    if (k === 'N' && this.q) { this.next(-1, count); return true; }
    return false;
  }
}
