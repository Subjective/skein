// Antigravity (`agy acp`): the Agent Client Protocol over stdio, JSON-RPC 2.0, one process per machine serving
// every Antigravity thread on it. Notifications and permission requests carry the session id they belong to.
// The shapes below are what agy 1.5.18 sends (checked against a real run, 2026-11-26), which is ACP plus a few
// extras of its own (a tool call's `name` and `args`), as much as Skein reads.
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine } from '../../../shared/types';
import { spawnOn } from '../../exec';
import { log } from '../../log';
import { which } from '../../shell';
import { Rpc } from '../codex/rpc';

export interface ContentBlock { type: string; text?: string; data?: string; mimeType?: string; uri?: string }
export interface ToolCall {
  toolCallId: string;
  /** agy's own: the tool's name (write_file, run_command, update_steps) and its arguments. */
  name?: string; args?: Record<string, unknown>;
  title?: string; kind?: string; status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  locations?: { path: string; line?: number }[];
  rawInput?: Record<string, unknown>; rawOutput?: Record<string, unknown>;
  content?: ({ type: 'diff'; path: string; oldText?: string | null; newText: string } | { type: 'content'; content: ContentBlock } | { type: string })[];
}
export interface ConfigOption { id: string; name: string; category?: string; type: string; currentValue: string; options: { value: string; name: string; description?: string }[] }
export interface Mode { id: string; name: string; description?: string }
/** What session/new, session/load and session/resume answer with. */
export interface Opened {
  sessionId?: string;
  models?: { availableModels: { modelId: string; name: string }[]; currentModelId: string };
  modes?: { currentModeId: string; availableModes: Mode[] };
  configOptions?: ConfigOption[];
}
export interface AvailableCommand { name: string; description?: string; input?: { hint?: string } | null }
export type Update =
  | { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; content: ContentBlock }
  | ({ sessionUpdate: 'tool_call' | 'tool_call_update' } & ToolCall)
  | { sessionUpdate: 'plan'; entries: { content: string; status: string }[] }
  | { sessionUpdate: 'usage_update'; used: number; size: number }
  | { sessionUpdate: 'session_info_update'; title?: string | null }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] }
  | { sessionUpdate: 'config_option_update'; configOptions: ConfigOption[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string };
export interface PermissionRequest { sessionId: string; toolCall: ToolCall; options: { optionId: string; name: string; kind: string }[] }
export interface SessionInfo { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }

/** Listens to one session's traffic on its machine's server. */
export interface SessionListener {
  update(u: Update): void;
  permission(p: PermissionRequest): Promise<unknown>;
  exited(reason: string): void;
}

/** Starts `agy acp` on a machine, in `cwd`. Injected so tests can run a fake. */
export type AgyLaunch = (m: Machine, cwd: string) => Rpc;

/** Where Skein runs agy: a folder of its own, so the files agy keeps in the folder it runs in stay out of the way,
 *  and a session agy can't place (it reports the folder it runs in as an old session's cwd) is recognisable. */
export function agyHome(m: Machine): string {
  if (m.ssh) return (m.home || '~') + '/.skein/agy';
  const d = join(tmpdir(), 'skein-agy');
  try { mkdirSync(d, { recursive: true }); return realpathSync(d); } catch { return d; }
}

export const launchAgy: AgyLaunch = (m, cwd) => {
  if (m.ssh) return Rpc.overProcess(spawnOn(m, ['agy', 'acp'], { stdio: ['pipe', 'pipe', 'pipe'], posixCwd: '"$(mkdir -p "$HOME/.skein/agy" && echo "$HOME/.skein/agy")"' }), { tag: 'agy', strict: true });
  const exe = which('agy');
  if (!exe) throw Object.assign(new Error('Antigravity is not installed on this computer (agy was not found on PATH).'), { code: 'ENOENT' });
  return Rpc.overProcess(spawnOn(m, [exe, 'acp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: process.env }), { tag: 'agy', strict: true });
};

/** What a machine's agy last said it offers (the answer to the newest session it opened), for the pickers. */
export interface Offered { opened?: Opened; commands?: AvailableCommand[] }

/** One `agy acp` per machine, started on first use and again after it exits. */
export class AgyServers {
  private servers = new Map<string, { rpc?: Rpc; ready: Promise<Rpc> }>();
  private listeners = new Map<string, SessionListener>();
  /** Per machine: what agy last offered. */
  readonly offered = new Map<string, Offered>();
  /** Called when a machine's offer changes (the options and / menu caches drop their answer). */
  onOffer: (machine: string) => void = () => {};

  constructor(private launch: AgyLaunch = launchAgy) {}

  listen(sessionId: string, l: SessionListener) { this.listeners.set(sessionId, l); return () => { if (this.listeners.get(sessionId) === l) this.listeners.delete(sessionId); }; }

  /** Note what a session's answer or update says agy offers on the machine. */
  offer(m: Machine, o: Offered) {
    const cur = this.offered.get(m.id) ?? {};
    const next = { ...cur, ...(o.opened?.configOptions ? { opened: o.opened } : {}), ...(o.commands?.length ? { commands: o.commands } : {}) };
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    this.offered.set(m.id, next);
    this.onOffer(m.id);
  }

  get(m: Machine): Promise<Rpc> {
    const cur = this.servers.get(m.id);
    if (cur && (!cur.rpc || cur.rpc.alive)) return cur.ready;
    const entry: { rpc?: Rpc; ready: Promise<Rpc> } = { ready: null as never };
    entry.ready = (async () => {
      const rpc = this.launch(m, agyHome(m));
      entry.rpc = rpc;
      rpc.onNotify = (method, p) => {
        const o = p as { sessionId?: string; update?: Update };
        if (method === 'session/update' && o?.sessionId && o.update) this.listeners.get(o.sessionId)?.update(o.update);
      };
      rpc.onRequest = async (method, p) => {
        const o = p as PermissionRequest;
        const l = o?.sessionId ? this.listeners.get(o.sessionId) : undefined;
        if (method !== 'session/request_permission') throw { code: -32601, message: `Skein does not handle ${method}` };
        // nobody is driving the session (its chat closed mid-turn): agy hears it as a cancel
        if (!l) return { outcome: { outcome: 'cancelled' } };
        return l.permission(o);
      };
      rpc.onExit = (_code, reason) => {
        if (this.servers.get(m.id) === entry) this.servers.delete(m.id);
        for (const l of this.listeners.values()) l.exited(reason);
      };
      // Skein reads and writes no files and runs no terminals for agy: it does those itself
      await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'skein', title: 'Skein', version: '0.1.0' } });
      return rpc;
    })();
    entry.ready.catch(e => { log('agy', m.id, 'start', (e as Error).message); if (this.servers.get(m.id) === entry) this.servers.delete(m.id); entry.rpc?.kill(); });
    this.servers.set(m.id, entry);
    return entry.ready;
  }

  dispose() { for (const s of this.servers.values()) s.rpc?.kill(); this.servers.clear(); }
}
