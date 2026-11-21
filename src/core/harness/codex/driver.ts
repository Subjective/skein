// The Codex chat driver. One `codex app-server` per machine (stdio JSON-RPC; over ssh for remote machines)
// serves every Codex thread on it; notifications and approval requests are routed by thread id.
// A thread started from Skein gets its Codex thread id from thread/start (or thread/fork for a side chat)
// and keeps it as ThreadMeta.sessionId, which links it to the rollout and the TUI's `codex resume`.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSend } from '../../../shared/api';
import { effortId, modelId, permId } from '../../../shared/models';
import type { ApprovalRequest, Machine, ThreadEvent, ThreadMeta } from '../../../shared/types';
import type { ChatDriver, ChatHost } from '../../chat';
import { spawnOn } from '../../exec';
import { log } from '../../log';
import { which } from '../../shell';
import { errorKind, throttle, tidy } from '../common';
import { codexHistory } from './history';
import { agentStates, commandStep, itemEvents, turnError } from './items';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { UserInput } from './protocol/v2/UserInput';
import { Rpc } from './rpc';

type Params = Record<string, unknown> & { threadId?: string; conversationId?: string };

export interface ThreadListener {
  notify(method: string, p: Params): void;
  request(method: string, p: Params, rpcId: string | number): Promise<unknown>;
  exited(reason: string): void;
}

const VERSION = '0.1.0';

/** A running app-server and, for a local one, the loopback websocket a TUI can attach to with --remote. */
export interface Launched { rpc: Rpc; attach?: { url: string; token: string } }
/** Starts `codex app-server` on a machine. Injected so tests can run a fake server. */
export type Launch = (m: Machine) => Promise<Launched>;

const quoteWin = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/** Spawn the local codex CLI. npm installs a .cmd shim on Windows, which only runs through the shell. */
function spawnCodex(args: string[]) {
  const exe = which('codex');
  if (!exe) throw Object.assign(new Error('Codex is not installed on this computer (codex was not found on PATH).'), { code: 'ENOENT' });
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
  return viaShell
    ? spawn([exe, ...args].map(quoteWin).join(' '), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: true, env: process.env })
    : spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const a = srv.address(); srv.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port')))); });
});

/** Local: listen on a loopback websocket with a capability token, so the terminal view can attach to the same
 *  server (`codex --remote`) and both views stay live. Falls back to stdio when that does not come up. */
async function launchLocalWs(): Promise<Launched> {
  if (typeof WebSocket === 'undefined') throw new Error('no WebSocket');
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'skein-codex-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const proc = spawnCodex(['app-server', '--listen', `ws://127.0.0.1:${port}`, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile]);
  let exited: string | null = null, stderr = '';
  proc.stderr?.on('data', d => { stderr = (stderr + String(d)).slice(-2000); });
  proc.on('exit', code => {
    exited = `exited with code ${code}`;
    // in an event handler a throw is an uncaught exception; Windows can refuse the delete for a moment (EBUSY)
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { log('codex', 'token folder', (e as Error).message); }
  });
  proc.on('error', e => { exited = e.message; });
  const url = `ws://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !exited) {
    const ws = await new Promise<WebSocket | null>(resolve => {
      const w = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(url, { headers: { Authorization: `Bearer ${token}` } });
      w.addEventListener('open', () => resolve(w), { once: true });
      w.addEventListener('error', () => resolve(null), { once: true });
    });
    if (ws) return { rpc: Rpc.overWebSocket(ws, proc), attach: { url, token } };
    await new Promise(r => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(exited ? `${exited}: ${stderr.trim().split('\n').slice(-2).join(' ')}` : 'timed out');
}

export const launchAppServer: Launch = async m => {
  if (m.ssh) return { rpc: Rpc.overProcess(spawnOn(m, ['codex', 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })) };
  try { return await launchLocalWs(); }
  catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') throw e;
    log('codex', 'websocket app-server unavailable, using stdio:', (e as Error).message);
    return { rpc: Rpc.overProcess(spawnCodex(['app-server'])) };
  }
};

/** One app-server per machine, started on first use and restarted after it exits. */
export class CodexServers {
  private servers = new Map<string, { rpc?: Rpc; attach?: Launched['attach']; ready: Promise<Rpc> }>();
  private listeners = new Map<string, ThreadListener>();

  constructor(private launch: Launch = launchAppServer) {}

  listen(threadId: string, l: ThreadListener) { this.listeners.set(threadId, l); return () => { if (this.listeners.get(threadId) === l) this.listeners.delete(threadId); }; }

  /** Where a TUI can attach to this machine's server, if it is running and reachable that way. */
  attachInfo(m: Machine) { return this.servers.get(m.id)?.attach; }

  get(m: Machine): Promise<Rpc> {
    const cur = this.servers.get(m.id);
    if (cur && (!cur.rpc || cur.rpc.alive)) return cur.ready;
    const entry: { rpc?: Rpc; attach?: Launched['attach']; ready: Promise<Rpc> } = { ready: null as never };
    entry.ready = (async () => {
      const { rpc, attach } = await this.launch(m);
      entry.rpc = rpc; entry.attach = attach;
      rpc.onNotify = (method, p) => { const id = threadOf(p); if (id) this.listeners.get(id)?.notify(method, p as Params); };
      rpc.onRequest = async (method, p, rpcId) => {
        const id = threadOf(p);
        const l = id ? this.listeners.get(id) : undefined;
        if (!l) throw { code: -32601, message: 'No Skein view is driving this thread' };
        return l.request(method, p as Params, rpcId);
      };
      rpc.onExit = (_code, reason) => {
        if (this.servers.get(m.id) === entry) this.servers.delete(m.id);
        for (const l of this.listeners.values()) l.exited(reason);
      };
      await rpc.request('initialize', { clientInfo: { name: 'skein', title: 'Skein', version: VERSION }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['mcpServer/startupStatus/updated', 'remoteControl/status/changed', 'thread/realtime/outputAudio/delta'] } });
      rpc.notify('initialized');
      return rpc;
    })();
    entry.ready.catch(() => { if (this.servers.get(m.id) === entry) this.servers.delete(m.id); entry.rpc?.kill(); });
    this.servers.set(m.id, entry);
    return entry.ready;
  }

  dispose() { for (const s of this.servers.values()) s.rpc?.kill(); this.servers.clear(); }
}

const threadOf = (p: unknown): string | undefined => {
  const o = p as Params | undefined;
  return (o?.threadId ?? o?.conversationId ?? (o as { thread?: { id?: string } })?.thread?.id) as string | undefined;
};

/** Approval policy and sandbox for a permission id from shared/models. */
export function codexPerm(id: string | undefined) {
  switch (id) {
    case 'read-only': return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
    case 'full-access': return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, approvalsReviewer: 'user' };
    case 'auto': case 'auto-review': return {
      approvalPolicy: 'on-request', sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      // who answers the approval requests: you, or Codex's auto-review ("Approve for me")
      approvalsReviewer: id === 'auto-review' ? 'auto_review' : 'user',
    };
    default: return null;
  }
}

/** `$name` in the text names a skill (as the composer's / menu inserts it, and as Codex's own composer does):
 *  each one the folder has goes with the text as a skill input, so Codex loads it. */
export async function skillInputs(rpc: Pick<Rpc, 'request'>, text: string, cwd: string): Promise<UserInput[]> {
  const names = new Set([...text.matchAll(/(?:^|\s)\$([A-Za-z0-9][\w.:-]*)/g)].map(m => m[1]));
  if (!names.size) return [];
  try {
    const r = await rpc.request<{ data: { skills: { name: string; path: string; enabled?: boolean }[] }[] }>('skills/list', { cwds: [cwd] });
    return (r.data ?? []).flatMap(e => e.skills ?? []).filter(k => names.has(k.name) && k.enabled !== false && k.path)
      .map((k): UserInput => ({ type: 'skill', name: k.name, path: k.path }));
  } catch (e) { log('codex', 'skills/list', (e as Error).message); return []; }
}

const expand = (m: Machine, dir: string) => (m.ssh ? (dir.startsWith('~') ? (m.home ? m.home + dir.slice(1) : dir) : dir) : dir === '~' ? homedir() : dir.startsWith('~/') || dir.startsWith('~\\') ? join(homedir(), dir.slice(2)) : dir);

/** What thread/start, thread/resume and thread/fork answer with (the parts Skein reads). */
interface Opened { thread: { id: string }; model?: string; reasoningEffort?: string | null }

interface Pending { req: ApprovalRequest; method: string; params: Params; resolve: (v: unknown) => void; arg: string; rpcId: string }
type SubEv = Extract<ThreadEvent, { t: 'sub' }>;

export class CodexDriver implements ChatDriver {
  private rpc: Rpc | null = null;
  private loaded = false;
  private turn: string | null = null;
  private turnStarted = 0;
  private approvals = new Map<string, Pending>();
  private items = new Map<string, ThreadItem>();
  private text = new Map<string, { kind: 'text' | 'thinking' | 'out'; s: string }>();
  private sent = new Set<string>();
  private unlisten: (() => void) | null = null;
  private flush = throttle<() => void>(60, f => f());
  private lastUser: { id: string; text: string; images?: string[] } | null = null;
  /** The sub-agents this thread spawned, by sub event id. Each is a Codex thread of its own (its `agent`), listened
   *  to so its turns stream into its popup and its approvals reach this thread's chat. */
  private subs = new Map<string, SubEv>();
  private children = new Map<string, () => void>();
  private resumed = new Set<string>();
  /** A sub-agent thread's running turn, which a follow-up steers. */
  private childTurn = new Map<string, string>();

  constructor(private id: string, private host: ChatHost, private servers: CodexServers) {}

  private get t(): ThreadMeta { return this.host.thread(this.id); }
  private get m(): Machine { return this.host.machine(this.t.machine); }
  private ev = (e: ThreadEvent, replace = false) => {
    if (e.t === 'sub') {
      // the spawn item knows nothing of the turns streamed in since: keep them
      e = { ...this.subs.get(e.id), ...e, events: e.events ?? this.subs.get(e.id)?.events };
      this.subs.set(e.id, e);
      if (e.agent) this.listenChild(e);
    }
    this.host.event(this.id, e, replace);
  };
  private status(s: ThreadMeta['status']) { if (this.t.status !== s) this.host.update(this.id, { status: s }); }
  private error(text: string, kind = errorKind(text)) { this.ev({ t: 'error', id: 'e-' + randomUUID(), kind, text: tidy(text, 600) }); this.status('error'); }

  async send(msg: ChatSend): Promise<void> {
    if (msg.sub) return this.sendToSub(msg);
    let text = msg.text, images = msg.images;
    const t0 = this.t;
    const patch: Partial<ThreadMeta> = {};
    if (msg.model && msg.model !== t0.model) patch.model = msg.model;
    if (msg.effort && msg.effort !== t0.effort) patch.effort = msg.effort;
    if (msg.perm && msg.perm !== t0.perm) patch.perm = msg.perm;
    if ((!t0.title || t0.title === 'New thread') && text.trim()) patch.title = tidy(text, 60);
    if (Object.keys(patch).length) this.host.update(this.id, patch);

    if (!(await this.ensure())) return;
    const rpc = this.rpc!, threadId = this.t.sessionId!;

    if (msg.retry) {
      const last = this.lastUser ?? (await codexHistory(rpc, threadId)).events.filter((e): e is Extract<ThreadEvent, { t: 'user' }> => e.t === 'user').pop();
      if (!last) return;
      text = last.text; images = last.images;
      if (!(await this.revert(last.id))) return;
    } else if (msg.rewind) {
      if (!(await this.revert(msg.rewind))) return;
    }

    const clientId = randomUUID();
    const input = await this.inputOf(text, images);
    this.sent.add(clientId);
    this.lastUser = { id: clientId, text, images };
    this.ev({ t: 'user', id: clientId, text, ...(images?.length ? { images } : {}), at: Date.now() });

    const t = this.t;
    try {
      if (this.turn) {
        await rpc.request('turn/steer', { threadId, clientUserMessageId: clientId, input, expectedTurnId: this.turn });
      } else {
        this.status('running');
        const perm = codexPerm(permId('codex', t.perm));
        const r = await rpc.request<{ turn: { id: string } }>('turn/start', {
          threadId, clientUserMessageId: clientId, input,
          // the thread's folder every turn, so a moved thread works in its new one
          cwd: expand(this.m, t.dir),
          ...(modelId('codex', t.model) ? { model: modelId('codex', t.model) } : {}),
          ...(effortId(t.effort) ? { effort: effortId(t.effort) } : {}),
          ...(perm ? { approvalPolicy: perm.approvalPolicy, approvalsReviewer: perm.approvalsReviewer, sandboxPolicy: perm.sandboxPolicy } : {}),
        });
        this.beginTurn(r.turn.id);
      }
    } catch (e) {
      this.error((e as Error).message);
    }
  }

  private async inputOf(text: string, images?: string[]): Promise<UserInput[]> {
    return [
      ...(images ?? []).map((src): UserInput => (/^(data:|https?:)/.test(src) || this.m.ssh ? { type: 'image', url: src.startsWith('data:') || /^https?:/.test(src) ? src : toDataUrl(src) } : { type: 'localImage', path: src })),
      ...(text ? [{ type: 'text' as const, text, text_elements: [] }] : []),
      ...(await skillInputs(this.rpc!, text, expand(this.m, this.t.dir))),
    ];
  }

  /** A follow-up to a sub-agent: a turn on its own thread, which the app-server takes like any other. */
  private async sendToSub(msg: ChatSend): Promise<void> {
    if (!(await this.ensure())) return;
    const rpc = this.rpc!;
    let sub = this.subs.get(msg.sub!);
    if (!sub) {
      const e = (await codexHistory(rpc, this.t.sessionId)).events.find((x): x is SubEv => x.t === 'sub' && x.id === msg.sub);
      if (e) { sub = { ...e, events: [] }; this.subs.set(e.id, sub); }
    }
    if (!sub?.agent) throw new Error("Follow-ups aren't available for this subagent");
    this.listenChild(sub);
    if (!this.resumed.has(sub.agent)) { await rpc.request('thread/resume', { threadId: sub.agent, excludeTurns: true }); this.resumed.add(sub.agent); }
    const clientId = randomUUID();
    const input = await this.inputOf(msg.text, msg.images);
    this.ev({ ...sub, status: 'running', events: [...(sub.events ?? []), { t: 'user', id: clientId, text: msg.text, ...(msg.images?.length ? { images: msg.images } : {}), at: Date.now() }] }, true);
    const turn = this.childTurn.get(sub.agent);
    if (turn) await rpc.request('turn/steer', { threadId: sub.agent, clientUserMessageId: clientId, input, expectedTurnId: turn });
    else await rpc.request('turn/start', { threadId: sub.agent, clientUserMessageId: clientId, input });
  }

  private listenChild(sub: SubEv) {
    const child = sub.agent;
    if (!child || this.children.has(child)) return;
    this.children.set(child, this.servers.listen(child, {
      notify: (method, p) => {
        if (method === 'turn/started') this.childTurn.set(child, String((p.turn as { id?: string } | undefined)?.id));
        else if (method === 'turn/completed') this.childTurn.delete(child);
        this.onChildNotify(sub.id, method, p);
      },
      request: (method, p, rpcId) => this.onRequest(method, p, rpcId, this.subs.get(sub.id)?.name),
      exited: () => { this.resumed.delete(child); },
    }));
  }

  /** A sub-agent's own thread: its items become its popup's events, its turns its running state. */
  private onChildNotify(subId: string, method: string, p: Params) {
    const s = this.subs.get(subId);
    if (!s) return;
    if (method === 'turn/started') { if (s.status !== 'running') this.ev({ ...s, status: 'running' }, true); return; }
    if (method === 'turn/completed') { this.ev({ ...s, status: (p.turn as { status?: string }).status === 'failed' ? 'failed' : 'done' }, true); return; }
    if (method !== 'item/started' && method !== 'item/completed') return;
    const list = [...(s.events ?? [])];
    for (const e of itemEvents(p.item as ThreadItem)) { const i = list.findIndex(x => x.id === e.id); if (i >= 0) list[i] = e; else list.push(e); }
    this.ev({ ...s, events: list }, true);
  }

  async interrupt(): Promise<void> {
    for (const [rid, p] of this.approvals) this.settle(rid, p, decline(p.method, true), 'Cancelled');
    if (this.rpc && this.turn && this.t.sessionId) await this.rpc.request('turn/interrupt', { threadId: this.t.sessionId, turnId: this.turn }).catch(e => log('codex', 'interrupt', e));
  }

  async answer(requestId: string, optionId: string): Promise<void> {
    const p = this.approvals.get(requestId);
    if (!p) return;
    const label = p.req.options.find(o => o.id === optionId)?.label ?? optionId;
    if (p.method === 'item/tool/requestUserInput') {
      const qs = (p.params.questions as { id: string }[] | undefined) ?? [];
      if (optionId === 'decline') return this.settle(requestId, p, { answers: {} }, 'Skipped');
      return this.settle(requestId, p, { answers: { [qs[0]?.id ?? '']: { answers: [label] } } }, `Answered: ${label}`);
    }
    if (p.method === 'item/permissions/requestApproval') {
      if (optionId === 'decline') return this.settle(requestId, p, { permissions: {}, scope: 'turn' }, 'Denied');
      return this.settle(requestId, p, { permissions: p.params.permissions ?? {}, scope: optionId === 'acceptForSession' ? 'session' : 'turn' }, 'Allowed');
    }
    const legacy = p.method === 'execCommandApproval' || p.method === 'applyPatchApproval';
    const decision = legacy
      ? (optionId === 'accept' ? 'approved' : optionId === 'acceptForSession' ? 'approved_for_session' : { denied: { rejection: 'The user declined.' } })
      : optionId;
    const verb = optionId === 'decline' ? 'Denied' : optionId === 'acceptForSession' ? 'Always allowed' : 'Allowed';
    this.settle(requestId, p, { decision }, `${verb}: ${p.arg}`);
  }

  /** Create (or fork, or resume) the Codex thread now, so its id is known before any view uses it. */
  async prepare(): Promise<boolean> { return this.ensure(); }

  /** TUI arguments that attach to the same app-server (local machines), so terminal and chat are both live. */
  async attachArgs(): Promise<{ args: string[]; env: Record<string, string> } | null> {
    if (!(await this.ensure())) return null;
    const info = this.servers.attachInfo(this.m);
    if (!info) return null;
    return { args: ['--remote', info.url, '--remote-auth-token-env', 'SKEIN_CODEX_TOKEN', 'resume', this.t.sessionId!], env: { SKEIN_CODEX_TOKEN: info.token } };
  }

  /** Codex needs no handoff: the terminal resumes the same thread id. Nothing to let go of. */
  async release(): Promise<void> {}

  /** Stop listening and let the app-server unload the thread, so the next resume reads its record again. */
  dispose() {
    this.unlisten?.(); this.unlisten = null;
    for (const off of this.children.values()) off();
    this.children.clear(); this.resumed.clear(); this.childTurn.clear();
    const id = this.t.sessionId;
    if (this.rpc?.alive && id && this.loaded) void this.rpc.request('thread/unsubscribe', { threadId: id }).catch(() => undefined);
    this.loaded = false;
  }

  // ---- thread lifecycle ----

  private async ensure(): Promise<boolean> {
    const m = this.m;
    try {
      this.rpc = await this.servers.get(m);
    } catch (e) {
      const text = (e as Error).message || 'Codex app-server did not start.';
      const kind = errorKind(text, (e as { code?: string }).code);
      this.error(kind === 'missing' ? text : `Codex did not start: ${text}`, kind);
      return false;
    }
    if (this.loaded && this.rpc.alive) return true;
    const t = this.t, rpc = this.rpc;
    const perm = codexPerm(permId('codex', t.perm));
    const common = {
      cwd: expand(m, t.dir),
      ...(modelId('codex', t.model) ? { model: modelId('codex', t.model) } : {}),
      ...(perm ? { approvalPolicy: perm.approvalPolicy, sandbox: perm.sandbox } : {}),
    };
    if (!m.ssh && !existsSync(common.cwd)) { this.error(`The folder ${t.dir} does not exist on this computer.`, 'other'); return false; }
    try {
      let threadId = t.sessionId;
      let r: Opened;
      if (threadId) {
        this.listenTo(threadId);
        r = await rpc.request<Opened>('thread/resume', { threadId, ...common, excludeTurns: true });
      } else if (t.parent && this.host.thread(t.parent.id).sessionId) {
        const parent = this.host.thread(t.parent.id).sessionId!;
        const lastTurnId = t.parent.at ? (await codexHistory(rpc, parent)).turnOf.get(t.parent.at) : undefined;
        r = await rpc.request<Opened>('thread/fork', { threadId: parent, ...(lastTurnId ? { lastTurnId } : {}), ...common, excludeTurns: true });
        threadId = r.thread.id;
        this.listenTo(threadId);
        this.host.update(this.id, { sessionId: threadId });
      } else {
        r = await rpc.request<Opened>('thread/start', { ...common, serviceName: 'skein' });
        threadId = r.thread.id;
        this.listenTo(threadId);
        this.host.update(this.id, { sessionId: threadId });
      }
      // A thread with no model of its own (one started outside Skein, or before a pick) runs what Codex chose:
      // record it, so the composer's picker shows the model and effort the next turn really uses.
      const cur = this.t, adopt: Partial<ThreadMeta> = {};
      if (!cur.model && r?.model) adopt.model = r.model;
      if (!cur.effort && r?.reasoningEffort) adopt.effort = r.reasoningEffort;
      if (Object.keys(adopt).length) this.host.update(this.id, adopt);
      this.loaded = true;
      return true;
    } catch (e) {
      this.error((e as Error).message);
      return false;
    }
  }

  private listenTo(threadId: string) {
    this.unlisten?.();
    this.unlisten = this.servers.listen(threadId, {
      notify: (method, p) => this.onNotify(method, p),
      request: (method, p, rpcId) => this.onRequest(method, p, rpcId),
      exited: reason => this.onExit(reason),
    });
  }

  /** thread/revert to before the turn holding this user message, so the next send replaces it. */
  private async revert(userEventId: string): Promise<boolean> {
    const threadId = this.t.sessionId!;
    if (this.turn) { await this.interrupt(); await new Promise(r => setTimeout(r, 300)); }
    const turnId = (await codexHistory(this.rpc!, threadId)).turnOf.get(userEventId) ?? this.turnOfLive.get(userEventId);
    if (!turnId) return true; // never reached the rollout: nothing to undo
    try { await this.rpc!.request('thread/revert', { threadId, beforeTurnId: turnId }); return true; }
    catch (e) { this.error(`Could not rewind: ${(e as Error).message}`, 'other'); return false; }
  }
  private turnOfLive = new Map<string, string>();

  private beginTurn(id: string) {
    if (this.turn === id) return;
    this.turn = id; this.turnStarted = Date.now();
    this.status('running');
  }

  private onExit(reason: string) {
    this.loaded = false;
    const wasRunning = !!this.turn;
    for (const [rid, p] of this.approvals) this.settle(rid, p, {}, 'Cancelled');
    this.turn = null;
    for (const it of this.items.values()) for (const e of itemEvents(it)) if ('status' in e && e.status === 'running') this.ev({ ...e, status: 'failed' } as ThreadEvent, true);
    this.items.clear();
    if (wasRunning || this.t.status === 'running') this.error(`Codex stopped: ${reason}`, errorKind(reason) === 'other' ? 'crash' : errorKind(reason));
  }

  // ---- notifications ----

  private onNotify(method: string, p: Params) {
    switch (method) {
      case 'turn/started': this.beginTurn((p.turn as { id: string }).id); return;
      case 'turn/completed': {
        this.flush.flush();
        const turn = p.turn as { id: string; status: string; error: Parameters<typeof turnError>[1] | null; durationMs: number | null };
        const ms = turn.durationMs ?? (this.turnStarted ? Date.now() - this.turnStarted : 0);
        if (turn.status === 'failed' && turn.error) this.ev(turnError('e-' + turn.id, turn.error));
        if (turn.status === 'interrupted') this.ev({ t: 'interrupted', id: 'i-' + turn.id });
        if (ms >= 1000) this.ev({ t: 'worked', id: 'w-' + turn.id, ms });
        for (const [rid, p2] of this.approvals) this.settle(rid, p2, decline(p2.method, true), 'Cancelled');
        this.turn = null; this.items.clear(); this.text.clear();
        this.host.update(this.id, { status: turn.status === 'failed' ? 'error' : 'idle', updatedAt: Date.now() });
        return;
      }
      case 'item/started': case 'item/completed': {
        const item = p.item as ThreadItem;
        if (p.turnId && item.type === 'userMessage') this.turnOfLive.set(item.clientId ?? item.id, String(p.turnId));
        if (item.type === 'userMessage' && item.clientId && this.sent.has(item.clientId)) return; // shown when sent
        if (method === 'item/completed') { this.items.delete(item.id); this.text.delete(item.id); this.flush.flush(); } else this.items.set(item.id, item);
        for (const e of itemEvents(item)) this.ev(e, true);
        // a wait or a close says how a sub-agent ended
        for (const [agent, status] of agentStates(item)) for (const sub of this.subs.values()) if (sub.agent === agent && sub.status !== status) this.ev({ ...sub, status }, true);
        return;
      }
      case 'item/agentMessage/delta': return this.delta(String(p.itemId), 'text', String(p.delta ?? ''));
      case 'item/reasoning/summaryTextDelta': case 'item/reasoning/textDelta': return this.delta(String(p.itemId), 'thinking', String(p.delta ?? ''));
      case 'item/commandExecution/outputDelta': return this.delta(String(p.itemId), 'out', String(p.delta ?? ''));
      case 'turn/plan/updated': {
        const plan = (p.plan as { step: string; status: string }[]) ?? [];
        if (plan.length) this.ev({ t: 'todo', id: 'plan-' + p.turnId, items: plan.map(s => ({ text: s.step, done: s.status === 'completed' })) }, true);
        return;
      }
      case 'thread/name/updated': if (p.threadName) this.host.update(this.id, { title: String(p.threadName) }); return;
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage as { last?: { inputTokens?: number; totalTokens?: number }; modelContextWindow?: number | null } | undefined;
        const used = u?.last?.inputTokens ?? u?.last?.totalTokens;
        if (u?.modelContextWindow && used != null) this.host.update(this.id, { ctx: Math.min(100, Math.round((used / u.modelContextWindow) * 100)) });
        return;
      }
      case 'serverRequest/resolved': {
        const rid = String(p.requestId);
        for (const [k, pend] of this.approvals) if (pend.rpcId === rid) { this.approvals.delete(k); this.ev({ t: 'notice', id: 'ap-' + k, text: 'Answered in the terminal' }, true); pend.resolve(decline(pend.method, true)); }
        return;
      }
      case 'error': {
        if (p.willRetry) return;
        this.ev(turnError('e-' + randomUUID(), p.error as Parameters<typeof turnError>[1]));
        return;
      }
      default: return;
    }
  }

  private delta(itemId: string, kind: 'text' | 'thinking' | 'out', d: string) {
    const cur = this.text.get(itemId) ?? { kind, s: '' };
    cur.s += d;
    this.text.set(itemId, cur);
    const item = this.items.get(itemId);
    this.flush.push(() => {
      const s = this.text.get(itemId)?.s ?? '';
      if (kind === 'text') this.ev({ t: 'text', id: itemId, text: s, streaming: true }, true);
      else if (kind === 'thinking') this.ev({ t: 'thinking', id: itemId, text: s }, true);
      else if (item?.type === 'commandExecution') this.ev({ ...commandStep(item), id: itemId, out: s.slice(-6000), status: 'running' }, true);
    });
  }

  // ---- approvals and questions ----

  /** `from`: the sub-agent that asks, when it is not this thread. */
  private onRequest(method: string, p: Params, rpcId: string | number, from?: string): Promise<unknown> {
    const asked = this.approvalFor(method, p);
    if (!asked) return Promise.reject({ code: -32601, message: `Skein does not support ${method}` });
    const req = from ? { ...asked, from } : asked;
    return new Promise(resolve => {
      const arg = req.kind === 'command' ? tidy(req.body, 80) : req.detail ?? req.title;
      this.approvals.set(req.requestId, { req, method, params: p, resolve, arg, rpcId: String(rpcId) });
      this.ev({ t: 'approval', id: 'ap-' + req.requestId, request: req });
      this.status('wait');
    });
  }

  private approvalFor(method: string, p: Params): ApprovalRequest | null {
    const requestId = String(p.approvalId ?? p.itemId ?? p.callId ?? randomUUID());
    const opts = [{ id: 'accept', label: 'Allow', primary: true }, { id: 'acceptForSession', label: 'Always allow' }, { id: 'decline', label: 'Deny' }];
    switch (method) {
      case 'item/commandExecution/requestApproval': case 'execCommandApproval': {
        const cmd = Array.isArray(p.command) ? (p.command as string[]).join(' ') : String(p.command ?? (this.items.get(String(p.itemId)) as { command?: string } | undefined)?.command ?? '');
        return { requestId, kind: 'command', title: 'Run this command?', body: cmd, detail: (p.reason as string | null) ?? undefined, options: opts };
      }
      case 'item/fileChange/requestApproval': case 'applyPatchApproval': {
        const item = this.items.get(String(p.itemId));
        const changes = item?.type === 'fileChange' ? item.changes : Object.entries((p.fileChanges as Record<string, { unified_diff?: string; content?: string }>) ?? {}).map(([path, c]) => ({ path, diff: c.unified_diff ?? c.content ?? '' }));
        const paths = changes.map(c => c.path);
        return { requestId, kind: 'edit', title: paths.length === 1 ? `Edit ${paths[0].split(/[\\/]/).pop()}?` : `Edit ${paths.length} files?`, body: changes.map(c => c.diff).join('\n'), detail: paths.join(', ') || ((p.reason as string | null) ?? undefined), options: opts };
      }
      case 'item/permissions/requestApproval':
        return { requestId, kind: 'other', title: 'Allow more access?', body: (p.reason as string | null) ?? JSON.stringify(p.permissions, null, 2), options: opts };
      case 'item/tool/requestUserInput': {
        const q = ((p.questions as { question: string; header?: string; options: { label: string; description: string }[] | null }[]) ?? [])[0];
        if (!q?.options?.length) return null;
        return { requestId, kind: 'other', title: q.question, body: q.options.map(o => `${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n'), options: [...q.options.map((o, i) => ({ id: `opt:${i}`, label: o.label, ...(i === 0 ? { primary: true } : {}) })), { id: 'decline', label: 'Skip' }] };
      }
      default: return null;
    }
  }

  private settle(requestId: string, p: Pending, result: unknown, note: string) {
    if (this.approvals.get(requestId) !== p) return;
    this.approvals.delete(requestId);
    this.ev({ t: 'notice', id: 'ap-' + requestId, text: note }, true);
    if (!this.approvals.size && this.turn) this.status('running');
    p.resolve(result);
  }
}

const decline = (method: string, cancel = false): unknown =>
  method === 'item/tool/requestUserInput' ? { answers: {} }
    : method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' }
    : method === 'execCommandApproval' || method === 'applyPatchApproval' ? { decision: cancel ? 'abort' : { denied: { rejection: 'The user declined.' } } }
    : { decision: cancel ? 'cancel' : 'decline' };

function toDataUrl(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${type};base64,${readFileSync(path).toString('base64')}`;
}
