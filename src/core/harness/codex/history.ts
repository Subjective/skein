// Codex history, read through the app-server (thread/read, or thread/turns/list) rather than from its rollout files: the
// app-server hands back finished turns as the same ThreadItems it streams live, so history and live share one
// mapping (itemEvents) and one set of ids, and Skein does not depend on how Codex stores a thread on disk.
import type { ThreadEvent } from '../../../shared/types';
import { log } from '../../log';
import { itemEvents, turnError } from './items';
import type { Turn } from './protocol/v2/Turn';
import type { Rpc } from './rpc';

export interface CodexHistory {
  events: ThreadEvent[];
  /** Event id → the turn it belongs to: side chats fork through it (lastTurnId), edits revert before it. */
  turnOf: Map<string, string>;
}

const empty = (): CodexHistory => ({ events: [], turnOf: new Map() });

/** A thread's turns, oldest first, as chat events. */
export function turnEvents(turns: Turn[]): CodexHistory {
  const events: ThreadEvent[] = [], turnOf = new Map<string, string>();
  const put = (e: ThreadEvent, turn: string) => { events.push(e); turnOf.set(e.id, turn); };
  for (const turn of turns) {
    for (const item of turn.items) for (const e of itemEvents(item)) put(e, turn.id);
    if (turn.status === 'failed' && turn.error) put(turnError('e-' + turn.id, turn.error), turn.id);
    if (turn.status === 'interrupted') put({ t: 'interrupted', id: 'i-' + turn.id }, turn.id);
    if (turn.status !== 'inProgress' && (turn.durationMs ?? 0) >= 1000) put({ t: 'worked', id: 'w-' + turn.id, ms: turn.durationMs! }, turn.id);
  }
  return { events, turnOf };
}

/** Every turn of a thread, read from the app-server. thread/read returns a whole thread; a paginated one (which
 *  thread/read no longer hydrates) is paged with thread/turns/list. A thread with nothing recorded yet, or that
 *  the server cannot read, has no history. */
export async function codexHistory(rpc: Rpc, threadId: string | undefined): Promise<CodexHistory> {
  if (!threadId) return empty();
  try {
    const r = await rpc.request<{ thread: { turns?: Turn[] } }>('thread/read', { threadId, includeTurns: true });
    return turnEvents(r.thread.turns ?? []);
  } catch (e) {
    try { return turnEvents(await pagedTurns(rpc, threadId)); }
    catch (e2) { log('codex', 'history of', threadId, (e as Error).message, '/', (e2 as Error).message); return empty(); }
  }
}

async function pagedTurns(rpc: Rpc, threadId: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  let cursor: string | null = null;
  do {
    const r: { data: Turn[]; nextCursor: string | null } = await rpc.request('thread/turns/list', { threadId, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' });
    turns.push(...r.data);
    cursor = r.nextCursor;
  } while (cursor);
  return turns;
}
