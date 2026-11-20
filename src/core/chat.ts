// Chat drivers: one per thread while its chat view drives it.
//   Claude Code: the Agent SDK (spawnClaudeCodeProcess runs the CLI over ssh for remote machines).
//   Codex: `codex app-server` over JSON-RPC (stdio, or over ssh), shared with the TUI through `codex --remote`.
// This file is the seam; the adapters live in ./harness/ (createHarnesses in ./harness/index.ts).
import type { ChatSend } from '../shared/api';
import type { Machine, ThreadEvent, ThreadMeta, ViewKind } from '../shared/types';

export interface ChatDriver {
  send(msg: ChatSend): Promise<void>;
  interrupt(): Promise<void>;
  answer(requestId: string, optionId: string): Promise<void>;
  /** Stop driving (handoff to the terminal). Resolves when the harness process has let go of the session. */
  release(): Promise<void>;
}

export interface ChatHost {
  machine(id: string): Machine;
  thread(id: string): ThreadMeta;
  update(id: string, patch: Partial<ThreadMeta>): void;
  event(thread: string, e: ThreadEvent, replace?: boolean): void;
}

export interface Harnesses {
  history(t: ThreadMeta, m: Machine): Promise<ThreadEvent[]>;
  driver(t: ThreadMeta, host: ChatHost): ChatDriver;
  /** Call right after creating a thread, whichever view opens it. Codex: creates (or forks) the Codex thread
   *  so ThreadMeta.sessionId is known before the terminal or chat uses it. Returns the updated meta. */
  start?(t: ThreadMeta, host: ChatHost): Promise<ThreadMeta>;
  /** How the terminal view joins the session the chat view drives: Codex TUI args (`codex ...args`) and env
   *  for a local thread, attached to the same app-server. null: run the TUI on its own (`codex resume <id>`). */
  attach?(t: ThreadMeta): Promise<{ args: string[]; env: Record<string, string> } | null>;
  /** Drop whatever is kept for this thread (it moved): the next driver or attach starts from its record. */
  forget?(threadId: string): void;
  dispose?(): void;
}

/** Placeholder until the chat workstream lands: history is empty and sending explains why. */
export const unimplemented: Harnesses = {
  history: async () => [],
  driver: (t, host) => ({
    send: async () => host.event(t.id, { t: 'error', id: 'e-' + Date.now(), kind: 'other', text: 'The chat view is not wired to the harness yet. Use the terminal view (ldr t).' }),
    interrupt: async () => {},
    answer: async () => {},
    release: async () => {},
  }),
};

export type { ViewKind };
