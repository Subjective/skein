// Side chats, forks, subagent popups and quotes: everything the chat view opens or sends elsewhere.
import { createElement } from 'react';
import type { ThreadEvent, ThreadMeta } from '@shared/types';
import { api } from '../../api';
import { allTabs, mkTab, type Tab } from '../../state/layout';
import { S, thread, toast, update, ws } from '../../state/store';
import * as A from '../../state/actions';
import { openMenu } from '../../shell/overlays';
import { Icon, Spinner } from '../../ui/primitives';
import type { ComposerHandle } from './Composer';
import type { Reader } from './reader';
import { bump, tabChat, tokenOf, type Quote } from './state';

// ---- chat tabs on screen, so quotes can find their composer ----
interface Live { thread: string; draft: string; composer: { current: ComposerHandle | null }; reader: () => Reader }
const live = new Map<string, Live>();
export function registerChatTab(tabId: string, l: Live) { live.set(tabId, l); return () => { if (live.get(tabId) === l) live.delete(tabId); }; }
export const liveTab = (tabId: string) => live.get(tabId);

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

/** /sidechats: this thread's side chats, newest first, and New side chat. r renames the one under the cursor. */
export function chooseSide(th: ThreadMeta, anchor: DOMRect, at: string | undefined, then: (id: string) => void, title?: string) {
  const list = S.threads.filter(x => x.side && x.parent?.id === th.id).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length && title) { void newSide(th, at, title).then(then); return; }
  openMenu<string>({
    anchor, place: 'top-start', width: 'anchor', className: 'composer-menu', search: { placeholder: 'Search side chats' }, empty: 'No matching side chats',
    items: [{ label: 'New side chat', icon: createElement(Icon, { name: 'plus' }), data: '' }, ...list.map(x => ({ label: x.title, icon: createElement(Icon, { name: 'chat' }), data: x.id }))],
    keys: (k, it) => {
      if (k !== 'r' || !it?.data) return false;
      const sc = thread(it.data)!;
      openMenu<string>({ anchor, place: 'top-start', width: 'anchor', className: 'composer-menu', search: { prefix: 'Rename', placeholder: 'Side chat name', value: sc.title },
        items: q => [{ label: q.trim() || sc.title, icon: createElement(Icon, { name: 'chat' }), data: q.trim() }],
        onPick: (_, q) => { if (q.trim()) void api.threads.update(sc.id, { title: q.trim() }); } });
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
  box.quotes = [...box.quotes, q];
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
  const threadId = lt?.thread || allTabs(ws()).find(x => x.tab.id === tabId)?.tab.thread;
  lt?.reader().clear(); s.removeAllRanges();
  const q: Quote = { id: 'q' + Date.now(), text, src: key };
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
  chooseSide(main, rect, at, id => { openSide(id); requestAnimationFrame(() => { const t = allTabs(ws()).find(x => x.tab.thread === id); if (t) quoteToTab(t.tab.id, q); }); }, text.slice(0, 28));
  return true;
}
