// agy's session/update stream as chat events. The live driver and the history read (session/load, which replays a
// session as the same updates) both go through AgyFold, so a tool step has the same id (agy's toolCallId) either
// way. Messages carry no id of their own in ACP: a message is the run of chunks of one kind, named by the fold.
import { posix, win32 } from 'node:path';
import type { StepKind, ThreadEvent } from '../../../shared/types';
import { clip, countDiff, replaceDiff, tidy } from '../common';
import type { ContentBlock, ToolCall, Update } from './acp';

type Status = 'running' | 'done' | 'failed';
const st = (s?: string): Status => (s === 'completed' ? 'done' : s === 'failed' ? 'failed' : 'running');

/** A path as the thread shows it: relative to its folder when inside it (agy reports a macOS /tmp path both ways). */
export function shortPath(p: string, cwd?: string): string {
  const path = cwd?.startsWith('/') ? posix : win32;   // the machine agy runs on, not the one Skein runs on
  if (!cwd || !path.isAbsolute(p)) return p;
  const strip = (x: string) => x.replace(/^\/private(?=\/(tmp|var)\/)/, '');
  const r = path.relative(strip(cwd), strip(p));
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const input = (c: ToolCall) => ({ ...(c.args ?? {}), ...(c.rawInput ?? {}) });
const pathOf = (c: ToolCall) => str(input(c).Path) ?? str(input(c).AbsolutePath) ?? str(input(c).path) ?? c.locations?.[0]?.path;
const firstString = (o: Record<string, unknown>) => Object.entries(o).find(([k, v]) => typeof v === 'string' && k !== 'toolSummary')?.[1] as string | undefined;
/** snake_case to words: browser_subagent -> Browser subagent. */
const words = (s: string) => { const w = s.replace(/[_-]+/g, ' ').trim(); return w ? w[0].toUpperCase() + w.slice(1) : s; };

/** agy's command result: a header (times, exit code), then the output after "Command output:". */
export function commandOutput(c: ToolCall): { out?: string; code?: number } {
  const raw = c.rawOutput ?? {};
  const text = str(raw.output) ?? c.content?.flatMap(x => (x.type === 'content' ? [(x as { content: ContentBlock }).content.text ?? ''] : [])).join('\n') ?? '';
  const at = text.indexOf('Command output:\n');
  const out = (at >= 0 ? text.slice(at + 'Command output:\n'.length) : text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const code = typeof raw.exit_code === 'number' ? raw.exit_code : Number(/Command exited with code (\d+)/.exec(text)?.[1] ?? NaN);
  return { ...(out ? { out: clip(out) } : {}), ...(Number.isFinite(code) ? { code } : {}) };
}

/** One tool call as the steps it shows: an edit per changed file, a command, a read, a search, or the tool itself. */
export function callEvents(c: ToolCall, cwd?: string): ThreadEvent[] {
  const status = st(c.status), name = c.name ?? '', i = input(c);
  const diffs = (c.content ?? []).filter((x): x is { type: 'diff'; path: string; oldText?: string | null; newText: string } => x.type === 'diff');
  if (diffs.length) {
    return diffs.map((d, n) => {
      const path = shortPath(d.path, cwd), diff = replaceDiff(path, d.oldText ?? '', d.newText ?? '');
      return { t: 'edit' as const, id: diffs.length > 1 ? `${c.toolCallId}:${n}` : c.toolCallId, path, ...countDiff(diff), diff: clip(diff, 20000), status };
    });
  }
  if (c.kind === 'edit' || c.kind === 'delete' || c.kind === 'move') {
    return [{ t: 'edit', id: c.toolCallId, path: shortPath(pathOf(c) ?? c.title ?? '', cwd), add: 0, del: 0, status }];
  }
  const step = (kind: StepKind, label: string, arg: string, extra: Partial<Extract<ThreadEvent, { t: 'tool' }>> = {}): ThreadEvent[] =>
    [{ t: 'tool', id: c.toolCallId, name: label, arg: tidy(arg, 200), status, kind, ...extra }];
  if (c.kind === 'execute') {
    const { out, code } = commandOutput(c);
    const failed = code != null && code !== 0;
    return step('command', 'Shell', str(i.CommandLine) ?? str(i.command) ?? c.title ?? '', {
      ...(out ? { out } : {}), ...(failed ? { meta: `exit ${code}`, status: status === 'done' ? 'failed' : status } : {}),
    });
  }
  if (c.kind === 'read') {
    const p = pathOf(c);
    if (/list|dir/i.test(name)) return step('list', 'List', p ? shortPath(p, cwd) : '.');
    return step('read', 'Read', p ? shortPath(p, cwd) : c.title ?? '');
  }
  if (c.kind === 'search') return step('search', 'Search', [str(i.Query) ?? str(i.Pattern) ?? str(i.query) ?? firstString(i) ?? '', pathOf(c) ? shortPath(pathOf(c)!, cwd) : ''].filter(Boolean).join('  '));
  if (c.kind === 'fetch') return step('web', /search/i.test(name) ? 'Web search' : 'Fetch', str(i.Url) ?? str(i.url) ?? str(i.Query) ?? firstString(i) ?? c.title ?? '');
  const label = name ? words(name) : c.title ?? 'Tool';
  return step('other', label, str(i.toolSummary) ?? firstString(i) ?? (c.title && c.title !== `Run ${name}` ? c.title : ''));
}

/** agy's own plan tool: its steps as the turn's to-do list. */
const STEPS = 'update_steps';
const stepsOf = (c: ToolCall) => ((input(c).steps as { title?: string; status?: string }[] | undefined) ?? []).map(s => ({ text: s.title ?? '', done: s.status === 'completed' }));

const imageSrc = (b: ContentBlock) => (b.data ? `data:${b.mimeType || 'image/png'};base64,${b.data}` : b.uri);

/** Folds a session's content updates into events. `emit` gets each event as it changes (replace: an earlier one with
 *  the same id is superseded). `id` names a new message. */
export class AgyFold {
  private seg: { kind: 'user' | 'text' | 'thinking'; id: string; text: string; images: string[] } | null = null;
  private calls = new Map<string, ToolCall>();
  private steps: string | null = null;
  /** The live driver streams text: a message is marked streaming until the next step or the turn's end. */
  streaming = false;

  constructor(private emit: (e: ThreadEvent, replace: boolean) => void, private id: () => string, private cwd?: string) {}

  /** A turn starts (the driver's prompt; a replayed user message): the to-do list and messages start afresh. */
  turn() { this.close(); this.steps = null; }

  /** The turn ended: its last message stops streaming. */
  end() { this.close(); }

  /** A content update. Returns false for an update that isn't content (the driver's to handle). */
  update(u: Update): boolean {
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        if (this.seg?.kind !== 'user') { this.turn(); this.open('user'); }
        this.chunk(u.content);
        return true;
      }
      case 'agent_message_chunk': case 'agent_thought_chunk': {
        const kind = u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking';
        if (this.seg?.kind !== kind) { this.close(); this.open(kind); }
        this.chunk(u.content);
        return true;
      }
      case 'tool_call': case 'tool_call_update': {
        this.close();
        const { sessionUpdate: _, ...patch } = u;
        const c: ToolCall = { ...this.calls.get(u.toolCallId), ...patch };
        this.calls.set(u.toolCallId, c);
        if (c.name === STEPS) {
          const items = stepsOf(c);
          if (items.length) { this.steps ??= 'steps-' + c.toolCallId; this.emit({ t: 'todo', id: this.steps, items }, true); }
          return true;
        }
        for (const e of callEvents(c, this.cwd)) this.emit(e, true);
        if (c.status === 'completed' || c.status === 'failed') this.calls.delete(u.toolCallId);
        return true;
      }
      case 'plan': {
        this.steps ??= 'plan-' + this.id();
        this.emit({ t: 'todo', id: this.steps, items: u.entries.map(e => ({ text: e.content, done: e.status === 'completed' })) }, true);
        return true;
      }
      default: return false;
    }
  }

  /** Steps still running when the turn stopped (cancelled, or agy exited): they won't finish. */
  abandon() {
    for (const c of this.calls.values()) for (const e of callEvents({ ...c, status: 'failed' }, this.cwd)) this.emit(e, true);
    this.calls.clear();
  }

  private open(kind: 'user' | 'text' | 'thinking') { this.seg = { kind, id: this.id(), text: '', images: [] }; }

  private chunk(b: ContentBlock) {
    const s = this.seg!;
    if (b.type === 'text' && b.text) s.text += b.text;
    else if (b.type === 'image' && s.kind === 'user') { const src = imageSrc(b); if (src) s.images.push(src); }
    else return;
    this.show(this.streaming && s.kind === 'text');
  }

  private show(streaming: boolean) {
    const s = this.seg; if (!s) return;
    if (s.kind === 'user') this.emit({ t: 'user', id: s.id, text: s.text, ...(s.images.length ? { images: s.images } : {}) }, true);
    else if (s.kind === 'thinking') { if (s.text.trim()) this.emit({ t: 'thinking', id: s.id, text: s.text.trim() }, true); }
    else if (s.text.trim()) this.emit({ t: 'text', id: s.id, text: s.text, ...(streaming ? { streaming: true } : {}) }, true);
  }

  private close() {
    if (this.seg?.kind === 'text' && this.streaming) this.show(false);
    this.seg = null;
  }
}

/** A session's replayed updates (session/load) as its history. */
export function replay(updates: Update[], cwd?: string): ThreadEvent[] {
  const out: ThreadEvent[] = [], at = new Map<string, number>();
  let n = 0;
  const fold = new AgyFold((e, replace) => {
    const i = at.get(e.id);
    if (i != null && replace) out[i] = e; else { at.set(e.id, out.length); out.push(e); }
  }, () => `h${n++}`, cwd);
  for (const u of updates) fold.update(u);
  fold.end();
  return out;
}
