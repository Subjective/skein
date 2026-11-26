// The Claude Code chat driver: one Agent SDK query per thread while the chat view drives it (G4).
// Streaming input keeps one CLI process across turns. canUseTool turns permission prompts into approval
// events. Remote machines run the CLI over ssh through spawnClaudeCodeProcess, so the SDK never knows.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { CanUseTool, FastModeDisabledReason, FastModeState, Options, PermissionMode, PermissionResult, Query, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSend } from '../../../shared/api';
import { CLAUDE_FAST, effortId, modelId, permId } from '../../../shared/models';
import type { ApprovalRequest, Machine, Queued, ThreadEvent, ThreadMeta } from '../../../shared/types';
import type { ChatDriver, ChatHost } from '../../chat';
import { spawnOn } from '../../exec';
import { log } from '../../log';
import { sqPath, which } from '../../shell';
import { deferred, errorKind, replaceDiff, throttle, tidy, type ErrorKind } from '../common';
import { ClaudeFold, toolArg, toolName } from './fold';
import { parseClaudeTranscript, readClaudeTranscript } from './history';

export type QueryFn = (p: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

interface Pending { req: ApprovalRequest; arg: string; input: Record<string, unknown>; done: (r: PermissionResult) => void; suggestions?: unknown[] }

/** An async iterable fed by push(); end() finishes it. */
class Inbox<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wait: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;
  push(v: T) { if (this.wait) { const w = this.wait; this.wait = null; w({ value: v, done: false }); } else this.items.push(v); }
  end() { this.ended = true; if (this.wait) { const w = this.wait; this.wait = null; w({ value: undefined as never, done: true }); } }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => (this.items.length ? Promise.resolve({ value: this.items.shift()!, done: false }) : this.ended ? Promise.resolve({ value: undefined as never, done: true }) : new Promise(r => (this.wait = r))) };
  }
}

const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** Images as Anthropic content blocks: data URLs as they are, local files read from this computer. */
export function imageBlocks(images: string[] = []) {
  return images.flatMap(src => {
    const m = src.match(/^data:([^;,]+);base64,(.*)$/s);
    if (m) return [{ type: 'image' as const, source: { type: 'base64' as const, media_type: m[1], data: m[2] } }];
    try {
      const data = readFileSync(src).toString('base64');
      return [{ type: 'image' as const, source: { type: 'base64' as const, media_type: MEDIA[extname(src).toLowerCase()] ?? 'image/png', data } }];
    } catch (e) { log('claude', 'image', src, e); return []; }
  });
}

/** The SDK's bundled CLI for this computer, if its platform package is installed. Otherwise the CLI on PATH. */
export function localExecutable(): string | undefined {
  try {
    const base = typeof __filename === 'string' ? __filename : join(process.cwd(), 'index.js');
    const sdk = createRequire(base).resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    createRequire(sdk).resolve(`${pkg}/package.json`);
    return undefined; // the SDK finds it itself
  } catch { /* not installed: fall through */ }
  if (process.platform === 'linux') {
    try { const base = typeof __filename === 'string' ? __filename : join(process.cwd(), 'index.js'); createRequire(createRequire(base).resolve('@anthropic-ai/claude-agent-sdk')).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/package.json`); return undefined; } catch { /* none */ }
  }
  return which('claude') ?? undefined;
}

const expand = (dir: string) => (dir === '~' ? homedir() : dir.startsWith('~/') || dir.startsWith('~\\') ? join(homedir(), dir.slice(2)) : dir);

/** Env the SDK adds for the CLI. Only these cross to a remote machine; the rest of this computer's env stays here. */
const forwardEnv = (env: Record<string, string | undefined>) =>
  Object.entries(env).filter(([k, v]) => v != null && /^(CLAUDE_CODE_|CLAUDE_AGENT_SDK|MCP_)/.test(k) && process.env[k] !== v).map(([k, v]) => `${k}=${v}`);

/** Run the CLI on an SSH machine. The SDK passes its own binary path as the command; the remote uses its `claude`. */
export function sshSpawner(m: Machine, dir: string, onStderr: (s: string) => void) {
  return (o: SpawnOptions): SpawnedProcess => {
    const args = [...o.args];
    while (args.length && /\.(c?js|mjs)$/.test(args[0])) args.shift();
    const env = forwardEnv(o.env);
    const cmd = [...(env.length ? ['env', ...env] : []), 'claude', ...args];
    const p = spawnOn(m, cmd, { posixCwd: sqPath(dir), stdio: ['pipe', 'pipe', 'pipe'] });
    p.stderr?.on('data', d => onStderr(String(d)));
    o.signal.addEventListener('abort', () => { if (!p.killed) p.kill('SIGTERM'); }, { once: true });
    return p as unknown as SpawnedProcess;
  };
}

/** An effort Claude Code takes (its EffortLevel); anything else (Codex's 'ultra', 'minimal') is left to its default. */
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/** Claude Code's reasons fast mode didn't run, in its own words where it has them. */
const FAST_OFF: Partial<Record<FastModeDisabledReason | 'cooldown', string>> = {
  cooldown: 'Fast mode is paused after a rate limit',
  not_first_party: 'Fast mode is not available on this provider',
  model_not_allowed: "Fast mode isn't available for this model",
  preference: 'Fast mode is turned off by your settings or organization',
  extra_usage_disabled: 'Fast mode needs extra usage turned on',
  disabled_by_env: 'Fast mode is not available',
};
const claudeEffort = (v?: string) => { const e = effortId(v); return e && CLAUDE_EFFORTS.has(e) ? e : undefined; };

export class ClaudeDriver implements ChatDriver {
  private q: Query | null = null;
  private inbox: Inbox<SDKUserMessage> | null = null;
  private fold!: ClaudeFold;
  private pump: Promise<void> | null = null;
  private closing = false;
  private running = false;
  private turnDone = deferred();
  private turnId = '';
  private approvals = new Map<string, Pending>();
  private stderr = '';
  private live: { model?: string; effort?: string; perm?: string; ultra?: boolean; fast?: boolean } = {};
  /** The Ultracode switch as the chat last sent it (session-scoped, as the SDK's setting is). */
  private ultra = false;
  /** Fast mode as the chat last sent it (ChatSend.speed 'fast'; session-scoped like Ultracode). */
  private fast = false;
  /** Why fast mode didn't run, as last told in the chat, so a reason is said once and not after every turn. */
  private fastSaid: string | undefined;
  private stream = new Map<number, { kind: 'text' | 'thinking'; text: string }>();
  private streamMsg = '';
  private partial = throttle<() => void>(60, f => f());
  private lastSend: { text: string; images?: string[] } | null = null;

  constructor(private id: string, private host: ChatHost, private query: () => Promise<QueryFn>) {
    this.turnDone.resolve();
  }

  private get t(): ThreadMeta { return this.host.thread(this.id); }
  private ev = (e: ThreadEvent, replace = false) => this.host.event(this.id, e, replace);
  private status(s: ThreadMeta['status']) { if (this.t.status !== s) this.host.update(this.id, { status: s }); }

  async send(msg: ChatSend): Promise<void> {
    // Claude Code takes no messages for a subagent from outside it (its popup's composer says so)
    if (msg.sub) throw new Error("Follow-ups aren't available for this subagent");
    // queued: Skein keeps it (Claude Code's own queue can't be listed, reordered or edited, and merges what waits
    // into one turn) and sends it when this turn ends, as a turn of its own
    if (msg.queue && this.running) { this.setQueue([...this.queue, { id: randomUUID(), text: msg.text, ...(msg.images?.length ? { images: msg.images } : {}) }]); return; }
    let text = msg.text, images = msg.images;
    let rewind = msg.rewind;
    if (msg.retry) {
      const last = await this.lastUser();
      if (!last) return;
      rewind = last.id; text = last.text; images = last.images;
    }
    const t = this.t;
    const patch: Partial<ThreadMeta> = {};
    if (msg.model && msg.model !== t.model) patch.model = msg.model;
    if (msg.effort && msg.effort !== t.effort) patch.effort = msg.effort;
    if (msg.perm && msg.perm !== t.perm) patch.perm = msg.perm;
    if (msg.ultra !== undefined) this.ultra = msg.ultra;
    if (msg.speed !== undefined) this.fast = msg.speed === CLAUDE_FAST.id;
    if ((!t.title || t.title === 'New thread') && text.trim()) patch.title = tidy(text, 60);
    if (Object.keys(patch).length) this.host.update(this.id, patch);

    if (rewind) await this.rewindTo(rewind);
    try { await this.ensure(); } catch (e) { log('claude', 'start', e); return; }
    await this.applySettings();

    const uuid = randomUUID();
    this.lastSend = { text, images };
    this.sentText.set(uuid, text);
    const content = [...imageBlocks(images), ...(text ? [{ type: 'text' as const, text }] : [])];
    this.ev({ t: 'user', id: uuid, text, ...(images?.length ? { images } : {}), at: Date.now() });
    // a turn you start resumes a paused queue: it goes on when this turn ends (as Codex's does)
    if (this.t.queuePaused) this.setQueue(this.queue, false);
    if (!this.running) this.startTurn(uuid);
    this.inbox!.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: uuid as SDKUserMessage['uuid'] } as SDKUserMessage);
  }

  // ---- the queue (ThreadMeta.queue) ----
  private get queue(): Queued[] { return this.t.queue ?? []; }
  private setQueue(queue: Queued[], paused = this.t.queuePaused) { this.host.update(this.id, { queue, queuePaused: queue.length > 0 && !!paused }); }
  /** The turn ended: the next one starts, unless a stop or an error paused the queue. */
  private nextQueued() {
    const [head, ...rest] = this.queue;
    if (!head || this.t.queuePaused || this.running) return;
    this.setQueue(rest);
    void this.send({ text: head.text, images: head.images });
  }
  async steerQueued(id: string): Promise<void> {
    const m = this.queue.find(x => x.id === id); if (!m) return;
    this.setQueue(this.queue.filter(x => x !== m), this.running && this.t.queuePaused);
    await this.send({ text: m.text, images: m.images });
  }
  async dropQueued(id: string): Promise<void> { this.setQueue(this.queue.filter(x => x.id !== id)); }
  async editQueued(id: string, text: string): Promise<void> { this.setQueue(this.queue.map(x => (x.id === id ? { ...x, text } : x))); }
  async orderQueue(ids: string[]): Promise<void> {
    const q = this.queue, by = new Map(q.map(x => [x.id, x]));
    this.setQueue([...ids.flatMap(i => by.get(i) ?? []), ...q.filter(x => !ids.includes(x.id))]);
  }
  async resumeQueue(): Promise<void> { this.setQueue(this.queue, false); this.nextQueued(); }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    for (const [rid, p] of this.approvals) this.settle(rid, p, { behavior: 'deny', message: 'The user interrupted.', interrupt: true }, 'Cancelled');
    if (this.q && this.running) await this.q.interrupt().catch(e => log('claude', 'interrupt', e));
  }

  async answer(requestId: string, optionId: string): Promise<void> {
    const p = this.approvals.get(requestId);
    if (!p) return;
    const allow = (extra: Partial<Extract<PermissionResult, { behavior: 'allow' }>> = {}): PermissionResult => ({ behavior: 'allow', updatedInput: p.input, ...extra });
    if (p.req.kind === 'plan') {
      if (optionId === 'deny') return this.settle(requestId, p, { behavior: 'deny', message: 'The user wants to keep planning. Wait for their feedback on the plan.', interrupt: true }, 'Kept planning');
      const mode: PermissionMode = optionId === 'accept-edits' ? 'acceptEdits' : 'default';
      this.host.update(this.id, { perm: mode });
      this.live.perm = mode;
      this.q?.setPermissionMode(mode).catch(e => log('claude', 'mode', e));
      return this.settle(requestId, p, allow(), 'Plan approved');
    }
    if (optionId.startsWith('opt:')) {
      const label = p.req.options.find(o => o.id === optionId)?.label ?? '';
      const question = String(((p.input.questions as { question?: string }[] | undefined) ?? [])[0]?.question ?? '');
      return this.settle(requestId, p, allow({ updatedInput: { ...p.input, answers: { [question]: label } } }), `Answered: ${label}`);
    }
    if (optionId === 'deny') return this.settle(requestId, p, { behavior: 'deny', message: 'The user declined this. Wait for their instructions.', interrupt: true }, `Denied: ${p.arg}`);
    if (optionId === 'always') return this.settle(requestId, p, allow({ updatedPermissions: p.suggestions as never }), `Always allowed: ${p.arg}`);
    return this.settle(requestId, p, allow(), `Allowed: ${p.arg}`);
  }

  async release(): Promise<void> {
    if (this.running) await this.turnDone.promise;
    await this.stop();
  }

  // ---- the process ----

  private async stop() {
    if (!this.q) return;
    this.closing = true;
    this.inbox?.end();
    const q = this.q, pump = this.pump;
    const timer = setTimeout(() => q.close(), 5000);
    await pump?.catch(() => {});
    clearTimeout(timer);
    this.q = null; this.inbox = null; this.pump = null; this.closing = false;
  }

  private async ensure() {
    if (this.q) return;
    const t = this.t;
    const m = this.host.machine(t.machine);
    this.fold = new ClaudeFold((e, rep) => this.ev(e, rep));
    const opts: Options = {
      cwd: m.ssh ? undefined : expand(t.dir),
      includePartialMessages: true,
      // a subagent's whole conversation, not only its tool calls: its popup shows its turns as they happen
      forwardSubagentText: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      canUseTool: this.canUseTool,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
      stderr: d => this.tail(d),
    };
    const model = modelId('claude', t.model), effort = claudeEffort(t.effort), perm = permId('claude', t.perm) as PermissionMode | undefined;
    if (model) opts.model = model;
    if (effort) opts.effort = effort as Options['effort'];
    if (perm) { opts.permissionMode = perm; if (perm === 'bypassPermissions') opts.allowDangerouslySkipPermissions = true; }
    // the SDK runs fast mode only when the app opts in through flag settings (else 'sdk_opt_in_required')
    if (this.ultra || this.fast) opts.settings = { ...(this.ultra ? { ultracode: true } : {}), ...(this.fast ? { fastMode: true } : {}) };
    this.live = { model, effort, perm, ultra: this.ultra, fast: this.fast };

    if (!m.ssh && !existsSync(expand(t.dir))) throw this.fail('other', `The folder ${t.dir} does not exist on this computer.`);
    if (m.ssh) opts.spawnClaudeCodeProcess = sshSpawner(m, t.dir, d => this.tail(d));
    else { const exe = localExecutable(); if (exe) opts.pathToClaudeCodeExecutable = exe; }

    // New, resumed, or a fork (side chat): Claude Code takes the session id up front in every case.
    const transcript = t.sessionId ? await readClaudeTranscript(m, t.sessionId).catch(() => null) : null;
    if (transcript) opts.resume = t.sessionId;
    else if (t.parent) {
      const parent = this.host.thread(t.parent.id);
      const ptext = parent.sessionId ? await readClaudeTranscript(m, parent.sessionId).catch(() => null) : null;
      if (ptext && parent.sessionId) {
        opts.resume = parent.sessionId;
        opts.forkSession = true;
        if (t.sessionId) opts.sessionId = t.sessionId;
        const at = t.parent.at ? parseClaudeTranscript(ptext).fold.uuidOf.get(t.parent.at) : undefined;
        if (at) opts.resumeSessionAt = at;
      } else if (t.sessionId) opts.sessionId = t.sessionId;
    } else if (t.sessionId) opts.sessionId = t.sessionId;
    if (this.rewindAt) { opts.resume = t.sessionId; opts.resumeSessionAt = this.rewindAt; delete opts.sessionId; delete opts.forkSession; this.rewindAt = undefined; }

    const query = await this.query();
    this.inbox = new Inbox();
    this.stderr = '';
    this.q = query({ prompt: this.inbox, options: opts });
    const q = this.q;
    this.pump = this.read(q);
  }

  private tail(d: string) { this.stderr = (this.stderr + d).slice(-4000); }

  private async read(q: Query) {
    let failure: unknown = null;
    try {
      for await (const m of q) this.onMessage(m);
    } catch (e) { failure = e; }
    if (this.q !== q) return;
    const intended = this.closing;
    this.q = null; this.inbox = null;
    for (const [rid, p] of this.approvals) this.settle(rid, p, { behavior: 'deny', message: 'Stopped.' }, 'Cancelled');
    if (!intended) {
      const text = (failure instanceof Error ? failure.message : failure ? String(failure) : '') || this.stderr.trim().split('\n').slice(-3).join('\n') || 'Claude Code stopped unexpectedly.';
      const kind = errorKind(text + ' ' + this.stderr);
      this.fold?.settleRunning('failed');
      this.ev({ t: 'error', id: 'e-' + randomUUID(), kind: kind === 'other' ? 'crash' : kind, text: tidy(text, 600) });
      this.status('error');
      if (this.queue.length) this.setQueue(this.queue, true);
    } else if (this.running) this.status('idle');
    this.endTurn();
  }

  private onMessage(m: SDKMessage) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (m.session_id && m.session_id !== this.t.sessionId) this.host.update(this.id, { sessionId: m.session_id });
        } else if (m.subtype === 'compact_boundary') this.fold.notice('c-' + m.uuid, 'Context compacted');
        else if (m.subtype === 'task_notification' && m.tool_use_id) this.fold.subEnded(m.tool_use_id, m.status, m.usage?.duration_ms);
        return;
      case 'stream_event': return this.onStream(m.event as unknown as StreamEv, m.parent_tool_use_id);
      case 'assistant':
        if (!m.parent_tool_use_id) {
          this.partial.flush(); this.stream.clear();
          const u = (m.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
          if (u) this.contextUsed = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
        this.fold.assistant({ uuid: m.uuid, message: m.message as never, error: m.error }, m.parent_tool_use_id);
        return;
      case 'user':
        this.fold.user({ uuid: (m as { uuid?: string }).uuid, message: m.message as never, toolUseResult: m.tool_use_result, isSynthetic: m.isSynthetic } as never, m.parent_tool_use_id);
        return;
      case 'result': {
        this.partial.flush();
        const r = m as SDKMessage & { subtype: string; duration_ms: number; is_error: boolean; errors?: string[]; result?: string };
        if (r.subtype !== 'success') {
          const text = r.errors?.join('\n') || r.subtype.replace(/_/g, ' ');
          if (!this.interrupted && !/interrupt|aborted/i.test(text)) this.ev({ t: 'error', id: 'e-' + randomUUID(), kind: errorKind(text), text: tidy(text, 600) });
        } else if (r.is_error && r.result) this.ev({ t: 'error', id: 'e-' + randomUUID(), kind: errorKind(r.result), text: tidy(r.result, 600) });
        if (r.duration_ms >= 1000) this.fold.worked('w-' + this.turnId, r.duration_ms);
        this.fastNotice(m as { fast_mode_state?: FastModeState; fast_mode_disabled_reason?: FastModeDisabledReason });
        const window = Math.max(0, ...Object.values((r as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {}).map(x => x.contextWindow ?? 0));
        const ctx = window && this.contextUsed ? { ctx: Math.min(100, Math.round((this.contextUsed / window) * 100)), ctxTokens: { used: this.contextUsed, max: window } } : {};
        this.host.update(this.id, { status: r.is_error ? 'error' : 'idle', updatedAt: Date.now(), ...ctx });
        this.contextUsage();
        this.endTurn();
        // a stop or a failed turn pauses the queue (as Codex does); otherwise the next one starts
        if (this.queue.length && (this.interrupted || r.is_error || r.subtype !== 'success')) this.setQueue(this.queue, true);
        else this.nextQueued();
        return;
      }
      case 'auth_status':
        if (m.error) this.ev({ t: 'error', id: 'e-' + m.uuid, kind: 'auth', text: m.error });
        return;
      case 'rate_limit_event': {
        const i = m.rate_limit_info;
        if (i.status === 'rejected') {
          const when = i.resetsAt ? new Date(i.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
          this.ev({ t: 'error', id: 'e-' + m.uuid, kind: 'rate', text: `Usage limit reached${when ? `; resets at ${when}` : ''}.` });
        }
        return;
      }
      default: return;
    }
  }

  private onStream(e: StreamEv, parent: string | null) {
    if (parent) return; // subagents stream into their popup through whole messages only
    if (e.type === 'message_start') { this.streamMsg = e.message?.id ?? ''; this.stream.clear(); return; }
    if (e.type === 'content_block_start') {
      const k = e.content_block?.type;
      if (k === 'text' || k === 'thinking') this.stream.set(e.index!, { kind: k, text: '' });
      return;
    }
    if (e.type === 'content_block_delta') {
      const s = this.stream.get(e.index!);
      if (!s) return;
      s.text += e.delta?.type === 'text_delta' ? e.delta.text ?? '' : e.delta?.type === 'thinking_delta' ? e.delta.thinking ?? '' : '';
      const msg = this.streamMsg, n = e.index!, kind = s.kind, text = s.text;
      if (text.trim()) this.partial.push(() => this.fold.partial(msg, n, kind, text));
    }
  }

  /** Set when this turn was stopped on purpose (interrupt, or a denial that interrupts): its error result is expected. */
  private interrupted = false;
  private contextUsed = 0;
  /** Claude Code's own count (what /context shows): used, the window and where it auto-compacts. */
  private contextUsage() {
    this.q?.getContextUsage({ detail: 'summary' }).then(c => {
      const max = c.rawMaxTokens || c.maxTokens; if (!max) return;
      const compactAt = c.isAutoCompactEnabled && c.autoCompactThreshold ? c.autoCompactThreshold : undefined;
      this.host.update(this.id, { ctx: Math.min(100, Math.round((c.totalTokens / max) * 100)), ctxTokens: { used: c.totalTokens, max, ...(compactAt ? { compactAt } : {}) } });
    }, e => log('claude', 'context', e));
  }

  private startTurn(id: string) {
    this.interrupted = false;
    this.running = true; this.turnId = id; this.turnDone = deferred();
    this.status('running');
  }
  private endTurn() {
    this.running = false; this.turnDone.resolve();
  }

  private fail(kind: ErrorKind, text: string) {
    this.ev({ t: 'error', id: 'e-' + randomUUID(), kind, text });
    this.status('error');
    return new Error(text);
  }

  private async applySettings() {
    const t = this.t, q = this.q;
    if (!q) return;
    const model = modelId('claude', t.model), effort = claudeEffort(t.effort), perm = permId('claude', t.perm) as PermissionMode | undefined;
    if (model && model !== this.live.model) { await q.setModel(model).catch(e => log('claude', 'model', e)); this.live.model = model; this.ev({ t: 'notice', id: 'n-' + randomUUID(), text: `Model: ${t.model}` }); }
    if (perm && perm !== this.live.perm) { await q.setPermissionMode(perm).catch(e => log('claude', 'perm', e)); this.live.perm = perm; }
    // an effortLevel sent without an ultracode key turns Ultracode off (SDK applyFlagSettings), so a change of any
    // of them sends Ultracode and fast mode too; Ultracode works at any effort
    const effortMoved = !!effort && effort !== this.live.effort, ultraMoved = this.ultra !== !!this.live.ultra, fastMoved = this.fast !== !!this.live.fast;
    if (effortMoved || ultraMoved || fastMoved) {
      await q.applyFlagSettings({ ...(effortMoved ? { effortLevel: effort as never } : {}), ultracode: this.ultra, fastMode: this.fast }).catch(e => log('claude', 'effort / ultracode / fast', e));
      if (effortMoved) this.live.effort = effort;
      this.live.ultra = this.ultra; this.live.fast = this.fast;
      if (fastMoved) this.fastSaid = undefined;
    }
  }

  /** Fast mode was asked for and Claude Code says it didn't run: say why, once (the chip still shows it as on). */
  private fastNotice(r: { fast_mode_state?: FastModeState; fast_mode_disabled_reason?: FastModeDisabledReason }) {
    if (!this.fast || !r.fast_mode_state || r.fast_mode_state === 'on') { this.fastSaid = undefined; return; }
    const why = r.fast_mode_state === 'cooldown' ? 'cooldown' : r.fast_mode_disabled_reason;
    if (!why || why === 'pending' || why === this.fastSaid) return;
    this.fastSaid = why;
    this.ev({ t: 'notice', id: 'n-' + randomUUID(), text: FAST_OFF[why] ?? "Fast mode isn't available right now" });
  }

  // ---- rewind (edit and resend, retry) ----

  private rewindAt: string | undefined;
  private sentText = new Map<string, string>();

  private async transcriptFold() {
    const t = this.t;
    if (!t.sessionId) return null;
    const text = await readClaudeTranscript(this.host.machine(t.machine), t.sessionId).catch(() => null);
    return text ? parseClaudeTranscript(text) : null;
  }

  private async lastUser(): Promise<{ id: string; text: string; images?: string[] } | null> {
    const h = await this.transcriptFold();
    const u = h?.events.filter((e): e is Extract<ThreadEvent, { t: 'user' }> => e.t === 'user').pop();
    if (u) return u;
    return this.lastSend ? { id: '', ...this.lastSend } : null;
  }

  /** Resume the session just before a user message, so the next send replaces it and what followed. */
  private async rewindTo(userEventId: string) {
    if (this.running) { await this.interrupt(); await this.turnDone.promise; }
    await this.stop();
    const h = await this.transcriptFold();
    if (!h) return;
    let id = userEventId;
    if (!h.fold.before.has(id)) {
      // A message sent in this session may be stored under another uuid: match it by its text instead.
      const text = this.sentText.get(userEventId);
      const hit = text != null ? h.events.filter(e => e.t === 'user' && e.text === text).pop() : undefined;
      if (!hit) return; // not in the transcript: nothing to rewind
      id = hit.id;
    }
    const before = h.fold.before.get(id);
    if (before) this.rewindAt = before;
    else this.host.update(this.id, { sessionId: randomUUID() }); // editing the first message starts over
  }

  // ---- permission prompts ----

  private canUseTool: CanUseTool = (tool, input, o) => new Promise<PermissionResult>(resolve => {
    const requestId = o.toolUseID ?? randomUUID();
    const req = approvalFor(tool, input, requestId, o);
    const arg = tidy(toolArg(tool, input) || toolName(tool), 80);
    const p: Pending = { req, arg, input, done: resolve, suggestions: o.suggestions };
    this.approvals.set(requestId, p);
    o.signal.addEventListener('abort', () => this.settle(requestId, p, { behavior: 'deny', message: 'Cancelled.' }, 'Cancelled'), { once: true });
    this.ev({ t: 'approval', id: 'ap-' + requestId, request: req });
    this.status('wait');
  });

  private settle(requestId: string, p: Pending, r: PermissionResult, note: string) {
    if (this.approvals.get(requestId) !== p) return;
    this.approvals.delete(requestId);
    if (r.behavior === 'deny' && r.interrupt) this.interrupted = true;
    this.ev({ t: 'notice', id: 'ap-' + requestId, text: note }, true);
    if (!this.approvals.size && this.running) this.status('running');
    p.done(r);
  }
}

type StreamEv = { type: string; index?: number; message?: { id?: string }; content_block?: { type?: string }; delta?: { type?: string; text?: string; thinking?: string } };

/** The card for a permission prompt. */
export function approvalFor(tool: string, input: Record<string, unknown>, requestId: string, o: { title?: string; description?: string; decisionReason?: string; suggestions?: unknown[] } = {}): ApprovalRequest {
  const opts = (always: boolean) => [
    { id: 'allow', label: 'Allow', primary: true },
    ...(always ? [{ id: 'always', label: 'Always allow' }] : []),
    { id: 'deny', label: 'Deny' },
  ];
  const always = !!o.suggestions?.length;
  if (tool === 'ExitPlanMode') return {
    requestId, kind: 'plan', title: 'Ready to start?', body: String(input.plan ?? ''),
    options: [{ id: 'accept-edits', label: 'Yes, accept edits', primary: true }, { id: 'approve', label: 'Yes, ask before edits' }, { id: 'deny', label: 'Keep planning' }],
  };
  if (tool === 'AskUserQuestion') {
    const q = ((input.questions as { question?: string; options?: { label?: string; description?: string }[] }[] | undefined) ?? [])[0];
    const choices = (q?.options ?? []).map((c, i) => ({ id: `opt:${i}`, label: String(c.label ?? ''), ...(i === 0 ? { primary: true } : {}) }));
    return { requestId, kind: 'other', title: String(q?.question ?? 'Claude has a question'), body: (q?.options ?? []).map(c => `${c.label}${c.description ? `: ${c.description}` : ''}`).join('\n'), options: [...choices, { id: 'deny', label: 'Skip' }] };
  }
  if (tool === 'Bash') return { requestId, kind: 'command', title: 'Run this command?', body: String(input.command ?? ''), detail: (input.description as string | undefined) ?? o.decisionReason, options: opts(always) };
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const path = String(input.file_path ?? input.notebook_path ?? '');
    const diff = tool === 'Edit' ? replaceDiff(path, String(input.old_string ?? ''), String(input.new_string ?? ''))
      : tool === 'Write' ? replaceDiff(path, '', String(input.content ?? ''))
      : tool === 'MultiEdit' ? ((input.edits as { old_string?: string; new_string?: string }[]) ?? []).map(e => replaceDiff(path, e.old_string ?? '', e.new_string ?? '')).join('\n')
      : String(input.new_source ?? '');
    return { requestId, kind: 'edit', title: `${tool === 'Write' ? 'Write' : 'Edit'} ${path.split(/[\\/]/).pop()}?`, body: diff, detail: path, options: opts(always) };
  }
  const arg = toolArg(tool, input);
  return { requestId, kind: 'other', title: o.title ?? `Use ${toolName(tool)}?`, body: arg || JSON.stringify(input, null, 2), detail: o.description ?? o.decisionReason, options: opts(always) };
}
