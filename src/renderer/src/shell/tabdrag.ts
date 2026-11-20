// Dragging a tab (the mouse does what the keys do: rule 10), drawn as the mockup draws it: the tab is lifted
// onto a layer above the app and follows the pointer at its own size. Its bar keeps an empty slot of that
// width (the ghost), which moves to where the tab would land while the other tabs glide around it. Over a
// pane's body the outcome is drawn in advance: its middle (the slot joins that pane's bar, the body shows
// the tab's big icon) or an edge (a half-pane panel with its own bar: a new split on that side). Dropped
// outside every pane, a tab pops out where it was let go (HANDOFF: drop semantics).
// A thread row dragged from the sidebar into the panes behaves the same way (shell/move.tsx): its open tab is
// the one that moves, else a new tab for the thread lands where it is dropped.
import * as A from '../state/actions';
import { findPane, leaves, mkPane, mkTab, splitAt, type Tab } from '../state/layout';
import { S, update, ws } from '../state/store';
import { reduced } from '../ui/motion';
import { tabMeta } from './meta';

type Zone = 'c' | 'l' | 'r' | 't' | 'b';
type Over = { pane: string; bar: true } | { pane: string; zone: Zone } | null;

const svg = (name: string, size = '') => `<svg class="i ${size} i-${name}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const mk = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild as HTMLElement; };

/** Which part of a pane the pointer is over: the middle, else the nearest edge. */
export function zoneOf(r: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
  if (fx > 0.28 && fx < 0.72 && fy > 0.28 && fy < 0.72) return 'c';
  const d: Record<Zone, number> = { l: fx, r: 1 - fx, t: fy, b: 1 - fy, c: 9 };
  return (['l', 'r', 't', 'b'] as Zone[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

export interface PaneDrag {
  /** Follow the pointer; returns whether it is over a pane. */
  track(x: number, y: number): boolean;
  /** Let go: lands where the preview showed (false when it was over no pane). */
  drop(x: number, y: number): boolean;
  /** Take everything off the screen without landing. */
  cancel(): void;
  /** Show or hide the lifted tab (a sidebar row shows its own lift outside the panes). */
  show(on: boolean): void;
}

/** A drag into the panes. `tab` is the tab that moves (in pane `from`, drawn by `src`), or a new tab when `from` is null. */
export function paneDrag(o: { tab: Tab; from: string | null; src: HTMLElement | null; dx: number; dy: number; width?: number; outside?: 'popout' | 'none' }): PaneDrag {
  const m = tabMeta(o.tab);
  const lift = mk(`<div class="tab on lift">${svg(m.icon)}<span class="t">${esc(m.title)}</span></div>`);
  document.body.appendChild(lift);
  const w = o.src ? o.src.getBoundingClientRect().width : o.width || lift.offsetWidth;   // the lifted tab keeps the width it had
  lift.style.width = w + 'px';
  const ghost = mk('<div class="tab ghost"></div>'); ghost.style.width = w + 'px';         // ...and so does the slot it leaves
  const home = o.src ? o.src.parentElement as HTMLElement : null;
  if (o.src) { o.src.parentElement!.insertBefore(ghost, o.src); o.src.classList.add('dragging'); }
  const hint = mk('<div class="drop"></div>');
  document.body.classList.add('dragging-tab');
  let over: Over = null, hz = '';
  const live = (el: Element) => [...el.querySelectorAll<HTMLElement>('.tab:not(.dragging)')];

  // move the slot in the DOM and let every tab glide from where it was drawn to where it now belongs
  const place = (parent: HTMLElement | null, before: Element | null) => {
    if (ghost.parentElement === parent && ghost.nextElementSibling === before) return;
    if (!parent && !ghost.parentElement) return;
    const all = [...document.querySelectorAll<HTMLElement>('.pane .tabs .tab')];
    const was = new Map(all.map(t => [t, t.getBoundingClientRect().left]));
    if (parent) parent.insertBefore(ghost, before); else ghost.remove();
    if (reduced()) return;
    for (const t of document.querySelectorAll<HTMLElement>('.pane .tabs .tab')) {
      t.getAnimations?.().forEach(a => a.cancel());
      const d = (was.get(t) ?? NaN) - t.getBoundingClientRect().left;
      if (d) t.animate?.([{ transform: `translateX(${d}px)` }, { transform: 'none' }], { duration: 170, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  };
  const goHome = () => { if (o.src?.isConnected && home) place(home, o.src); else place(null, null); };
  // keep the slot under the pointer within a bar, one neighbour at a time, by layout position: offsetLeft is not
  // moved by the glide (a transform), so the slot doesn't swap back and forth while the tabs are still sliding
  const slot = (tabs: HTMLElement, x: number | null) => {
    const r = tabs.getBoundingClientRect();
    const mid = (t: HTMLElement) => r.left - tabs.scrollLeft + t.offsetLeft - (t.offsetParent === tabs ? 0 : tabs.offsetLeft) + t.offsetWidth / 2;
    if (ghost.parentElement !== tabs) { const ts = live(tabs), i = x == null ? -1 : ts.findIndex(t => x < mid(t)); return place(tabs, i < 0 ? null : ts[i]); }
    if (x == null) return;   // over this bar's own pane: the slot stays where it is
    for (let n = 0; n < 12; n++) {
      const ts = live(tabs), i = ts.indexOf(ghost), p = ts[i - 1], nx = ts[i + 1];
      if (p && x < mid(p)) place(tabs, p); else if (nx && x > mid(nx)) place(tabs, nx.nextElementSibling); else break;
    }
  };
  // a pane the tab can land in: not its own pane when it is that pane's only tab
  const ok = (pe: HTMLElement) => pe.dataset.pane !== o.from || (findPane(ws().tree, o.from!)?.tabs.length ?? 0) > 1;

  const api: PaneDrag = {
    track(x, y) {
      lift.style.transform = `translate(${x - o.dx}px, ${y - o.dy}px)`;
      const under = document.elementFromPoint(x, y), bar = under?.closest<HTMLElement>('.pane > .tb'), pe = under?.closest<HTMLElement>('.pane[data-pane]');
      over = null;
      if (bar && pe) { hint.remove(); hz = ''; slot(bar.querySelector<HTMLElement>('.tabs')!, x); over = { pane: pe.dataset.pane!, bar: true }; return true; }
      if (!pe || !ok(pe)) { hint.remove(); hz = ''; goHome(); return false; }
      const r = pe.getBoundingClientRect(), z = zoneOf(r, x, y), s = hint.style, tb = pe.querySelector('.tb')?.getBoundingClientRect().height || 40;
      if (z === 'c') slot(pe.querySelector<HTMLElement>('.tb .tabs')!, null);   // middle: it joins this pane's tabs and takes over the body
      else place(null, null);                                                     // edge: it becomes its own pane in that half
      if (z + pe.dataset.pane !== hz) {
        hz = z + pe.dataset.pane;
        hint.innerHTML = (z === 'c' ? '' : `<div class="tb"><div class="tabs"><div class="tab ghost" style="width:${w}px"></div></div></div>`) + `<div class="dz">${svg(m.icon, 'xl')}</div>`;
      }
      s.left = (z === 'r' ? r.left + r.width / 2 : r.left) + 'px'; s.top = (z === 'b' ? r.top + r.height / 2 : z === 'c' ? r.top + tb : r.top) + 'px';
      s.width = (z === 'l' || z === 'r' ? r.width / 2 : r.width) + 'px'; s.height = (z === 't' || z === 'b' ? r.height / 2 : z === 'c' ? r.height - tb : r.height) + 'px';
      if (!hint.isConnected) document.body.appendChild(hint);
      over = { pane: pe.dataset.pane!, zone: z };
      return true;
    },
    drop(x, y) {
      // where the slot sits among the bar's other tabs is where the tab lands
      const index = over && ghost.parentElement ? live(ghost.parentElement).indexOf(ghost) : undefined;
      const at = over;
      api.cancel();
      if (!at && o.outside !== 'popout') return false;
      land(o.tab, o.from, at, index, x, y);
      return !!at;
    },
    cancel() { lift.remove(); hint.remove(); ghost.remove(); o.src?.classList.remove('dragging'); document.body.classList.remove('dragging-tab'); },
    show(on) { lift.style.visibility = on ? '' : 'hidden'; if (!on) { hint.remove(); hz = ''; goHome(); over = null; } },
  };
  return api;
}

export function startTabDrag(e: React.MouseEvent, tab: Tab, fromPane: string) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  const src = e.currentTarget as HTMLElement;
  let d: PaneDrag | null = null;
  const mv = (ev: MouseEvent) => {
    if (!d && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!d) { const r = src.getBoundingClientRect(); d = paneDrag({ tab, from: fromPane, src, dx: x0 - r.left, dy: y0 - r.top, outside: 'popout' }); }
    ev.preventDefault();
    d.track(ev.clientX, ev.clientY);
  };
  const end = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up, true); removeEventListener('keydown', key, true); };
  const up = (ev: MouseEvent) => { end(); if (!d) return; ev.stopPropagation(); d.drop(ev.clientX, ev.clientY); };
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && d) { ev.preventDefault(); ev.stopPropagation(); end(); d.cancel(); } };
  addEventListener('mousemove', mv); addEventListener('mouseup', up, true); addEventListener('keydown', key, true);
}

/** A thread row from the sidebar, as a tab: its open tab if one shows it, else a new one. */
export function threadDrag(thread: string): PaneDrag {
  const w = ws();
  const hit = leaves(w.tree).flatMap(p => p.tabs.map(t => ({ p, t }))).find(v => v.t.kind === 'thread' && v.t.thread === thread);
  const src = hit ? document.querySelector<HTMLElement>(`.pane[data-pane="${hit.p.id}"] .tab[data-id="${hit.t.id}"]`) : null;
  const th = S.threads.find(t => t.id === thread);
  const tab = hit ? hit.t : mkTab('thread', { thread, view: th?.harness === 'claude' && th.drive === 'term' ? 'term' : S.settings.defaultView });
  return paneDrag({ tab, from: hit ? hit.p.id : null, src, dx: (src?.getBoundingClientRect().width ?? 160) / 2, dy: 14, width: 160, outside: 'none' });
}

function land(tab: Tab, fromPane: string | null, t: Over, index: number | undefined, x: number, y: number) {
  update(s => {
    const w = ws(), from = fromPane ? findPane(w.tree, fromPane) : null;
    if (fromPane && !from) return;
    const take = () => { if (!from) return; const i = from.tabs.indexOf(tab); from.tabs.splice(i, 1); if (from.active === tab.id && from.tabs.length) from.active = from.tabs[Math.max(0, i - 1)].id; };
    if (!t) { // outside every pane: float it where it was let go
      if (!from) return;
      take(); if (!from.tabs.length) A.closePane(from);
      const box = document.getElementById('work')?.getBoundingClientRect() || { left: 0, top: 0 };
      w.pops.push({ tab, from: w.focus, x: Math.max(0, x - box.left - 200), y: Math.max(0, y - box.top - 20), w: 560, h: 420 }); w.pf = tab.id; s.tick++;
      return;
    }
    const to = findPane(w.tree, t.pane); if (!to) return;
    if ('bar' in t || t.zone === 'c') {
      if (to === from && !('bar' in t)) { to.active = tab.id; w.focus = to.id; w.pf = null; s.tick++; return; }   // its own pane's middle: nothing moves
      take();
      const i = Math.max(0, Math.min(index ?? to.tabs.length, to.tabs.length));
      to.tabs.splice(i, 0, tab);
      to.active = tab.id; w.focus = to.id; w.pf = null;
      if (from && !from.tabs.length && from !== to) A.closePane(from);
    } else {
      if (to === from && from.tabs.length === 1) return; // splitting a pane with itself: nothing changes
      take();
      const n = mkPane(tab);
      w.tree = splitAt(w.tree, to.id, t.zone === 'l' || t.zone === 'r' ? 'row' : 'col', n, t.zone === 'l' || t.zone === 't');
      if (from && !from.tabs.length) { const r = leaves(w.tree).find(p => p.id === from.id); if (r) A.closePane(r); }
      w.focus = n.id; w.pf = null;
    }
    if (tab.kind === 'thread' && tab.thread) { s.sideCursor = tab.thread; s.sideFocus = false; }
    w.zoom = false; s.tick++;
  });
  A.save();
}
