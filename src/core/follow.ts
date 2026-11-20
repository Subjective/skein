// Live follow of a thread's transcript, for sessions written by something other than Skein's chat driver: a
// `claude` or `codex` started in another terminal, or Skein's own terminal view while the chat view mirrors it.
// The transcript is tailed (core/tail), its lines kept parsed, and the whole thread re-folded with the history
// parsers on each change; the events that are new or changed since the last fold are pushed as chat events, so
// ids match history exactly and nothing is sent twice. What the turn is doing (running, or ended) is read from
// the transcript too, and reported for writes nobody in Skein made, so the sidebar shows them (G13 blue dot).
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Machine, ThreadEvent, ThreadMeta } from '../shared/types';
import { jsonLines } from './harness/common';
import { parseClaudeTranscript } from './harness/claude/history';
import { parseCodexRollout } from './harness/codex/history';
import { run } from './exec';
import { log } from './log';
import { sq } from './shell';
import { LocalTail, RemoteTail, type TailSink } from './tail';

export type TurnState = 'running' | 'idle';
type Rec = Record<string, unknown>;

/** No write for this long while "running": the writer died mid-turn (or a tool runs very long); call it idle. */
export const STALE_MS = 10 * 60_000;

const END_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal', 'pause_turn']);
const rawText = (content: unknown) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(c => (c && typeof c === 'object' && typeof (c as Rec).text === 'string' ? (c as Rec).text as string : '')).join('\n') : '';

/** Whether a Claude Code transcript's last turn is still going. Reads from the end; pure, for tests. */
export function claudeTurnState(entries: Rec[]): TurnState {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.isSidechain) continue;
    if (e.type === 'system') { if (e.subtype === 'turn_duration') return 'idle'; continue; }
    if (e.type === 'assistant') {
      const m = (e.message ?? {}) as Rec;
      if (e.isApiErrorMessage || e.error) return 'idle';
      return END_REASONS.has(String(m.stop_reason)) ? 'idle' : 'running';
    }
    if (e.type === 'user') {
      if (e.isMeta || e.isVisibleInTranscriptOnly) continue;
      const m = (e.message ?? {}) as Rec;
      if (Array.isArray(m.content) && (m.content as Rec[]).some(b => b?.type === 'tool_result')) return 'running';
      const t = rawText(m.content).trim();
      if (/^\[Request interrupted by user/.test(t)) return 'idle';
      // a local command (/model, /clear) or a ! shell line gets its output and no reply
      if (/^<(local-command-(stdout|stderr)|bash-(stdout|stderr))/.test(t) || /^Caveat: /.test(t)) return 'idle';
      return 'running';
    }
  }
  return 'idle';
}

/** Whether a Codex rollout's last turn is still going. */
export function codexTurnState(lines: Rec[]): TurnState {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.type !== 'event_msg') continue;
    const t = String(((l.payload ?? {}) as Rec).type ?? '');
    if (t === 'task_started' || t === 'turn_started') return 'running';
    if (t === 'task_complete' || t === 'turn_complete' || t === 'turn_aborted') return 'idle';
  }
  return 'idle';
}

/** Did these new lines finish a turn? (A reply landed, so an unseen thread gets its blue dot.) */
export function endsTurn(harness: ThreadMeta['harness'], lines: Rec[]): boolean {
  return lines.some(l => harness === 'claude'
    ? (l.type === 'assistant' && !l.isSidechain && END_REASONS.has(String(((l.message ?? {}) as Rec).stop_reason))) || (l.type === 'system' && l.subtype === 'turn_duration')
    : l.type === 'event_msg' && /^(task_complete|turn_complete)$/.test(String(((l.payload ?? {}) as Rec).type)));
}

export interface FollowHost {
  machine(id: string): Machine;
  thread(id: string): ThreadMeta | undefined;
  /** Who in Skein writes this thread now: its chat driver (which pushes its own events), a Skein terminal, or no one. */
  owner(id: string): 'driver' | 'pty' | null;
  event(thread: string, e: ThreadEvent, replace: boolean): void;
  /** Something outside Skein wrote the transcript. `ended`: the write finished a turn. */
  activity(thread: string, a: { state: TurnState; ended: boolean }): void;
}

export interface Located { path: string; text: string }

/** Where a thread's transcript is and what it holds now, or null when it doesn't exist (yet). */
export async function locate(t: ThreadMeta, m: Machine): Promise<Located | null> {
  if (!t.sessionId || !/^[\w-]+$/.test(t.sessionId)) return null;
  if (m.ssh) {
    const glob = t.harness === 'claude'
      ? `"$HOME"/.claude/projects/*/${sq(t.sessionId + '.jsonl')}`
      : `"$HOME"/.codex/sessions/*/*/*/rollout-*${sq(t.sessionId + '.jsonl')}`;
    // the path, a newline, then the file: one round trip
    const r = await run(m, `for f in ${glob}; do [ -f "$f" ] && printf '%s\\n' "$f" && cat "$f" && exit 0; done; exit 3`, { timeout: 60_000 });
    if (r.code !== 0) return null;
    const nl = r.stdout.indexOf('\n');
    return nl < 0 ? null : { path: r.stdout.slice(0, nl), text: r.stdout.slice(nl + 1) };
  }
  const path = await localPath(t.harness, t.sessionId);
  if (!path) return null;
  const text = await readFile(path, 'utf8').catch(() => null);
  return text == null ? null : { path, text };
}

export const claudeRoot = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
export const codexRoot = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

async function localPath(harness: ThreadMeta['harness'], id: string): Promise<string | null> {
  const isFile = (p: string) => stat(p).then(s => s.isFile(), () => false);
  if (harness === 'claude') {
    const root = claudeRoot();
    for (const d of await readdir(root).catch(() => [] as string[])) { const p = join(root, d, `${id}.jsonl`); if (await isFile(p)) return p; }
    return null;
  }
  const walk = async (d: string, depth: number): Promise<string | null> => {
    for (const e of (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => b.name.localeCompare(a.name))) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3) { const f = await walk(p, depth + 1); if (f) return f; }
      else if (e.name.startsWith('rollout-') && e.name.endsWith(`${id}.jsonl`)) return p;
    }
    return null;
  };
  return walk(codexRoot(), 0);
}

/** The session id a transcript file belongs to, from its name (Claude: <id>.jsonl, Codex: rollout-<time>-<id>.jsonl). */
export function sessionOfFile(name: string): { harness: ThreadMeta['harness']; id: string } | null {
  const base = name.replace(/^.*[\\/]/, '');
  const x = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(base);
  if (x) return { harness: 'codex', id: x[1] };
  const c = /^([\w-]+)\.jsonl$/.exec(base);
  return c && !base.startsWith('rollout-') ? { harness: 'claude', id: c[1] } : null;
}

export interface FollowerOptions {
  /** ms between folds while lines arrive. */
  throttle?: number;
  /** Builds the tail (tests pass their own). */
  tail?: (path: string, offset: number, sink: TailSink, m: Machine) => { stop(): void; kick?(): void };
  now?: () => number;
}

export class Follower {
  path: string | null = null;
  private entries: Rec[] = [];
  private fresh: Rec[] = [];
  private snap = new Map<string, string>();
  private tail: { stop(): void; kick?(): void } | null = null;
  private offset = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stale: ReturnType<typeof setTimeout> | null = null;
  private lastWrite = 0;
  private loaded = false;

  constructor(readonly id: string, private host: FollowHost, private o: FollowerOptions = {}) {}

  private get t() { return this.host.thread(this.id); }
  private now() { return (this.o.now ?? Date.now)(); }

  /** Read the transcript as it is now: its events, which become the baseline later pushes are measured against.
   *  null: there is no transcript (yet). A running tail continues from the new end. */
  async load(): Promise<ThreadEvent[] | null> {
    const t = this.t; if (!t) return null;
    const m = this.host.machine(t.machine);
    const found = await locate(t, m).catch(() => null);
    if (!found) return null;
    const following = !!this.tail;
    this.tail?.stop(); this.tail = null;
    this.flushTimer();
    // a last line without its newline is still being written: leave it for the tail
    const end = found.text.lastIndexOf('\n') + 1;
    const whole = found.text.slice(0, end);
    this.path = found.path;
    this.offset = Buffer.byteLength(whole);
    this.entries = jsonLines(whole);
    this.fresh = [];
    const events = this.fold() ?? [];
    this.snap = new Map(events.map(e => [e.id, JSON.stringify(e)]));
    this.loaded = true;
    if (following) this.start();
    return events;
  }

  /** Start tailing (after load). Idempotent. */
  start() {
    if (this.tail || !this.path || !this.loaded) return;
    const t = this.t; if (!t) return;
    const m = this.host.machine(t.machine);
    const sink: TailSink = { lines: ls => this.onLines(ls), reset: () => { this.entries = []; this.fresh = []; } };
    this.tail = this.o.tail ? this.o.tail(this.path, this.offset, sink, m)
      : m.ssh ? new RemoteTail(m, this.path, this.offset, sink) : new LocalTail(this.path, this.offset, sink);
  }

  get following() { return !!this.tail; }
  /** The file changed (a directory watcher saw it): read now instead of at the next poll. */
  kick() { this.tail?.kick?.(); }

  stop() { this.tail?.stop(); this.tail = null; this.flushTimer(); if (this.stale) clearTimeout(this.stale); this.stale = null; }

  private onLines(ls: string[]) {
    let n = 0;
    for (const l of ls) { try { const o = JSON.parse(l); if (o && typeof o === 'object') { this.entries.push(o); this.fresh.push(o); n++; } } catch { /* not JSON */ } }
    if (!n) return;
    this.lastWrite = this.now();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.refold(); }, this.o.throttle ?? 250);
  }

  private flushTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  /** Fold now (tests; and the end of a throttle window). */
  refold() {
    this.flushTimer();
    const t = this.t; if (!t) return;
    const owner = this.host.owner(this.id);
    const events = this.fold();
    if (!events) return;
    const next = new Map<string, string>();
    for (const e of events) {
      const j = JSON.stringify(e);
      next.set(e.id, j);
      // the chat driver pushes its own turn as it streams; the transcript only catches the baseline up
      if (owner !== 'driver' && this.snap.get(e.id) !== j) this.host.event(this.id, e, this.snap.has(e.id));
    }
    this.snap = next;
    const fresh = this.fresh; this.fresh = [];
    if (owner || !fresh.length) return;
    const state = this.state();
    this.host.activity(this.id, { state, ended: state === 'idle' && endsTurn(t.harness, fresh) });
    if (this.stale) clearTimeout(this.stale);
    this.stale = state === 'running' ? setTimeout(() => { this.stale = null; if (!this.host.owner(this.id)) this.host.activity(this.id, { state: 'idle', ended: false }); }, STALE_MS) : null;
    this.stale?.unref?.();
  }

  /** The turn state from the transcript; a write long ago means whoever was writing has stopped. */
  state(): TurnState {
    const t = this.t; if (!t) return 'idle';
    const s = t.harness === 'claude' ? claudeTurnState(this.entries) : codexTurnState(this.entries);
    return s === 'running' && this.lastWrite && this.now() - this.lastWrite > STALE_MS ? 'idle' : s;
  }

  /** Seconds since the transcript's last entry was written, from its own timestamps (for a first look). */
  lastEntryAge(): number {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const at = Date.parse(String(this.entries[i].timestamp ?? ''));
      if (!Number.isNaN(at)) return this.now() - at;
    }
    return Infinity;
  }

  /** The transcript's events. null when it could not be read: this runs on a timer in the main process, where
   *  a throw would be an uncaught exception, so a transcript this code does not understand is logged instead. */
  private fold(): ThreadEvent[] | null {
    const t = this.t; if (!t) return [];
    try {
      if (t.harness === 'codex') return parseCodexRollout(this.entries).events;
      const h = parseClaudeTranscript(this.entries);
      // a turn that is over has no running tools: the writer was interrupted or killed between a call and its result
      if (claudeTurnState(this.entries) === 'idle') h.fold.settleRunning('done');
      return h.events;
    } catch (e) {
      log('follow', 'could not read the transcript of', this.id, (e as Error).message);
      return null;
    }
  }
}

export interface FollowsHost extends FollowHost {
  bySession(sessionId: string): ThreadMeta | undefined;
  /** A transcript of a session no thread has yet was written on this computer (a new session started outside Skein). */
  unknown?(harness: ThreadMeta['harness']): void;
}

/** Every follower, and the directory watchers that wake them on this computer.
 *  This computer: a thread is followed once its history is read or its transcript is written while Skein runs, and
 *  stays followed (a stat poll every few seconds, woken early by the watchers). An SSH machine: only while a chat
 *  view shows the thread (follow on / off), since each followed file holds one ssh `tail`. */
export class Follows {
  private map = new Map<string, Follower>();
  private loading = new Map<string, Promise<ThreadEvent[] | null>>();
  private want = new Map<string, number>();
  private drop = new Map<string, ReturnType<typeof setTimeout>>();
  private watchers: TreeWatch[] = [];
  private unknownTimer: ReturnType<typeof setTimeout> | null = null;
  private tried = new Set<string>();

  constructor(private host: FollowsHost, private o: FollowerOptions & { watch?: boolean; dropMs?: number } = {}) {
    if (o.watch !== false) {
      this.watchers.push(new TreeWatch(claudeRoot(), 1, f => this.changed(f)));
      this.watchers.push(new TreeWatch(codexRoot(), 3, f => this.changed(f)));
    }
  }

  private follower(id: string) {
    let f = this.map.get(id);
    if (!f) { f = new Follower(id, this.host, { ...this.o, tail: this.o.tail ?? this.localTail() }); this.map.set(id, f); }
    return f;
  }

  /** Local tails rely on the watchers when they run; the poll is the safety net (Windows, network drives). */
  private localTail(): FollowerOptions['tail'] {
    const watched = this.watchers.some(w => w.ok);
    return (path, offset, sink, m) => m.ssh ? new RemoteTail(m, path, offset, sink) : new LocalTail(path, offset, sink, watched ? { watch: false, poll: 3000 } : {});
  }

  private remote(id: string) { const t = this.host.thread(id); return !!t && !!this.host.machine(t.machine).ssh; }

  /** The thread's history, read through its follower so live pushes continue exactly where it ends. null: no transcript. */
  history(id: string): Promise<ThreadEvent[] | null> {
    const f = this.follower(id);
    const p = f.load().then(evs => { if (evs && (!this.remote(id) || (this.want.get(id) ?? 0) > 0)) f.start(); return evs; })
      .finally(() => { if (this.loading.get(id) === p) this.loading.delete(id); });
    this.loading.set(id, p);
    return p;
  }

  /** A chat view showing the thread opened (on) or closed (off). */
  follow(id: string, on: boolean) {
    const n = Math.max(0, (this.want.get(id) ?? 0) + (on ? 1 : -1));
    this.want.set(id, n);
    const d = this.drop.get(id); if (d) { clearTimeout(d); this.drop.delete(id); }
    const f = this.map.get(id);
    if (on) {
      // the history read starts it; a view opened again later (its events cached) catches up from where it stopped
      if (this.loading.has(id)) return;
      if (f?.path) f.start(); else void this.history(id);
      return;
    }
    if (n === 0 && f && this.remote(id)) {
      // a moment's grace: switching tabs should not restart the ssh tail
      this.drop.set(id, setTimeout(() => { this.drop.delete(id); if (!this.want.get(id)) f.stop(); }, this.o.dropMs ?? 20_000));
    }
  }

  /** Let go of a thread (it moved, or was removed): the next look starts from its record. */
  forget(id: string) { this.map.get(id)?.stop(); this.map.delete(id); this.want.delete(id); }

  /** A transcript on this computer changed. */
  changed(file: string) {
    const s = sessionOfFile(file); if (!s) return;
    const t = this.host.bySession(s.id);
    if (!t || t.harness !== s.harness || this.host.machine(t.machine).ssh) {
      // look once per new session (discovery reads every recent transcript's head; one it can't parse would loop)
      if (!t && this.host.unknown && !this.tried.has(s.id) && !this.unknownTimer && this.tried.add(s.id)) this.unknownTimer = setTimeout(() => { this.unknownTimer = null; this.host.unknown?.(s.harness); }, 4000);
      return;
    }
    const f = this.map.get(t.id);
    if (f?.following && f.path && samePath(f.path, file)) { f.kick(); return; }
    if (this.loading.has(t.id)) return;
    // first sight of this one (or it moved to another file): read it, and say what it is doing if someone outside
    // Skein just wrote it
    void this.history(t.id).then(evs => {
      const g = this.map.get(t.id);
      if (!evs || !g || this.host.owner(t.id) || g.lastEntryAge() > 30_000) return;
      const state = g.state();
      this.host.activity(t.id, { state, ended: state === 'idle' });
    });
  }

  dispose() { for (const w of this.watchers) w.close(); for (const f of this.map.values()) f.stop(); for (const d of this.drop.values()) clearTimeout(d); if (this.unknownTimer) clearTimeout(this.unknownTimer); }
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Non-recursive watchers on a folder and its sub-folders down to `depth`, added as folders appear. (Recursive
 *  fs.watch on Linux watches every folder below, and Claude Code keeps a folder per session.) */
export class TreeWatch {
  private ws = new Map<string, FSWatcher>();
  private closed = false;
  private retry: ReturnType<typeof setInterval> | null = null;
  constructor(root: string, private depth: number, private onFile: (path: string) => void) {
    this.add(root, 0);
    // the folder may not exist yet (the harness was never run): look again now and then
    if (!this.ws.size) { this.retry = setInterval(() => { this.add(root, 0); if (this.ws.size && this.retry) { clearInterval(this.retry); this.retry = null; } }, 60_000); this.retry.unref?.(); }
  }
  get ok() { return this.ws.size > 0; }
  private add(dir: string, level: number) {
    if (this.closed || this.ws.has(dir)) return;
    let w: FSWatcher;
    try {
      w = fsWatch(dir, { persistent: false }, (_ev, name) => {
        if (!name) return;
        const p = join(dir, String(name));
        if (String(name).endsWith('.jsonl')) this.onFile(p);
        else if (level < this.depth) void stat(p).then(s => { if (s.isDirectory()) this.add(p, level + 1); }, () => {});
      });
    } catch { return; }
    w.on('error', () => { w.close(); this.ws.delete(dir); });
    this.ws.set(dir, w);
    if (level < this.depth) void readdir(dir, { withFileTypes: true }).then(es => { for (const e of es) if (e.isDirectory()) this.add(join(dir, e.name), level + 1); }, () => {});
  }
  close() { this.closed = true; if (this.retry) clearInterval(this.retry); for (const w of this.ws.values()) w.close(); this.ws.clear(); }
}
