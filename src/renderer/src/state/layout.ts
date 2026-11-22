// The pane tree of a workspace: tmux-style nested splits whose leaves are panes, every pane a tab group.
// Pure functions over plain objects, so layouts persist as JSON and are tested without a DOM.
import type { ViewKind } from '@shared/types';

export type TabKind = 'thread' | 'shell' | 'new' | 'changes' | 'files' | 'file' | 'vimrc' | 'browser' | 'sub';

export interface Tab {
  id: string;
  kind: TabKind;
  /** thread tabs (and tools scoped to a thread) */
  thread?: string;
  view?: ViewKind;
  /** subagent tabs: the id of the thread's 'sub' event (the thread is `thread`) */
  sub?: string;
  /** shells, new-thread launchers and tools: where they run */
  machine?: string;
  dir?: string;
  /** file tabs */
  path?: string;
  /** browser tabs: the address as the user means it (a remote thread's localhost stays localhost) and the page's title */
  url?: string;
  title?: string;
  /** new-thread launcher choices */
  model?: string;
  effort?: string;
  perm?: string;
  worktree?: boolean;
  /** A launcher made by a split opens in NORMAL (B10), so | then \\ splits twice instead of typing. */
  startNormal?: boolean;
  /** Where the tab last floated as a popup (in #work), so popping it out again puts it back there. */
  pop?: { x: number; y: number; w: number; h: number };
}

export interface Pane { type: 'pane'; id: string; tabs: Tab[]; active: string }
export interface Split { type: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: Node; b: Node }
export type Node = Pane | Split;

export interface Popup { tab: Tab; x?: number; y?: number; w?: number; h?: number; from?: string }

export interface Workspace {
  id: string;
  name: string;
  machine: string;
  dir: string;
  tree: Node;
  focus: string;
  zoom: boolean;
  pops: Popup[];
  /** id of the focused popup, if a popup has the keys */
  pf?: string | null;
  usedAt: number;
}

let uid = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(++uid).toString(36)}`;
export const mkTab = (kind: TabKind, x: Partial<Tab> = {}): Tab => ({ id: newId('t'), kind, ...x });
export const mkPane = (...tabs: Tab[]): Pane => ({ type: 'pane', id: newId('p'), tabs, active: tabs[0].id });
export const mkSplit = (dir: 'row' | 'col', a: Node, b: Node, ratio = 0.5): Split => ({ type: 'split', id: newId('x'), dir, ratio, a, b });

export function leaves(n: Node, out: Pane[] = []): Pane[] {
  if (n.type === 'pane') out.push(n); else { leaves(n.a, out); leaves(n.b, out); }
  return out;
}
export const findPane = (n: Node, id: string) => leaves(n).find(p => p.id === id);
export const activeTab = (p: Pane) => p.tabs.find(t => t.id === p.active) || p.tabs[0];

export function replace(n: Node, id: string, fn: (old: Node) => Node): Node {
  if (n.id === id) return fn(n);
  if (n.type === 'split') { n.a = replace(n.a, id, fn); n.b = replace(n.b, id, fn); }
  return n;
}

/** Split pane `id`, putting `node` after it (right / below), or before it. */
export const splitAt = (root: Node, id: string, dir: 'row' | 'col', node: Node, before = false): Node =>
  replace(root, id, old => mkSplit(dir, before ? node : old, before ? old : node));

/** Remove a pane; its sibling takes the space. Returns the new root and the pane that should get focus. */
export function removePane(root: Node, id: string): { root: Node; focus: string } | null {
  if (root.type === 'pane') return null;
  const path = pathTo(root, id);
  if (!path) return null;
  const last = path[path.length - 1];
  const sib = last.side === 'a' ? last.s.b : last.s.a;
  const rm = (n: Node): Node => {
    if (n.type !== 'split') return n;
    if (n.a.id === id) return n.b;
    if (n.b.id === id) return n.a;
    n.a = rm(n.a); n.b = rm(n.b); return n;
  };
  return { root: rm(root), focus: leaves(sib)[0].id };
}

export function pathTo(n: Node, id: string, acc: { s: Split; side: 'a' | 'b' }[] = []): { s: Split; side: 'a' | 'b' }[] | null {
  if (n.type === 'pane') return n.id === id ? acc : null;
  return pathTo(n.a, id, [...acc, { s: n, side: 'a' }]) || pathTo(n.b, id, [...acc, { s: n, side: 'b' }]);
}

/** Grow or shrink the focused pane along an axis (leader < >). */
export function resize(root: Node, id: string, axis: 'row' | 'col', delta: number) {
  const hit = [...(pathTo(root, id) || [])].reverse().find(x => x.s.dir === axis);
  if (!hit) return;
  hit.s.ratio = Math.min(0.85, Math.max(0.15, hit.s.ratio + (hit.side === 'a' ? delta : -delta)));
}

/** Swap two panes' contents in place (ids travel with contents, so focus follows the moved pane). */
export function swap(a: Pane, b: Pane) {
  const ta = { ...a }, tb = { ...b };
  Object.assign(a, tb); Object.assign(b, ta);
}

export interface Rect { left: number; top: number; right: number; bottom: number }
/** The nearest pane in a direction, by on-screen rectangles (what the eye calls "left of"). */
export function neighbour(rects: Map<string, Rect>, from: string, d: 'h' | 'j' | 'k' | 'l'): string | null {
  const a = rects.get(from); if (!a) return null;
  const cx = (a.left + a.right) / 2, cy = (a.top + a.bottom) / 2;
  let best: string | null = null, bd = Infinity;
  for (const [id, b] of rects) {
    if (id === from) continue;
    const ok = d === 'h' ? b.right <= a.left + 2 : d === 'l' ? b.left >= a.right - 2 : d === 'k' ? b.bottom <= a.top + 2 : b.top >= a.bottom - 2;
    if (!ok) continue;
    const dist = 'hl'.includes(d)
      ? Math.abs(d === 'h' ? a.left - b.right : b.left - a.right) * 4 + Math.abs(Math.max(b.top, Math.min(cy, b.bottom)) - cy)
      : Math.abs(d === 'k' ? a.top - b.bottom : b.top - a.bottom) * 4 + Math.abs(Math.max(b.left, Math.min(cx, b.right)) - cx);
    if (dist < bd) { bd = dist; best = id; }
  }
  return best;
}

/** Tabs that show a folder's files or tools. A pane showing one of these is where more files open. */
const DOC_KINDS = new Set<TabKind>(['file', 'files', 'changes', 'browser', 'vimrc']);
export const showsDocs = (p: Pane) => DOC_KINDS.has(activeTab(p).kind);

/** Where a file or tool opens from pane `src` (VS Code's rule, Josh 2026-11-21): a pane that shows files or tools
 *  takes it as a tab. From a thread or a shell it goes beside: to a pane that shows files or tools (the one to the
 *  right first), else to the pane to the right, else to a new split (`'split'`). Splitting on purpose is the
 *  caller's: shift-enter (or O, or a modifier click) in ctrl-p, Files and Changes. */
export function placeFor(tree: Node, src: Pane, right: Pane | null): Pane | 'split' {
  if (showsDocs(src)) return src;
  if (right && showsDocs(right)) return right;
  return leaves(tree).find(p => p !== src && showsDocs(p)) || right || 'split';
}

/** Every tab in the workspace, with its pane (null for a popup). */
export function allTabs(w: Workspace): { tab: Tab; pane: Pane | null }[] {
  return [...leaves(w.tree).flatMap(p => p.tabs.map(tab => ({ tab, pane: p as Pane | null }))), ...w.pops.map(p => ({ tab: p.tab, pane: null }))];
}
