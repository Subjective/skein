// Skein's thread records. Discovery merges sessions found on disk; ids are stable per harness session.
import { randomUUID } from 'node:crypto';
import type { NewThread } from '../shared/api';
import type { ThreadMeta } from '../shared/types';
import { discoverLocal, discoverRemote, type Found } from './discover';
import { emit } from './events';
import type { Store } from './store';

export class Threads {
  private map = new Map<string, ThreadMeta>();
  constructor(private store: Store) {
    for (const t of store.rows<ThreadMeta>('threads')) this.map.set(t.id, { ...t, status: t.status === 'running' ? 'idle' : t.status, ...(t.queue?.length ? { queuePaused: true } : {}) }); // nothing runs a queue after a restart until you resume it
  }
  list() { return [...this.map.values()]; }
  get(id: string) { const t = this.map.get(id); if (!t) throw new Error(`Unknown thread ${id}`); return t; }
  bySession(sessionId: string) { return this.list().find(t => t.sessionId === sessionId); }

  update(id: string, patch: Partial<ThreadMeta>): ThreadMeta {
    const prev = this.get(id);
    // activity moves a thread up the Recent list: a turn starting or ending, or it asking you something. Marking a
    // reply read or unread is not activity.
    const moved = patch.status && prev && patch.status !== prev.status && patch.status !== 'unread' && !(prev.status === 'unread' && patch.status === 'idle');
    const t = { ...prev, ...(moved && patch.updatedAt === undefined ? { updatedAt: Date.now() } : {}), ...patch, id };
    this.map.set(id, t); this.store.put('threads', id, t); emit({ type: 'thread', thread: t });
    return t;
  }

  create(spec: NewThread): ThreadMeta {
    const now = Date.now();
    const t: ThreadMeta = {
      id: 't-' + randomUUID().slice(0, 8), harness: spec.harness, machine: spec.machine, dir: spec.dir, title: 'New thread',
      model: spec.model, effort: spec.effort, perm: spec.perm, createdAt: now, updatedAt: now, status: 'idle',
      // Claude Code accepts a session id up front (--session-id), so the thread knows it before the first turn.
      sessionId: spec.harness === 'claude' ? randomUUID() : undefined,
      drive: spec.harness === 'claude' ? spec.view : undefined,
      parent: spec.parent, side: !!spec.side,
    };
    this.map.set(t.id, t); this.store.put('threads', t.id, t); emit({ type: 'thread', thread: t });
    return t;
  }

  /** Merge sessions found on a machine (this computer, or an SSH machine given as a Machine). Returns the
   *  threads that were new. Remote finds are pushed as 'thread' events too, since they arrive in the background. */
  async discover(machine: string, remote?: import('../shared/types').Machine): Promise<ThreadMeta[]> {
    const found: Found[] = remote?.ssh ? await discoverRemote(remote) : machine === 'local' ? discoverLocal() : [];
    const added: ThreadMeta[] = [];
    for (const f of found) {
      const known = this.bySession(f.sessionId);
      if (known) {
        const patch: Partial<ThreadMeta> = {};
        if (f.updatedAt > known.updatedAt) Object.assign(patch, { updatedAt: f.updatedAt }, known.title === 'New thread' ? { title: f.title } : {});
        if (Object.keys(patch).length) this.update(known.id, patch);
        continue;
      }
      const t: ThreadMeta = { id: discoveredId(f.sessionId, id => this.map.has(id)), harness: f.harness, sessionId: f.sessionId, machine, dir: f.dir, title: f.title, branch: f.branch, createdAt: f.createdAt, updatedAt: f.updatedAt, status: 'idle', discovered: true, drive: f.harness === 'claude' ? 'chat' : undefined };
      this.map.set(t.id, t); this.store.put('threads', t.id, t); added.push(t);
      if (remote) emit({ type: 'thread', thread: t });
    }
    return added;
  }
}

/** A found session's thread id. Its tail, not its head: Codex ids are UUIDv7, whose first 8 hex digits are a
 *  timestamp shared by every session started in the same ~65 seconds, so a head prefix let a second session
 *  overwrite the first. */
export function discoveredId(sessionId: string, taken: (id: string) => boolean): string {
  const id = 't-' + sessionId.replace(/-/g, '').slice(-12);
  return taken(id) ? 't-' + randomUUID().slice(0, 8) : id;
}
