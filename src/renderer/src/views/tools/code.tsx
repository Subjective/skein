// Small pieces every tool view shares: the language badge, +/- counts, and a highlighted line of code with
// indent guides, a cursor and a selection painted over its tokens.
import { memo, type ReactNode } from 'react';
import { cx, Icon } from '../../ui/primitives';
import { langOf, type Tok } from './highlight';

export const LangBadge = ({ path }: { path: string }) => {
  const l = langOf(path);
  return l.badge ? <span className={cx('lang', l.cls)} title={l.name}>{l.badge}</span> : <Icon name="file" className="lang-f" />;
};

export const Nums = ({ add, del, small }: { add: number; del: number; small?: boolean }) => (
  <span className={cx('nums', small && 'sm')} aria-label={`${add} added, ${del} removed`}><span className="c-add">+{add}</span><span className="c-del">−{del}</span></span>
);

/** Status of a file in a tree: M amber, A green, D red, R blue. */
export const GitMark = ({ s }: { s?: string }) => (s ? <span className={cx('gst', s.toLowerCase())} title={({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked' } as Record<string, string>)[s]}>{s}</span> : null);

export interface Paint { from: number; to: number; cls: string }

/** One line: tokens, with leading whitespace drawn as indent guides every `unit` columns, and `paint` ranges
 *  (cursor, selection, search hits) laid over by character offset. */
export const CodeLine = memo(function CodeLine({ toks, unit, paint }: { toks: Tok[]; unit: number; paint?: Paint[] }) {
  const text = toks.map(t => t[1]).join('');
  const lead = /^[ \t]*/.exec(text)![0];
  const out: ReactNode[] = [];
  // indent guides: a box per tab, or per `unit` spaces, of leading whitespace
  const gb: number[] = [];
  if (unit) {
    if (lead.includes('\t')) { for (let i = 0; i < lead.length; i++) if (lead[i] === '\t') gb.push(i + 1); }
    else for (let i = unit; i <= lead.length; i += unit) gb.push(i);
  }
  const guides = gb.length ? gb[gb.length - 1] : 0;
  const cuts = new Set<number>(gb);
  for (const p of paint || []) { cuts.add(p.from); cuts.add(p.to); }
  let off = 0, k = 0;
  for (const [cls, t] of toks) {
    let s = 0;
    const end = off + t.length;
    const inner = [...cuts].filter(c => c > off && c < end).sort((a, b) => a - b);
    for (const c of [...inner, end]) {
      const piece = t.slice(s, c - off), at = off + s;
      if (piece) {
        const pc = (paint || []).filter(p => p.from <= at && p.to >= at + piece.length && p.to > p.from).map(p => p.cls);
        const guide = at < guides;
        out.push(guide ? <i key={k++} className={cx(at === 0 || gb.includes(at) ? 'igi' : 'igc', ...pc)}>{piece}</i> : <span key={k++} className={cx(cls, ...pc) || undefined}>{piece}</span>);
      }
      s = c - off;
    }
    off = end;
  }
  // a cursor past the end of the line (an empty line, or $ in VISUAL) still shows
  const tail = (paint || []).filter(p => p.from >= text.length && p.to > p.from);
  if (tail.length) out.push(<span key="tail" className={cx(...tail.map(p => p.cls))}> </span>);
  if (!out.length) out.push(' ');
  return <>{out}</>;
});
