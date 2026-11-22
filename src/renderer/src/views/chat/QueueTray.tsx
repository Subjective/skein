// Messages sent while a turn runs wait here, stacked on the composer's top edge, each for a turn of its own.
// A row: its text, then Steer (send it into the running turn now), delete and ⋯ (edit, move to the top, open in a
// side chat, what enter does while a turn runs). The pointer drags a row by its grip to reorder.
// Keys (a List, VIM-MODEL rule 16 for the row's buttons): k from the composer's first line lands on the last row;
// j / k move, j past the last row goes back to the composer and k past the first reads the thread. On a row h / l move
// a ring over its buttons and enter / space press the ringed one (Steer first); s steers, x / dd delete, e / i / c
// edit in place (enter saves, esc twice keeps it as it was), K / J move it up / down, . opens ⋯, r resumes a paused queue.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { Queued } from '@shared/types';
import { registerTab } from '../../input/surfaces';
import { Button, cx, Icon, IconButton } from '../../ui/primitives';
import { VimField, type VimFieldHandle } from '../../ui/VimField';
import { animate, MOTION } from '../../ui/motion';

export interface QueueTrayProps {
  tabId: string;
  items: Queued[];
  paused?: boolean;
  /** The row with the keys, or null when the composer or the reader has them. */
  cursor: number | null;
  onCursor(i: number | null): void;
  /** j past the last row (back to the composer), k past the first (the thread above). */
  onLeaveDown(): void;
  onLeaveUp(): void;
  /** A turn runs, so Steer sends into it (else it starts the next turn). */
  running: boolean;
  onSteer(id: string): void;
  onDrop(id: string): void;
  onEdit(id: string, text: string): void;
  onOrder(ids: string[]): void;
  onResume(): void;
  onMenu(id: string, anchor: DOMRect): void;
}

export interface QueueTrayHandle { edit(id: string): void }

export const QueueTray = forwardRef<QueueTrayHandle, QueueTrayProps>(function QueueTray(p, handle) {
  const box = useRef<HTMLDivElement>(null);
  const [ring, setRing] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const edit = useRef<VimFieldHandle>(null);
  const props = useRef(p); props.current = p;
  const pend = useRef('');

  const order = (from: number, to: number) => {
    const ids = props.current.items.map(x => x.id), [id] = ids.splice(from, 1);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    props.current.onOrder(ids);
  };

  // the row with the keys stays in view; a new row slides up out of the composer
  useLayoutEffect(() => {
    if (p.cursor == null) return;
    box.current?.querySelectorAll<HTMLElement>('.qrow')[p.cursor]?.scrollIntoView({ block: 'nearest' });
  }, [p.cursor]);
  const seen = useRef(new Set(p.items.map(x => x.id)));
  useLayoutEffect(() => {
    for (const el of box.current?.querySelectorAll<HTMLElement>('.qrow') ?? []) {
      const id = el.dataset.id!; if (seen.current.has(id)) continue;
      seen.current.add(id);
      animate(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], MOTION.fast);
    }
  }, [p.items]);

  const startEdit = (id: string) => { const i = props.current.items.findIndex(x => x.id === id); if (i >= 0) props.current.onCursor(i); setDraft(props.current.items.find(x => x.id === id)?.text ?? ''); setEditing(id); requestAnimationFrame(() => edit.current?.focus(true)); };
  useImperativeHandle(handle, () => ({ edit: startEdit }));
  const saveEdit = () => {
    const id = editing, text = draft.trim();
    setEditing(null);
    if (id && text) props.current.onEdit(id, text);
  };

  // the keys, while a row has them
  const on = p.cursor != null && !editing;
  useEffect(() => {
    if (!on) return;
    return registerTab(p.tabId, {
      kind: 'list',
      mode: () => 'NORMAL',
      key: k => {
        const q = props.current, i = q.cursor ?? 0, it = q.items[i];
        if (!it) return false;
        const pending = pend.current; pend.current = '';
        const btns = () => [...(box.current?.querySelectorAll<HTMLButtonElement>('.qrow')[i]?.querySelectorAll<HTMLButtonElement>('.qact button') ?? [])];
        switch (k) {
          case 'j': case 'down': if (i >= q.items.length - 1) q.onLeaveDown(); else { q.onCursor(i + 1); setRing(0); } return true;
          case 'k': case 'up': if (i <= 0) q.onLeaveUp(); else { q.onCursor(i - 1); setRing(0); } return true;
          case 'g': if (pending === 'g') { q.onCursor(0); return true; } pend.current = 'g'; return true;
          case 'G': q.onCursor(q.items.length - 1); return true;
          case 'h': case 'left': setRing(r => Math.max(0, r - 1)); return true;
          case 'l': case 'right': setRing(r => Math.min(btns().length - 1, r + 1)); return true;
          case 'enter': case 'space': btns()[ring]?.click(); return true;
          case 's': q.onSteer(it.id); return true;
          case 'x': q.onDrop(it.id); return true;
          case 'd': if (pending === 'd') { q.onDrop(it.id); return true; } pend.current = 'd'; return true;
          case 'e': case 'i': case 'a': case 'c': startEdit(it.id); return true;
          case 'K': if (i > 0) { order(i, i - 1); q.onCursor(i - 1); } return true;
          case 'J': if (i < q.items.length - 1) { order(i, i + 1); q.onCursor(i + 1); } return true;
          case '.': { const b = btns().at(-1); if (b) q.onMenu(it.id, b.getBoundingClientRect()); return true; }
          case 'r': if (q.paused) { q.onResume(); return true; } return false;
          case 'esc': q.onLeaveDown(); return true;
          default: return false;
        }
      },
    });
  }, [on, p.tabId, ring]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p.items.length) return null;
  return (
    <div ref={box} className={cx('qtray', p.cursor != null && 'kb')} role="list" aria-label={`${p.items.length} queued`}>
      {p.paused && (
        <div className="qhead"><Icon name="clock" /><span>Queue paused after stop</span><span className="sp" />
          <Button small variant="ghost" title="Start the next one · r" onClick={p.onResume}>Resume</Button></div>
      )}
      <div className="qrows">
        {p.items.map((it, i) => {
          const cur = p.cursor === i;
          return (
            <div key={it.id} data-id={it.id} role="listitem" className={cx('qrow', cur && 'cur', editing === it.id && 'editing', drag?.id === it.id && 'dragging', drag && drag.id !== it.id && drag.over === i && 'over')}
              draggable={editing !== it.id}
              onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-skein-queued', it.id); setDrag({ id: it.id, over: i }); }}
              onDragOver={e => { if (!drag) return; e.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }); }}
              onDrop={e => { e.preventDefault(); if (drag) order(p.items.findIndex(x => x.id === drag.id), i); setDrag(null); }}
              onDragEnd={() => setDrag(null)}
              onMouseDown={e => { if (!(e.target as Element).closest('button, textarea')) p.onCursor(i); }}
              onDoubleClick={() => startEdit(it.id)}>
              <span className="qgrip" aria-hidden="true"><Icon name="grip" /></span>
              <Icon name="queue" className="qic" />
              {editing === it.id ? (
                <div className="qedit">
                  <VimField ref={edit} tabId={p.tabId} value={draft} onChange={setDraft} onEnter={saveEdit} onLeave={() => setEditing(null)} startMode="INSERT" placeholder="Queued message" />
                </div>
              ) : (
                <span className="qtext" title={it.text}>{it.text.replace(/\s+/g, ' ')}</span>
              )}
              {!!it.images?.length && <span className="qimgs">{it.images.slice(0, 3).map((src, j) => <img key={j} src={src} alt="" />)}</span>}
              {editing === it.id ? (
                <span className="qact on"><Button small variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button small variant="primary" onClick={saveEdit}>Save</Button></span>
              ) : (
                <span className={cx('qact', cur && 'on')}>
                  <button type="button" className={cx('qsteer', cur && ring === 0 && 'rng')} title={p.running ? 'Send into the running turn now · s' : 'Send now · s'} onClick={() => p.onSteer(it.id)}>
                    <Icon name="steer" />{p.running ? 'Steer' : 'Send now'}</button>
                  <IconButton icon="trash" label="Delete" keys="x" className={cx(cur && ring === 1 && 'rng')} onClick={() => p.onDrop(it.id)} />
                  <IconButton icon="dots" label="More" keys="." className={cx(cur && ring === 2 && 'rng')} onClick={e => p.onMenu(it.id, e.currentTarget.getBoundingClientRect())} />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
