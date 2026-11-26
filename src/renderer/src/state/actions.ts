// What commands do. Every key binding, menu item and button ends up here, so the mouse and the keys
// reach the same result (VIM-MODEL rule 10).
import type { ThreadMeta, ViewKind } from '@shared/types';
import { api } from '../api';
import { editorTyping } from '../ui/editor/vim';
import { openFile as openFileTab } from '../views/tools/open';
import { tabPlace, tabRestore } from '../views/tools/hooks';
import {
  activeTab, allTabs, findPane, leaves, mkPane, mkTab, neighbour, placeFor, removePane, resize as resizeTree, splitAt, swap as swapPanes,
  type Pane, type Popup, type Rect, type Tab, type Workspace,
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
  if (w.pf) return;   // a popup has no neighbours: ldr o cycles popups, ctrl-o goes back to the pane
  const n = neighbour(rects(), w.focus, d);
  if (!n && d === 'h') return sideFocus(true);
  if (n) focusPane(n);
}

export function sideFocus(on: boolean) {
  update(s => {
    if (on) {
      s.sideOpen = true; s.sideFocus = true;
      const t = currentTab();
      if (!s.sideCursor) s.sideCursor = t.kind === 'thread' && t.thread ? t.thread : 'new';   // a cursor to see: else the first j only showed one
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

/** A file or tool opens where `placeFor` says, from the pane holding `from` (else the focused pane); `split`
 *  always opens it in a new split to the right of that pane. */
export function openBeside(t: Tab, o: { from?: Tab; split?: boolean } = {}) {
  update(s => {
    const w = ws(), src = (o.from && leaves(w.tree).find(p => p.tabs.includes(o.from!))) || focusedPane(w);
    const n = o.split ? null : neighbour(rects(), src.id, 'l');
    const at = o.split ? 'split' : placeFor(w.tree, src, (n && findPane(w.tree, n)) || null);
    if (at === 'split') { const p = mkPane(t); w.tree = splitAt(w.tree, src.id, 'row', p); w.focus = p.id; }
    else addTab(at, t);
    w.pf = null; w.zoom = false; s.sideFocus = false; s.tick++;
  });
  save();
}

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

/** Stepping tabs with keys never changes the mode: H / L (NORMAL) land in NORMAL, the leader's n / p from a field
 *  that is typing land typing. steppedInsert() is that mode for the composer the step lands on, else undefined. */
let stepped = { at: 0, insert: false };
export const steppedInsert = (ms = 600): boolean | undefined => (Date.now() - stepped.at < ms ? stepped.insert : undefined);
export function tabStep(d: number) {
  const el = document.activeElement;
  stepped = { at: Date.now(), insert: !!el && ((el.tagName === 'TEXTAREA' && !el.classList.contains('vn')) || editorTyping(el, S.settings.vim)) };
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

/** A turn ended (running -> idle). Out of sight (another tab, another window, the app in the background) the reply
 *  is unread: the sidebar shows the blue dot until you open the thread (mockup app.js:131, 597). */
export function turnEnded(id: string) {
  const th = thread(id); if (!th || th.status !== 'idle') return;
  if (document.hasFocus() && currentTab().thread === id) return;
  update(() => { th.status = 'unread'; });
  void api.threads.update(id, { status: 'unread' });
}
/** The thread is in front of you: a blue dot clears. */
export function markRead(id: string) {
  const th = thread(id); if (!th || th.status !== 'unread') return;
  update(() => { th.status = 'idle'; });
  void api.threads.update(id, { status: 'idle' });
}

/** When a thread was last opened (the sidebar, the palette): it opens ready to type, so a chat coming back into focus
 *  then does not put back a reading cursor it had. */
let opened = 0;
export const justOpened = (ms = 600) => Date.now() - opened < ms;
export function openThread(id: string, o: { split?: boolean; view?: ViewKind } = {}) {
  const th = thread(id); if (!th) return;
  opened = Date.now();
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

/** Open a file (path relative to dir, forward slashes): an open tab for it is reused, else it opens where
 *  views/tools/open says (`split`: in a new split). The file view keeps back / forward history. */
export function openFile(machine: string, dir: string, path: string, o: { split?: boolean } = {}) { openFileTab({ machine, dir }, path, o); }

/** Start a thread from a launcher tab: the tab becomes the thread. */
export async function startThread(t: Tab, harness: 'claude' | 'codex', view: ViewKind): Promise<ThreadMeta> {
  const th = await api.threads.create({ harness, machine: t.machine || 'local', dir: t.dir || '~', model: t.model?.includes(':') ? t.model.split(':')[1] || undefined : t.model, effort: t.effort, perm: t.perm, worktree: t.worktree, view });
  update(s => {
    if (!s.threads.some(x => x.id === th.id)) s.threads = [th, ...s.threads];
    Object.assign(t, { kind: 'thread', thread: th.id, view });
    s.sideCursor = th.id;
  });
  save();
  return th;
}

/** /clear (Claude Code) and /new (Codex): a fresh conversation as a new thread with this one's harness, folder and
 *  settings, in this one's tab. The old thread stays in the sidebar. */
export async function freshThread(from: ThreadMeta): Promise<void> {
  const th = await api.threads.create({ harness: from.harness, machine: from.machine, dir: from.dir, model: from.model, effort: from.effort, perm: from.perm, view: 'chat' });
  update(s => { if (!s.threads.some(x => x.id === th.id)) s.threads = [th, ...s.threads]; });
  openThread(th.id, { view: 'chat' });
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
/** Grow or shrink the focused pane: across (row: ldr < >) or up and down (col: ldr + -). */
export function resizePane(delta: number, axis: 'row' | 'col' = 'row') {
  update(s => { const w = ws(); resizeTree(w.tree, w.focus, axis, delta); s.tick++; }); save();
}
// ---------- popups ----------
// Rule 15: opening a popup remembers where the keyboard was in the pane (a tab's `place` hook: the reading cursor,
// or the composer's mode and position); closing it, or ctrl-o, puts it back; ctrl-i returns to where you were in
// the popup. Places live here, not in the saved layout.
const places = new Map<string, { from?: string; tab?: string; place?: unknown; own?: unknown }>();
let backTo: string | null = null;   // the popup ctrl-o left, for ctrl-i
const placeOf = (tabId: string) => { try { return tabPlace(tabId); } catch { return undefined; } };
function restoreLater(tabId: string | undefined, place: unknown) {
  if (!tabId || place === undefined) return;
  requestAnimationFrame(() => requestAnimationFrame(() => tabRestore(tabId, place)));
}
/** Note where the keyboard is before a popup takes it (every way a popup opens calls this). */
export function notePlace(popupTab: string) {
  const w = ws(), t = w.pf ? w.pops.find(x => x.tab.id === w.pf)?.tab : activeTab(focusedPane(w));
  places.set(popupTab, { from: w.focus, tab: t?.id, place: t ? placeOf(t.id) : undefined });
}

export function popOut(tabId?: string) {
  update(s => {
    const w = ws(), p = focusedPane(w), t = tabId ? p.tabs.find(x => x.id === tabId) : activeTab(p);
    if (!t) return;
    const i = p.tabs.indexOf(t);
    p.tabs = p.tabs.filter(x => x.id !== t.id);
    // the tab before it becomes active (the mockup's tabClose with alt)
    if (!p.tabs.length) closePane(p); else if (p.active === t.id) p.active = p.tabs[Math.max(0, i - 1)].id;
    places.set(t.id, { from: w.focus, tab: activeTab(focusedPane(w)).id, place: placeOf(activeTab(focusedPane(w)).id) });
    w.pops.push({ tab: t, from: w.focus }); w.pf = t.id; s.tick++;
  });
  save();
}
/** Close a popup (inside an update). Focused, the keys go back to where they were before it opened. */
export function closePopup(id: string) {
  const w = ws(), p = w.pops.find(x => x.tab.id === id), pl = places.get(id);
  w.pops = w.pops.filter(x => x.tab.id !== id);
  places.delete(id); if (backTo === id) backTo = null;
  if (w.pf === id) {
    w.pf = null;
    if (p?.from && findPane(w.tree, p.from)) w.focus = p.from;
    restoreLater(pl?.tab, pl?.place);
  }
}
/** esc with nothing left to step out of in a popup closes it (rule 2), as its x does. */
export function closeFocusedPopup(): boolean {
  const w = ws(); if (!w.pf) return false;
  const id = w.pf;
  update(s => { closePopup(id); s.tick++; });
  save();
  return true;
}
/** ctrl-o from a popup: back to the pane it came from (the popup stays), at the place you left there. */
/** ctrl-o / ctrl-i only act when there is somewhere to go; otherwise the key goes on (mockup keys.js 296-301). */
export const canPopBack = () => { const w = ws(); return !!w.pf && w.pops.some(x => x.tab.id === w.pf); };
export const canPopForward = () => { const w = ws(); return !w.pf && !!backTo && w.pops.some(x => x.tab.id === backTo); };
export function popBack(): boolean {
  const w = ws(), p = w.pf ? w.pops.find(x => x.tab.id === w.pf) : null; if (!p) return false;
  const pl = places.get(p.tab.id) || {};
  pl.own = placeOf(p.tab.id); places.set(p.tab.id, pl);
  backTo = p.tab.id;
  update(s => { w.pf = null; if (p.from && findPane(w.tree, p.from)) w.focus = p.from; s.sideFocus = false; s.tick++; });
  restoreLater(pl.tab, pl.place);
  return true;
}
/** ctrl-i: forward to the popup ctrl-o left, at its own place. */
export function popForward(): boolean {
  const w = ws(), p = backTo ? w.pops.find(x => x.tab.id === backTo) : null; if (!p || w.pf) return false;
  const pl = places.get(p.tab.id) || {};
  const t = activeTab(focusedPane(w));
  pl.tab = t.id; pl.from = w.focus; pl.place = placeOf(t.id); places.set(p.tab.id, pl);
  backTo = null;
  update(s => { w.pf = p.tab.id; s.sideFocus = false; s.tick++; });
  restoreLater(p.tab.id, pl.own);
  return true;
}
/** ldr o: each popup in turn, then back to the panes. */
export function popNext() {
  const w = ws(); if (!w.pops.length) return;
  const i = w.pops.findIndex(x => x.tab.id === w.pf), nx = w.pops[i + 1];
  if (nx && !places.has(nx.tab.id)) notePlace(nx.tab.id);
  update(s => { w.pf = nx ? nx.tab.id : null; s.sideFocus = false; s.tick++; });
  if (!nx && i >= 0) { const pl = places.get(w.pops[i].tab.id); restoreLater(pl?.tab, pl?.place); }
}
/** Put a popup back as a tab in the focused pane (alt + its x, or ldr d for the focused one). */
export function dock(id?: string | null) {
  id ??= ws().pf; if (!id) return;
  update(s => {
    const w = ws(), p = w.pops.find(x => x.tab.id === id); if (!p) return;
    places.delete(id);   // docked, the keys stay with the tab: no place to put back
    closePopup(id);
    const f = focusedPane(w);
    if (f.tabs.length === 1 && f.tabs[0].kind === 'new') f.tabs = [];   // the launcher popping out left behind
    addTab(f, p.tab); w.pf = null; s.tick++;
  });
  save();
}

// ---------- workspaces ----------
export function newWorkspace(name: string, machine: string, dir: string) {
  update(s => { const w = blankWs(machine, dir); w.name = name; s.workspaces.push(w); s.wid = w.id; s.sideFocus = false; s.sideCursor = null; s.tick++; });
  save();
}
/** Switch workspace (mockup WS.go): no field keeps the caret, so it comes up in NORMAL. */
export function switchWorkspace(id: string) {
  (document.activeElement as HTMLElement | null)?.blur?.();
  update(s => { const w = s.workspaces.find(x => x.id === id); if (w) { w.usedAt = Date.now(); s.wid = id; s.sideFocus = false; s.sideCursor = null; s.tick++; } });
  save();
}
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
    void api.app.save('ui', { workspaces: S.workspaces, wid: S.wid, sideOpen: S.sideOpen, collapsed: S.collapsed, projects: S.projects, names: S.names, dirOrder: S.dirOrder });
  }, 400);
}

export function notImplemented(what: string) { toast(`${what} is not built yet`); }

// ---------- archiving ----------
/** Archive a thread (or bring it back). Archiving closes every tab and popup showing it, its side chats and its
 *  subagents, in every workspace; the toast's Undo brings the thread and those tabs back where they were. */
export function archiveThread(id: string, archived = true) {
  void api.threads.update(id, { archived });
  if (!archived) return;
  const mine = (t: Tab) => (t.kind === 'thread' || t.kind === 'sub') && !!t.thread && (t.thread === id || thread(t.thread)?.parent?.id === id);
  const shut: { w: Workspace; pane: string; at: number; tab: Tab; active: boolean; pop?: Popup }[] = [];
  update(s => {
    for (const w of S.workspaces) {
      for (const pop of w.pops.filter(x => mine(x.tab))) { shut.push({ w, pane: '', at: 0, tab: pop.tab, active: false, pop }); if (w === ws()) closePopup(pop.tab.id); else w.pops = w.pops.filter(x => x !== pop); }
      for (const p of leaves(w.tree)) {
        for (const t of p.tabs.filter(mine)) {
          const i = p.tabs.indexOf(t);
          shut.push({ w, pane: p.id, at: i, tab: t, active: p.active === t.id });
          p.tabs.splice(i, 1);
          if (p.active === t.id && p.tabs.length) p.active = p.tabs[Math.max(0, i - 1)].id;
        }
        if (p.tabs.length) continue;
        // the pane showed only this thread: it goes, unless it is the last one, which keeps a new-thread tab
        const r = removePane(w.tree, p.id);
        if (r) { w.tree = r.root; if (w.focus === p.id) w.focus = r.focus; }
        else { const t = shut[shut.length - 1].tab, l = launcherFor(t); p.tabs.push(l); p.active = l.id; }
      }
      if (leaves(w.tree).length === 1) w.zoom = false;
    }
    s.tick++;
  });
  save();
  const name = thread(id)?.title || 'Thread';
  toast(`Archived ${name}`, { icon: 'archive', action: { label: 'Undo', run: () => {
    void api.threads.update(id, { archived: false });
    update(s => {
      for (const x of shut) {
        if (x.pop) { if (!x.w.pops.some(p => p.tab.id === x.tab.id)) x.w.pops.push(x.pop); continue; }
        const p = findPane(x.w.tree, x.pane) || focusedPane(x.w);
        if (p.tabs.some(t => t.id === x.tab.id)) continue;
        p.tabs.splice(Math.min(x.at, p.tabs.length), 0, x.tab);
        if (x.active) { p.active = x.tab.id; if (x.w === ws()) x.w.focus = p.id; }
      }
      s.tick++;
    });
    save();
  } } }, 6000);
}
