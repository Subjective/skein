// Fuzzy matching for file search: the query's characters in order, scored so that matches in the file name,
// at word starts and in runs rank first (like Cursor's and VS Code's quick open).

/** A score for q against s (higher is better), or -1 when q is not a subsequence of s. Case-insensitive. */
export function fuzzyScore(q: string, s: string): number {
  if (!q) return 0;
  const ql = q.toLowerCase().replace(/\s+/g, ''), sl = s.toLowerCase();
  const base = sl.lastIndexOf('/') + 1;
  let score = 0, si = 0, run = 0, first = -1;
  for (const c of ql) {
    const j = sl.indexOf(c, si);
    if (j < 0) return -1;
    if (first < 0) first = j;
    run = j === si && si > 0 ? run + 1 : 0;
    const prev = sl[j - 1];
    score += 1 + run * 3 + (j >= base ? 2 : 0) + (j === 0 || prev === '/' || prev === '-' || prev === '_' || prev === '.' ? 4 : 0);
    si = j + 1;
  }
  if (sl.slice(base).startsWith(ql)) score += 12;
  return score - first * 0.05 - s.length * 0.02;
}

/** The best n entries of list for q, best first. An empty q keeps list order. */
export function fuzzyTop(q: string, list: string[], n = 50): string[] {
  if (!q.trim()) return list.slice(0, n);
  const hits: [number, string][] = [];
  for (const s of list) { const sc = fuzzyScore(q, s); if (sc >= 0) hits.push([sc, s]); }
  return hits.sort((a, b) => b[0] - a[0]).slice(0, n).map(h => h[1]);
}
