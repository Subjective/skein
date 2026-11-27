// Antigravity history and discovery, read through a reader `agy acp` of its own on the machine (not the drivers'
// process, so a replay never reaches a live chat and agy's reset of a loaded session's model never reaches a
// session a chat is driving). History is session/load, which replays the session as updates before it answers
// (agy leaves thoughts and images out of the replay). Discovery is session/list.
import type { Machine, ThreadEvent } from '../../../shared/types';
import type { Found } from '../../discover';
import { log } from '../../log';
import { agyHome, type AgyServers, type SessionInfo, type Update } from './acp';
import { replay, subPromptId } from './fold';

const loading = new Map<string, Promise<ThreadEvent[]>>();

/** A session's turns as chat events. Empty when agy has no such session or can't be reached. */
export function agyHistory(readers: AgyServers, m: Machine, sessionId: string | undefined, cwd: string): Promise<ThreadEvent[]> {
  if (!sessionId) return Promise.resolve([]);
  const key = m.id + ':' + sessionId;
  let p = loading.get(key);
  if (p) return p;
  p = (async () => {
    const rpc = await readers.get(m);
    const updates: Update[] = [];
    const off = readers.listen(sessionId, { update: u => updates.push(u), permission: async () => ({ outcome: { outcome: 'cancelled' } }), exited: () => {} });
    try {
      await rpc.request('session/load', { sessionId, cwd, mcpServers: [] });
      return replay(updates, cwd);
    } finally {
      off();
      void rpc.request('session/close', { sessionId }).catch(() => undefined);
    }
  })().catch(e => { log('agy', 'history of', sessionId, (e as Error).message); return []; })
    .finally(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

/** A subagent's turns: its own session (sub.agent), led by a stand-in for its prompt, which agy's replay leaves out
 *  and the thread's subagent row carries (the popup puts that one in its place). */
export async function agySubHistory(readers: AgyServers, m: Machine, sub: { id: string; agent?: string }, cwd: string): Promise<ThreadEvent[]> {
  if (!sub.agent) return [];
  const evs = await agyHistory(readers, m, sub.agent, cwd);
  return evs.length ? [{ t: 'user', id: subPromptId(sub.id), text: '' }, ...evs] : [];
}

const strip = (p: string) => p.replace(/^\/private(?=\/(tmp|var)\/)/, '').replace(/[\\/]+$/, '');

/** A machine's Antigravity sessions, newest first. agy reports a session it can't place (one from before it kept
 *  folders) under the folder it runs in, Skein's own (agyHome): those are left out, as they belong nowhere. */
export async function agySessions(readers: AgyServers, m: Machine, limit: number): Promise<Found[]> {
  const rpc = await readers.get(m), home = strip(agyHome(m));
  const out: SessionInfo[] = [];
  let cursor: string | undefined;
  do {
    const r: { sessions?: SessionInfo[]; nextCursor?: string | null } = await rpc.request('session/list', cursor ? { cursor } : {});
    out.push(...(r.sessions ?? []));
    cursor = r.nextCursor ?? undefined;
  } while (cursor && out.length < limit);
  return out.filter(s => s.cwd && strip(s.cwd) !== home && !strip(s.cwd).endsWith('/.skein/agy')).slice(0, limit).map(s => {
    const at = s.updatedAt ? Date.parse(s.updatedAt) : NaN, when = Number.isFinite(at) ? at : Date.now();
    return { harness: 'agy' as const, sessionId: s.sessionId, dir: s.cwd, ...(s.title ? { title: s.title.replace(/\s+/g, ' ').trim().slice(0, 80) } : {}), updatedAt: when, createdAt: when };
  });
}
