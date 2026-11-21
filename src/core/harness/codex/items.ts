// Codex ThreadItems (app-server v2) to ThreadEvents. The live driver and the rollout reader both go
// through itemEvents, so an event's id is the item's id from either source.
import type { StepKind, ThreadEvent } from '../../../shared/types';
import { clip, countDiff, errorKind, textOf, tidy } from '../common';
import type { CollabAgentStatus } from './protocol/v2/CollabAgentStatus';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { TurnError } from './protocol/v2/TurnError';

type Status = 'running' | 'done' | 'failed';
const st = (s: string | null | undefined, ok = true): Status => (s === 'inProgress' ? 'running' : s === 'completed' && ok ? 'done' : s === 'completed' ? 'failed' : s == null ? 'done' : 'failed');
const dur = (ms: number | null | undefined) => (ms == null ? undefined : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** Text a harness puts in the user's turn (environment context, instructions), not typed by the user. */
const injected = (s: string) => /^\s*<(environment_context|user_instructions|turn_aborted|permissions|skills_instructions|INSTRUCTIONS)/.test(s) || /^# AGENTS\.md instructions/.test(s);

type Command = Extract<ThreadItem, { type: 'commandExecution' }>;
/** A shell command as the step it is. Codex runs reads, searches and listings as commands and tags each one
 *  (commandActions): one tagged action shows as that step ("Read restore.ts"), anything else as the command itself,
 *  without the shell wrapper Codex runs it in. */
export function commandStep(item: Pick<Command, 'command' | 'commandActions'>): { t: 'tool'; name: string; arg: string; kind: StepKind } {
  const acts = item.commandActions ?? [], a = acts.length === 1 ? acts[0] : null;
  if (a?.type === 'read') return { t: 'tool', name: 'Read', arg: a.path || a.name, kind: 'read' };
  if (a?.type === 'search') return { t: 'tool', name: 'Search', arg: [a.query, a.path].filter(Boolean).join('  '), kind: 'search' };
  if (a?.type === 'listFiles') return { t: 'tool', name: 'List', arg: a.path || '.', kind: 'list' };
  return { t: 'tool', name: 'Shell', arg: unwrap(item.command), kind: 'command' };
}
/** `/bin/bash -lc 'pnpm test'` to `pnpm test`: the command Codex was asked to run, not how it ran it. */
export const unwrap = (c: string) => {
  const m = /^(?:\S*\/)?(?:ba|z)?sh -l?c (?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")$/.exec(c.trim());
  return !m ? c : m[1] != null ? m[1].replace(/'\\''/g, "'") : m[2].replace(/\\(["\\$`])/g, '$1');
};

export function itemEvents(item: ThreadItem): ThreadEvent[] {
  switch (item.type) {
    case 'userMessage': {
      const text = item.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');
      if (injected(text)) return [];
      const images = item.content.flatMap(c => (c.type === 'image' && 'url' in c ? [c.url] : c.type === 'localImage' ? [c.path] : []));
      const mentions = item.content.flatMap(c => (c.type === 'mention' || c.type === 'skill' ? [`@${c.name}`] : []));
      // the client's id when it sent one: Skein shows its own message under that id as it sends it
      return [{ t: 'user', id: item.clientId ?? item.id, text: [text, ...mentions].filter(Boolean).join(' '), ...(images.length ? { images } : {}) }];
    }
    case 'agentMessage': return item.text.trim() ? [{ t: 'text', id: item.id, text: item.text }] : [];
    case 'plan': return item.text.trim() ? [{ t: 'text', id: item.id, text: item.text }] : [];
    case 'reasoning': {
      const text = (item.summary.length ? item.summary : item.content).join('\n\n').trim();
      return text ? [{ t: 'thinking', id: item.id, text }] : [];
    }
    case 'commandExecution': {
      const ok = item.exitCode == null || item.exitCode === 0;
      const meta = [item.exitCode != null && item.exitCode !== 0 ? `exit ${item.exitCode}` : '', dur(item.durationMs) ?? ''].filter(Boolean).join(' · ');
      return [{ ...commandStep(item), id: item.id, ...(item.aggregatedOutput ? { out: clip(item.aggregatedOutput) } : {}), status: item.status === 'declined' ? 'failed' : st(item.status, ok), ...(meta ? { meta } : {}) }];
    }
    case 'fileChange': {
      const status = item.status === 'declined' ? 'failed' : st(item.status);
      return item.changes.map((c, i) => {
        // a new file arrives as its content: one + per line, the final newline is not a line
        const diff = c.kind.type === 'add' && !/^[-+@]/m.test(c.diff) ? c.diff.replace(/\n$/, '').split('\n').map(l => '+' + l).join('\n') : c.diff;
        return { t: 'edit' as const, id: item.changes.length > 1 ? `${item.id}:${i}` : item.id, path: c.kind.type === 'update' && c.kind.move_path ? c.kind.move_path : c.path, ...countDiff(diff), diff: clip(diff, 20000), status };
      });
    }
    case 'mcpToolCall': {
      const out = item.error?.message ?? (item.result ? textOf(item.result.content) : '');
      return [{ t: 'tool', id: item.id, kind: 'mcp', name: `${item.server}: ${item.tool}`, arg: argText(item.arguments), ...(out ? { out: clip(out) } : {}), status: item.error ? 'failed' : st(item.status), ...(dur(item.durationMs) ? { meta: dur(item.durationMs) } : {}) }];
    }
    case 'dynamicToolCall': {
      const out = item.contentItems ? textOf(item.contentItems) : '';
      return [{ t: 'tool', id: item.id, name: item.tool, arg: argText(item.arguments), ...(out ? { out: clip(out) } : {}), status: item.success === false ? 'failed' : st(item.status) }];
    }
    case 'webSearch': {
      const a = item.action;
      const arg = a?.type === 'openPage' ? a.url ?? '' : a?.type === 'findInPage' ? `${a.pattern ?? ''}  ${a.url ?? ''}` : item.query || a?.type === 'search' && (a.query ?? a.queries?.join(', ')) || '';
      return [{ t: 'tool', id: item.id, kind: 'web', name: a?.type === 'openPage' ? 'Open page' : 'Web search', arg: arg || '', status: 'done' }];
    }
    case 'collabAgentToolCall': {
      if (item.tool !== 'spawnAgent') return [];
      // a sub-agent is a Codex thread of its own: its turns are read, and follow-ups sent, through that thread's id
      const agent = item.receiverThreadIds[0];
      const state = agent ? item.agentsStates[agent] : undefined;
      const status: Status = state ? agentStatus(state.status) : item.status === 'failed' ? 'failed' : 'running';
      return [{ t: 'sub', id: item.id, name: item.model ? `Agent (${item.model})` : 'Agent', task: tidy(item.prompt ?? '', 160), status, ...(agent ? { agent, followUps: true } : {}) }];
    }
    case 'imageView': return [{ t: 'tool', id: item.id, kind: 'read', name: 'View image', arg: item.path, status: 'done' }];
    case 'contextCompaction': return [{ t: 'notice', id: item.id, text: 'Context compacted' }];
    case 'enteredReviewMode': return [{ t: 'notice', id: item.id, text: 'Reviewing' }];
    case 'exitedReviewMode': return item.review.trim() ? [{ t: 'text', id: item.id, text: item.review }] : [];
    default: return [];
  }
}

const agentStatus = (s: CollabAgentStatus): Status => (s === 'pendingInit' || s === 'running' ? 'running' : s === 'completed' ? 'done' : 'failed');

/** The sub-agent states a collab call reports (a wait, a close), by the sub-agent's thread id: what the
 *  sub events that spawned them should now say. */
export function agentStates(item: ThreadItem): Map<string, Status> {
  const out = new Map<string, Status>();
  if (item.type !== 'collabAgentToolCall') return out;
  for (const [id, st] of Object.entries(item.agentsStates)) if (st) out.set(id, agentStatus(st.status));
  return out;
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
