// Claude Code history: ~/.claude/projects/<slug>/<session-id>.jsonl folded into ThreadEvents.
// A transcript is a tree: an edit-and-resend or a rewind starts a new branch from an older entry, so the
// conversation is the chain from the newest entry back through parentUuid, not the file in order.
import type { Machine, ThreadEvent } from '../../../shared/types';
import { jsonLines, readHarnessFile } from '../common';
import { ClaudeFold, collector, promptOf, type AssistantIn, type UserIn } from './fold';

type Entry = Record<string, unknown> & { uuid?: string; parentUuid?: string | null; logicalParentUuid?: string | null; type?: string; isSidechain?: boolean; timestamp?: string };

const CHAIN = new Set(['user', 'assistant', 'system', 'attachment']);

/** The entries of the current branch, oldest first. */
export function currentChain(entries: Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of entries) if (e.uuid && CHAIN.has(String(e.type)) && !e.isSidechain) byId.set(e.uuid, e);
  // The newest leaf: the last chain entry in the file. A `last-prompt` record names it explicitly when present.
  let leafId: string | undefined;
  for (let i = entries.length - 1; i >= 0 && !leafId; i--) {
    const e = entries[i];
    if (e.uuid && byId.has(e.uuid)) leafId = e.uuid;
  }
  const out: Entry[] = [];
  const seen = new Set<string>();
  let cur = leafId ? byId.get(leafId) : undefined;
  while (cur && cur.uuid && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    out.push(cur);
    const next = cur.parentUuid ?? cur.logicalParentUuid ?? null;
    cur = next ? byId.get(next) : undefined;
  }
  return out.reverse();
}

export interface ClaudeHistory { events: ThreadEvent[]; fold: ClaudeFold }

/** Fold transcript text into events. Pure, for tests. */
export function parseClaudeTranscript(text: string): ClaudeHistory {
  const c = collector();
  const fold = new ClaudeFold(c.emit);
  const chain = currentChain(jsonLines(text) as Entry[]);
  let turnStart: number | null = null, turnEnd = 0, turnId = '';
  const endTurn = () => {
    if (turnStart != null && turnEnd - turnStart >= 1000) fold.worked('w-' + turnId, turnEnd - turnStart);
    turnStart = null;
  };
  for (const e of chain) {
    const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (e.type === 'user') {
      const p = promptOf(e as unknown as UserIn);
      if (p && p !== 'interrupted') { endTurn(); turnStart = at; turnId = String(e.uuid); }
      fold.user(e as unknown as UserIn);
      if (!Number.isNaN(at)) turnEnd = at;
    } else if (e.type === 'assistant') {
      fold.assistant(e as unknown as AssistantIn);
      if (!Number.isNaN(at)) turnEnd = at;
    } else if (e.type === 'system') {
      if (e.subtype === 'compact_boundary') fold.notice('c-' + e.uuid, 'Context compacted');
      else if (e.subtype === 'turn_duration' && typeof e.durationMs === 'number' && turnStart != null) { fold.worked('w-' + turnId, e.durationMs); turnStart = null; }
    }
  }
  endTurn();
  return { events: c.list, fold };
}

/** The transcript of a session on a machine, or null when it does not exist (yet). */
export function readClaudeTranscript(m: Machine, sessionId: string): Promise<string | null> {
  if (!/^[\w-]+$/.test(sessionId)) return Promise.resolve(null);
  return readHarnessFile(m, [...configDir(m), 'projects', '*', `${sessionId}.jsonl`]);
}

/** ~/.claude, or CLAUDE_CONFIG_DIR when it is set for this computer and lives under the home folder. */
function configDir(m: Machine): string[] {
  const dir = !m.ssh ? process.env.CLAUDE_CONFIG_DIR : undefined;
  if (dir) {
    const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/[\\/]+$/, '');
    if (home && dir.startsWith(home)) return dir.slice(home.length).split(/[\\/]+/).filter(Boolean);
  }
  return ['.claude'];
}

export async function claudeHistory(m: Machine, sessionId: string | undefined): Promise<ThreadEvent[]> {
  if (!sessionId) return [];
  const text = await readClaudeTranscript(m, sessionId);
  return text ? parseClaudeTranscript(text).events : [];
}
