// Codex history: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl folded into ThreadEvents.
// Current rollouts record each finished item (`event_msg` / `item_completed`) exactly as the app-server sends
// it, so those go through itemEvents and keep the live ids. Older rollouts only have the model's messages
// and tool calls; those are read from `event_msg` and `response_item` lines instead.
import type { Machine, ThreadEvent } from '../../../shared/types';
import { clip, countDiff, jsonLines, readHarnessFile, tidy } from '../common';
import { collector } from '../claude/fold';
import { camelItem, itemEvents, turnError } from './items';

export interface CodexHistory {
  events: ThreadEvent[];
  /** Event id → the turn it belongs to: side chats fork through it (lastTurnId), edits revert before it. */
  turnOf: Map<string, string>;
}

type Line = { timestamp?: string; type?: string; payload?: Record<string, unknown> };

export function parseCodexRollout(text: string | Record<string, unknown>[]): CodexHistory {
  const lines = (typeof text === 'string' ? jsonLines(text) : text) as Line[];
  const modern = lines.some(l => l.type === 'event_msg' && l.payload?.type === 'item_completed');
  const c = collector();
  const turnOf = new Map<string, string>();
  let turn = '';
  const put = (e: ThreadEvent) => { c.emit(e, true); if (turn) turnOf.set(e.id, turn); };
  const calls = new Map<string, ThreadEvent>();
  let n = 0;
  const nid = (p: string) => `${p}-${n++}`;

  for (const l of lines) {
    const p = l.payload ?? {};
    const pt = String(p.type ?? '');
    if (l.type === 'event_msg') {
      if (pt === 'task_started' || pt === 'turn_started') turn = String(p.turn_id ?? turn);
      else if (pt === 'item_completed' && p.item) { if (p.turn_id) turn = String(p.turn_id); for (const e of itemEvents(camelItem(p.item as Record<string, unknown>))) put(e); }
      else if (pt === 'turn_aborted') put({ t: 'interrupted', id: 'i-' + (p.turn_id ?? nid('t')) });
      else if (pt === 'task_complete' || pt === 'turn_complete') { const ms = Number(p.duration_ms ?? 0); if (ms >= 1000) put({ t: 'worked', id: 'w-' + (p.turn_id ?? nid('t')), ms }); }
      else if (pt === 'error') put(turnError(nid('e'), { message: String(p.message ?? 'The turn failed.'), codexErrorInfo: (p.codex_error_info ?? null) as never, additionalDetails: null, misalignment: null }));
      else if (pt === 'context_compacted') put({ t: 'notice', id: nid('c'), text: 'Context compacted' });
      else if (!modern) legacyEvent(pt, p);
    } else if (l.type === 'compacted' && !modern) put({ t: 'notice', id: nid('c'), text: 'Context compacted' });
    else if (l.type === 'response_item' && !modern) legacyItem(pt, p);
  }

  function legacyEvent(pt: string, p: Record<string, unknown>) {
    if (pt === 'user_message') { const text = String(p.message ?? ''); if (text.trim() && !/^\s*</.test(text)) put({ t: 'user', id: nid('u'), text, ...(Array.isArray(p.images) && p.images.length ? { images: p.images as string[] } : {}) }); }
    else if (pt === 'agent_message') { const text = String(p.message ?? ''); if (text.trim()) put({ t: 'text', id: nid('m'), text }); }
    else if (pt === 'agent_reasoning') { const text = String(p.text ?? ''); if (text.trim()) put({ t: 'thinking', id: nid('r'), text }); }
  }

  function legacyItem(pt: string, p: Record<string, unknown>) {
    if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'local_shell_call') {
      const id = String(p.call_id ?? p.id ?? nid('f'));
      const name = String(p.name ?? 'shell');
      let args: Record<string, unknown> = {};
      try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.action as Record<string, unknown>) ?? {}; } catch { /* not JSON */ }
      const input = typeof p.input === 'string' ? p.input : '';
      if (name === 'apply_patch' || /\*\*\* Begin Patch/.test(input)) {
        for (const [i, f] of patchFiles(input || String(args.input ?? '')).entries()) put(remember(`${id}:${i}`, { t: 'edit', id: `${id}:${i}`, path: f.path, ...countDiff(f.diff), diff: clip(f.diff, 20000), status: 'done' }));
        return;
      }
      const cmd = Array.isArray(args.command) ? (args.command as string[]).slice(-1)[0] : String(args.command ?? args.cmd ?? input ?? '');
      put(remember(id, { t: 'tool', id, name: name === 'shell' || name === 'exec_command' || pt === 'local_shell_call' ? 'Shell' : name, arg: tidy(cmd, 300), status: 'running' }));
    } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
      const id = String(p.call_id ?? '');
      const e = calls.get(id);
      if (!e || e.t !== 'tool') return;
      const raw = p.output as unknown;
      let out = typeof raw === 'string' ? raw : JSON.stringify(raw);
      try { const o = JSON.parse(out); if (o && typeof o.output === 'string') out = o.output; } catch { /* plain text */ }
      put(remember(id, { ...e, out: clip(out), status: 'done' }));
    }
  }

  function remember(id: string, e: ThreadEvent) { calls.set(id, e); return e; }

  // A tool still running at the end of an old rollout was cut off.
  for (const e of c.list) if ((e.t === 'tool' || e.t === 'edit' || e.t === 'sub') && e.status === 'running' && !modern) c.emit({ ...e, status: 'done' }, true);
  return { events: c.list, turnOf };
}

/** Files and per-file diffs of an apply_patch body. */
export function patchFiles(patch: string): { path: string; diff: string }[] {
  const out: { path: string; diff: string }[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  for (const l of patch.split('\n')) {
    const m = l.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) { if (cur) out.push({ path: cur.path, diff: cur.lines.join('\n') }); cur = { path: m[2].trim(), lines: [] }; continue; }
    const mv = l.match(/^\*\*\* Move to: (.+)$/);
    if (mv && cur) { cur.path = mv[1].trim(); continue; }
    if (l.startsWith('*** ')) continue;
    if (cur) cur.lines.push(l);
  }
  if (cur) out.push({ path: cur.path, diff: cur.lines.join('\n') });
  return out;
}

export function readCodexRollout(m: Machine, threadId: string): Promise<string | null> {
  if (!/^[\w-]+$/.test(threadId)) return Promise.resolve(null);
  const root = !m.ssh && process.env.CODEX_HOME ? null : '.codex';
  if (!root) return readCodexHome(threadId);
  return readHarnessFile(m, [root, 'sessions', '*', '*', '*', `rollout-*${threadId}.jsonl`]);
}

async function readCodexHome(threadId: string): Promise<string | null> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = join(process.env.CODEX_HOME!, 'sessions');
  const walk = async (d: string, depth: number): Promise<string | null> => {
    for (const e of (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => b.name.localeCompare(a.name))) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3) { const f = await walk(p, depth + 1); if (f) return f; }
      else if (e.name.startsWith('rollout-') && e.name.endsWith(`${threadId}.jsonl`)) return readFile(p, 'utf8');
    }
    return null;
  };
  return walk(root, 0);
}

export async function codexHistory(m: Machine, threadId: string | undefined): Promise<CodexHistory> {
  const text = threadId ? await readCodexRollout(m, threadId) : null;
  return text ? parseCodexRollout(text) : { events: [], turnOf: new Map() };
}
