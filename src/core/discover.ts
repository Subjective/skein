// Finding sessions the harnesses already have, so the sidebar shows existing work, under the harness's own titles.
// Each harness is asked where it can answer: Claude Code through the Agent SDK's listSessions() (its title: the one
// set with /rename, else the one it generates, else a prompt), Codex through its app-server's thread/list (the name
// set on the thread, else its preview, the first prompt). The SDK can't reach an SSH machine, so there Claude Code's
// transcripts are read: their head (folder, branch, first prompt) and their tail, where the titles are appended.
import type { Machine } from '../shared/types';
import type { Thread, ThreadListResponse } from './harness/codex/protocol/v2';
import type { Rpc } from './harness/codex/rpc';
import { runScript } from './exec';

/** A session found on a machine. No title: the harness has none yet (no prompt written). */
export interface Found { harness: 'claude' | 'codex'; sessionId: string; dir: string; title?: string; branch?: string; updatedAt: number; createdAt: number }

const tidy = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined;

/** This computer's Claude Code sessions, newest first, from the Agent SDK. */
export async function claudeLocal(limit: number): Promise<Found[]> {
  const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
  return (await listSessions({ limit })).flatMap(s => (s.cwd ? [{
    harness: 'claude' as const, sessionId: s.sessionId, dir: s.cwd, title: tidy(s.customTitle || s.summary),
    branch: s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : undefined,   // 'HEAD': no repo, or detached
    updatedAt: s.lastModified, createdAt: s.createdAt ?? s.lastModified,
  }] : []));
}

/** A machine's Codex threads, newest activity first, from its app-server. */
export async function codexThreads(rpc: Pick<Rpc, 'request'>, limit: number): Promise<Found[]> {
  const out: Thread[] = [];
  let cursor: string | null = null;
  do {
    const r: ThreadListResponse = await rpc.request('thread/list', { limit: limit - out.length, cursor, sortKey: 'updated_at' });
    out.push(...r.data);
    cursor = r.nextCursor;
  } while (cursor && out.length < limit);
  return out.slice(0, limit).map(t => ({
    harness: 'codex', sessionId: t.id, dir: t.cwd, title: tidy(t.name || t.preview), branch: t.gitInfo?.branch ?? undefined,
    updatedAt: t.updatedAt * 1000, createdAt: t.createdAt * 1000,
  }));
}

// ---- Claude Code on SSH machines: one round trip sends the head and tail of the newest transcripts ----

const lines = (text: string) => text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
/** Harness-injected text (environment context, command wrappers) is not a title. */
const isNoise = (s: string) => !s.trim() || /^\s*</.test(s) || /^Caveat:/.test(s);
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ');
  return '';
};

/** A Claude Code transcript's head and tail (either may hold a cut line, which is skipped). Titles go as
 *  Claude Code ranks them: the last /rename, else the last generated title, else the first prompt. */
export function parseClaudeTranscript(text: string): { dir: string; title?: string; branch?: string; sessionId?: string; created?: number } | null {
  let dir = '', prompt = '', custom = '', ai = '', branch: string | undefined, sessionId: string | undefined, created: number | undefined;
  for (const o of lines(text)) {
    if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
    if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
    if (o.cwd && !dir) dir = o.cwd;
    if (o.gitBranch && o.gitBranch !== 'HEAD' && !branch) branch = o.gitBranch; // 'HEAD': no repo, or detached
    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.timestamp && !created) created = Date.parse(o.timestamp);
    if (o.type === 'user' && !prompt && !o.isMeta) { const t = textOf(o.message?.content); if (!isNoise(t)) prompt = t; }
  }
  return dir ? { dir, title: tidy(custom || ai || prompt), branch, sessionId, created } : null;
}

/** sh script for discovery over SSH. Each file is framed by a \x1e header line: mtime, path. */
export function remoteDiscoverScript(limit = 60): string {
  return `C="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
if [ -d "$C" ]; then ls -t "$C"/*/*.jsonl 2>/dev/null | head -n ${limit} | while IFS= read -r f; do printf "\\036%s\\t%s\\n" "$(mt "$f")" "$f"; head -c 32768 "$f"; printf "\\n"; tail -c 32768 "$f"; printf "\\n"; done; fi
true
`;
}

/** Parse the script's output. Pure, for tests. */
export function parseRemoteDiscovery(out: string): Found[] {
  const found: Found[] = [];
  for (const chunk of out.split('\x1e')) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const [mtime, path] = chunk.slice(0, nl).split('\t');
    const updatedAt = (+mtime || 0) * 1000;
    const h = parseClaudeTranscript(chunk.slice(nl + 1));
    const sessionId = h?.sessionId || (path || '').replace(/^.*\//, '').replace(/\.jsonl$/, '');
    if (h && sessionId) found.push({ harness: 'claude', sessionId, dir: h.dir, title: h.title, branch: h.branch, updatedAt, createdAt: h.created || updatedAt });
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Claude Code sessions on an SSH machine, newest first. Throws when the machine can't be reached. */
export async function claudeRemote(m: Machine, limit = 60): Promise<Found[]> {
  const r = await runScript(m, remoteDiscoverScript(limit), { compress: true, timeout: 90000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `Could not list sessions on ${m.name}`);
  return parseRemoteDiscovery(r.stdout);
}
