// The mouse on text in a tool view (the file view, a Changes diff), as in a thread (VIM-MODEL rule 10): a double
// click selects the word and a drag selects what it covers (VISUAL), a triple click the line (V-LINE), each with the
// thread's Add to Chat bar (views/chat/SelBar). Each view maps the selection onto its own cursor model; this holds
// the bar and lets it go as the chat's does: a mousedown anywhere but the bar, or the selection going.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tab } from '../../state/layout';
import { SelBar } from '../chat/SelBar';

export interface ToolSel {
  /** Show the bar over the page's current selection (its text), or hide it (null). */
  show(text: string | null): void;
  on: boolean;
  bar: ReactNode;
}

/** `onClear`: the view drops its VISUAL (the bar went with a click elsewhere, esc, or a quote). */
export function useToolSel(t: Tab, onClear: () => void): ToolSel {
  const [sel, setSel] = useState<string | null>(null);
  const clear = useRef(onClear); clear.current = onClear;
  useEffect(() => {
    if (!sel) return;
    const away = (e: MouseEvent) => {
      if ((e.target as Element).closest?.('.seltb')) return;
      setSel(null); getSelection()?.removeAllRanges(); clear.current();
    };
    const gone = () => { const g = getSelection(); if (!g || g.isCollapsed) { setSel(null); clear.current(); } };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('selectionchange', gone);
    return () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('selectionchange', gone); };
  }, [sel]);
  return {
    show: x => setSel(x && x.trim() ? x : null),
    on: !!sel,
    bar: sel ? <SelBar tab={t} text={sel} onDone={() => { setSel(null); clear.current(); }} /> : null,
  };
}

/** Where a DOM point falls in a code row (`.dl[data-ln]` / `.c`): the row element and the column in its text.
 *  On the line number (or left of the text) the column is 0; right of the text, the line's length. */
export function colAt(node: Node, off: number): { row: HTMLElement; col: number } | null {
  const el = node.nodeType === 1 ? node as Element : node.parentElement;
  const row = el?.closest<HTMLElement>('.dl'); if (!row) return null;
  const c = row.querySelector('.c'); if (!c) return null;
  if (!c.contains(node)) {
    // a boundary outside the text: before it (the line number) is 0, after it the end
    const at = node === row ? row.childNodes[off] : node;
    const before = !!at && (at === c || !!(at.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING));
    return { row, col: before ? 0 : (c.textContent || '').length };
  }
  const rg = document.createRange(); rg.setStart(c, 0); rg.setEnd(node, off);
  return { row, col: rg.toString().length };
}

/** The page selection as two code positions, in order, and whether the focus (the cursor end) is the start. */
export function selEnds(root: Element): { a: { row: HTMLElement; col: number }; b: { row: HTMLElement; col: number }; back: boolean } | null {
  const s = getSelection(); if (!s || s.isCollapsed || !s.rangeCount || !s.anchorNode || !root.contains(s.anchorNode)) return null;
  const r = s.getRangeAt(0);
  const a = colAt(r.startContainer, r.startOffset), b = colAt(r.endContainer, r.endOffset);
  if (!a || !b) return null;
  const back = s.focusNode === r.startContainer && s.focusOffset === r.startOffset && !(s.anchorNode === s.focusNode && s.anchorOffset === s.focusOffset);
  return { a, b, back };
}

/** The text node and offset at a column of a code row's text (the inverse of colAt). */
export function nodeAt(c: Element, col: number): [Node, number] {
  const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT); let n: Node | null, last: Node | null = null;
  while ((n = w.nextNode())) { const l = (n.textContent || '').length; if (col <= l) return [n, col]; col -= l; last = n; }
  return last ? [last, (last.textContent || '').length] : [c, 0];
}
