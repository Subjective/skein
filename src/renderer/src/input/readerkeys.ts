// What every Reader shares (VIM-MODEL: Reader): counts before a motion, and `/` `?` search with `n` / `N`.
// Pure: each reader (terminal scrollback, chat transcript, file, diff) hands over its text as a list of strings
// (lines, rows or text nodes) and its cursor as a position in that list; ui/search.tsx is the one prompt.

/** A place in a reader's text: item `i` (a line, a row, a text node), offset `o` in it. */
export interface Pos { i: number; o: number }
export interface Hit extends Pos { len: number }

// ---------- counts ----------

/** Digits typed before a motion. `0` is a motion (line start) unless a count has begun, as in Vim. */
export class Count {
  private s = '';
  /** true when the key was a digit of the count (consumed). */
  feed(k: string): boolean {
    if (/^[1-9]$/.test(k) || (k === '0' && this.s)) { this.s = (this.s + k).slice(0, 6); return true; }
    return false;
  }
  /** Was a count typed (so `G` goes to that line rather than the last)? */
  get explicit() { return !!this.s; }
  get pending() { return this.s; }
  /** The count for this key (1 without one), clearing it. */
  take(): number { const n = this.s ? parseInt(this.s, 10) : 1; this.s = ''; return n; }
  clear() { this.s = ''; }
}

/** Run a one-step motion `n` times, stopping when it can't move. Returns how many steps it made. */
export function repeat(n: number, stepOnce: () => boolean): number {
  let done = 0;
  while (done < n && stepOnce()) done++;
  return done;
}

// ---------- search ----------

/** A literal search, smart case: all lower case ignores case, any capital matches exactly. */
export function searchRe(q: string, flags = 'g'): RegExp | null {
  if (!q) return null;
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags + (q === q.toLowerCase() ? 'i' : ''));
}

/** Every match of `q` in `items`, in order (capped). */
export function findAll(items: readonly string[], q: string, cap = 5000): Hit[] {
  const re = searchRe(q); if (!re) return [];
  const out: Hit[] = [];
  for (let i = 0; i < items.length && out.length < cap; i++) {
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(items[i])) && out.length < cap) { out.push({ i, o: m.index, len: m[0].length }); if (!m[0]) re.lastIndex++; }
  }
  return out;
}

const cmp = (a: Pos, b: Pos) => a.i - b.i || a.o - b.o;

/** The next match from `from` in direction `dir` (strictly after / before it), wrapping at the ends. */
export function nextHit(hits: readonly Hit[], from: Pos, dir: 1 | -1): { hit: Hit; index: number; wrapped: boolean } | null {
  if (!hits.length) return null;
  let index = dir > 0 ? hits.findIndex(h => cmp(h, from) > 0) : findLast(hits, h => cmp(h, from) < 0);
  const wrapped = index < 0;
  if (wrapped) index = dir > 0 ? 0 : hits.length - 1;
  return { hit: hits[index], index, wrapped };
}

/** The matches in the order `n` would visit them from `from` (for the prompt's list): nearest first. */
export function fromHere(hits: readonly Hit[], from: Pos, dir: 1 | -1): { hit: Hit; wrapped: boolean }[] {
  const first = nextHit(hits, from, dir); if (!first) return [];
  const out: { hit: Hit; wrapped: boolean }[] = [];
  for (let k = 0, j = first.index; k < hits.length; k++, j = (j + dir + hits.length) % hits.length) {
    out.push({ hit: hits[j], wrapped: first.wrapped || (dir > 0 ? j < first.index : j > first.index) });
  }
  return out;
}

/** The notice when a search wraps, as Vim says it. */
export const wrapNotice = (dir: 1 | -1) => (dir > 0 ? 'Search hit BOTTOM, continuing at TOP' : 'Search hit TOP, continuing at BOTTOM');

function findLast<T>(a: readonly T[], f: (x: T) => boolean) { for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i; return -1; }
