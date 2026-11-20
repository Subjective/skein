// What commands do. Every key binding, menu item and button ends up here, so the mouse and the keys
// reach the same result (VIM-MODEL rule 10).
import type { ThreadMeta, ViewKind } from '@shared/types';
import { api } from '../api';
import {
  activeTab, allTabs, findPane, leaves, mkPane, mkTab, neighbour, removePane, resize as resizeTree, splitAt, swap as swapPanes,
  type Pane, type Rect, type Tab, type Workspace,
} from './layout';
import { blankWs, S, thread, toast, update, ws } from './store';

// ---------- focus ----------
export const focusedPane = (w: Workspace = ws()): Pane => findPane(w.tree, w.focus) || leaves(w.tree)[0];
export const currentTab = (w: Workspace = ws()): Tab => {
  const p = w.pf && w.pops.find(x => x.tab.id === w.pf);
  return p ? p.tab : activeTab(focusedPane(w));
};

function rects(): Map<string, Rect> {
  const m = new Map<string, Rect>();
  document.querySelectorAll<HTMLElement>('.pane[data-pane]').forEach(e => m.set(e.dataset.pane!, e.getBoundingClientRect()));
  return m;
}

export function focusPane(id: string) { update(s => { const w = ws(); w.focus = id; w.pf = null; s.sideFocus = false; s.tick++; }); }

export function focusDir(d: 'h' | 'j' | 'k' | 'l') {
  if (S.sideFocus) { if (d === 'l') sideFocus(false); return; }
  const w = ws();
  if (w.pf) { if (d === 'h' || d === 'l' || d === 'j' || d === 'k') update(() => { w.pf = null; }); return; }
  const n = neighbour(rects(), w.focus, d);
  if (!n && d === 'h') return sideFocus(true);
  if (n) focusPane(n);
}

export function sideFocus(on: boolean) {
  update(s => {
    if (on) {
      s.sideOpen = true; s.sideFocus = true;
      const t = currentTab();
      if (!s.sideCursor) s.sideCursor = t.kind === 'thread' && t.thread ? t.thread : null;
    } else s.sideFocus = false;
    s.tick++;
  });
}

// ---------- tabs and panes ----------
const ctxOf = (t: Tab): { machine: string; dir: string } => {
  const th = thread(t.thread);
  if (th) return { machine: th.machine, dir: th.dir };
  const w = ws();
  return { machine: t.machine || w.machine, dir: t.dir || w.dir };
};
export const launcherFor = (from?: Tab) => mkTab('new', from ? ctxOf(from) : { machine: ws().machine, dir: ws().dir });
export const shellFor = (from?: Tab) => mkTab('shell', from ? ctxOf(from) : { machine: ws().machine, dir: ws().dir });

export function addTab(p: Pane, t: Tab) { p.tabs.push(t); p.active = t.id; ws().focus = p.id; }

export function split(dir: 'row' | 'col', tab?: Tab) {
  update(s => {
    const w = ws(), g = focusedPane(w), n = mkPane(tab || { ...launcherFor(activeTab(g)), startNormal: true });
    w.tree = splitAt(w.tree, g.id, dir, n); w.focus = n.id; w.zoom = false; w.pf = null; s.sideFocus = false; s.tick++;
  });
  save();
}

export function closePane(p: Pane) {
  const w = ws();
  const r = removePane(w.tree, p.id);
  if (!r) { const n = mkPane(launcherFor(activeTab(p))); w.tree = n; w.focus = n.id; }
  else { w.tree = r.root; w.focus = r.focus; }
  if (leaves(w.tree).length === 1) w.zoom = false;
}

export function closeTab(tabId?: string) {
  update(s => {
    const w = ws();
    const pop = w.pops.find(p => p.tab.id === (tabId || w.pf));
    if (pop && (!tabId || tabId === pop.tab.id)) { closePopup(pop.tab.id); return; }
    const p = tabId ? leaves(w.tree).find(x => x.tabs.some(t => t.id === tabId))! : focusedPane(w);
    if (!p) return;
    const t = tabId ? p.tabs.find(x => x.id === tabId)! : activeTab(p);
    const i = p.tabs.indexOf(t);
    p.tabs.splice(i, 1);
    if (!p.tabs.length) closePane(p);
    else if (p.active === t.id) p.active = p.tabs[Math.max(0, i - 1)].id;
    s.tick++;
  });
  save();
}

export function tabStep(d: number) {
  update(s => { const p = focusedPane(); const i = p.tabs.indexOf(activeTab(p)); p.active = p.tabs[(i + d + p.tabs.length) % p.tabs.length].id; s.tick++; });
  save();
}
export function activate(paneId: string, tabId: string) {
  update(s => { const w = ws(); const p = findPane(w.tree, paneId); if (!p) return; p.active = tabId; w.focus = p.id; w.pf = null; s.sideFocus = false; s.tick++; });
  save();
}

export function setView(t: Tab, v?: ViewKind) {
  if (t.kind !== 'thread') return;
  const next = v || (t.view === 'chat' ? 'term' : 'chat');
  update(() => { t.view = next; });
  const th = thread(t.thread);
  // Claude Code: showing the terminal hands it the thread (G4); the terminal view runs the handoff.
  if (th?.harness === 'claude' && next === 'term' && th.drive !== 'term') void api.chat.drive(th.id, 'term');
  save();
}

export function openThread(id: string, o: { split?: boolean; view?: ViewKind } = {}) {
  const th = thread(id); if (!th) return;
  update(s => {
    const w = ws();
    s.sideFocus = false; s.sideCursor = id;
    if (th.status === 'unread') { th.status = 'idle'; void api.threads.update(id, { status: 'idle' }); }
    const pop = w.pops.find(p => p.tab.kind === 'thread' && p.tab.thread === id);
    if (pop) { w.pf = pop.tab.id; s.tick++; return; }
    const hit = leaves(w.tree).flatMap(p => p.tabs.map(t => ({ p, t }))).find(x => x.t.kind === 'thread' && x.t.thread === id);
    w.pf = null;
    const view = o.view || (th.harness === 'claude' && th.drive === 'term' ? 'term' : s.settings.defaultView);
    if (hit) { hit.p.active = hit.t.id; w.focus = hit.p.id; }
    else {
      const g = focusedPane(w), a = activeTab(g), t = mkTab('thread', { thread: id, view });
      if (o.split) { const n = mkPane(t); w.tree = splitAt(w.tree, g.id, 'row', n); w.focus = n.id; }
      else if (a.kind === 'new' || a.kind === 'thread') { g.tabs[g.tabs.indexOf(a)] = t; g.active = t.id; }  // replace, like a browser tab
      else addTab(g, t);
    }
    s.tick++;
  });
  save();
}

/** Start a thread from a launcher tab: the tab becomes the thread. */
export async function startThread(t: Tab, harness: 'claude' | 'codex', view: ViewKind): Promise<ThreadMeta> {
  const th = await api.threads.create({ harness, machine: t.machine || 'local', dir: t.dir || '~', model: t.model, effort: t.effort, perm: t.perm, worktree: t.worktree, view });
  update(s => {
    if (!s.threads.some(x => x.id === th.id)) s.threads = [th, ...s.threads];
    Object.assign(t, { kind: 'thread', thread: th.id, view });
    s.sideCursor = th.id;
  });
  save();
  return th;
}

export function zoom() { update(s => { const w = ws(); if (leaves(w.tree).length > 1) w.zoom = !w.zoom; s.tick++; }); }
export function only() { update(s => { const w = ws(); const p = focusedPane(w); w.tree = p; w.focus = p.id; w.zoom = false; s.tick++; }); save(); }
export function movePane(d: 'h' | 'j' | 'k' | 'l') {
  const w = ws(), f = focusedPane(w), n = neighbour(rects(), f.id, d), other = n && findPane(w.tree, n);
  if (other) { update(() => { swapPanes(f, other); w.focus = f.id === w.focus ? other.id : f.id; w.focus = other.id; }); save(); }
}
export function swapNext() {
  const w = ws(), ls = leaves(w.tree); if (ls.length < 2) return;
  const f = focusedPane(w), n = ls[(ls.indexOf(f) + 1) % ls.length];
  update(() => { swapPanes(f, n); w.focus = n.id; }); save();
}
export function resizePane(delta: number) {
  update(() => { const w = ws(); resizeTree(w.tree, w.focus, 'row', delta); }); save();
}

// ---------- popups ----------
export function popOut(tabId?: string) {
  update(s => {
    const w = ws(), p = focusedPane(w), t = tabId ? p.tabs.find(x => x.id === tabId) : activeTab(p);
    if (!t) return;
    p.tabs = p.tabs.filter(x => x.id !== t.id);
    if (!p.tabs.length) closePane(p); else if (p.active === t.id) p.active = p.tabs[p.tabs.length - 1].id;
    w.pops.push({ tab: t, from: w.focus }); w.pf = t.id; s.tick++;
  });
  save();
}
export function closePopup(id: string) {
  const w = ws(), p = w.pops.find(x => x.tab.id === id);
  w.pops = w.pops.filter(x => x.tab.id !== id);
  if (w.pf === id) { w.pf = null; if (p?.from && findPane(w.tree, p.from)) w.focus = p.from; }
}
/** Put a popup back as a tab in the pane it came from (alt + x on its close button). */
export function dock(id: string) {
  update(s => {
    const w = ws(), p = w.pops.find(x => x.tab.id === id); if (!p) return;
    closePopup(id);
    const g = (p.from && findPane(w.tree, p.from)) || focusedPane(w);
    addTab(g, p.tab); s.tick++;
  });
  save();
}

// ---------- workspaces ----------
export function newWorkspace(name: string, machine: string, dir: string) {
  update(s => { const w = blankWs(machine, dir); w.name = name; s.workspaces.push(w); s.wid = w.id; s.tick++; });
  save();
}
export function switchWorkspace(id: string) { update(s => { const w = s.workspaces.find(x => x.id === id); if (w) { w.usedAt = Date.now(); s.wid = id; s.tick++; } }); save(); }
export function lastWorkspace() {
  const other = [...S.workspaces].filter(w => w.id !== S.wid).sort((a, b) => b.usedAt - a.usedAt)[0];
  if (other) { ws().usedAt = Date.now() - 1; switchWorkspace(other.id); }
}

// ---------- every thread as chat / terminal ----------
export function allViews(v: ViewKind) {
  update(() => { for (const { tab } of allTabs(ws())) if (tab.kind === 'thread') tab.view = v; });
  save();
}

// ---------- persistence ----------
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void api.app.save('ui', { workspaces: S.workspaces, wid: S.wid, sideOpen: S.sideOpen, collapsed: S.collapsed });
  }, 400);
}

export function notImplemented(what: string) { toast(`${what} is not built yet`); }
