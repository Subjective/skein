// The chat view of a thread, a side chat (a thread forked at a reply) or a subagent (a 'sub' tab).
// Keys: the composer is a Vim field; k from its first line, or gg, reads the thread with the reader;
// y / n answer the oldest request from NORMAL anywhere in the tab (G7). Claude Code driven from its
// terminal shows a read-only mirror with Show terminal and Take back instead of the composer (G4).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ThreadEvent, ThreadMeta } from '@shared/types';
import type { Surface } from '../../input/dispatcher';
import { registerTab, tabSurface } from '../../input/surfaces';
import { api } from '../../api';
import type { Tab } from '../../state/layout';
import { machine, S, thread, update, useApp } from '../../state/store';
import * as A from '../../state/actions';
import { Button, cx, Dot, Icon, Spinner } from '../../ui/primitives';
import { harnessName, setSubNames } from '../../shell/meta';
import { Composer, type ComposerHandle } from './Composer';
import { Reader } from './reader';
import { Ticks } from './Ticks';
import { fixError, Transcript, type TranscriptCtx } from './Transcript';
import { answer as answerReq, blank, bump, log, outgoing, pending, rewindTo, saveDraft, startChat, tabChat, useChat, type Draft } from './state';
import { chooseSide, forkAt, newSide, openSide, openSub, quoteInto, registerChatTab, subList } from './threads';
import { SelBar } from './SelBar';
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
  const lg = log(th.id);
  const sub = t.kind === 'sub' ? lg.events.find((e): e is Sub => e.t === 'sub' && e.id === t.sub) : undefined;
  const events = t.kind === 'sub' ? sub?.events || [] : lg.events;
  const key = t.kind === 'sub' ? `${th.id}:${t.sub}` : th.id;   // a thread's draft follows the thread, whichever tab shows it
  const tc = tabChat(key);
  const composer = useRef<ComposerHandle>(null);
  const editor = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const read = useRef<HTMLDivElement>(null);
  const running = t.kind === 'sub' ? sub?.status === 'running' : th.status === 'running';
  const mirror = t.kind !== 'sub' && th.harness === 'claude' && th.drive === 'term';
  const [taking, setTaking] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const since = useRef(Date.now());
  useEffect(() => { if (running) since.current = Date.now(); }, [running]);
  useEffect(() => registerChatTab(t.id, { thread: th.id, draft: key, composer, reader: () => reader }), [t.id, th.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const idleSurface: Surface = {
    kind: 'layout', mode: () => 'NORMAL',
    key: k => {
      if ((k === 'y' || k === 'n') && answerKey(k === 'y')) return true;
      if ((k === 'i' || k === 'a' || k === 'enter') && composer.current) { composer.current.focus(true); return true; }
      if ((k === 'k' || k === 'G' || k === 'up') && read.current) { reader.enter(read.current); return true; }
      return false;
    },
  };
  const idle = () => { registerTab(t.id, idleSurface); update(s => { s.tick++; }); };
  useEffect(() => { if (!scroller.current?.parentElement?.contains(document.activeElement)) idle(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // focus follows the pane: a newly focused chat types into its composer (side chats and subagents open in INSERT)
  const wasFocused = useRef(false);
  useLayoutEffect(() => {
    if (focused && !wasFocused.current && !reader.on) { if (composer.current) composer.current.focus(); else idle(); }
    if (!focused && wasFocused.current) {
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
  const send = () => {
    const d = tc.draft, text = outgoing(d);
    if (!text && !d.images.length) return;
    stick.current = true;
    if (t.kind === 'sub') void api.chat.send(th.id, { text, images: d.images, sub: t.sub });
    else void api.chat.send(th.id, { text, images: d.images, model: th.model, effort: th.effort, perm: th.perm });
    tc.draft = blank(); bump();
    saveDraft(key, '');
  };
  const stop = () => void api.chat.interrupt(th.id);

  // ---- edit and resend (G8) ----
  const startEdit = (id: string, offset?: number, key?: string) => {
    if (t.kind === 'sub' || mirror) return;
    const e = lg.events.find(x => x.id === id); if (!e || e.t !== 'user') return;
    reader.clear();
    tc.edit = { event: id, draft: { ...blank(), text: e.text, images: e.images || [] } }; bump();
    requestAnimationFrame(() => {
      const f = editor.current?.field(); if (!f) return;
      if (offset === undefined) { f.focus(true); return; }
      f.focus(false); f.set(f.state().text, Math.min(offset, f.state().text.length));
      if (key) tabSurface(t.id)?.key(key, { key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
    });
  };
  const cancelEdit = () => { tc.edit = undefined; bump(); composer.current?.focus(false); };
  const resend = () => {
    const ed = tc.edit; if (!ed) return;
    const text = outgoing(ed.draft); if (!text && !ed.draft.images.length) return;
    rewindTo(th.id, ed.event);
    void api.chat.send(th.id, { text, images: ed.draft.images, rewind: ed.event, model: th.model, effort: th.effort, perm: th.perm });
    tc.edit = undefined; bump(); stick.current = true; composer.current?.focus(true);
  };
  const laterSides = useMemo(() => {
    if (!tc.edit) return 0;
    const i = lg.events.findIndex(e => e.id === tc.edit!.event);
    return S.threads.filter(x => x.side && x.parent?.id === th.id && lg.events.findIndex(e => e.id === x.parent!.at) > i).length;
  }, [tc.edit, lg.events, th.id]);

  // ---- our / commands ----
  const lastText = () => [...lg.events].reverse().find(e => e.t === 'text')?.id;
  const onCommand = (cmd: string, anchor: DOMRect) => {
    if (cmd === '/subagents') return subList(th, lg.events, anchor);
    if (cmd === '/side') return void newSide(th, lastText()).then(openSide);
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
    if (k === '{' && read.current) { reader.enter(read.current, 'block'); return true; }
    return false;
  };

  const ctx: TranscriptCtx = {
    thread: th, src: t.kind === 'sub' ? `sub:${t.sub}` : `ev:${th.id}`, main: t.kind !== 'sub',
    editing: tc.edit?.event,
    editBox: tc.edit && (
      <>
        <Composer ref={editor} tabId={t.id} thread={th} draft={tc.edit.draft} onDraft={d => { tc.edit!.draft = d; bump(); }} placeholder="Edit message"
          onSend={resend} onLeave={cancelEdit} onCommand={onCommand} />
        {laterSides > 0 && <div className="edit-note"><Icon name="branch" /><span>Resending keeps {laterSides === 1 ? 'the side chat' : `the ${laterSides} side chats`} from later replies, unlinked</span></div>}
      </>
    ),
    onEdit: t.kind === 'sub' || mirror ? undefined : id => startEdit(id),
    onSide: t.kind === 'sub' || th.side ? undefined : at => void newSide(th, at).then(openSide),
    onFork: t.kind === 'sub' || th.side ? undefined : at => void forkAt(th, at),
    onOpenSub: id => openSub(th, id),
    onOpenSide: id => openSide(id),
    onFix: e => fixError(th, e, () => A.setView(t, 'term')),
  };

  // the mouse (as the mockup): a click in the transcript moves the reader's cursor there (NORMAL), a drag selects
  // (VISUAL), a triple click selects lines. A click outside a message being edited cancels the edit first. A click
  // on nothing readable still leaves INSERT: the composer lets go and the tab is in NORMAL.
  const onMouseUp = (e: React.MouseEvent) => {
    const root = read.current; if (!root || e.button !== 0) return;
    const ev = e.nativeEvent, target = ev.target as Element;
    if (target.closest('.m-edit, .menu, .seltb, button, input, textarea, a, summary, [role=dialog]')) return;
    if (target.closest('.m-user.can-edit') && !getSelection()?.toString()) return;   // that click opens the edit box
    setTimeout(() => {
      const s = getSelection();
      if (s && !s.isCollapsed && root.contains(s.anchorNode)) setSel(s.toString());
      reader.fromMouse(ev, root);   // first, while the text under the pointer is where it was clicked
      if (tc.edit && (!s || s.isCollapsed)) { tc.edit = undefined; bump(); }
      if (!reader.on) {
        const el = document.activeElement as HTMLElement | null;
        if (el && el.matches('textarea, input') && scroller.current?.parentElement?.contains(el)) el.blur();
        idle();
      }
    }, 0);
  };
  // a field in this tab taking the focus takes the cursor too: the reader's goes (never two cursors)
  const onFocusIn = (e: React.FocusEvent) => { if ((e.target as Element).matches('textarea, input') && reader.on) reader.clear(); };

  const m = machine(th.machine);
  const parent = th.side ? thread(th.parent?.id) : undefined;
  const anchorText = th.side && th.parent?.at ? (log(th.parent.id).events.find(e => e.id === th.parent!.at) as { text?: string } | undefined)?.text : undefined;
  return (
    <div className={cx('chat', (th.side || t.kind === 'sub') && 'side')} onFocus={onFocusIn}>
      <div className="thread" ref={scroller} onScroll={onScroll} onMouseUp={onMouseUp}>
        <div className="col" data-read ref={read}>
          {t.kind === 'sub' && sub && <div className="sub-h"><Icon name="agent" /><span>{sub.task}</span></div>}
          {th.side && parent && (
            <button type="button" className="sc-anchor" title="Open the thread at this message" onClick={() => A.openThread(parent.id)}>
              <Icon name="branch" /><span>{anchorText ? anchorText.replace(/[`*]/g, '') : parent.title}</span>
            </button>
          )}
          {!lg.loaded && !events.length ? <div className="empty"><Spinner /></div>
            : !events.length && !th.side && t.kind !== 'sub' ? <div className="empty"><Icon name={th.harness} size="xl" /></div>
            : <Transcript events={events} c={ctx} running={!!running} since={since.current} />}
        </div>
      </div>
      {t.kind !== 'sub' && <Ticks scroller={scroller} version={events.length} />}
      <div className="compw"><div className="col">
        {m?.ssh && m.link !== 'up' && (
          <div className="link-note" role="status"><Dot color={m.link === 'down' ? 'red' : 'amber'} pulse={m.link !== 'down'} />
            <span>{m.link === 'reconnecting' ? `Reconnecting to ${m.name}. The turn keeps running there.` : m.link === 'down' ? `${m.name} is offline${m.note ? ': ' + m.note : ''}` : m.link === 'auth' ? `${m.name} needs you to sign in` : `Connecting to ${m.name}`}</span></div>
        )}
        {mirror ? (
          <div className="mirror kbrow" role="status"><Icon name="terminal" />
            <span>{taking ? 'Chat takes over when this turn finishes' : `${harnessName(th.harness)} is driving this thread in its terminal`}</span><span className="sp" />
            {taking
              ? <Button small onClick={() => { setTaking(false); void api.chat.drive(th.id, 'term'); }}>Cancel</Button>
              : <><Button small onClick={() => A.setView(t, 'term')}>Show terminal</Button>
                <Button small variant="primary" title="Ends the terminal session and continues here" onClick={() => { setTaking(true); void api.chat.drive(th.id, 'chat').finally(() => setTaking(false)); }}>Take back</Button></>}
          </div>
        ) : (
          <Composer ref={composer} tabId={t.id} persist={key} thread={th} draft={tc.draft} onDraft={setDraft} running={!!running} onSend={send} onStop={stop}
            placeholder={t.kind === 'sub' ? `Message ${sub?.name || 'subagent'}` : th.side ? 'Ask in this side chat' : undefined}
            showContext={!th.side && t.kind !== 'sub'} bare={t.kind === 'sub'} onCommand={onCommand} onLeave={idle}
            onLeaveUp={() => { if (read.current && !reader.enter(read.current)) composer.current?.focus(false); }} onNormalKey={onNormalKey} />
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

/** Side chat → thread: its last answer becomes a quote in the parent's composer. */
function sendToThread(th: ThreadMeta, events: ThreadEvent[]) {
  const last = [...events].reverse().find(e => e.t === 'text');
  if (!last || last.t !== 'text' || !th.parent) return;
  quoteInto(th.parent.id, { id: 'q' + Date.now(), text: last.text.replace(/[`*]/g, ''), src: `ev:${th.id}:${last.id}` });
}
