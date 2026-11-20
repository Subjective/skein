// Dragging a tab (the mouse does what the keys do: rule 10). The tab itself follows the pointer; a blue
// outline shows where it will land: another tab bar (into that pane at that spot), a pane's middle
// (into that pane), or a pane's edge (a new split on that side). Dropped outside any pane, it pops out.
import * as A from '../state/actions';
import { findPane, leaves, mkPane, splitAt, type Tab } from '../state/layout';
import { update, ws } from '../state/store';

type Target = { pane: string; zone: 'bar' | 'c' | 'l' | 'r' | 't' | 'b'; index?: number } | null;

export function startTabDrag(e: React.MouseEvent, tab: Tab, fromPane: string) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  const src = (e.currentTarget as HTMLElement);
  let lift: HTMLElement | null = null, hint: HTMLElement | null = null, target: Target = null;
  const begin = () => {
    const r = src.getBoundingClientRect();
    lift = src.cloneNode(true) as HTMLElement;
    Object.assign(lift.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
    lift.classList.add('on', 'lift');
    document.body.appendChild(lift);
    hint = document.createElement('div'); hint.className = 'drop-hint'; hint.style.display = 'none'; document.body.appendChild(hint);
    src.style.opacity = '.35';
    document.body.classList.add('dragging-tab');
  };
  const mv = (ev: MouseEvent) => {
    if (!lift && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!lift) begin();
    lift!.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
    target = hit(ev.clientX, ev.clientY);
    const h = hint!;
    if (!target) { h.style.display = 'none'; return; }
    const pe = document.querySelector<HTMLElement>(`.pane[data-pane="${target.pane}"]`)!;
    const r = pe.getBoundingClientRect(), bar = pe.querySelector('.tb')!.getBoundingClientRect();
    let box = { l: r.left, t: r.top, w: r.width, h: r.height };
    if (target.zone === 'bar') box = { l: bar.left, t: bar.top, w: bar.width, h: bar.height };
    if (target.zone === 'l') box.w /= 2;
    if (target.zone === 'r') { box.l += box.w / 2; box.w /= 2; }
    if (target.zone === 't') box.h /= 2;
    if (target.zone === 'b') { box.t += box.h / 2; box.h /= 2; }
    Object.assign(h.style, { display: 'block', left: box.l + 'px', top: box.t + 'px', width: box.w + 'px', height: box.h + 'px' });
  };
  const up = (ev: MouseEvent) => {
    removeEventListener('mousemove', mv); removeEventListener('mouseup', up, true);
    if (!lift) return; // a click, not a drag
    ev.stopPropagation();
    lift.remove(); hint?.remove(); src.style.opacity = ''; document.body.classList.remove('dragging-tab');
    drop(tab, fromPane, target, ev);
  };
  addEventListener('mousemove', mv); addEventListener('mouseup', up, true);
}

function hit(x: number, y: number): Target {
  for (const pe of document.querySelectorAll<HTMLElement>('.pane[data-pane]')) {
    const r = pe.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const bar = pe.querySelector('.tb')!.getBoundingClientRect();
    if (y <= bar.bottom) {
      const tabs = [...pe.querySelectorAll<HTMLElement>('.tab')];
      const i = tabs.findIndex(t => { const b = t.getBoundingClientRect(); return x < b.left + b.width / 2; });
      return { pane: pe.dataset.pane!, zone: 'bar', index: i < 0 ? tabs.length : i };
    }
    const fx = (x - r.left) / r.width, fy = (y - bar.bottom) / (r.bottom - bar.bottom);
    const zone = fx < 0.22 ? 'l' : fx > 0.78 ? 'r' : fy < 0.22 ? 't' : fy > 0.78 ? 'b' : 'c';
    return { pane: pe.dataset.pane!, zone };
  }
  return null;
}

function drop(tab: Tab, fromPane: string, t: Target, ev: MouseEvent) {
  update(s => {
    const w = ws(), from = findPane(w.tree, fromPane);
    if (!from) return;
    if (!t) { // outside every pane: float it where it was let go
      from.tabs = from.tabs.filter(x => x.id !== tab.id);
      if (!from.tabs.length) A.closePane(from); else if (from.active === tab.id) from.active = from.tabs[from.tabs.length - 1].id;
      w.pops.push({ tab, from: w.focus, x: Math.max(0, ev.clientX - 200), y: Math.max(0, ev.clientY - 20), w: 560, h: 420 }); w.pf = tab.id; s.tick++;
      return;
    }
    const to = findPane(w.tree, t.pane); if (!to) return;
    if (t.zone === 'bar' || t.zone === 'c') {
      const i0 = from.tabs.indexOf(tab);
      from.tabs.splice(i0, 1);
      let i = t.index ?? to.tabs.length;
      if (to === from && i > i0) i--;
      to.tabs.splice(Math.min(i, to.tabs.length), 0, tab);
      to.active = tab.id; w.focus = to.id;
      if (!from.tabs.length && from !== to) A.closePane(from);
      else if (from.active === tab.id && from !== to) from.active = from.tabs[Math.max(0, i0 - 1)].id;
    } else {
      if (to === from && from.tabs.length === 1) return; // splitting a pane with itself: nothing changes
      from.tabs = from.tabs.filter(x => x.id !== tab.id);
      const n = mkPane(tab);
      w.tree = splitAt(w.tree, to.id, t.zone === 'l' || t.zone === 'r' ? 'row' : 'col', n, t.zone === 'l' || t.zone === 't');
      if (!from.tabs.length) { const r = leaves(w.tree).find(p => p.id === from.id); if (r) A.closePane(r); }
      else if (from.active === tab.id) from.active = from.tabs[from.tabs.length - 1].id;
      w.focus = n.id;
    }
    w.zoom = false; s.tick++;
  });
  A.save();
}
