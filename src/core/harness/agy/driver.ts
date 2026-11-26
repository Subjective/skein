// The Antigravity chat driver: one ACP session on the machine's `agy acp` (agy/acp.ts), kept as ThreadMeta.sessionId,
// which the terminal view resumes with `agy --conversation <id>`. A thread started from Skein gets its session from
// session/new; one opened again is resumed (session/resume: no replay; its history is read separately, history.ts).
// agy runs its own tools (it never calls the client's fs or terminal methods) and asks before an edit or a command,
// per its mode. It can't steer a running turn, fork or rewind, so those are Skein's queue or not offered.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChatSend } from '../../../shared/api';
import { effortId, modelId, permId } from '../../../shared/models';
import type { ApprovalRequest, Machine, Queued, ThreadEvent, ThreadMeta } from '../../../shared/types';
import type { ChatDriver, ChatHost } from '../../chat';
import type { Rpc } from '../codex/rpc';
import { errorKind, tidy } from '../common';
import type { AgyServers, ConfigOption, ContentBlock, Opened, PermissionRequest, Update } from './acp';
import { AgyFold, callEvents, shortPath } from './fold';
import { agyOptions } from './options';

/** A folder as agy takes it: absolute. */
export const expand = (m: Machine, dir: string) => (m.ssh ? (dir.startsWith('~') ? (m.home ? m.home + dir.slice(1) : dir) : dir) : dir === '~' ? homedir() : dir.startsWith('~/') || dir.startsWith('~\\') ? join(homedir(), dir.slice(2)) : dir);

/** An image the composer attached (a local path or a data URL) as an ACP image block. */
export function imageBlock(src: string): ContentBlock {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(src);
  if (m) return { type: 'image', mimeType: m[1] || 'image/png', data: m[2] };
  const ext = src.split('.').pop()?.toLowerCase();
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
  return { type: 'image', mimeType, data: readFileSync(src).toString('base64') };
}

const current = (opts: ConfigOption[] | undefined, id: string) => opts?.find(o => o.id === id || o.category === id)?.currentValue;

interface Pending { req: ApprovalRequest; resolve: (v: unknown) => void; arg: string }

export class AgyDriver implements ChatDriver {
  private rpc: Rpc | null = null;
  private loaded = false;
  private running = false;
  private interrupted = false;
  private turnStarted = 0;
  private turnId = '';
  private seq = 0;
  private approvals = new Map<string, Pending>();
  private unlisten: (() => void) | null = null;
  /** What the session runs now, as agy last said: its model family, thinking level and mode. */
  private live: { model?: string; effort?: string; mode?: string; options?: ConfigOption[] } = {};
  private lastSend: { text: string; images?: string[] } | null = null;
  private fold: AgyFold;

  constructor(private id: string, private host: ChatHost, private servers: AgyServers) {
    this.fold = new AgyFold((e, replace) => this.ev(e, replace), () => `${this.turnId}:${this.seq++}`, expand(this.m, this.t.dir));
  }

  private get t(): ThreadMeta { return this.host.thread(this.id); }
  private get m(): Machine { return this.host.machine(this.t.machine); }
  private ev = (e: ThreadEvent, replace = false) => this.host.event(this.id, e, replace);
  private status(s: ThreadMeta['status']) { if (this.t.status !== s) this.host.update(this.id, { status: s }); }
  private error(text: string, kind = errorKind(text)) { this.ev({ t: 'error', id: 'e-' + randomUUID(), kind, text: tidy(text, 600) }); this.status('error'); }

  async send(msg: ChatSend): Promise<void> {
    if (msg.sub) throw new Error("Antigravity's subagents don't take follow-ups");
    if (msg.rewind) throw new Error("Antigravity can't rewind a thread, so an earlier message can't be edited");
    let text = msg.text, images = msg.images;
    if (msg.retry) { if (!this.lastSend) return; ({ text, images } = this.lastSend); }
    // agy can't take a message into a running turn: it waits in Skein's queue for the turn to end (a steer goes first)
    if (this.running) {
      const q: Queued = { id: randomUUID(), text, ...(images?.length ? { images } : {}) };
      this.setQueue(msg.queue ? [...this.queue, q] : [q, ...this.queue]);
      return;
    }
    const t0 = this.t, patch: Partial<ThreadMeta> = {};
    if (msg.model && msg.model !== t0.model) patch.model = msg.model;
    if (msg.effort && msg.effort !== t0.effort) patch.effort = msg.effort;
    if (msg.perm && msg.perm !== t0.perm) patch.perm = msg.perm;
    if ((!t0.title || t0.title === 'New thread') && text.trim()) patch.title = tidy(text, 60);
    if (Object.keys(patch).length) this.host.update(this.id, patch);

    if (!(await this.ensure())) return;
    if (!(await this.apply())) return;
    this.lastSend = { text, images };
    if (this.t.queuePaused) this.setQueue(this.queue, false);
    let prompt: ContentBlock[];
    try { prompt = [...(images ?? []).map(imageBlock), ...(text ? [{ type: 'text', text }] : [])]; }
    catch (e) { this.error(`Could not attach the image: ${(e as Error).message}`, 'other'); return; }
    this.turnId = randomUUID().slice(0, 8); this.seq = 0;
    this.fold.turn();
    this.ev({ t: 'user', id: this.turnId + ':u', text, ...(images?.length ? { images } : {}), at: Date.now() });
    this.run(prompt);
  }

  private run(prompt: ContentBlock[]) {
    const sessionId = this.t.sessionId!;
    this.running = true; this.interrupted = false; this.turnStarted = Date.now();
    this.fold.streaming = true;
    this.status('running');
    this.rpc!.request<{ stopReason: string }>('session/prompt', { sessionId, prompt }).then(
      r => this.finish(r.stopReason),
      e => this.finish('error', e as Error),
    );
  }

  private finish(stop: string, err?: Error, kind?: Extract<ThreadEvent, { t: 'error' }>['kind']) {
    if (!this.running) return;   // once: agy exiting ends the turn before its prompt's call fails
    this.fold.end();
    this.fold.streaming = false;
    const cancelled = stop === 'cancelled' || (!!err && this.interrupted);
    if (cancelled || err) this.fold.abandon();
    for (const [rid, p] of this.approvals) this.settle(rid, p, { outcome: { outcome: 'cancelled' } }, 'Cancelled');
    if (err && !cancelled) this.ev({ t: 'error', id: 'e-' + this.turnId, kind: kind ?? errorKind(err.message, (err as { code?: number }).code), text: tidy(err.message, 600) });
    if (cancelled) this.ev({ t: 'interrupted', id: 'i-' + this.turnId });
    else if (stop === 'refusal') this.ev({ t: 'notice', id: 'n-' + this.turnId, text: 'Antigravity declined to continue' });
    else if (stop === 'max_tokens' || stop === 'max_turn_requests') this.ev({ t: 'notice', id: 'n-' + this.turnId, text: 'Stopped at the turn limit' });
    const ms = Date.now() - this.turnStarted;
    if (ms >= 1000) this.ev({ t: 'worked', id: 'w-' + this.turnId, ms });
    this.running = false;
    this.host.update(this.id, { status: err && !cancelled ? 'error' : 'idle', updatedAt: Date.now() });
    // a stop or a failed turn pauses the queue (as Codex does); otherwise the next one starts
    if (this.queue.length && (cancelled || err)) this.setQueue(this.queue, true);
    else this.nextQueued();
  }

  // ---- the queue (ThreadMeta.queue): Skein's, as agy keeps none ----
  private get queue(): Queued[] { return this.t.queue ?? []; }
  private setQueue(queue: Queued[], paused = this.t.queuePaused) { this.host.update(this.id, { queue, queuePaused: queue.length > 0 && !!paused }); }
  private nextQueued() {
    const [head, ...rest] = this.queue;
    if (!head || this.t.queuePaused || this.running) return;
    this.setQueue(rest);
    void this.send({ text: head.text, images: head.images });
  }
  async steerQueued(id: string): Promise<void> {
    const m = this.queue.find(x => x.id === id); if (!m) return;
    // agy can't steer: it goes first, and starts now if nothing runs
    this.setQueue([m, ...this.queue.filter(x => x !== m)], false);
    this.nextQueued();
  }
  async dropQueued(id: string): Promise<void> { this.setQueue(this.queue.filter(x => x.id !== id)); }
  async editQueued(id: string, text: string): Promise<void> { this.setQueue(this.queue.map(x => (x.id === id ? { ...x, text } : x))); }
  async orderQueue(ids: string[]): Promise<void> {
    const q = this.queue, by = new Map(q.map(x => [x.id, x]));
    this.setQueue([...ids.flatMap(i => by.get(i) ?? []), ...q.filter(x => !ids.includes(x.id))]);
  }
  async resumeQueue(): Promise<void> { this.setQueue(this.queue, false); this.nextQueued(); }

  async interrupt(): Promise<void> {
    if (!this.running) return;
    this.interrupted = true;
    for (const [rid, p] of this.approvals) this.settle(rid, p, { outcome: { outcome: 'cancelled' } }, 'Cancelled');
    this.rpc?.notify('session/cancel', { sessionId: this.t.sessionId });
  }

  async answer(requestId: string, optionId: string): Promise<void> {
    const p = this.approvals.get(requestId);
    if (!p) return;
    const opt = p.req.options.find(o => o.id === optionId);
    this.settle(requestId, p, { outcome: { outcome: 'selected', optionId } }, `${opt?.primary ? 'Allowed' : opt?.label ?? 'Answered'}: ${p.arg}`);
  }

  /** Create (or resume) the session now, so its id is known before either view uses it. */
  async prepare(): Promise<boolean> { return this.ensure(); }

  /** Nothing to hand over: the terminal opens the same conversation in a process of its own. */
  async release(): Promise<void> {}

  dispose() {
    this.unlisten?.(); this.unlisten = null;
    const id = this.t.sessionId;
    if (this.rpc?.alive && id && this.loaded && !this.running) void this.rpc.request('session/close', { sessionId: id }).catch(() => undefined);
    this.loaded = false;
  }

  // ---- the session ----

  private async ensure(): Promise<boolean> {
    const m = this.m;
    try { this.rpc = await this.servers.get(m); }
    catch (e) {
      const text = (e as Error).message || 'Antigravity did not start.';
      const kind = errorKind(text, (e as { code?: string }).code);
      this.error(kind === 'missing' ? text : `Antigravity did not start: ${text}`, kind);
      return false;
    }
    if (this.loaded && this.rpc.alive) return true;
    const t = this.t, rpc = this.rpc, cwd = expand(m, t.dir);
    if (!m.ssh && !existsSync(cwd)) { this.error(`The folder ${t.dir} does not exist on this computer.`, 'other'); return false; }
    const base = { cwd, mcpServers: [] };
    try {
      let r: Opened;
      if (t.sessionId) {
        this.listenTo(t.sessionId);
        // resume: the session without its replay (the chat already has its history)
        r = await rpc.request<Opened>('session/resume', { sessionId: t.sessionId, ...base });
      } else {
        r = await rpc.request<Opened>('session/new', base);
        this.listenTo(r.sessionId!);
        this.host.update(this.id, { sessionId: r.sessionId });
      }
      this.opened(r);
      this.loaded = true;
      return true;
    } catch (e) {
      const err = e as Error & { code?: number };
      this.error(err.code === -32002 ? 'Antigravity no longer has this conversation.' : err.message, errorKind(err.message, err.code));
      return false;
    }
  }

  /** What a session/new or session/resume answer says the session runs now (agy resets a resumed session's model to
   *  its default, so the thread's own is applied again before its next prompt). */
  private opened(r: Opened) {
    this.live = { options: r.configOptions, model: current(r.configOptions, 'model'), effort: current(r.configOptions, 'thought_level'), mode: r.modes?.currentModeId ?? current(r.configOptions, 'mode') };
    this.servers.offer(this.m, { opened: r });
    // a thread with no model of its own runs what agy picked: record it, so the picker shows what really runs
    const t = this.t, adopt: Partial<ThreadMeta> = {};
    if (!t.model && this.live.model) adopt.model = this.live.model;
    if (!t.effort && this.live.effort) adopt.effort = this.live.effort;
    if (Object.keys(adopt).length) this.host.update(this.id, adopt);
  }

  /** The thread's model, thinking level and mode, where they differ from what the session runs. */
  private async apply(): Promise<boolean> {
    const t = this.t, rpc = this.rpc!, sessionId = t.sessionId!;
    const models = agyOptions(this.servers.offered.get(this.m.id)?.opened ?? { configOptions: this.live.options }).models;
    const model = modelId('agy', t.model, models), def = models.find(x => x.id === model);
    const effort = effortId(t.effort), mode = permId('agy', t.perm);
    try {
      if (model && model !== this.live.model) await this.config('model', model);
      // a thinking level the model has (switching models can change the levels it offers)
      if (effort && effort !== this.live.effort && (def ? def.efforts.includes(effort) : true)) await this.config('thought_level', effort);
      if (mode && mode !== this.live.mode) { await rpc.request('session/set_mode', { sessionId, modeId: mode }); this.live.mode = mode; }
      return true;
    } catch (e) { this.error(`Antigravity didn't take the setting: ${(e as Error).message}`, 'other'); return false; }
  }

  private async config(configId: string, value: string) {
    const r = await this.rpc!.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId: this.t.sessionId, configId, value });
    this.options(r?.configOptions);
    if (configId === 'model') this.live.model = value; else this.live.effort = value;
  }

  private options(opts?: ConfigOption[]) {
    if (!opts?.length) return;
    this.live = { ...this.live, options: opts, model: current(opts, 'model') ?? this.live.model, effort: current(opts, 'thought_level') ?? this.live.effort, mode: current(opts, 'mode') ?? this.live.mode };
  }

  private listenTo(sessionId: string) {
    this.unlisten?.();
    this.unlisten = this.servers.listen(sessionId, {
      update: u => this.onUpdate(u),
      permission: p => this.onPermission(p),
      exited: reason => this.onExit(reason),
    });
  }

  private onExit(reason: string) {
    this.loaded = false;
    // a turn cut off reads as a crash (Restart runs it again)
    if (this.running) this.finish('error', new Error(`Antigravity stopped: ${reason}`), errorKind(reason) === 'other' ? 'crash' : errorKind(reason));
  }

  private onUpdate(u: Update) {
    if (this.fold.update(u)) return;
    switch (u.sessionUpdate) {
      case 'usage_update':
        if (u.size > 0) this.host.update(this.id, { ctx: Math.min(100, Math.round((u.used / u.size) * 100)), ctxTokens: { used: u.used, max: u.size } });
        return;
      case 'session_info_update':
        if (u.title && !this.t.named) this.host.update(this.id, { title: tidy(u.title, 80) });
        return;
      case 'available_commands_update': this.servers.offer(this.m, { commands: u.availableCommands }); return;
      case 'config_option_update': this.options(u.configOptions); return;
      case 'current_mode_update': this.live.mode = u.currentModeId; return;
      default: return;
    }
  }

  // ---- approvals ----

  private onPermission(p: PermissionRequest): Promise<unknown> {
    const c = p.toolCall, cwd = expand(this.m, this.t.dir);
    const step = callEvents(c, cwd)[0];
    const diffs = step?.t === 'edit' ? callEvents(c, cwd).flatMap(e => (e.t === 'edit' && e.diff ? [e.diff] : [])) : [];
    const options = p.options.map(o => ({ id: o.optionId, label: o.name, ...(o.kind.startsWith('allow') ? { primary: true } : {}) }));
    // one primary: the first allow
    let seen = false;
    for (const o of options) if (o.primary) { if (seen) delete (o as { primary?: boolean }).primary; seen = true; }
    const requestId = c.toolCallId || randomUUID();
    let req: ApprovalRequest;
    if (step?.t === 'tool' && step.kind === 'command') req = { requestId, kind: 'command', title: 'Run this command?', body: step.arg, options };
    else if (step?.t === 'edit') {
      const name = step.path.split(/[\\/]/).pop();
      req = { requestId, kind: 'edit', title: `Edit ${name}?`, body: diffs.join('\n'), detail: shortPath(step.path, cwd), options };
    } else req = { requestId, kind: 'other', title: `Allow ${step?.t === 'tool' ? step.name : c.title ?? 'this'}?`, body: step?.t === 'tool' ? step.arg : c.title ?? '', options };
    return new Promise(resolve => {
      const arg = req.kind === 'command' ? tidy(req.body, 80) : req.detail ?? req.title;
      this.approvals.set(requestId, { req, resolve, arg });
      this.ev({ t: 'approval', id: 'ap-' + requestId, request: req });
      this.status('wait');
    });
  }

  private settle(requestId: string, p: Pending, result: unknown, note: string) {
    if (this.approvals.get(requestId) !== p) return;
    this.approvals.delete(requestId);
    this.ev({ t: 'notice', id: 'ap-' + requestId, text: note }, true);
    if (!this.approvals.size && this.running) this.status('running');
    p.resolve(result);
  }
}
