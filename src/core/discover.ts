// Finding sessions the harnesses already have, so the sidebar shows existing work on first launch.
// Claude Code: ~/.claude/projects/<slug>/<session-id>.jsonl   Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// Only the head of each file is read. Exported parsers are pure, for tests and for the SSH path.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Found { harness: 'claude' | 'codex'; sessionId: string; dir: string; title: string; branch?: string; updatedAt: number; createdAt: number }

const head = (file: string, bytes = 65536) => {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(bytes); const n = readSync(fd, b, 0, bytes, 0); return b.subarray(0, n).toString('utf8'); } finally { closeSync(fd); }
};
const lines = (text: string) => text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);
/** Harness-injected text (environment context, command wrappers) is not a title. */
const isNoise = (s: string) => !s.trim() || /^\s*</.test(s) || /^Caveat:/.test(s);

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ');
  return '';
};

export function parseClaudeHead(text: string): Omit<Found, 'updatedAt' | 'createdAt' | 'sessionId'> & { sessionId?: string; created?: number } | null {
  let dir = '', title = '', summary = '', branch: string | undefined, sessionId: string | undefined, created: number | undefined;
  for (const o of lines(text)) {
    if (o.type === 'summary' && o.summary && !summary) summary = o.summary;
    if (o.cwd && !dir) dir = o.cwd;
    if (o.gitBranch && !branch) branch = o.gitBranch;
    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.timestamp && !created) created = Date.parse(o.timestamp);
    if (o.type === 'user' && !title && !o.isMeta) { const t = textOf(o.message?.content); if (!isNoise(t)) title = tidy(t); }
  }
  if (!dir) return null;
  return { harness: 'claude', dir, title: summary || title || 'Untitled', branch, sessionId, created };
}

export function parseCodexHead(text: string): Omit<Found, 'updatedAt' | 'createdAt'> & { created?: number } | null {
  let dir = '', title = '', id = '', branch: string | undefined, created: number | undefined;
  for (const o of lines(text)) {
    const p = o.payload || {};
    if (o.type === 'session_meta') { id = p.id; dir = p.cwd; branch = p.git?.branch; created = Date.parse(p.timestamp || o.timestamp); }
    if (!title && o.type === 'event_msg' && p.type === 'user_message' && !isNoise(p.message || '')) title = tidy(p.message);
    if (!title && o.type === 'response_item' && p.type === 'message' && p.role === 'user') { const t = textOf(p.content); if (!isNoise(t)) title = tidy(t); }
  }
  if (!id || !dir) return null;
  return { harness: 'codex', sessionId: id, dir, title: title || 'Untitled', branch, created };
}

const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };

/** Local discovery, newest first, at most `limit` per harness. */
export function discoverLocal(limit = 150, home = homedir()): Found[] {
  const out: Found[] = [];
  const claudeRoot = join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
  const cfiles = safe(() => readdirSync(claudeRoot), [] as string[]).flatMap(d => safe(() => readdirSync(join(claudeRoot, d)).filter(f => f.endsWith('.jsonl')).map(f => join(claudeRoot, d, f)), [] as string[]));
  for (const f of newest(cfiles, limit)) {
    const st = statSync(f.file); const h = safe(() => parseClaudeHead(head(f.file)), null);
    if (h) out.push({ ...h, sessionId: h.sessionId || f.file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, ''), updatedAt: st.mtimeMs, createdAt: h.created || st.birthtimeMs });
  }
  const codexRoot = join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions');
  const xfiles: string[] = [];
  const walk = (d: string, depth: number) => { for (const e of safe(() => readdirSync(d, { withFileTypes: true }), [])) { const p = join(d, e.name); if (e.isDirectory() && depth < 4) walk(p, depth + 1); else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) xfiles.push(p); } };
  walk(codexRoot, 0);
  for (const f of newest(xfiles, limit)) {
    const st = statSync(f.file); const h = safe(() => parseCodexHead(head(f.file)), null);
    if (h) out.push({ ...h, updatedAt: st.mtimeMs, createdAt: h.created || st.birthtimeMs });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

const newest = (files: string[], n: number) => files.map(file => ({ file, m: safe(() => statSync(file).mtimeMs, 0) })).sort((a, b) => b.m - a.m).slice(0, n);
