// Which lines of a file differ from its base, for an editor's gutter. Pure; used by the renderer and tests.
import type { DiffLine, Hunk } from './api';

/** Lines of a file that differ from the base, for an editor's gutter. From hunks with any context. */
export function gutterMarks(hunks: Hunk[]): { add: number[]; chg: number[]; del: number[] } {
  const add: number[] = [], chg: number[] = [], del: number[] = [];
  for (const h of hunks) {
    let run: DiffLine[] = [];
    const flush = (next?: number) => {
      const plus = run.filter(x => x.k === '+'), minus = run.filter(x => x.k === '-');
      if (plus.length) for (const x of plus) (minus.length ? chg : add).push(x.b!);
      else if (minus.length && next != null) del.push(next);
      run = [];
    };
    for (const x of h.lines) { if (x.k === ' ') flush(x.b); else run.push(x); }
    flush(h.b + h.bn);
  }
  return { add, chg, del };
}
