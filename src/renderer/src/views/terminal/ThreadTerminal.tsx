// A thread's terminal view: the harness TUI for that session.
// Claude Code (G4): one view drives at a time. If chat drives, showing the terminal waits for the turn to end
// (the handoff card), then runs `claude --resume <id>`. Quitting the TUI gives the thread back to chat.
// Codex: the TUI resumes the session; with the chat workstream it attaches to the shared app-server instead.
import { useEffect, useRef } from 'react';
import type { ThreadMeta } from '@shared/types';
import { useKbRow } from '../../ui/kbrow';
import { pending, useChat } from '../chat/state';
import type { PtySpec } from '@shared/api';
import { api } from '../../api';
import type { Tab } from '../../state/layout';
import { machine, thread, toast, update } from '../../state/store';
import { LinkNote } from '../../ui/LinkNote';
import * as A from '../../state/actions';
import { Button, Icon, Spinner } from '../../ui/primitives';
import { harnessName } from '../../shell/meta';
import { KbRow, startPty, termOf, UploadCard, useTerminal } from './TerminalView';
import { pendingArgs } from '../../shell/Launcher';
import { SPIN, titleRunning } from './title';


const takeArgs = (id: string) => { const a = pendingArgs.get(id); return a?.length ? a : undefined; };

function onTitle(id: string, raw: string) {
  const th = thread(id); if (!th) return;
  const running = titleRunning(raw);
  const title = raw.replace(SPIN, '').replace(/^(Claude Code|Codex)\s*[-–—:]?\s*/i, '').trim();
  const patch: Partial<typeof th> = {};
  if (title && title.length > 2 && !/^(claude|codex|bash|zsh|pwsh|powershell)$/i.test(title) && th.title !== title) patch.title = title.slice(0, 80);
  const status = running ? 'running' : th.status === 'running' ? 'idle' : undefined;
  if (status && status !== th.status) patch.status = status;
  if (Object.keys(patch).length) { update(() => Object.assign(th, patch)); void api.threads.update(id, patch); }
}
/** The TUI rang the bell or sent a notification: it is waiting on you (G13). */
function attention(id: string, text: string) {
  const th = thread(id); if (!th) return;
  const seen = document.hasFocus() && A.currentTab().thread === id;
  if (seen) return;
  // the status change comes back as a 'thread' event, and App posts the OS notification (G13)
  void text;
  void api.threads.update(id, { status: 'wait' });
}

export function ThreadTerminal({ t, focused }: { t: Tab; focused: boolean }) {
  const th = thread(t.thread);
  const waiting = !!th && th.harness === 'claude' && th.drive !== 'term';
  const spec: PtySpec | null = !th || waiting ? null : {
    machine: th.machine, cwd: th.dir, thread: th.id,
    run: th.harness === 'claude' ? { kind: 'claude', session: th.sessionId, args: takeArgs(th.id) } : { kind: 'codex', resume: th.sessionId, args: takeArgs(th.id) },
    cols: 80, rows: 24,
  };
  // Claude Code's TUI quit (/exit): chat has the thread again, and a clean exit shows it there
  const onExit = (code: number | null) => {
    const cur = thread(t.thread);
    if (cur?.harness !== 'claude') return;
    void api.chat.drive(cur.id, 'chat');
    if (code === 0) { const e = termOf(t.id); if (e) e.exited = undefined; A.setView(t, 'chat'); toast(<><b>Claude Code</b> exited. Chat has the thread again</>, { icon: 'claude' }); }
  };
  const host = useTerminal(t, focused, spec, onExit);
  const e0 = termOf(t.id);
  if (e0 && th) {
    e0.onTitle = title => onTitle(th.id, title);
    e0.onAttention = text => attention(th.id, text);
  }
  // a thread is read once its tab is on screen and focused (G13); a bell's "waiting" clears the same way
  useEffect(() => { if (focused && th && (th.status === 'unread' || (th.status === 'wait' && th.drive === 'term'))) void api.threads.update(th.id, { status: 'idle' }); }, [focused, th?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!th) return <div className="empty">This thread is gone.</div>;
  if (waiting) return <Handoff t={t} th={th} focused={focused} />;
  const e = termOf(t.id);
  const exited = e && e.exited !== undefined && e.exited !== -1;
  return (
    <div className="term-wrap">
      <div className="term-host" ref={host} />
      <LinkNote machine={machine(th.machine)} variant="term" />
      <UploadCard tabId={t.id} focused={focused} />
      {exited && (
        <KbRow tabId={t.id} focused={focused} className="t-exit">
          <Icon name={th.harness} />
          <span>{harnessName(th.harness)} exited{e!.exited ? ` with code ${e!.exited}` : ''}</span>
          <span className="sp" />
          {th.harness === 'claude' && <Button small variant="ghost" onClick={() => A.setView(t, 'chat')}>Show chat</Button>}
          <Button small variant="primary" onClick={async () => {
            if (th.harness === 'claude') await api.chat.drive(th.id, 'term');
            e!.term.reset(); void startPty(e!); update();
          }}>Restart</Button>
        </KbRow>
      )}
    </div>
  );
}


/** Claude Code with chat driving (G4): the terminal opens once the turn ends, or now if you interrupt it.
 *  A request waiting in chat has to be answered there first. esc goes back to chat. */
function Handoff({ t, th, focused }: { t: Tab; th: ThreadMeta; focused: boolean }) {
  useChat();
  const asking = pending(th.id).length > 0;
  const busy = th.status === 'running' || asking;
  const back = () => A.setView(t, 'chat');
  // the card's buttons are a row (rule 16): h / l, enter, esc = Back to chat; Interrupt and open has the focus
  const row = useRef<HTMLDivElement>(null);
  useKbRow(t.id, focused && busy, row);
  return (
    <div className="term handoff-wrap"><div className="handoff kbrow" role="status" ref={row}>
      <div className="hf-ic"><Icon name="claude" size="xl" /></div>
      <b>{busy ? <><Spinner />{asking ? 'Answer the request in chat first' : 'Opens when this turn finishes'}</> : 'Opening in Claude Code'}</b>
      <span className="dim">{busy ? 'Chat keeps driving this thread until then.' : `claude --resume ${th.sessionId ?? ''}`}</span>
      {busy ? (
        <div className="hf-b">
          <Button small data-esc title="Back to chat · esc" onClick={back}>Back to chat</Button>
          {th.status === 'running' && !asking && <Button small variant="primary" onClick={() => void api.chat.interrupt(th.id).then(() => api.chat.drive(th.id, 'term'))}>Interrupt and open</Button>}
        </div>
      ) : <Spinner />}
    </div></div>
  );
}
