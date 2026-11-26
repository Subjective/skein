// The chat view of a thread, a side chat (a thread forked at a reply) or a subagent (a 'sub' tab).
// Keys: the composer is a Vim field; k from its first line, or gg, reads the thread with the reader;
// y / n answer the oldest request from NORMAL anywhere in the tab (G7). Claude Code driven from its
// terminal shows a read-only mirror with Show terminal and Take back instead of the composer (G4).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Density, ThreadEvent, ThreadMeta } from '@shared/types';
import type { Surface } from '../../input/dispatcher';
import type { KeyLike } from '../../input/keys';
import { registerTab, tabSurface } from '../../input/surfaces';
import { api } from '../../api';
import { allTabs, type Tab } from '../../state/layout';
import { machine, S, thread, toast, update, useApp, ws } from '../../state/store';
import * as A from '../../state/actions';
import { Button, cx, Dot, Icon, Spinner } from '../../ui/primitives';
import { canBranch, harnessName, setSubNames } from '../../shell/meta';
import { dispatchKey } from '../../shell/keyboard';
import { openMenu, setSetting } from '../../shell/overlays';
import { clipImages, Composer, LockedComposer, type ComposerHandle } from './Composer';
import { onText, Reader, SEL_BLOCK, selectable } from './reader';
import { Ticks } from './Ticks';
import { fixError, Transcript, transcriptDeps, type TranscriptCtx } from './Transcript';
import { DENSITY, DENSITY_NAME } from './options';
import { answer as answerReq, blank, bump, log, outgoing, pending, rewindTo, saveDraft, sessionFor, startChat, tabChat, tokenOf, useChat, type Draft } from './state';
import { QueueTray, type QueueTrayHandle } from './QueueTray';
import { chooseSide, forkAt, newSide, openSide, openSub, quoteInto, quoteToTab, registerChatTab, subList } from './threads';
import { registerHooks } from '../tools/hooks';
import { SelBar } from './SelBar';
import { rawAt } from './markdown';
import { chatLink, OS_OPENS } from './links';
import { openFile as openFileAt, splitClick } from '../tools/open';
import { recentMouse } from '../../ui/VimField';
import './chat.css';

type Sub = Extract<ThreadEvent, { t: 'sub' }>;
setSubNames(t => { const e = t.thread ? log(t.thread).events.find(x => x.t === 'sub' && x.id === t.sub) : undefined; return e?.t === 'sub' ? e.name : 'Subagent'; });

export function ChatView({ t, focused }: { t: Tab; focused: boolean }) {
  useApp(); useChat(); startChat();
  const th = thread(t.thread);
  if (!th) return <div className="empty">This thread is gone.</div>;
  return <Chat key={th.id + (t.sub || '')} t={t} th={th} focused={focused} />;
}

function Chat({ t, th, focused }: { t: Tab; th: ThreadMeta; focused: boolean }) {
  useEffect(() => { if (focused && !t.sub) A.markRead(th.id); }, [focused, th.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const lg = log(th.id);
  const sub = t.kind === 'sub' ? lg.events.find((e): e is Sub => e.t === 'sub' && e.id === t.sub) : undefined;
  const subTurns = useSubTurns(th, sub);
  const events = t.kind === 'sub' ? subTurns.events : lg.events;
  // a subagent the harness takes no messages for gets a grayed-out composer that says so
  const locked = t.kind === 'sub' && !sub?.followUps;
  const key = t.kind === 'sub' ? `${th.id}:${t.sub}` : th.id;   // a thread's draft follows the thread, whichever tab shows it
  const tc = tabChat(key);
  const composer = useRef<ComposerHandle>(null);
  const editor = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const read = useRef<HTMLDivElement>(null);
  const running = t.kind === 'sub' ? sub?.status === 'running' : th.status === 'running';
  // read-only: Skein's own terminal drives it (G4), or the harness runs it in a terminal outside Skein (one writer per session)
  const outside = t.kind !== 'sub' && !!th.external && !(th.harness === 'claude' && th.drive === 'term');
  const mirror = t.kind !== 'sub' && ((th.harness === 'claude' && th.drive === 'term') || outside);
  const [taking, setTaking] = useState(false);
  // density: the setting, or this view's own after zr / zm (until the tab closes)
  const [dens, setDens] = useState<Density | null>(null);
  const density = dens ?? S.settings.density ?? 'compact';
  const densRef = useRef(density); densRef.current = density;
  // an image pasted anywhere in the focused tab (reader, nothing focused) lands in its composer (app.js paste → curTab)
  useEffect(() => {
    if (!focused || mirror) return;
    const paste = (e: ClipboardEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.('textarea, input, [contenteditable=true]')) return;   // a field takes its own paste
      const fs = clipImages(e.clipboardData); if (!fs.length) return;
      e.preventDefault();
      for (const f of fs) { const r = new FileReader(); r.onload = () => { const d = tc.edit ? tc.edit.draft : tc.draft; d.images = [...d.images, String(r.result)]; bump(); }; r.readAsDataURL(f); }
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [focused, mirror, tc]);
  // a mouse drag in the transcript stays inside the message it started in (a whole reply, or one of your bubbles),
  // live, as it moves (annot.js boundDrag); the reader's v / V use the same bound (SEL_BLOCK)
  useEffect(() => {
    let root: Element | null = null;
    const down = (e: MouseEvent) => { const el = e.target as Element; root = e.button === 0 && read.current?.contains(el) && !el.closest('input, textarea, [contenteditable=true]') ? read.current : null; };
    const up = () => { root = null; };
    const bound = () => {
      const s = getSelection(); if (!root || !s || s.isCollapsed || !s.anchorNode || !root.contains(s.anchorNode)) return;
      const an = s.anchorNode.nodeType === 1 ? s.anchorNode as Element : s.anchorNode.parentElement, block = an?.closest(SEL_BLOCK);
      if (!block || !s.focusNode || block.contains(s.focusNode)) return;
      const forward = !!(s.anchorNode.compareDocumentPosition(s.focusNode) & Node.DOCUMENT_POSITION_FOLLOWING);
      const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), texts: Text[] = []; let n: Node | null;
      while ((n = w.nextNode())) if ((n as Text).data.trim() && selectable(n)) texts.push(n as Text);
      const end = forward ? texts[texts.length - 1] : texts[0];
      if (end) s.extend(end, forward ? end.length : 0);
    };
    document.addEventListener('mousedown', down, true); document.addEventListener('mouseup', up, true); document.addEventListener('selectionchange', bound);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('mouseup', up, true); document.removeEventListener('selectionchange', bound); };
  }, []);
  // the terminal hands the thread back: say so (the mockup's hand → chat)
  const wasMirror = useRef(mirror);
  useEffect(() => { if (wasMirror.current && !mirror) toast('Chat has the thread again', { icon: 'chat' }); wasMirror.current = mirror; }, [mirror]);
  const mirrorRef = useRef<(() => void) | null>(null), mirrorRow = useRef<HTMLDivElement>(null);
  const takeOver = () => void api.threads.update(th.id, { external: 0 });
  mirrorRef.current = outside ? takeOver : mirror && !taking ? () => { setTaking(true); void api.chat.drive(th.id, 'chat').finally(() => setTaking(false)); } : null;
  const [sel, setSel] = useState<string | null>(null);
  const qref = useRef<number | null>(null);   // the queue row with the keys (QueueTray), for rule 15's place / restore
  const since = useRef(Date.now());
  useEffect(() => { if (running) since.current = Date.now(); }, [running]);
  // the transcript is followed live while the chat shows it, whoever writes it (another terminal, Skein's own)
  useEffect(() => { api.chat.follow(th.id, true); return () => api.chat.follow(th.id, false); }, [th.id]);
  useEffect(() => registerChatTab(t.id, { thread: th.id, draft: key, composer, reader: () => reader, enter: () => !!read.current && reader.enter(read.current, 'back') }), [t.id, th.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // rule 15: a popup over this pane notes where the keyboard was (the reader's cursor, or the composer's mode and
  // position) and puts it back when it closes
  useEffect(() => registerHooks(t.id, {
    place: () => {
      if (qref.current != null) return { q: qref.current };
      if (reader.on && reader.root && reader.f) return { root: reader.root, f: { ...reader.f } };
      const s = composer.current?.field()?.state();
      return s ? { ins: s.mode === 'INSERT', pos: s.pos } : null;
    },
    restore: (pl: unknown) => {
      const r = pl as { root?: HTMLElement; f?: { n: Text; o: number }; ins?: boolean; pos?: number; q?: number } | null;
      if (r?.q != null) { (document.activeElement as HTMLElement | null)?.blur(); setQcur(r.q); return; }
      if (r?.root && r.f && r.root.isConnected && r.f.n.isConnected) { reader.begin(r.root, 'n', r.f); return; }
      const c = composer.current, f = c?.field(); if (!c || !f) { idle(); return; }
      const pos = Math.min(r?.pos ?? f.state().text.length, f.state().text.length);
      if (r?.ins === false) { c.focus(false); f.at(pos); }
      else { f.set(f.state().text, pos); c.focus(true); }
    },
  }), [t.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the reader over this tab's transcript ----
  const reader = useMemo(() => new Reader({
    tabId: t.id,
    exit: how => {
      if (!composer.current) { idle(); return; }
      composer.current.focus(how === 'insert');
      if (how === 'end') { const f = composer.current.field(); const s = f?.state(); if (f && s) f.set(s.text); }
    },
    edit: (id, offset, key) => startEdit(id, offset, key),
    answer: yes => answerKey(yes),
    selection: s => setSel(s),
    density: d => {
      const i = Math.max(0, Math.min(DENSITY.length - 1, DENSITY.indexOf(densRef.current) + d)), to = DENSITY[i];
      setDens(to); toast(`${DENSITY_NAME[to]} in this view`, { icon: 'layers' });
    },
  }), [t.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => reader.clear(), [reader]);

  // ---- answering requests (G7): y the main answer, n the last one ----
  const answerKey = (yes: boolean) => {
    if (t.kind === 'sub') return false;
    const p = pending(th.id)[0]; if (!p) return false;
    const o = p.request.options, pick = yes ? o.find(x => x.primary) || o[0] : o[o.length - 1];
    if (pick) answerReq(th.id, p.request.requestId, pick.id);
    return true;
  };

  // ---- with nothing focused in the tab: NORMAL, i / a type, k reads, y / n answer ----
  const idleKey = useRef({ k: '', at: 0 });
  const idleSurface: Surface = {
    kind: 'layout', mode: () => 'NORMAL',
    key: k => {
      if ((k === 'y' || k === 'n') && answerKey(k === 'y')) return true;
      if ((k === 'i' || k === 'a' || k === 'enter') && composer.current) {   // back into the text at its END (mockup keys.js)
        const f = composer.current.field(); if (f) f.set(f.state().text); composer.current.focus(true); return true;
      }
      // the reader from here too (the mirror bar has no field): [ [ your last message, { the block above
      if (k === '[' && read.current) { const prev = idleKey.current; idleKey.current = { k, at: Date.now() }; if (prev.k === '[' && Date.now() - prev.at < 800) { idleKey.current = { k: '', at: 0 }; if (reader.enter(read.current)) { reader.key('['); reader.key('['); } } return true; }
      if (k === '{' && read.current) { reader.enter(read.current, 'block'); return true; }
      // folds from here too: zr / zm / zR / zM
      if (k === 'z' && read.current) { idleKey.current = { k, at: Date.now() }; return true; }
      if (idleKey.current.k === 'z' && read.current && Date.now() - idleKey.current.at < 800) { idleKey.current = { k: '', at: 0 }; reader.fold(k, read.current); return true; }
      if ((k === 'i' || k === 'a') && mirrorRef.current) { mirrorRef.current(); return true; }   // the mirror bar: i / a take the thread back
      // the mirror bar is a row of buttons (rule 16): h / l along it, enter / space press, esc presses Cancel
      const row = mirrorRow.current;
      if (row && ['h', 'l', 'left', 'right', 'enter', 'space', 'esc'].includes(k)) {
        const bs = [...row.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]; if (!bs.length) return false;
        const cur = bs.indexOf(document.activeElement as HTMLButtonElement), i = cur < 0 ? Math.max(0, bs.findIndex(b => b.classList.contains('primary'))) : cur;
        if (k === 'h' || k === 'left') bs[Math.max(0, i - 1)].focus();
        else if (k === 'l' || k === 'right') bs[Math.min(bs.length - 1, i + 1)].focus();
        else if (k === 'esc') { const out = row.querySelector<HTMLButtonElement>('[data-esc]'); if (!out) return false; out.click(); }
        else bs[i].click();
        return true;
      }
      if ((k === 'k' || k === 'up') && read.current) { reader.enter(read.current, 'view'); return true; }
      if (k === 'G' && read.current) { reader.enter(read.current); return true; }
      return false;
    },
  };
  const idle = () => { registerTab(t.id, idleSurface); update(s => { s.tick++; }); };
  useEffect(() => { if (!scroller.current?.parentElement?.contains(document.activeElement)) idle(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // focus follows the pane: a newly focused chat types into its composer (side chats and subagents open in INSERT)
  const wasFocused = useRef(false);
  /** The reader had the keys when something else took them: closing an overlay (a menu, the palette, file search, the
   *  keyboard sheet, rule 15), or coming back from the sidebar or another pane, puts the reading cursor back where it
   *  was rather than handing the keys to the composer. Not after H / L (stepping tabs carries the mode you came from),
   *  a click (it places the keys itself) or opening the thread again (it opens ready to type). */
  const readingUnder = useRef<false | 'layer' | 'away'>(false);
  useLayoutEffect(() => {
    // back to the thread from a side chat's anchor line comes up in NORMAL (the mockup's D3); a thread opened from
    // the sidebar still opens ready to type (VIM-MODEL: the composer is a Field, INSERT). Stepping tabs with H / L
    // never changes the mode: the composer takes the keys in NORMAL
    const by = recentMouse(), listed = !!by?.closest?.('.sc-anchor');
    const u = readingUnder.current, back = u === 'layer' || (u === 'away' && !by && A.steppedInsert() === undefined && !A.justOpened()); if (focused) readingUnder.current = false;
    const onRow = !!(composer.current?.onControls() || editor.current?.onControls());   // its menu closed: the row keeps the keys
    if (focused && !wasFocused.current && !reader.on && qref.current == null && !onRow && !(back && !S.layers.length && read.current && reader.enter(read.current, 'back'))) { if (composer.current) composer.current.focus(listed ? false : A.steppedInsert()); else idle(); }
    if (!focused && wasFocused.current) {
      readingUnder.current = reader.on && (S.layers.length ? 'layer' : 'away');
      const el = document.activeElement as HTMLElement | null;
      if (el && scroller.current?.parentElement?.contains(el)) el.blur();
      reader.clear();
    }
    wasFocused.current = focused;
  });

  // ---- scrolling: follow the bottom while you are there ----
  const stick = useRef(true);
  const onScroll = () => { const s = scroller.current; if (s) stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < 40; };
  useLayoutEffect(() => { const s = scroller.current; if (s && stick.current) s.scrollTop = s.scrollHeight; }, [events, tc.edit]);

  // ---- sending ----
  const setDraft = (d: Draft) => { tc.draft = d; bump(); };
  // while a turn runs, enter queues (or steers, by the setting) and mod-enter does the other; subagents only steer
  const send = (alt?: boolean) => {
    const d = tc.draft, text = outgoing(d);
    if (!text && !d.images.length) { if (canContinue) { stick.current = true; void api.chat.send(th.id, { text: '', resume: true, model: th.model, effort: th.effort, perm: th.perm, ...sessionFor(th) }); } return; }
    stick.current = true;
    const queue = running && t.kind !== 'sub' && ((S.settings.followUp ?? 'queue') === 'queue') !== !!alt;
    const sent = t.kind === 'sub' ? api.chat.send(th.id, { text, images: d.images, sub: t.sub })
      : api.chat.send(th.id, { text, images: d.images, model: th.model, effort: th.effort, perm: th.perm, ...sessionFor(th), ...(queue ? { queue } : {}) });
    // refused (the terminal is mid-turn, another process has the thread): the message comes back to the composer
    void sent.catch(e => {
      if (!outgoing(tc.draft) && !tc.draft.images.length) { tc.draft = d; bump(); }
      toast(String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { icon: 'terminal' });
    });
    tc.draft = blank(); bump();
    saveDraft(key, '');
  };
  const stop = () => void api.chat.interrupt(th.id);
  // Codex: the last turn was stopped, so with nothing typed send continues it (Codex's ▶; Claude Code has no such call)
  const canContinue = th.harness === 'codex' && t.kind !== 'sub' && !running && events.filter(e => e.t !== 'worked').at(-1)?.t === 'interrupted';

  // ---- the queue: messages waiting for the running turn (QueueTray) ----
  const queue = t.kind === 'sub' ? [] : th.queue ?? [];
  const [qcur, setQcur] = useState<number | null>(null);
  qref.current = qcur;
  const tray = useRef<QueueTrayHandle>(null);
  useEffect(() => { if (qcur != null && qcur >= queue.length) setQcur(queue.length ? queue.length - 1 : null); }, [queue.length, qcur]);
  useEffect(() => { if (qcur != null && queue.length === 0) composer.current?.focus(false); }, [queue.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const toQueue = () => { if (!queue.length) return false; (document.activeElement as HTMLElement | null)?.blur(); setQcur(queue.length - 1); return true; };
  const dropQueued = (id: string) => {
    const i = queue.findIndex(x => x.id === id), m = queue[i]; if (!m) return;
    void api.chat.dropQueued(th.id, id);
    toast('Removed from the queue', { icon: 'trash', action: { label: 'Undo', run: () => void api.chat.send(th.id, { text: m.text, images: m.images, queue: true }).then(() => {
      const now = thread(th.id)?.queue ?? [], back = now.at(-1); if (!back) return;
      const ids = now.slice(0, -1).map(x => x.id); ids.splice(i, 0, back.id); void api.chat.orderQueue(th.id, ids);
    }) } });
  };
  const queueMenu = (id: string, anchor: DOMRect) => {
    const i = queue.findIndex(x => x.id === id), m = queue[i]; if (!m) return;
    const steer = (S.settings.followUp ?? 'queue') === 'steer';
    openMenu<() => void>({ anchor, place: 'top-end', items: [
      { label: 'Edit message', icon: <Icon name="pencil" />, kbd: 'e', data: () => requestAnimationFrame(() => tray.current?.edit(id)) },
      { label: 'Move to top', icon: <Icon name="up" />, dis: i === 0, data: () => void api.chat.orderQueue(th.id, [id, ...queue.filter(x => x.id !== id).map(x => x.id)]) },
      { label: 'Open in side chat', icon: <Icon name="chat" />, dis: !!th.side || !canBranch(th.harness), data: () => void newSide(th, lastText()).then(sid => { void api.chat.dropQueued(th.id, id); openSide(sid); void api.chat.send(sid, { text: m.text, images: m.images }); }) },
      { label: steer ? 'Turn on queueing' : 'Turn off queueing', hint: steer ? 'Enter queues while a turn runs' : 'Enter steers while a turn runs', icon: <Icon name="queue" />, data: () => void setSetting({ followUp: steer ? 'queue' : 'steer' }) },
    ], onPick: it => it.data?.() });
  };

  // ---- edit and resend (G8) ----
  // `insert`: a click on the message, so INSERT with the caret before the clicked character; else the reader's
  // NORMAL cursor carried over. A message's trailing newlines stay out of the box (the bubble never shows them).
  const startEdit = (id: string, offset?: number, key?: string, insert?: boolean) => {
    if (t.kind === 'sub' || mirror) return;
    const e = lg.events.find(x => x.id === id); if (!e || e.t !== 'user') return;
    reader.clear();
    tc.edit = { event: id, draft: { ...blank(), text: e.text.replace(/\s+$/, ''), images: e.images || [] } }; bump();
    // the box takes the keys a frame from now: keys typed before then (the w of c w) wait for it, then go in
    const held: KeyLike[] = [];
    const unhold = registerTab(t.id, { kind: 'field', mode: () => offset === undefined || insert ? 'INSERT' : 'NORMAL', local: () => true, key: (_k, ev) => { held.push(keyCopy(ev)); return true; } });
    const replay = () => {
      for (const ev of held) {
        if (dispatchKey(ev) || ev.ctrlKey || ev.metaKey || ev.altKey) continue;
        if (ev.key.length === 1) document.execCommand('insertText', false, ev.key);   // INSERT: the field types it
        else if (ev.key === 'Backspace') document.execCommand('delete');
      }
    };
    requestAnimationFrame(() => {
      unhold();
      const f = editor.current?.field(); if (!f) return;
      if (offset === undefined) { f.focus(true); replay(); return; }
      const raw = f.state().text, at = offset;   // an offset in the raw text (rawAt)
      if (insert) { f.focus(true); f.set(raw, Math.min(at, raw.length)); replay(); return; }
      // NORMAL never rests past the end of a line (the mockup's Vim.block)
      let pos = Math.min(at, raw.length);
      if (pos > 0 && (pos === raw.length || raw[pos] === '\n') && raw[pos - 1] !== '\n') pos--;
      f.focus(false); f.set(raw, pos);
      if (key) tabSurface(t.id)?.key(key, { key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
      replay();
    });
  };
  const keyCopy = (e: KeyLike): KeyLike => ({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
  // a double-click on your own message: the first click opened the edit box; the second (and a third) select the
  // word (the line) there in VISUAL instead of landing on whatever the box put under the pointer (the model chip)
  /** The raw-text offset of the character under a point in your message's text, if the point is on it. */
  const offsetAt = (own: Element, x: number, y: number) => {
    const c = document.caretRangeFromPoint?.(x, y);
    return c && own.contains(c.startContainer) ? rawAt(own, (own as HTMLElement).dataset.md ?? '', c.startContainer, c.startOffset) : undefined;
  };
  const bubble = useRef<{ x: number; y: number; off: number; t: number } | null>(null);
  const tcRef = useRef(tc); tcRef.current = tc;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const own = e.detail === 1 && (e.target as Element | null)?.closest?.('.m-user.can-edit .mt');
      if (own) {   // note where a click on your own message was: it opens the edit box under the pointer
        bubble.current = { x: e.clientX, y: e.clientY, off: offsetAt(own, e.clientX, e.clientY) ?? 0, t: Date.now() }; return;
      }
      const b = bubble.current;
      if (!b || !tcRef.current.edit || e.detail < 2 || Date.now() - b.t > 900 || Math.hypot(e.clientX - b.x, e.clientY - b.y) > 8) return;
      e.preventDefault(); e.stopPropagation();
      const eat = (x: Event) => { x.preventDefault(); x.stopPropagation(); };
      document.addEventListener('click', eat, { capture: true, once: true });
      b.t = Date.now();
      const detail = e.detail;
      requestAnimationFrame(() => requestAnimationFrame(() => pick(b, detail)));   // after startEdit's own focus
    };
    const pick = (b: { off: number }, detail: number) => {
      const f = editor.current?.field(); if (!f) return;
      const raw = f.state().text, at = Math.min(b.off, Math.max(0, raw.length - 1));
      let a = at, z = at;
      if (detail >= 3) { a = raw.lastIndexOf('\n', at - 1) + 1; z = raw.indexOf('\n', at); if (z < 0) z = raw.length; z = Math.max(a, z - 1); }
      else { const w = /[\p{L}\p{N}_]/u; if (w.test(raw[at] || '')) { while (a > 0 && w.test(raw[a - 1])) a--; while (z < raw.length - 1 && w.test(raw[z + 1])) z++; } }
      f.focus(false); f.at(z, { anchor: a, mode: detail >= 3 ? 'V-LINE' : 'VISUAL' });
      update(s => { s.tick++; });
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // k on the edit box's first line reads the conversation above it, with the box left open (the mockup's 'up')
  const readAboveEdit = () => {
    const root = read.current, box = root?.querySelector('.m-edit'); if (!root || !box) return;
    const before = reader.texts(root).filter(n => box.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING);
    const n = before[before.length - 1]; if (!n) return;
    reader.begin(root, 'n', { n, o: Math.max(0, n.data.trimEnd().length - 1) }); reader.key('0');
  };
  // esc out of an edit box puts the reader's cursor back on that message (the mockup's editCancel), not the composer
  const cancelEdit = () => {
    const id = tc.edit?.event; tc.edit = undefined; bump();
    requestAnimationFrame(() => {
      // you already went on to a field (the composer) in the frame the box took to close: it keeps the keys
      const on = document.activeElement;
      if (on?.matches('textarea, input, [contenteditable]') && !on.closest('.m-edit')) return;
      const root = read.current, el = id && root?.querySelector(`.m-user[data-ev="${CSS.escape(id)}"] .mt`);
      if (root && el) { reader.root = root; reader.at(el); } else composer.current?.focus(false);
    });
  };
  const resend = () => {
    const ed = tc.edit; if (!ed) return;
    const text = outgoing(ed.draft); if (!text && !ed.draft.images.length) return;
    rewindTo(th.id, ed.event);
    void api.chat.send(th.id, { text, images: ed.draft.images, rewind: ed.event, model: th.model, effort: th.effort, perm: th.perm, ...sessionFor(th) });
    tc.edit = undefined; bump(); stick.current = true; composer.current?.focus(true);
  };
  const laterSides = useMemo(() => {
    if (!tc.edit) return 0;
    const i = lg.events.findIndex(e => e.id === tc.edit!.event);
    return S.threads.filter(x => x.side && x.parent?.id === th.id && lg.events.findIndex(e => e.id === x.parent!.at) > i).length;
  }, [tc.edit, lg.events, th.id]);

  // ---- our / commands ----
  const lastText = () => [...lg.events].reverse().find(e => e.t === 'text')?.id;
  // /side: a new side chat about the quote in the composer (its quotes move over with it), else the last reply
  const sideFromDraft = async () => {
    const qs = tc.draft.quotes;
    const at = qs.map(q => /^ev:[^:]+:(.+)$/.exec(q.src)?.[1]).find(Boolean) ?? lastText();
    const id = await newSide(th, at);
    if (qs.length) {
      let text = tc.draft.text;
      for (const q of qs) text = text.replace(tokenOf(q), '');
      text = text.replace(/ {2,}/g, ' ').trim();
      tc.draft = { ...tc.draft, text, quotes: [] };
      saveDraft(key, text, []); composer.current?.field()?.set(text); bump();
    }
    openSide(id);
    if (qs.length) requestAnimationFrame(() => { const x = allTabs(ws()).find(y => y.tab.thread === id); if (x) for (const q of qs) quoteToTab(x.tab.id, q); });
  };
  const onCommand = (cmd: string, anchor: DOMRect) => {
    if (cmd === '/subagents') return subList(th, lg.events, anchor);
    if (cmd === '/side') return void sideFromDraft();
    if (cmd === '/sidechats') return chooseSide(th, anchor, lastText(), openSide);
  };

  // ---- reader entry from the composer: k on its first line, gg ----
  const lastKey = useRef({ k: '', at: 0 });
  const onNormalKey = (k: string) => {
    if ((k === 'y' || k === 'n') && answerKey(k === 'y')) return true;
    const prev = lastKey.current; lastKey.current = { k, at: Date.now() };
    if (k === 'g' && prev.k === 'g' && Date.now() - prev.at < 800 && read.current) {
      const f = composer.current?.field(); const s = f?.state(); if (f && s) f.set(s.text);
      reader.enter(read.current, 'top'); return true;
    }
    if (k === '{' && read.current) {   // the thread above, unless the draft has a blank line above the cursor
      const st = composer.current?.field()?.state();
      if (st && /\n[ \t]*\n/.test(st.text.slice(0, st.pos))) return false;
      reader.enter(read.current, 'block'); return true;
    }
    // [[ : your last message (rule 7)
    if (k === '[' && prev.k === '[' && Date.now() - prev.at < 800 && read.current) {
      lastKey.current = { k: '', at: 0 };
      if (reader.enter(read.current)) { reader.key('['); reader.key('['); }
      return true;
    }
    if (k === '[') return true;
    return false;
  };

  // one object, updated in place, so the transcript's handlers stay current when it is not drawn again (transcriptDeps)
  const ctx = Object.assign(useRef({} as TranscriptCtx).current, {
    thread: th, src: t.kind === 'sub' ? `sub:${t.sub}` : `ev:${th.id}`, main: t.kind !== 'sub' && !th.side, density,
    editing: tc.edit?.event,
    editBox: tc.edit && (
      <>
        <Composer ref={editor} tabId={t.id} thread={th} draft={tc.edit.draft} onDraft={d => { tc.edit!.draft = d; bump(); }} placeholder="Edit message"
          onSend={resend} onLeave={cancelEdit} onCommand={onCommand} onLeaveUp={readAboveEdit} />
        {laterSides > 0 && <div className="edit-note"><Icon name="branch" /><span>Resending keeps {laterSides === 1 ? 'the side chat' : `the ${laterSides} side chats`} from later replies, unlinked</span></div>}
      </>
    ),
    onEdit: t.kind === 'sub' || mirror || !canBranch(th.harness) ? undefined : (id, x, y) => {
      const own = x === undefined ? null : read.current?.querySelector(`.m-user[data-ev="${CSS.escape(id)}"] .mt`);
      startEdit(id, own ? offsetAt(own, x!, y!) : undefined, undefined, true);
    },
    onSide: t.kind === 'sub' || th.side || !canBranch(th.harness) ? undefined : at => void newSide(th, at).then(openSide),
    onFork: t.kind === 'sub' || th.side || !canBranch(th.harness) ? undefined : at => void forkAt(th, at),
    onOpenSub: id => openSub(th, id),
    onOpenSide: id => openSide(id),
    onFix: e => fixError(th, e, () => A.setView(t, 'term')),
  } satisfies TranscriptCtx);

  // the mouse (as the mockup): a click in the transcript moves the reader's cursor there (NORMAL), a drag selects
  // (VISUAL), a triple click selects lines. A click outside a message being edited cancels the edit first. A click
  // on nothing readable still leaves INSERT: the composer lets go and the tab is in NORMAL.
  /** Where the button went down: a double-click that started on text and was dragged off it is a word-wise selection. */
  const downAt = useRef({ x: 0, y: 0 });
  const onMouseUp = (e: React.MouseEvent) => {
    const root = read.current; if (!root || e.button !== 0) return;
    const ev = e.nativeEvent, target = ev.target as Element;
    // a press on a control is the control's; a drag that only ends on one (from text above it) is still a selection.
    // A link in the text is text too: a click puts the cursor on it (and onLinkClick then follows it)
    const ctl = target.closest('.m-edit, .menu, .seltb, button, input, textarea, a:not(.clink), [role=dialog], img[data-zoom], summary .flink');
    if (ctl && (ctl.contains(document.elementFromPoint(downAt.current.x, downAt.current.y)) || !getSelection()?.toString())) return;
    if (target.closest('summary') && ev.detail < 2) return;   // a click folds; a double-click selects its words (VISUAL)
    if (target.closest('.m-user.can-edit') && !target.closest('.clink, .flink') && !getSelection()?.toString()) return;   // that click opens the edit box
    setTimeout(() => {
      const s = getSelection();
      // a double-click on blank space (beside a line, the margin, next to a bubble) does nothing: no stray VISUAL
      // (a drag that started on text and ended past a line's or paragraph's end keeps its selection)
      if (ev.detail >= 2 && !target.closest('.diff .dl > .n') && !onText(ev.clientX, ev.clientY) && !onText(downAt.current.x, downAt.current.y)) { s?.removeAllRanges(); setSel(null); if (reader.on && reader.mode !== 'n') reader.clear(); return; }
      if (s && !s.isCollapsed && root.contains(s.anchorNode)) setSel(s.toString());
      reader.fromMouse(ev, root, downAt.current);   // first, while the text under the pointer is where it was clicked
      if (tc.edit && (!s || s.isCollapsed)) { tc.edit = undefined; bump(); }
      if (!reader.on) {
        const el = document.activeElement as HTMLElement | null;
        if (el && el.matches('textarea, input') && scroller.current?.parentElement?.contains(el)) el.blur();
        idle();
      }
    }, 0);
  };
  // the selection toolbar (Add to chat / Add to side chat) goes with a click anywhere else, as in the mockup:
  // the selection and the reader's VISUAL go with it (a click in this transcript then puts the cursor there)
  useEffect(() => {
    if (!sel) return;
    const away = (e: MouseEvent) => {
      if ((e.target as Element).closest?.('.seltb')) return;
      setSel(null);
      if (reader.mode !== 'n') reader.clear();
      if (!read.current?.contains(e.target as Node)) getSelection()?.removeAllRanges();
    };
    // and when the selection itself goes (by keys or a script), the bar goes too (annot.js selectionchange)
    const gone = () => { const g = getSelection(); if (!g || g.isCollapsed) setSel(null); };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('selectionchange', gone);
    return () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('selectionchange', gone); };
  }, [sel, reader]);
  // a link in a reply (.clink) or a file named in a reply or a tool row (.flink): a click follows it (and does not
  // fold its row); with a modifier a file opens in a new split. The reader's keys (enter, g x, g f) click it too.
  // A mouse click follows it after onMouseUp has put the cursor there, so the file it opens keeps the focus.
  const onLinkClick = (e: React.MouseEvent) => {
    const t = e.target as Element, link = t.closest<HTMLElement>('.clink') || t.closest<HTMLElement>('.flink');
    if (!link || getSelection()?.toString()) return;
    e.preventDefault(); e.stopPropagation();
    const split = splitClick(e);
    if (e.detail > 0) setTimeout(() => follow(link, split), 0); else follow(link, split);
  };
  const follow = (link: HTMLElement, split: boolean) => {
    const to = link.matches('.clink') ? chatLink(link.dataset.href || '', th.dir) : chatLink(link.dataset.p || link.textContent || '', th.dir);
    if (to.kind === 'none') { toast(`Skein does not open ${(link.dataset.href || '').replace(/:.*/, ':')} links`); return; }
    if (to.kind === 'external') { void api.app.openExternal(to.url); return; }
    const local = !machine(th.machine)?.ssh, full = to.dir.replace(/[\\/]+$/, '') + '/' + to.path;
    if (local && !split && OS_OPENS.test(to.path)) { void api.app.openPath(full).catch(() => toast(`No file at ${to.path}`)); return; }
    reader.clear();
    openFileAt({ machine: th.machine, dir: to.dir }, to.path, { line: to.line, col: to.col, split });
  };
  // a field in this tab taking the focus takes the cursor too: the reader's goes (never two cursors)
  const onFocusIn = (e: React.FocusEvent) => { if ((e.target as Element).matches('textarea, input') && reader.on) reader.clear(); };

  const m = machine(th.machine);
  const parent = th.side ? thread(th.parent?.id) : undefined;
  const anchorText = th.side && th.parent?.at ? (log(th.parent.id).events.find(e => e.id === th.parent!.at) as { text?: string } | undefined)?.text : undefined;
  return (
    <div className={cx('chat', (th.side || t.kind === 'sub') && 'side')} onFocus={onFocusIn}>
      <div className="thread" ref={scroller} onScroll={onScroll} onMouseDown={e => { downAt.current = { x: e.clientX, y: e.clientY }; }} onMouseUp={onMouseUp} onClick={onLinkClick}>
        <div className="col" data-read ref={read}>
          {t.kind === 'sub' && sub && <div className="sub-h"><Icon name="agent" /><span>{sub.task}</span></div>}
          {th.side && parent && (
            <button type="button" className="sc-anchor" title="Open the thread at this message" onClick={() => A.openThread(parent.id)}>
              <Icon name="branch" /><span>{anchorText ? anchorText.replace(/[`*]/g, '') : parent.title}</span>
            </button>
          )}
          {(t.kind === 'sub' ? !subTurns.loaded : !lg.loaded) && !events.length ? <div className="empty"><Spinner /></div>
            : !events.length && !th.side && t.kind !== 'sub' ? <div className="empty"><Icon name={th.harness} size="xl" /></div>
            : <Transcript events={events} c={ctx} running={!!running} since={since.current} deps={transcriptDeps(ctx)} />}
        </div>
      </div>
      {t.kind !== 'sub' && !th.side && <Ticks scroller={scroller} version={events.length} />}
      <div className="compw"><div className="col">
        {m?.ssh && m.link !== 'up' && (
          <div className="link-note" role="status"><Dot color={m.link === 'down' ? 'red' : 'amber'} pulse={m.link !== 'down'} />
            <span>{m.link === 'reconnecting' ? `Reconnecting to ${m.name}. The turn keeps running there.` : m.link === 'down' ? `${m.name} is offline${m.note ? ': ' + m.note : ''}` : m.link === 'auth' ? `${m.name} needs you to sign in` : `Connecting to ${m.name}`}</span></div>
        )}
        {outside ? (
          <div className="mirror kbrow" role="status" ref={mirrorRow}><Icon name="terminal" />
            <span>{`${harnessName(th.harness)} is running this thread in another terminal`}</span><span className="sp" />
            <Button small variant="primary" title="Send from here. Close the other terminal first, so only one writes to this thread" onClick={takeOver}>Take over</Button>
          </div>
        ) : mirror ? (
          <div className="mirror kbrow" role="status" ref={mirrorRow}><Icon name="terminal" />
            <span>{taking ? 'Chat takes over when this turn finishes' : `${harnessName(th.harness)} is driving this thread in its terminal`}</span><span className="sp" />
            {taking
              ? <Button small data-esc onClick={() => { setTaking(false); void api.chat.drive(th.id, 'term'); }}>Cancel</Button>
              : <><Button small onClick={() => A.setView(t, 'term')}>Show terminal</Button>
                <Button small variant="primary" title="Continue here. The terminal picks up what you send when you open it again" onClick={() => { setTaking(true); void api.chat.drive(th.id, 'chat').finally(() => setTaking(false)); }}>Take back</Button></>}
          </div>
        ) : locked ? <LockedComposer note="Follow-ups aren't available for this subagent" /> : (
          <>
          <QueueTray ref={tray} tabId={t.id} items={queue} paused={th.queuePaused} running={!!running} cursor={focused ? qcur : null} onCursor={setQcur}
            onLeaveDown={() => { setQcur(null); composer.current?.focus(false); }}
            onLeaveUp={() => { setQcur(null); if (!read.current || !reader.enter(read.current, 'view')) composer.current?.focus(false); }}
            onSteer={id => void api.chat.steerQueued(th.id, id)} onDrop={dropQueued} onEdit={(id, text) => void api.chat.editQueued(th.id, id, text)}
            onOrder={ids => void api.chat.orderQueue(th.id, ids)} onResume={() => void api.chat.resumeQueue(th.id)} onMenu={queueMenu} />
          <Composer ref={composer} tabId={t.id} persist={key} thread={th} draft={tc.draft} onDraft={setDraft} running={!!running && t.kind !== 'sub'} onSend={send} onStop={stop}
            placeholder={t.kind === 'sub' ? `Message ${sub?.name || 'subagent'}` : th.side ? 'Ask in this side chat' : undefined}
            showContext={!th.side && t.kind !== 'sub'} bare={t.kind === 'sub'} onCommand={onCommand} onLeave={() => { if (ws().pf === t.id) A.closeFocusedPopup(); else { (document.activeElement as HTMLElement | null)?.blur(); idle(); } }}
            onLeaveUp={() => { if (toQueue()) return; if (read.current && !reader.enter(read.current, 'view')) composer.current?.focus(false); }} onNormalKey={onNormalKey}
            onFocus={() => setQcur(null)} canContinue={canContinue} />
          </>
        )}
        {t.kind === 'sub' && sub && (
          <div className="under"><span className="u" title="Subagent of this thread"><Icon name={th.harness} />{th.title}</span><span className="sp" />
            <span className="u">{sub.status === 'running' ? <><Spinner />running{sub.dur ? ' ' + sub.dur : ''}</> : <><Icon name="check" />finished{sub.dur ? ' in ' + sub.dur : ''}</>}</span></div>
        )}
        {th.side && parent && (
          <div className="under"><span className="u"><Icon name={th.harness} />{parent.title}</span><span className="sp" />
            <Button small variant="ghost" icon="up" title="Quote the last answer into the thread's composer" onClick={() => sendToThread(th, lg.events)}>Send to thread</Button></div>
        )}
      </div></div>
      {sel && <SelBar tab={t} text={sel} onDone={() => { setSel(null); reader.clear(); }} />}
    </div>
  );
}

/** A subagent's turns: what the harness keeps of it (read when its popup opens, and again every few seconds while
 *  it runs, since a session driven from a terminal streams nothing here), with what streamed in live on top. */
function useSubTurns(th: ThreadMeta, sub: Sub | undefined): { events: ThreadEvent[]; loaded: boolean } {
  const [kept, setKept] = useState<ThreadEvent[] | null>(null);
  const id = sub?.id, agent = sub?.agent, running = sub?.status === 'running';
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = () => api.threads.sub(th.id, { id, ...(agent ? { agent } : {}) }).then(es => { if (live) setKept(es); }, () => { if (live) setKept(k => k ?? []); });
    void read();
    const timer = running ? setInterval(read, 2500) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [th.id, id, agent, running]);
  return useMemo(() => ({ events: mergeTurns(kept ?? [], sub?.events ?? []), loaded: kept !== null || !!sub?.events?.length }), [kept, sub?.events]);
}

/** The kept turns, with each live event in its place (or after them, when it is newer than the record). */
function mergeTurns(kept: ThreadEvent[], live: ThreadEvent[]): ThreadEvent[] {
  if (!kept.length) return live;
  if (!live.length) return kept;
  const at = new Map(kept.map((e, i) => [e.id, i]));
  const out = [...kept];
  for (const e of live) { const i = at.get(e.id); if (i == null) out.push(e); else out[i] = e; }
  return out;
}

/** Side chat → thread: its last answer becomes a quote in the parent's composer. */
function sendToThread(th: ThreadMeta, events: ThreadEvent[]) {
  const last = [...events].reverse().find(e => e.t === 'text');
  if (!last || last.t !== 'text' || !th.parent) return;
  // the whole reply is the quote, so it points at all of that reply's text
  const src = `ev:${th.id}:${last.id}`, el = document.querySelector(`[data-src="${src}"]`);
  quoteInto(th.parent.id, { id: 'q' + Date.now(), text: last.text.replace(/[`*]/g, ''), src, ...(el ? { start: 0, len: (el.textContent || '').length } : {}) });
}
