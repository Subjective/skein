// Leader [ (or leader esc) reads a terminal's scrollback as a Reader, like tmux copy-mode.
// j k ctrl-d ctrl-u gg G move (with counts: 5j, 10G goes to line 10); v starts a selection by lines, y copies it;
// / ? n N search (ui/search.tsx); i a q esc (or j past the end) go back. esc first clears a selection or a search.
import type { IDecoration, IMarker } from '@xterm/xterm';
import type { KeyLike } from '../../input/keys';
import { Count, type Hit } from '../../input/readerkeys';
import { yank } from '../../input/register';
import { S, update } from '../../state/store';
import { ReaderSearch } from '../../ui/search';
import { termOf } from './TerminalView';

interface Reading { line: number; col: number; anchor: number | null; g: boolean; count: Count; search: ReaderSearch; marks: { m: IMarker; d?: IDecoration }[]; hit: Hit | null }
const reading = new Map<string, Reading>();
export const isReading = (tabId: string) => reading.has(tabId);

const lines = (tabId: string): string[] => {
  const t = termOf(tabId); if (!t) return [];
  const b = t.term.buffer.active, out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out;
};

function paint(tabId: string) {
  const t = termOf(tabId), r = reading.get(tabId); if (!t || !r) return;
  t.term.scrollToLine(Math.max(0, r.line - Math.floor(t.term.rows / 2)));
  if (r.anchor != null) { const a = Math.min(r.anchor, r.line), b = Math.max(r.anchor, r.line); t.term.selectLines(a, b); }
  else if (r.hit && r.hit.i === r.line) t.term.select(r.hit.o, r.hit.i, Math.max(1, r.hit.len));
  else t.term.selectLines(r.line, r.line);
}

/** Highlight every match of q in the scrollback (decorations, capped), or clear them. */
function paintHits(tabId: string, q: string) {
  const t = termOf(tabId), r = reading.get(tabId); if (!t || !r) return;
  for (const x of r.marks) { x.d?.dispose(); x.m.dispose(); }
  r.marks = [];
  if (!q) { r.hit = null; paint(tabId); return; }
  const b = t.term.buffer.active, cur = b.baseY + b.cursorY;
  const ls = lines(tabId);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (q === q.toLowerCase() ? 'i' : ''));
  for (let i = 0; i < ls.length && r.marks.length < 400; i++) {
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(ls[i])) && r.marks.length < 400) {
      if (!m[0]) { re.lastIndex++; continue; }
      const mk = t.term.registerMarker(i - cur); if (!mk) continue;
      const d = t.term.registerDecoration({ marker: mk, x: m.index, width: m[0].length, backgroundColor: '#e2a53c', layer: 'top' });
      d?.onRender(el => { el.classList.add('t-hit'); });
      r.marks.push({ m: mk, d });
    }
  }
}

export function scrollback(tabId: string) {
  const t = termOf(tabId); if (!t) return;
  const buf = t.term.buffer.active;
  const r: Reading = { line: buf.baseY + buf.cursorY, col: 0, anchor: null, g: false, count: new Count(), marks: [], hit: null, search: null as unknown as ReaderSearch };
  r.search = new ReaderSearch(() => ({
    items: () => lines(tabId),
    at: () => ({ i: r.line, o: r.col }),
    go: h => { r.line = h.i; r.col = h.o; r.hit = h; paint(tabId); update(s => { s.tick++; }); },
    paint: q => paintHits(tabId, q),
    anchor: () => termOf(tabId)?.term.element?.getBoundingClientRect() ?? null,
    num: h => h.i + 1,
  }));
  reading.set(tabId, r);
  t.term.blur(); paint(tabId); update(s => { s.tick++; });
}

function leave(tabId: string) {
  const t = termOf(tabId), r = reading.get(tabId);
  if (r) { for (const x of r.marks) { x.d?.dispose(); x.m.dispose(); } }
  reading.delete(tabId);
  if (t) { t.term.clearSelection(); t.term.scrollToBottom(); t.term.focus(); }
  update(s => { s.tick++; });
}

export function readerKey(tabId: string, k: string, _e: KeyLike): boolean {
  const t = termOf(tabId), r = reading.get(tabId); if (!t || !r) return false;
  const last = t.term.buffer.active.length - 1, half = Math.floor(t.term.rows / 2);
  const go = (l: number) => { if (l > last && r.anchor == null) return leave(tabId); r.line = Math.max(0, Math.min(last, l)); r.col = 0; r.hit = null; paint(tabId); };
  if (r.g) { r.g = false; const explicit = r.count.explicit, n = r.count.take(); if (k === 'g') go(explicit ? n - 1 : 0); return true; }
  if (r.count.feed(k)) return true;
  const explicit = r.count.explicit, n = r.count.take();
  if (r.search.key(k, n)) return true;
  switch (k) {
    case 'j': case 'down': go(r.line + n); return true;
    case 'k': case 'up': go(r.line - n); return true;
    case 'ctrl-d': go(r.line + half * n); return true;
    case 'ctrl-u': go(r.line - half * n); return true;
    case 'G': go(explicit ? n - 1 : last); return true;
    case 'g': r.g = true; if (explicit) for (const c of String(n)) r.count.feed(c); return true;
    case 'v': case 'V': r.anchor = r.anchor == null ? r.line : null; paint(tabId); update(s => { s.tick++; }); return true;
    case 'y': if (t.term.hasSelection()) yank(t.term.getSelection().replace(/\n$/, ''), r.anchor != null); r.anchor = null; paint(tabId); return true;
    case 'esc':
      if (r.anchor != null) { r.anchor = null; paint(tabId); update(s => { s.tick++; }); return true; }
      if (r.search.clear()) return true;
      leave(tabId); return true;
    case 'i': case 'a': case 'q': leave(tabId); return true;
  }
  return k.length === 1 || !S.settings.vim;
}
export const readingVisual = (tabId: string) => reading.get(tabId)?.anchor != null;
