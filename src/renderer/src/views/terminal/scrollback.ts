// Leader [ (or leader esc) reads a terminal's scrollback as a Reader, like tmux copy-mode.
// j k ctrl-d ctrl-u gg G move; v starts a selection by lines, y copies it; i a q esc (or j past the end) go back.
import type { KeyLike } from '../../input/keys';
import { S, update } from '../../state/store';
import { termOf } from './TerminalView';

const reading = new Map<string, { line: number; anchor: number | null }>();
export const isReading = (tabId: string) => reading.has(tabId);

function paint(tabId: string) {
  const t = termOf(tabId), r = reading.get(tabId); if (!t || !r) return;
  const buf = t.term.buffer.active;
  t.term.scrollToLine(Math.max(0, r.line - Math.floor(t.term.rows / 2)));
  if (r.anchor != null) { const a = Math.min(r.anchor, r.line), b = Math.max(r.anchor, r.line); t.term.selectLines(a, b); }
  else t.term.selectLines(r.line, r.line);
  void buf;
}

export function scrollback(tabId: string) {
  const t = termOf(tabId); if (!t) return;
  const buf = t.term.buffer.active;
  reading.set(tabId, { line: buf.baseY + buf.cursorY, anchor: null });
  t.term.blur(); paint(tabId); update(s => { s.tick++; });
}

function leave(tabId: string) {
  const t = termOf(tabId); reading.delete(tabId);
  if (t) { t.term.clearSelection(); t.term.scrollToBottom(); t.term.focus(); }
  update(s => { s.tick++; });
}

export function readerKey(tabId: string, k: string, _e: KeyLike): boolean {
  const t = termOf(tabId), r = reading.get(tabId); if (!t || !r) return false;
  const last = t.term.buffer.active.length - 1, half = Math.floor(t.term.rows / 2);
  const go = (l: number) => { if (l > last && r.anchor == null) return leave(tabId); r.line = Math.max(0, Math.min(last, l)); paint(tabId); };
  switch (k) {
    case 'j': case 'down': go(r.line + 1); return true;
    case 'k': case 'up': go(r.line - 1); return true;
    case 'ctrl-d': go(r.line + half); return true;
    case 'ctrl-u': go(r.line - half); return true;
    case 'G': go(last); return true;
    case 'g': go(0); return true;
    case 'v': case 'V': r.anchor = r.anchor == null ? r.line : null; paint(tabId); update(s => { s.tick++; }); return true;
    case 'y': if (t.term.hasSelection()) void navigator.clipboard.writeText(t.term.getSelection()); r.anchor = null; paint(tabId); return true;
    case 'i': case 'a': case 'q': case 'esc': if (k === 'esc' && r.anchor != null) { r.anchor = null; paint(tabId); return true; } leave(tabId); return true;
  }
  return k.length === 1 || !S.settings.vim;
}
export const readingVisual = (tabId: string) => reading.get(tabId)?.anchor != null;
