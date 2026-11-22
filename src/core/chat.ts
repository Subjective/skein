// Chat drivers: one per thread while its chat view drives it.
//   Claude Code: the Agent SDK (spawnClaudeCodeProcess runs the CLI over ssh for remote machines).
//   Codex: `codex app-server` over JSON-RPC (stdio, or over ssh), shared with the TUI through `codex --remote`.
// This file is the seam; the adapters live in ./harness/ (createHarnesses in ./harness/index.ts).
import type { ChatSend } from '../shared/api';
import type { HarnessCommands } from '../shared/commands';
import type { HarnessOptions } from '../shared/models';
import type { Harness, Machine, ThreadEvent, ThreadMeta, ViewKind } from '../shared/types';

export interface ChatDriver {
  send(msg: ChatSend): Promise<void>;
  interrupt(): Promise<void>;
  answer(requestId: string, optionId: string): Promise<void>;
  /** Stop driving (handoff to the terminal). Resolves when the harness process has let go of the session. */
  release(): Promise<void>;
  /** The queue (ThreadMeta.queue, filled by send with `queue`): send one now (into the running turn, else as the
   *  next turn), drop or rewrite one, reorder them, or start the next after a stop paused it. */
  steerQueued(id: string): Promise<void>;
  dropQueued(id: string): Promise<void>;
  editQueued(id: string, text: string): Promise<void>;
  orderQueue(ids: string[]): Promise<void>;
  resumeQueue(): Promise<void>;
}

export interface ChatHost {
  machine(id: string): Machine;
  thread(id: string): ThreadMeta;
  update(id: string, patch: Partial<ThreadMeta>): void;
  event(thread: string, e: ThreadEvent, replace?: boolean): void;
}

export interface Harnesses {
  history(t: ThreadMeta, m: Machine): Promise<ThreadEvent[]>;
  /** A subagent's turns: the `sub` event's id and, when known, the harness's id for it (ThreadEvent 'sub'.agent). */
  subHistory?(t: ThreadMeta, m: Machine, sub: { id: string; agent?: string }): Promise<ThreadEvent[]>;
  driver(t: ThreadMeta, host: ChatHost): ChatDriver;
  /** Call right after creating a thread, whichever view opens it. Codex: creates (or forks) the Codex thread
   *  so ThreadMeta.sessionId is known before the terminal or chat uses it. Returns the updated meta. */
  start?(t: ThreadMeta, host: ChatHost): Promise<ThreadMeta>;
  /** How the terminal view joins the session the chat view drives: Codex TUI args (`codex ...args`) and env
   *  for a local thread, attached to the same app-server. null: run the TUI on its own (`codex resume <id>`). */
  attach?(t: ThreadMeta): Promise<{ args: string[]; env: Record<string, string> } | null>;
  /** Drop whatever is kept for this thread (it moved): the next driver or attach starts from its record. */
  forget?(threadId: string): void;
  /** What the harness offers on the machine (models, effort levels, permission modes), asked from the harness
   *  and cached; the bundled lists (shared/models.ts) with the reason when it can't be asked. */
  options?(m: Machine, h: Harness): Promise<HarnessOptions>;
  /** What the harness offers in the / menu in that folder (commands, skills), asked and cached like options. */
  commands?(m: Machine, h: Harness, dir: string): Promise<HarnessCommands>;
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
    steerQueued: async () => {}, dropQueued: async () => {}, editQueued: async () => {}, orderQueue: async () => {}, resumeQueue: async () => {},
  }),
};

export type { ViewKind };
