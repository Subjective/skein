// Chat state: each thread's events (loaded once, then kept fresh by 'chat' pushes) and each tab's
// composer (draft, images, quotes, the message being edited). Components read through useChat().
import { useSyncExternalStore } from 'react';
import type { ThreadEvent } from '@shared/types';
import { api } from '../../api';

interface Log { events: ThreadEvent[]; loaded: boolean; loading?: Promise<void>; answered: Set<string> }
const logs = new Map<string, Log>();
let version = 0;
const subs = new Set<() => void>();
export function bump() { version++; for (const f of subs) f(); }
const subscribe = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
/** Re-render on any chat change. */
export function useChat() { useSyncExternalStore(subscribe, () => version); }

export function log(thread: string): Log {
  let l = logs.get(thread);
  if (!l) { l = { events: [], loaded: false, answered: new Set() }; logs.set(thread, l); }
  if (!l.loaded && !l.loading) {
    const ll = l;
    ll.loading = api.threads.history(thread).then(evs => {
      // pushes that arrived while loading win over the snapshot
      const seen = new Set(ll.events.map(e => e.id));
      ll.events = [...evs.filter(e => !seen.has(e.id)), ...ll.events];
    }).catch(() => {}).finally(() => { ll.loaded = true; ll.loading = undefined; bump(); });
  }
  return l;
}

/** Apply a pushed event: replace the one with the same id, else append. */
export function apply(thread: string, e: ThreadEvent) {
  const l = logs.get(thread);
  if (!l) return;
  const i = l.events.findIndex(x => x.id === e.id);
  if (i >= 0) l.events = l.events.map((x, j) => (j === i ? e : x));
  else l.events = [...l.events, e];
  bump();
}

/** Cut the thread back to just before an event (edit and resend). */
export function rewindTo(thread: string, eventId: string) {
  const l = logs.get(thread); if (!l) return;
  const i = l.events.findIndex(x => x.id === eventId);
  if (i >= 0) { l.events = l.events.slice(0, i); bump(); }
}

/** Approvals still waiting, oldest first (G7). Answered ones hide at once, before the harness confirms. */
export function pending(thread: string) {
  const l = log(thread);
  return l.events.filter((e): e is Extract<ThreadEvent, { t: 'approval' }> => e.t === 'approval' && !l.answered.has(e.request.requestId));
}
export function answer(thread: string, requestId: string, optionId: string) {
  const l = log(thread);
  l.answered.add(requestId); bump();
  void api.chat.answer(thread, requestId, optionId).catch(() => { l.answered.delete(requestId); bump(); });
}

let started = false;
/** Listen for chat pushes once. */
export function startChat() {
  if (started) return; started = true;
  api.on(e => { if (e.type === 'chat') apply(e.thread, e.event); });
}

// ---------- composers ----------
export interface Quote { id: string; text: string; src: string }
export interface Draft { text: string; images: string[]; quotes: Quote[] }
export const blank = (): Draft => ({ text: '', images: [], quotes: [] });

/** A tab's composer draft, and the box that edits one of its messages (G8). */
export interface TabChat { draft: Draft; edit?: { event: string; draft: Draft } }
const tabs = new Map<string, TabChat>();
export function tabChat(tabId: string): TabChat {
  let t = tabs.get(tabId);
  if (!t) { t = { draft: loadDraft(tabId) }; tabs.set(tabId, t); }
  return t;
}

// Drafts survive a relaunch (G12). Text only: images and quotes point at things that may be gone.
const KEY = 'skein.drafts';
let saved: Record<string, string> = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
function loadDraft(tabId: string): Draft { return { ...blank(), text: saved[tabId] || '' }; }
let timer: ReturnType<typeof setTimeout> | null = null;
export function saveDraft(tabId: string, text: string) {
  if (text) saved[tabId] = text; else delete saved[tabId];
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* full or blocked: drafts just don't persist */ } }, 300);
}

// ---------- quotes ----------
// A quote lives in the draft's text as one item between invisible marks (U+2063), so it can sit
// anywhere among the words; the composer paints it as a chip. On send it becomes the full quoted text.
export const TK = '⁣';
export const TOK = /⁣[^⁣]*⁣/g;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const tokenOf = (q: Quote) => `${TK}“${clip(q.text, 40)}”${TK}`;
/** The text the harness receives: each chip becomes its whole quote. */
export function outgoing(d: Draft): string {
  let i = 0;
  return d.text.replace(TOK, () => { const q = d.quotes[i++]; return q ? `“${q.text}”` : ''; }).trim();
}
/** Keep quotes in step with the chips still in the text (one was deleted, or the text was replaced). */
export function syncQuotes(d: Draft): Quote[] {
  const pool = [...d.quotes];
  return (d.text.match(TOK) || []).map(m => { const i = pool.findIndex(q => tokenOf(q) === m); return i < 0 ? null : pool.splice(i, 1)[0]; }).filter((q): q is Quote => !!q);
}
export const plain = (s: string) => s.replace(new RegExp(TK, 'g'), '');
