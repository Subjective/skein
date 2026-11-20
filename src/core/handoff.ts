// Claude Code handoff between Skein's two views of a thread (G4). Claude Code has no app-server: the chat view runs
// an Agent SDK process and the terminal view runs the `claude` TUI, and each keeps the conversation in memory. Two of
// them writing one session fork it (each chains its entries off its own last message, and a resume shows one branch),
// so exactly one writes at a time:
// - terminal -> chat waits for the TUI's turn to end. The TUI stays open ("parked"), so a look at chat and back
//   costs nothing, until chat actually sends: then the idle TUI is closed first, and the terminal view starts
//   `claude --resume` the next time it shows, which reads what chat wrote.
// - chat -> terminal waits for the chat turn to end (the chat driver's release) before the TUI starts.
import type { TurnState } from './follow';

export interface HandoffHost {
  /** Is a Skein terminal running this thread's TUI? */
  hasTerm(thread: string): boolean;
  /** Close the thread's TUI on purpose, so its view resumes the session next time it shows. */
  closeTerm(thread: string): Promise<void>;
  /** Whether the transcript's last turn is still going. `fresh`: read it now, not from a tail that may lag. */
  turnState(thread: string, o?: { fresh?: boolean }): Promise<TurnState>;
}

export class TermBusy extends Error {
  constructor() { super('Claude Code is still running a turn in the terminal. Wait for it to finish, or stop it there.'); }
}

export class Handoff {
  private waits = new Map<string, { cancelled: boolean }>();
  constructor(private host: HandoffHost, private o: { poll?: number } = {}) {}

  /** The terminal hands the thread to chat. Resolves true once its turn is over (chat may drive), or false when
   *  cancelled first (the terminal keeps it). */
  async toChat(thread: string): Promise<boolean> {
    this.cancel(thread);
    const w = { cancelled: false };
    this.waits.set(thread, w);
    try {
      while (this.host.hasTerm(thread) && (await this.host.turnState(thread).catch(() => 'idle' as const)) === 'running') {
        if (w.cancelled) return false;
        await new Promise(r => setTimeout(r, this.o.poll ?? 500));
        if (w.cancelled) return false;
      }
      return !w.cancelled;
    } finally { if (this.waits.get(thread) === w) this.waits.delete(thread); }
  }

  /** The terminal takes the thread back while chat waits for it: stop waiting. */
  cancel(thread: string) { const w = this.waits.get(thread); if (w) w.cancelled = true; }

  /** Chat is about to write the session: close a parked TUI first. Throws TermBusy when it is mid-turn (it
   *  started one on its own, say when a background task finished), as closing it would cut that turn off. */
  async beforeSend(thread: string): Promise<void> {
    if (!this.host.hasTerm(thread)) return;
    if ((await this.host.turnState(thread, { fresh: true }).catch(() => 'idle' as const)) === 'running') throw new TermBusy();
    await this.host.closeTerm(thread);
  }
}
