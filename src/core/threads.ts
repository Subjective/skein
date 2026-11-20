// Skein's thread records. Discovery merges sessions found on disk; ids are stable per harness session.
import { randomUUID } from 'node:crypto';
import type { NewThread } from '../shared/api';
import type { ThreadMeta } from '../shared/types';
import { discoverLocal } from './discover';
import { emit } from './events';
import type { Store } from './store';

export class Threads {
  private map = new Map<string, ThreadMeta>();
  constructor(private store: Store) {
    for (const t of store.rows<ThreadMeta>('threads')) this.map.set(t.id, { ...t, status: t.status === 'running' ? 'idle' : t.status });
  }
  list() { return [...this.map.values()]; }
  get(id: string) { const t = this.map.get(id); if (!t) throw new Error(`Unknown thread ${id}`); return t; }
  bySession(sessionId: string) { return this.list().find(t => t.sessionId === sessionId); }

  update(id: string, patch: Partial<ThreadMeta>): ThreadMeta {
    const t = { ...this.get(id), ...patch, id };
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
      parent: spec.parent, side: !!spec.parent,
    };
    this.map.set(t.id, t); this.store.put('threads', t.id, t); emit({ type: 'thread', thread: t });
    return t;
  }

  /** Merge sessions found on this computer. Returns the threads that were new. */
  discover(machine: string): ThreadMeta[] {
    if (machine !== 'local') return []; // remote discovery: see HANDOFF "Workstreams"
    const added: ThreadMeta[] = [];
    for (const f of discoverLocal()) {
      const known = this.bySession(f.sessionId);
      if (known) { if (f.updatedAt > known.updatedAt) this.update(known.id, { updatedAt: f.updatedAt, ...(known.title === 'New thread' ? { title: f.title } : {}) }); continue; }
      const t: ThreadMeta = { id: 't-' + f.sessionId.slice(0, 8), harness: f.harness, sessionId: f.sessionId, machine, dir: f.dir, title: f.title, branch: f.branch, createdAt: f.createdAt, updatedAt: f.updatedAt, status: 'idle', discovered: true, drive: f.harness === 'claude' ? 'chat' : undefined };
      this.map.set(t.id, t); this.store.put('threads', t.id, t); added.push(t);
    }
    return added;
  }
}
