// Folds Claude Code messages into ThreadEvents. The transcript (~/.claude/projects/.../<id>.jsonl) and the
// Agent SDK stream carry the same Anthropic-format messages, so history and the live driver share this,
// and an event has the same id from either source:
//   user        the transcript entry's uuid
//   text        `${message.id}:${n}` where n is the block's index in the API message
//   thinking    same as text
//   tool, edit, todo, sub   the tool_use id
import type { StepKind, ThreadEvent } from '../../../shared/types';
import { clip, countDiff, errorKind, replaceDiff, textOf, tidy } from '../common';

type Block = { type: string; [k: string]: unknown };
type Emit = (e: ThreadEvent, replace: boolean) => void;
type ToolEvent = Extract<ThreadEvent, { t: 'tool' | 'edit' | 'todo' | 'sub' }>;
type SubEvent = Extract<ThreadEvent, { t: 'sub' }> & { events?: ThreadEvent[] };

export interface AssistantIn {
  uuid?: string;
  message: { id?: string; content?: unknown; model?: string };
  isApiErrorMessage?: boolean;
  error?: string;
}
export interface UserIn {
  uuid?: string;
  parentUuid?: string | null;
  message: { content?: unknown };
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  isSynthetic?: boolean;
  toolUseResult?: unknown;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SUB_TOOLS = new Set(['Task', 'Agent']);
const INTERRUPTED = /^\[Request interrupted by user/;

/** Text the harness injects into the user's turn (reminders, hook output, command wrappers), not typed by them. */
export function userText(raw: string): string | null {
  const cmd = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return (cmd[1].trim().startsWith('/') ? cmd[1].trim() : '/' + cmd[1].trim()) + (args ? ' ' + args : '');
  }
  const t = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t || /^<(local-command-|command-|bash-|user-memory-input|task-notification)/.test(t) || /^Caveat: /.test(t)) return null;
  return t;
}

/** The one-line argument a tool row shows. */
export function toolArg(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash': return s('command');
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return s('file_path') || s('notebook_path');
    case 'Grep': return s('pattern') + (s('path') ? `  ${s('path')}` : '');
    case 'Glob': return s('pattern');
    case 'WebFetch': return s('url');
    case 'WebSearch': return s('query');
    case 'Skill': return s('skill') || s('command');
    default: {
      const first = Object.values(input).find(v => typeof v === 'string') as string | undefined;
      return tidy(first ?? JSON.stringify(input), 200);
    }
  }
}

/** A friendlier tool name: mcp__server__tool reads as "server: tool". */
/** Claude Code names each kind of step as its own tool. */
export const stepKind = (name: string): StepKind =>
  name === 'Read' || name === 'NotebookRead' ? 'read' : name === 'Grep' || name === 'Glob' ? 'search' : name === 'LS' ? 'list'
    : name === 'Bash' || name === 'BashOutput' || name === 'KillShell' ? 'command' : name === 'WebFetch' || name === 'WebSearch' ? 'web'
      : name.startsWith('mcp__') ? 'mcp' : 'other';

export const toolName = (name: string) => {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1].replace(/_/g, ' ')}: ${m[2].replace(/_/g, ' ')}` : name;
};

function editOf(id: string, name: string, input: Record<string, unknown>): Extract<ThreadEvent, { t: 'edit' }> {
  const path = String(input.file_path ?? input.notebook_path ?? '');
  let diff = '';
  if (name === 'Edit') diff = replaceDiff(path, String(input.old_string ?? ''), String(input.new_string ?? ''));
  else if (name === 'MultiEdit' && Array.isArray(input.edits)) diff = (input.edits as { old_string?: string; new_string?: string }[]).map(e => replaceDiff(path, e.old_string ?? '', e.new_string ?? '')).join('\n');
  else if (name === 'Write') diff = replaceDiff(path, '', String(input.content ?? ''));
  else if (name === 'NotebookEdit') diff = replaceDiff(path, '', String(input.new_source ?? ''));
  return { t: 'edit', id, path, ...countDiff(diff), diff: clip(diff, 20000), status: 'running' };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  return '';
}

const dataUrl = (b: Block): string | null => {
  const src = b.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
  if (src?.type === 'base64' && src.data) return `data:${src.media_type ?? 'image/png'};base64,${src.data}`;
  if (src?.type === 'url' && src.url) return src.url;
  return null;
};

/** What the user typed in this message, 'interrupted' for the interrupt marker, or null for tool results and injected text. */
export function promptOf(m: UserIn): { text: string; images: string[] } | 'interrupted' | null {
  if (m.isMeta || m.isSynthetic || m.isCompactSummary || m.isVisibleInTranscriptOnly) return null;
  const content = m.message.content;
  const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];
  if (blocks.some(b => b.type === 'tool_result')) return null;
  const raw = blocks.filter(b => b.type === 'text').map(b => String(b.text)).join('\n');
  if (INTERRUPTED.test(raw.trim())) return 'interrupted';
  const text = userText(raw);
  const images = blocks.filter(b => b.type === 'image').map(dataUrl).filter((x): x is string => !!x);
  if (text == null && !images.length) return null;
  return { text: text ?? '', images };
}

const fmtDur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

export class ClaudeFold {
  /** Event id → the transcript uuid that ends it. Side chats fork there; edits rewind to before a user event. */
  readonly uuidOf = new Map<string, string>();
  /** User event id → the uuid of the entry before it (where an edit-and-resend resumes). */
  readonly before = new Map<string, string | null>();
  private blocks = new Map<string, number>();
  private tools = new Map<string, ToolEvent>();
  private subs = new Map<string, { ev: SubEvent; fold: ClaudeFold; started: number }>();
  private last: string | null = null;

  constructor(private emit: Emit, private now: () => number = Date.now) {}

  assistant(m: AssistantIn, parentTool?: string | null) {
    if (parentTool) return this.toSub(parentTool, f => f.assistant(m));
    const msgId = m.message.id ?? m.uuid ?? 'm' + this.now();
    const content = Array.isArray(m.message.content) ? (m.message.content as Block[]) : [];
    if (m.isApiErrorMessage || m.error) {
      const text = textOf(content) || m.error || 'The request failed.';
      this.put({ t: 'error', id: m.uuid ?? msgId, kind: errorKind(text, m.error), text }, m.uuid);
      return;
    }
    for (const b of content) {
      const n = this.blocks.get(msgId) ?? 0;
      this.blocks.set(msgId, n + 1);
      const id = `${msgId}:${n}`;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) this.put({ t: 'text', id, text: b.text }, m.uuid);
      else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) this.put({ t: 'thinking', id, text: b.thinking }, m.uuid);
      else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') this.toolUse(String(b.id), String(b.name), (b.input ?? {}) as Record<string, unknown>, m.uuid);
    }
  }

  /** Streaming: the text or thinking of block n of message msgId so far. */
  partial(msgId: string, n: number, kind: 'text' | 'thinking', text: string) {
    const id = `${msgId}:${n}`;
    if (kind === 'text') this.put({ t: 'text', id, text, streaming: true }); else this.put({ t: 'thinking', id, text });
  }

  user(m: UserIn, parentTool?: string | null) {
    if (parentTool) return this.toSub(parentTool, f => f.user(m));
    const content = m.message.content;
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];
    const results = blocks.filter(b => b.type === 'tool_result');
    for (const r of results) this.toolResult(String(r.tool_use_id), r.content, !!r.is_error, m.toolUseResult, m.uuid);
    if (results.length || m.isMeta || m.isSynthetic || m.isCompactSummary || m.isVisibleInTranscriptOnly) { if (m.uuid) this.last = m.uuid; return; }
    const p = promptOf(m);
    if (p === 'interrupted') { this.put({ t: 'interrupted', id: m.uuid ?? 'i' + this.now() }, m.uuid); return; }
    if (!p) { if (m.uuid) this.last = m.uuid; return; }
    const id = m.uuid ?? 'u' + this.now();
    this.before.set(id, m.parentUuid ?? this.last);
    this.put({ t: 'user', id, text: p.text, ...(p.images.length ? { images: p.images } : {}) }, m.uuid);
  }

  notice(id: string, text: string) { this.put({ t: 'notice', id, text }); }
  worked(id: string, ms: number) { this.put({ t: 'worked', id, ms }); }
  error(id: string, kind: ErrorKindArg, text: string) { this.put({ t: 'error', id, kind, text }); }

  /** Mark every running tool as failed (the process died) or done (an interrupt). */
  settleRunning(status: 'failed' | 'done') {
    for (const e of this.tools.values()) if ('status' in e && e.status === 'running') this.update(e.id, { status } as Partial<ToolEvent>);
  }

  get lastUuid() { return this.last; }

  private toolUse(id: string, name: string, input: Record<string, unknown>, uuid?: string) {
    let e: ToolEvent;
    if (EDIT_TOOLS.has(name)) e = editOf(id, name, input);
    else if (name === 'TodoWrite' && Array.isArray(input.todos)) e = { t: 'todo', id, items: (input.todos as { content?: string; status?: string }[]).map(x => ({ text: String(x.content ?? ''), done: x.status === 'completed' })) };
    else if (SUB_TOOLS.has(name)) {
      const ev: SubEvent = { t: 'sub', id, name: String(input.subagent_type ?? 'Subagent'), task: String(input.description ?? input.prompt ?? ''), status: 'running', events: [] };
      this.subs.set(id, { ev, started: this.now(), fold: new ClaudeFold((se, rep) => this.subEvent(id, se, rep), this.now) });
      e = ev;
    } else e = { t: 'tool', id, name: toolName(name), arg: toolArg(name, input), status: 'running', kind: stepKind(name) };
    this.tools.set(id, e);
    this.put(e, uuid);
  }

  private toolResult(id: string, content: unknown, isError: boolean, extra: unknown, uuid?: string) {
    const e = this.tools.get(id);
    if (!e) return;
    const status = isError ? 'failed' : 'done';
    if (uuid) this.uuidOf.set(id, uuid);
    if (e.t === 'todo') return;
    if (e.t === 'sub') {
      const s = this.subs.get(id);
      const ms = (extra as { totalDurationMs?: number } | undefined)?.totalDurationMs ?? (s ? this.now() - s.started : 0);
      this.update(id, { status, ...(ms > 0 ? { dur: fmtDur(ms) } : {}) });
      return;
    }
    if (e.t === 'edit') { this.update(id, { status }); return; }
    const out = clip(resultText(content).replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1'));
    this.update(id, { status, out });
  }

  private toSub(toolId: string, f: (fold: ClaudeFold) => void) {
    const s = this.subs.get(toolId);
    if (s) f(s.fold);
  }

  private subEvent(toolId: string, e: ThreadEvent, replace: boolean) {
    const s = this.subs.get(toolId);
    if (!s) return;
    const list = s.ev.events ?? (s.ev.events = []);
    const i = replace ? list.findIndex(x => x.id === e.id) : -1;
    if (i >= 0) list[i] = e; else list.push(e);
    this.update(toolId, { events: [...list] } as Partial<SubEvent>);
  }

  private update(id: string, patch: Partial<ToolEvent>) {
    const e = this.tools.get(id);
    if (!e) return;
    const next = { ...e, ...patch } as ToolEvent;
    this.tools.set(id, next);
    if (next.t === 'sub') { const s = this.subs.get(id); if (s) s.ev = next as SubEvent; }
    this.emit(next, true);
  }

  private seen = new Set<string>();
  private put(e: ThreadEvent, uuid?: string) {
    if (uuid) { this.uuidOf.set(e.id, uuid); this.last = uuid; }
    const replace = this.seen.has(e.id);
    this.seen.add(e.id);
    this.emit(e, replace);
  }
}

type ErrorKindArg = Extract<ThreadEvent, { t: 'error' }>['kind'];

/** Collects folded events into a list, applying replaces in place: what history() returns. */
export function collector() {
  const list: ThreadEvent[] = [];
  const at = new Map<string, number>();
  const emit: Emit = (e, replace) => {
    const i = at.get(e.id);
    if (replace && i != null) list[i] = e;
    else if (i == null) { at.set(e.id, list.length); list.push(e); }
    else list[i] = e;
  };
  return { list, emit };
}
