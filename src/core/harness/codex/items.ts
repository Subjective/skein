// Codex ThreadItems (app-server v2) to ThreadEvents. The live driver and the rollout reader both go
// through itemEvents, so an event's id is the item's id from either source.
import type { ThreadEvent } from '../../../shared/types';
import { clip, countDiff, errorKind, textOf, tidy } from '../common';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { TurnError } from './protocol/v2/TurnError';

type Status = 'running' | 'done' | 'failed';
const st = (s: string | null | undefined, ok = true): Status => (s === 'inProgress' ? 'running' : s === 'completed' && ok ? 'done' : s === 'completed' ? 'failed' : s == null ? 'done' : 'failed');
const dur = (ms: number | null | undefined) => (ms == null ? undefined : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** Text a harness puts in the user's turn (environment context, instructions), not typed by the user. */
const injected = (s: string) => /^\s*<(environment_context|user_instructions|turn_aborted|permissions|skills_instructions|INSTRUCTIONS)/.test(s) || /^# AGENTS\.md instructions/.test(s);

export function itemEvents(item: ThreadItem): ThreadEvent[] {
  switch (item.type) {
    case 'userMessage': {
      if (!Array.isArray(item.content)) return [];
      const text = item.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');
      if (injected(text)) return [];
      const images = item.content.flatMap(c => (c.type === 'image' && 'url' in c ? [c.url] : c.type === 'localImage' ? [c.path] : []));
      const mentions = item.content.flatMap(c => (c.type === 'mention' || c.type === 'skill' ? [`@${c.name}`] : []));
      return [{ t: 'user', id: item.id, text: [text, ...mentions].filter(Boolean).join(' '), ...(images.length ? { images } : {}) }];
    }
    case 'agentMessage': case 'plan': { const text = textOfItem(item); return text.trim() ? [{ t: 'text', id: item.id, text }] : []; }
    case 'reasoning': {
      // the app-server sends summary / content; rollouts store the core item's summary_text / raw_content
      const r = item as unknown as { summary?: string[]; content?: string[]; summaryText?: string[]; rawContent?: string[] };
      const summary = r.summary ?? r.summaryText ?? [], content = r.content ?? r.rawContent ?? [];
      const text = (summary.length ? summary : content).join('\n\n').trim();
      return text ? [{ t: 'thinking', id: item.id, text }] : [];
    }
    case 'commandExecution': {
      const ok = item.exitCode == null || item.exitCode === 0;
      const meta = [item.exitCode != null && item.exitCode !== 0 ? `exit ${item.exitCode}` : '', dur(item.durationMs) ?? ''].filter(Boolean).join(' · ');
      return [{ t: 'tool', id: item.id, name: 'Shell', arg: item.command, ...(item.aggregatedOutput ? { out: clip(item.aggregatedOutput) } : {}), status: item.status === 'declined' ? 'failed' : st(item.status, ok), ...(meta ? { meta } : {}) }];
    }
    case 'fileChange': {
      const status = item.status === 'declined' ? 'failed' : st(item.status);
      const changes = item.changes ?? [];
      return changes.map((c, i) => {
        const raw = c.diff ?? '';
        // a new file arrives as its content: one + per line, without counting the final newline as a line
        const diff = c.kind?.type === 'add' && !/^[-+@]/m.test(raw) ? raw.replace(/\n$/, '').split('\n').map(l => '+' + l).join('\n') : raw;
        return { t: 'edit' as const, id: changes.length > 1 ? `${item.id}:${i}` : item.id, path: c.kind?.type === 'update' && c.kind.move_path ? c.kind.move_path : c.path, ...countDiff(diff), diff: clip(diff, 20000), status };
      });
    }
    case 'mcpToolCall': {
      const out = item.error?.message ?? (item.result ? textOf(item.result.content) : '');
      return [{ t: 'tool', id: item.id, name: `${item.server}: ${item.tool}`, arg: argText(item.arguments), ...(out ? { out: clip(out) } : {}), status: item.error ? 'failed' : st(item.status), ...(dur(item.durationMs) ? { meta: dur(item.durationMs) } : {}) }];
    }
    case 'dynamicToolCall': {
      const out = item.contentItems ? textOf(item.contentItems) : '';
      return [{ t: 'tool', id: item.id, name: item.tool, arg: argText(item.arguments), ...(out ? { out: clip(out) } : {}), status: item.success === false ? 'failed' : st(item.status) }];
    }
    case 'webSearch': {
      const a = item.action;
      const arg = a?.type === 'openPage' ? a.url ?? '' : a?.type === 'findInPage' ? `${a.pattern ?? ''}  ${a.url ?? ''}` : item.query || a?.type === 'search' && (a.query ?? a.queries?.join(', ')) || '';
      return [{ t: 'tool', id: item.id, name: a?.type === 'openPage' ? 'Open page' : 'Web search', arg: arg || '', status: 'done' }];
    }
    case 'collabAgentToolCall': {
      if (item.tool !== 'spawnAgent') return [];
      const status: Status = item.status === 'inProgress' ? 'running' : item.status === 'completed' ? 'done' : 'failed';
      return [{ t: 'sub', id: item.id, name: item.model ? `Agent (${item.model})` : 'Agent', task: tidy(item.prompt ?? '', 160), status }];
    }
    case 'imageView': return [{ t: 'tool', id: item.id, name: 'View image', arg: item.path, status: 'done' }];
    case 'contextCompaction': return [{ t: 'notice', id: item.id, text: 'Context compacted' }];
    case 'enteredReviewMode': return [{ t: 'notice', id: item.id, text: 'Reviewing' }];
    case 'exitedReviewMode': return item.review?.trim() ? [{ t: 'text', id: item.id, text: item.review }] : [];
    default: return [];
  }
}

/** An agent message's or plan's text. The app-server sends `text`; rollouts store the core item, whose agent
 *  message has `content: [{ type: 'Text', text }]` instead. */
function textOfItem(item: ThreadItem): string {
  const o = item as unknown as { text?: unknown; content?: unknown };
  if (typeof o.text === 'string') return o.text;
  return Array.isArray(o.content) ? o.content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('') : '';
}

/** The core item's fields that differ in shape (not only in case) from the app-server's. */
function coreFields(raw: Record<string, unknown>): Record<string, unknown> {
  const o = { ...raw };
  if (Array.isArray(o.command)) {
    const argv = o.command.map(String);
    // `bash -lc <script>` (and Windows' `powershell -Command <script>`): the script is the command
    const i = argv.findIndex(a => /^-(l?c|Command)$/i.test(a));
    o.command = i >= 0 && i === argv.length - 2 ? argv[i + 1] : argv.join(' ');
  }
  const d = o.duration as { secs?: number; nanos?: number } | undefined;
  if (o.duration_ms == null && d && typeof d === 'object') o.duration_ms = Math.round((d.secs ?? 0) * 1000 + (d.nanos ?? 0) / 1e6);
  if (o.changes && typeof o.changes === 'object' && !Array.isArray(o.changes)) {
    // { path: { type: 'add' | 'delete', content } | { type: 'update', unified_diff, move_path } }; paths are kept as they are
    o.changes = Object.entries(o.changes as Record<string, Record<string, unknown>>).map(([path, c]) => {
      const type = String(c?.type ?? 'update').toLowerCase();
      const body = String(c?.unified_diff ?? c?.content ?? '');
      const diff = type === 'delete' && !/^[-+@]/m.test(body) ? body.replace(/\n$/, '').split('\n').map(l => '-' + l).join('\n') : body;
      return { path, kind: { type, move_path: c?.move_path ?? null }, diff };
    });
  }
  return o;
}

const argText = (v: unknown) => {
  if (v == null) return '';
  if (typeof v === 'string') return tidy(v, 200);
  if (typeof v === 'object') { const s = Object.values(v as object).find(x => typeof x === 'string'); return tidy(s ?? JSON.stringify(v), 200); }
  return String(v);
};

/** A turn's failure as an error row (G9). */
export function turnError(id: string, e: TurnError): ThreadEvent {
  const info = typeof e.codexErrorInfo === 'string' ? e.codexErrorInfo : e.codexErrorInfo ? JSON.stringify(e.codexErrorInfo) : '';
  const text = [e.message, e.additionalDetails].filter(Boolean).join('\n');
  let kind = errorKind(`${info} ${text}`);
  if (/usageLimitExceeded|rateLimitExceeded|serverOverloaded/.test(info)) kind = 'rate';
  else if (/unauthorized|"httpStatusCode":401/.test(info)) kind = 'auth';
  return { t: 'error', id, kind, text: tidy(text || 'The turn failed.', 600) };
}

/** Rollouts store the core's items: snake_case keys, PascalCase types, and some fields in another shape than
 *  the app-server's (a command as argv, file changes keyed by path, a duration as secs / nanos). This turns one
 *  into the app-server's camelCase ThreadItem. */
export function camelItem(raw: Record<string, unknown>): ThreadItem {
  raw = coreFields(raw);
  const camel = (v: unknown, depth: number): unknown => {
    if (Array.isArray(v)) return v.map(x => camel(x, depth + 1));
    if (!v || typeof v !== 'object' || depth > 6) return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const key = k === 'move_path' ? k : k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      o[key] = key === 'arguments' || key === 'structuredContent' ? x : camel(x, depth + 1);
    }
    return o;
  };
  const o = camel(raw, 0) as Record<string, unknown>;
  const low = (x: unknown) => (typeof x === 'string' ? x.charAt(0).toLowerCase() + x.slice(1) : x);
  o.type = low(o.type);
  if (typeof o.status === 'string') o.status = low(o.status);
  if (Array.isArray(o.changes)) for (const c of o.changes as { kind?: { type?: unknown } | string }[]) {
    if (typeof c.kind === 'string') c.kind = { type: low(c.kind) as string };
    else if (c.kind) c.kind.type = low(c.kind.type);
  }
  return o as unknown as ThreadItem;
}
