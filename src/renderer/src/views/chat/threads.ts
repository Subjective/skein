// Side chats, forks, subagent popups and quotes: everything the chat view opens or sends elsewhere.
import { createElement } from 'react';
import type { ThreadEvent, ThreadMeta } from '@shared/types';
import { api } from '../../api';
import { activeTab, allTabs, mkTab, type Pane, type Tab } from '../../state/layout';
import { S, subscribe, thread, toast, update, ws } from '../../state/store';
import * as A from '../../state/actions';
import { openMenu } from '../../shell/overlays';
import { Icon, Spinner } from '../../ui/primitives';
import type { ComposerHandle } from './Composer';
import type { Reader } from './reader';
import { bump, offsetsIn, saveDraft, syncQuotes, tabChat, tokenOf, type Quote } from './state';
import { termOf } from '../terminal/TerminalView';

// ---- chat tabs on screen, so quotes can find their composer ----
interface Live { thread: string; draft: string; composer: { current: ComposerHandle | null }; reader: () => Reader; /** Leader `[`: into the reader where its cursor was left, scrolled to (the end the first time). */ enter?: () => boolean }
const live = new Map<string, Live>();
export function registerChatTab(tabId: string, l: Live) { live.set(tabId, l); return () => { if (live.get(tabId) === l) live.delete(tabId); }; }
export const liveTab = (tabId: string) => live.get(tabId);

// ---- the thread a quote from a file or tool goes to ----
/** Thread tabs, the most recently focused first. */
const recent: string[] = [];
subscribe(() => {
  const t = A.currentTab();
  if (t.kind === 'thread' && recent[0] !== t.id) { const i = recent.indexOf(t.id); if (i >= 0) recent.splice(i, 1); recent.unshift(t.id); if (recent.length > 50) recent.pop(); }
});
/** Where a quote from a tab with no thread of its own goes: a thread on screen (the last focused one), else the
 *  last focused thread in this workspace. */
export function quoteTarget(): Tab | undefined {
  const w = ws();
  const rank = (t: Tab) => { const i = recent.indexOf(t.id); return i < 0 ? recent.length : i; };
  const shown = (x: { tab: Tab; pane: Pane | null }) => !x.pane || activeTab(x.pane).id === x.tab.id;
  const ts = allTabs(w).filter(x => x.tab.kind === 'thread' && x.tab.thread);
  const pick = (xs: typeof ts) => xs.sort((a, b) => rank(a.tab) - rank(b.tab))[0]?.tab;
  return pick(ts.filter(shown)) || pick(ts);
}

/** Show a tab as a popup (or focus it if it is already open somewhere). */
export function popTab(match: (t: Tab) => boolean, make: () => Tab) {
  const w = ws();
  const hit = allTabs(w).find(x => match(x.tab));
  if (hit) {
    const pop = w.pops.find(p => p.tab.id === hit.tab.id);
    if (pop) update(s => { w.pf = pop.tab.id; s.sideFocus = false; s.tick++; });
    else A.activate(hit.pane!.id, hit.tab.id);
    return hit.tab;
  }
  const tab = make();
  A.notePlace(tab.id);   // rule 15: where the keyboard was, for when the popup closes
  update(s => { w.pops.push({ tab, from: w.focus }); w.pf = tab.id; s.sideFocus = false; s.tick++; });
  A.save();
  return tab;
}

const addThread = (t: ThreadMeta) => update(s => { if (!s.threads.some(x => x.id === t.id)) s.threads = [t, ...s.threads]; });

/** A side chat about the reply `at`: a real fork, kept with its thread (G8). */
export async function newSide(th: ThreadMeta, at?: string, title?: string): Promise<string> {
  const sc = await api.threads.create({ harness: th.harness, machine: th.machine, dir: th.dir, model: th.model, effort: th.effort, perm: th.perm, view: 'chat', side: true, parent: { id: th.id, at } });
  const named = title ? await api.threads.update(sc.id, { title }) : sc;
  addThread({ ...named, side: true, parent: named.parent || { id: th.id, at } });
  return sc.id;
}
export function openSide(id: string) {
  popTab(t => t.kind === 'thread' && t.thread === id, () => mkTab('thread', { thread: id, view: 'chat' }));
}

/** Fork into a new thread from that reply, opened as a tab. */
export async function forkAt(th: ThreadMeta, at: string) {
  const f = await api.threads.create({ harness: th.harness, machine: th.machine, dir: th.dir, model: th.model, effort: th.effort, perm: th.perm, view: 'chat', parent: { id: th.id, at } });
  addThread(f);
  A.openThread(f.id, { view: 'chat' });
  toast('Forked into a new thread', { icon: 'branch' });
}

/** /sidechats: this thread's side chats in the order they were made, and New side chat. r (or the row's pencil)
 *  renames one. From the composer the menu sits over it at its width; from a selection (Add to Side Chat) it drops
 *  below the selection, 290 wide (the mockup's chooseSide). */
export function chooseSide(th: ThreadMeta, anchor: DOMRect, at: string | undefined, then: (id: string) => void, title?: string, o: { fromSelection?: boolean } = {}) {
  const list = S.threads.filter(x => x.side && x.parent?.id === th.id).sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length && title) { void newSide(th, at, title).then(then); return; }
  const placement = o.fromSelection ? { anchor, place: 'bottom-start' as const, width: 290 } : { anchor, place: 'top-start' as const, width: 'anchor' as const };
  const rename = (id: string) => {
    const sc = thread(id); if (!sc) return;
    openMenu<string>({ ...placement, className: 'composer-menu', search: { prefix: 'Rename', placeholder: 'Side chat name', value: sc.title },
      items: q => [{ label: q.trim() || sc.title, icon: createElement(Icon, { name: 'chat' }), data: q.trim() }],
      onPick: (_, q) => { if (q.trim()) void api.threads.update(sc.id, { title: q.trim() }); } });
    // the old name selected, so typing replaces it
    requestAnimationFrame(() => { const i = document.querySelector<HTMLInputElement>('.menu:last-of-type .m-s input'); i?.select(); });
  };
  const close = openMenu<string>({
    ...placement, className: 'composer-menu', search: { placeholder: 'Search side chats' }, empty: 'No matching side chats',
    items: [{ label: 'New side chat', icon: createElement(Icon, { name: 'plus' }), data: '' }, ...list.map(x => ({
      label: x.title, icon: createElement(Icon, { name: 'chat' }), data: x.id,
      right: createElement('span', { className: 'wact' }, createElement('button', {
        type: 'button', title: 'Rename side chat', 'aria-label': 'Rename side chat',
        onMouseDown: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); close(); rename(x.id); },
      }, createElement(Icon, { name: 'pencil' }))),
    }))],
    keys: (k, it) => {
      if (k !== 'r' || !it?.data) return false;
      close(); rename(it.data);
      return true;
    },
    onPick: it => (it.data ? then(it.data) : void newSide(th, at, title).then(then)),
  });
}

type Sub = Extract<ThreadEvent, { t: 'sub' }>;
/** A subagent's transcript as a popup, ready to type to it. */
export function openSub(th: ThreadMeta, sub: string) {
  popTab(t => t.kind === 'sub' && t.sub === sub, () => mkTab('sub', { thread: th.id, sub }));
}
/** /subagents: running first, then finished. */
export function subList(th: ThreadMeta, events: ThreadEvent[], anchor: DOMRect) {
  const gs = events.filter((e): e is Sub => e.t === 'sub');
  const item = (g: Sub) => ({ label: g.name, hint: g.task, icon: createElement(Icon, { name: 'agent' }), right: g.status === 'running' ? createElement(Spinner) : g.dur ? createElement('span', { className: 'age' }, g.dur) : undefined, data: g.id });
  openMenu<string>({
    anchor, place: 'top-start', width: 'anchor', className: 'composer-menu', search: { placeholder: 'Search subagents' },
    empty: gs.length ? 'No matching subagents' : 'No subagents in this thread',
    items: [{ head: true, label: 'Active' }, ...gs.filter(g => g.status === 'running').map(item), { head: true, label: 'Finished' }, ...gs.filter(g => g.status !== 'running').map(item)],
    onPick: it => it.data && openSub(th, it.data),
  });
}

/** Put a quote into a chat tab's composer at its caret, then type after it. */
export function quoteToTab(tabId: string, q: Quote) {
  const l = live.get(tabId), c = tabChat(l?.draft || tabId);
  const box = c.edit ? c.edit.draft : c.draft;
  const d = box.text, p = Math.min(l?.composer.current?.caret() ?? d.length, d.length), pre = d.slice(0, p), lead = pre && !/\s$/.test(pre) ? ' ' : '';
  const ins = lead + tokenOf(q) + ' ';
  box.text = pre + ins + d.slice(p);
  box.quotes = syncQuotes({ ...box, quotes: [...box.quotes, q] });   // in text order: the n-th chip is the n-th quote
  if (!c.edit && l) saveDraft(l.draft, box.text, box.quotes);
  bump();
  requestAnimationFrame(() => {
    const f = live.get(tabId)?.composer.current?.field(); if (!f) return;
    f.set(box.text, (pre + ins).length); f.focus(true);
  });
}
/** The chat tab of a thread: the one on screen, or a new tab in the focused pane. */
export function quoteInto(threadId: string, q: Quote) {
  const w = ws();
  let hit = allTabs(w).find(x => x.tab.kind === 'thread' && x.tab.thread === threadId);
  if (!hit) { A.openThread(threadId, { view: 'chat' }); hit = allTabs(w).find(x => x.tab.kind === 'thread' && x.tab.thread === threadId); }
  if (!hit) return;
  const tab = hit.tab;
  // a thread shown as its terminal takes the words as text at the TUI's prompt (it has no quote chips)
  const term = tab.view === 'term' ? termOf(tab.id) : undefined;
  if (term) {
    if (hit.pane) A.activate(hit.pane.id, tab.id); else update(s => { w.pf = tab.id; s.tick++; });
    term.term.paste(`"${q.text}" `); term.term.focus();
    return;
  }
  if (tab.view !== 'chat') A.setView(tab, 'chat');
  if (hit.pane) A.activate(hit.pane.id, tab.id); else update(s => { w.pf = tab.id; s.tick++; });
  requestAnimationFrame(() => quoteToTab(tab.id, q));
}

/** mod-l / mod-shift-s: quote the selection (mouse or reader VISUAL) into the chat, or into a side chat. */
export function quoteSelection(side: boolean): boolean {
  const s = getSelection(); if (!s || s.isCollapsed || !s.rangeCount) return false;
  const r = s.getRangeAt(0), start = r.startContainer.nodeType === 1 ? r.startContainer as Element : r.startContainer.parentElement;
  const src = start?.closest<HTMLElement>('[data-src]'), host = start?.closest<HTMLElement>('[data-tab]');
  const text = s.toString().replace(/\s+/g, ' ').trim();
  if (!text || !host) return false;
  const key = src?.dataset.src || '';
  const tabId = host.dataset.tab!;
  const lt = live.get(tabId);
  const threadId = lt?.thread || allTabs(ws()).find(x => x.tab.id === tabId)?.tab.thread || quoteTarget()?.thread;
  lt?.reader().clear(); s.removeAllRanges();
  const q: Quote = { id: 'q' + Date.now(), text, src: key, ...(src && src.contains(r.endContainer) ? offsetsIn(src, r) : {}) };
  if (!side) {
    if (lt) quoteToTab(tabId, q);
    else if (threadId) quoteInto(threadId, q);
    else { toast('Open a thread first'); return true; }
    return true;
  }
  const th = thread(threadId); if (!th) { toast('Open a thread first'); return true; }
  const main = th.side && th.parent ? thread(th.parent.id) || th : th;
  const at = /^ev:[^:]+:(.+)$/.exec(key)?.[1];
  const rect = r.getBoundingClientRect();
  chooseSide(main, rect, at, id => { openSide(id); requestAnimationFrame(() => { const t = allTabs(ws()).find(x => x.tab.thread === id); if (t) quoteToTab(t.tab.id, q); }); }, text.length > 28 ? text.slice(0, 27) + '…' : text, { fromSelection: true });
  return true;
}
