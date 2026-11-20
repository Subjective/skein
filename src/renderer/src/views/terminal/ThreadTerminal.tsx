// A thread's terminal view: the harness TUI for that session.
// Claude Code (G4): one view drives at a time. If chat drives, showing the terminal waits for the turn to end
// (the handoff card), then runs `claude --resume <id>`. Quitting the TUI gives the thread back to chat.
// Codex: the TUI resumes the session; with the chat workstream it attaches to the shared app-server instead.
import type { PtySpec } from '@shared/api';
import { api } from '../../api';
import type { Tab } from '../../state/layout';
import { thread, update } from '../../state/store';
import * as A from '../../state/actions';
import { Button, Icon, Spinner } from '../../ui/primitives';
import { harnessName } from '../../shell/meta';
import { startPty, termOf, useTerminal } from './TerminalView';
import { pendingArgs } from '../../shell/Launcher';

const takeArgs = (id: string) => { const a = pendingArgs.get(id); return a?.length ? a : undefined; };

export function ThreadTerminal({ t, focused }: { t: Tab; focused: boolean }) {
  const th = thread(t.thread);
  const waiting = !!th && th.harness === 'claude' && th.drive !== 'term';
  const spec: PtySpec | null = !th || waiting ? null : {
    machine: th.machine, cwd: th.dir, thread: th.id,
    run: th.harness === 'claude' ? { kind: 'claude', session: th.sessionId, args: takeArgs(th.id) } : { kind: 'codex', resume: th.sessionId, args: takeArgs(th.id) },
    cols: 80, rows: 24,
  };
  const onExit = () => {
    const cur = thread(t.thread);
    if (cur?.harness === 'claude') void api.chat.drive(cur.id, 'chat');
  };
  const host = useTerminal(t, focused, spec, onExit);
  if (!th) return <div className="empty">This thread is gone.</div>;
  if (waiting) {
    return (
      <div className="handoff-wrap"><div className="handoff">
        <Icon name="claude" size="xl" className="hf-ic" />
        <b>{th.status === 'running' ? <><Spinner />Waiting for the turn to end</> : 'Opening in Claude Code'}</b>
        <span className="dim">claude --resume {th.sessionId?.slice(0, 18)}…</span>
        <div className="hf-b kbrow">
          {th.status === 'running' && <Button small onClick={() => void api.chat.interrupt(th.id).then(() => api.chat.drive(th.id, 'term'))}>Interrupt and open</Button>}
          <Button small variant="ghost" onClick={() => A.setView(t, 'chat')}>Stay in chat</Button>
        </div>
      </div></div>
    );
  }
  const e = termOf(t.id);
  const exited = e && e.exited !== undefined && e.exited !== -1;
  return (
    <div className="term-wrap">
      <div className="term-host" ref={host} />
      {exited && (
        <div className="t-exit kbrow">
          <Icon name={th.harness} />
          <span>{harnessName(th.harness)} exited{e!.exited ? ` with code ${e!.exited}` : ''}</span>
          <span className="sp" />
          {th.harness === 'claude' && <Button small variant="ghost" onClick={() => A.setView(t, 'chat')}>Show chat</Button>}
          <Button small variant="primary" onClick={async () => {
            if (th.harness === 'claude') await api.chat.drive(th.id, 'term');
            e!.term.reset(); void startPty(e!); update();
          }}>Restart</Button>
        </div>
      )}
    </div>
  );
}
