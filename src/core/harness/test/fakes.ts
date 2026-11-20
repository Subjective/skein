// Test doubles shared by the harness tests: an in-memory ChatHost.
import type { ChatHost } from '../../chat';
import type { Machine, ThreadEvent, ThreadMeta } from '../../../shared/types';

export function fakeHost(threads: Partial<ThreadMeta>[], machine: Partial<Machine> = {}) {
  const map = new Map<string, ThreadMeta>();
  for (const t of threads) map.set(t.id!, { harness: 'claude', machine: 'local', dir: process.cwd(), title: 'New thread', createdAt: 0, updatedAt: 0, status: 'idle', ...t } as ThreadMeta);
  const events: { thread: string; e: ThreadEvent; replace?: boolean }[] = [];
  const statuses: string[] = [];
  const m: Machine = { id: 'local', name: 'This computer', link: 'up', has: ['claude', 'codex'], ...machine };
  const host: ChatHost = {
    machine: () => m,
    thread: id => { const t = map.get(id); if (!t) throw new Error('no thread ' + id); return t; },
    update: (id, patch) => { const t = { ...map.get(id)!, ...patch }; map.set(id, t); if (patch.status) statuses.push(patch.status); },
    event: (thread, e, replace) => { events.push({ thread, e, replace }); },
  };
  /** Events as the UI would hold them: replaces applied in place. */
  const view = () => {
    const out: ThreadEvent[] = [];
    for (const { e } of events) { const i = out.findIndex(x => x.id === e.id); if (i >= 0) out[i] = e; else out.push(e); }
    return out;
  };
  return { host, events, statuses, view, thread: (id: string) => map.get(id)! };
}

export const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
export async function until(f: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timed out waiting'); await tick(5); }
}
