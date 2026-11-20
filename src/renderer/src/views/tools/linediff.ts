// A line diff (Myers), for the open file's gutter while it is edited (marks follow unsaved text) and for
// the browser stand-in's fake repository.
import type { DiffLine, Hunk } from '@shared/api';

/** Edit script between two line lists: ' ' keep, '-' only in a, '+' only in b. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  // trim the common head and tail, which is most of a file being edited
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb), N = A.length, M = B.length, max = N + M;
  const out: DiffLine[] = [];
  for (let i = 0; i < s; i++) out.push({ k: ' ', a: i + 1, b: i + 1, text: a[i] });
  const mid: DiffLine[] = [];
  if (N === 0 || M === 0 || max > 20000) {
    // nothing in common inside (or too big to search): everything removed, then everything added
    A.forEach((t, i) => mid.push({ k: '-', a: s + i + 1, text: t }));
    B.forEach((t, i) => mid.push({ k: '+', b: s + i + 1, text: t }));
  } else {
    const v = new Int32Array(2 * max + 2), trace: Int32Array[] = [];
    let done = false;
    for (let d = 0; d <= max && !done; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[max + k] = x;
        if (x >= N && y >= M) { done = true; break; }
      }
    }
    // walk back through the trace
    let x = N, y = M;
    const rev: DiffLine[] = [];
    for (let d = trace.length - 1; d >= 0; d--) {
      const vv = trace[d], k = x - y;
      const pk = k === -d || (k !== d && vv[max + k - 1] < vv[max + k + 1]) ? k + 1 : k - 1;
      const px = vv[max + pk], py = px - pk;
      while (x > px && y > py) { x--; y--; rev.push({ k: ' ', a: s + x + 1, b: s + y + 1, text: A[x] }); }
      if (d > 0) { if (x === px) { y--; rev.push({ k: '+', b: s + y + 1, text: B[y] }); } else { x--; rev.push({ k: '-', a: s + x + 1, text: A[x] }); } }
    }
    mid.push(...rev.reverse());
  }
  out.push(...mid);
  for (let i = 0; i < a.length - ea; i++) out.push({ k: ' ', a: ea + i + 1, b: eb + i + 1, text: a[ea + i] });
  return out;
}

/** Group an edit script into hunks with `ctx` lines of context, like `git diff -U3`. */
export function toHunks(lines: DiffLine[], ctx = 3): Hunk[] {
  const hunks: Hunk[] = [];
  const changed = lines.map((l, i) => (l.k !== ' ' ? i : -1)).filter(i => i >= 0);
  if (!changed.length) return hunks;
  let i = 0;
  while (i < changed.length) {
    let from = Math.max(0, changed[i] - ctx), to = Math.min(lines.length - 1, changed[i] + ctx);
    while (i + 1 < changed.length && changed[i + 1] - ctx <= to + 1) { i++; to = Math.min(lines.length - 1, changed[i] + ctx); }
    const ls = lines.slice(from, to + 1);
    const firstA = ls.find(l => l.a != null)?.a, firstB = ls.find(l => l.b != null)?.b;
    const an = ls.filter(l => l.k !== '+').length, bn = ls.filter(l => l.k !== '-').length;
    // git numbers an empty side by the line before it
    const prevA = lines.slice(0, from).filter(l => l.k !== '+').length, prevB = lines.slice(0, from).filter(l => l.k !== '-').length;
    hunks.push({ a: firstA ?? prevA, b: firstB ?? prevB, an, bn, lines: ls });
    i++;
    void from;
  }
  return hunks;
}
