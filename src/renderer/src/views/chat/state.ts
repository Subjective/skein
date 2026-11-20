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
/** A quoted selection: its text, and where it came from (the data-src element, and the offsets inside it). */
export interface Quote { id: string; text: string; src: string; start?: number; len?: number }
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

// Drafts survive a relaunch (G12): the text and its quotes (so a chip still sends its words); not images.
const KEY = 'skein.drafts';
let saved: Record<string, string | { text: string; quotes: Quote[] }> = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
function loadDraft(tabId: string): Draft {
  const v = saved[tabId];
  return typeof v === 'object' && v ? { ...blank(), text: v.text, quotes: v.quotes || [] } : { ...blank(), text: v || '' };
}
let timer: ReturnType<typeof setTimeout> | null = null;
export function saveDraft(tabId: string, text: string, quotes: Quote[] = []) {
  if (text) saved[tabId] = quotes.length ? { text, quotes } : text; else delete saved[tabId];
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
/** The text the harness receives: each chip becomes its whole quote (a chip with no quote, its own words). */
export function outgoing(d: Draft): string {
  const pool = [...d.quotes];
  return d.text.replace(TOK, m => { const i = pool.findIndex(q => tokenOf(q) === m); return i >= 0 ? `“${pool.splice(i, 1)[0].text}”` : m.replace(new RegExp(TK, 'g'), ''); }).trim();
}
/** Keep quotes in step with the chips in the text, in text order: one was deleted, the text was replaced, or a
 *  chip was yanked and put again (the copy points at the same place). */
export function syncQuotes(d: Draft): Quote[] {
  const pool = [...d.quotes];
  return (d.text.match(TOK) || []).map(m => {
    const i = pool.findIndex(q => tokenOf(q) === m);
    if (i >= 0) return pool.splice(i, 1)[0];
    const twin = d.quotes.find(q => tokenOf(q) === m);
    return twin ? { ...twin, id: twin.id + '+' + Math.random().toString(36).slice(2, 6) } : null;
  }).filter((q): q is Quote => !!q);
}
export const plain = (s: string) => s.replace(new RegExp(TK, 'g'), '');

// ---------- where quotes point ----------
// Every quote waiting in a composer lights up its source text where that is on screen (CSS highlight 'note');
// the one under the pointer, or just jumped to, is brighter ('note-hot'). As the mockup's Annot.paint.
const HL = typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights : null;
declare const Highlight: { new (...r: Range[]): { add(r: Range): void } };
const srcSel = (k: string) => `[data-src="${k.replace(/"/g, '\\"')}"]`;
/** The DOM range of [start, start + len) of an element's text. */
export function rangeIn(el: Element, start: number, len: number): Range | null {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), r = document.createRange(), end = start + len;
  let n: Node | null, pos = 0, open = false;
  while ((n = w.nextNode())) {
    const L = (n as Text).data.length;
    if (!open && start < pos + L) { r.setStart(n, start - pos); open = true; }
    if (open && end <= pos + L) { r.setEnd(n, end - pos); return r; }
    pos += L;
  }
  return null;
}
/** Where a range sits inside an element's text. */
export function offsetsIn(el: Element, range: Range): { start: number; len: number } {
  const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, len: Math.max(1, Math.min(range.toString().length, (el.textContent || '').length - start)) };
}
function* allQuotes(): Generator<Quote> { for (const t of tabs.values()) { yield* t.draft.quotes; if (t.edit) yield* t.edit.draft.quotes; } }
let hotQuote: string | null = null, flash: string | null = null;
export function paintQuotes() {
  if (!HL) return;
  const norm = new Highlight(), hot = new Highlight();
  for (const q of allQuotes()) {
    if (!q.src || q.start == null || q.len == null) continue;
    document.querySelectorAll(srcSel(q.src)).forEach(el => { const r = rangeIn(el, q.start!, q.len!); if (r) (q.id === hotQuote || q.id === flash ? hot : norm).add(r); });
  }
  HL.set('note', norm); HL.set('note-hot', hot);
}
/** The quote under the pointer (null when none). */
export function hoverQuote(id: string | null) { if (hotQuote !== id) { hotQuote = id; paintQuotes(); } }
/** Scroll a quote's source into view and flash it. false when it is not on screen. */
export function revealQuote(q: Quote): boolean {
  if (!q.src) return false;
  const el = document.querySelector(srcSel(q.src)); if (!el) return false;
  const r = q.start != null && q.len != null ? rangeIn(el, q.start, q.len) : null;
  ((r?.startContainer.parentElement) || el).scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash = q.id; paintQuotes();
  setTimeout(() => { if (flash === q.id) { flash = null; paintQuotes(); } }, 1400);
  return true;
}

// ---------- Ultracode ----------
// ThreadMeta has no field for it and the harnesses take no flag yet, so it is kept here, per thread (or per
// new-thread tab until it starts), for the session.
const ultras = new Map<string, boolean>();
export const ultraOf = (id: string) => !!ultras.get(id);
export function setUltra(id: string, on: boolean) { if (on) ultras.set(id, true); else ultras.delete(id); bump(); }
