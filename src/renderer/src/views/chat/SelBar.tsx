// Over a selection in a thread (mouse drag or the reader's VISUAL): Add to Chat, Add to Side Chat.
import { useLayoutEffect, useState } from 'react';
import { kb } from '../../input/platform';
import type { Tab } from '../../state/layout';
import { Button } from '../../ui/primitives';
import { quoteSelection } from './threads';

export function SelBar({ text, onDone }: { tab: Tab; text: string; onDone: () => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const s = getSelection(); if (!s || s.isCollapsed || !s.rangeCount) { setPos(null); return; }
    const b = s.getRangeAt(0).getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(b.left, innerWidth - 260)), top: b.top > 48 ? b.top - 38 : b.bottom + 8 });
  }, [text]);
  if (!pos) return null;
  const add = (side: boolean) => { quoteSelection(side); onDone(); };
  return (
    <div className="seltb" style={pos} role="toolbar" aria-label="Quote the selection" onMouseDown={e => e.preventDefault()}>
      <Button small variant="ghost" title={kb('mod-l')} onClick={() => add(false)}>Add to Chat</Button><i />
      <Button small variant="ghost" title={kb('mod-shift-s')} onClick={() => add(true)}>Add to Side Chat</Button>
    </div>
  );
}
