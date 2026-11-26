// The real chat drivers: Claude Code through the Agent SDK, Codex through `codex app-server`, Antigravity through
// `agy acp` (the Agent Client Protocol).
import type { ChatDriver, ChatHost, Harnesses } from '../chat';
import type { Machine, ThreadEvent, ThreadMeta } from '../../shared/types';
import { ClaudeDriver, type QueryFn } from './claude/driver';
import { claudeHistory, claudeSubHistory } from './claude/history';
import { CodexDriver, CodexServers, type Launch } from './codex/driver';
import { codexHistory } from './codex/history';
import { AgyServers, type AgyLaunch } from './agy/acp';
import { AgyDriver, expand as agyDir } from './agy/driver';
import { agyHistory, agySessions } from './agy/history';
import { claudeLocal, claudeRemote, codexThreads } from '../discover';
import { log } from '../log';
import { harnessCommands } from './commands';
import { harnessOptions } from './options';
import { homedir } from 'node:os';

export interface HarnessDeps {
  /** The Agent SDK's query(). Tests pass a fake. */
  claudeQuery?: () => Promise<QueryFn>;
  /** Starts a codex app-server. Tests pass a fake. */
  codexLaunch?: Launch;
  /** Starts `agy acp`. Tests pass a fake. */
  agyLaunch?: AgyLaunch;
}

const sdkQuery = async (): Promise<QueryFn> => (await import('@anthropic-ai/claude-agent-sdk')).query as QueryFn;

export function createHarnesses(deps: HarnessDeps = {}): Harnesses {
  const servers = new CodexServers(deps.codexLaunch);
  // Antigravity: one process for the chats, one that reads history (agy/history.ts says why)
  const agy = new AgyServers(deps.agyLaunch), agyReaders = new AgyServers(deps.agyLaunch);
  const options = harnessOptions(deps.claudeQuery ?? sdkQuery, servers, agy);
  const commands = harnessCommands(deps.claudeQuery ?? sdkQuery, servers, homedir(), agy);
  // what agy offers comes with the sessions it opens: a new answer replaces what the pickers keep
  agy.onOffer = machine => { options.drop(machine, 'agy'); commands.drop(machine, 'agy'); };
  const agyDrivers = new Map<string, AgyDriver>();
  const codexDrivers = new Map<string, CodexDriver>();
  let lastHost: ChatHost | null = null;
  const codexDriver = (t: ThreadMeta, host: ChatHost) => {
    lastHost = host;
    let d = codexDrivers.get(t.id);
    if (!d) { d = new CodexDriver(t.id, host, servers); codexDrivers.set(t.id, d); }
    return d;
  };
  const agyDriver = (t: ThreadMeta, host: ChatHost) => {
    let d = agyDrivers.get(t.id);
    if (!d) { d = new AgyDriver(t.id, host, agy); agyDrivers.set(t.id, d); }
    return d;
  };
  return {
    async history(t: ThreadMeta, m: Machine): Promise<ThreadEvent[]> {
      if (t.harness === 'claude') return claudeHistory(m, t.sessionId);
      if (t.harness === 'agy') return agyHistory(agyReaders, m, t.sessionId, agyDir(m, t.dir));
      if (!t.sessionId) return [];
      // through the machine's app-server, which reads its own records (see codex/history.ts)
      const rpc = await servers.get(m).catch(() => null);
      return rpc ? (await codexHistory(rpc, t.sessionId)).events : [];
    },
    async subHistory(t: ThreadMeta, m: Machine, sub: { id: string; agent?: string }): Promise<ThreadEvent[]> {
      if (t.harness === 'claude') return claudeSubHistory(m, t.sessionId, sub.id, sub.agent);
      if (t.harness === 'agy') return [];
      // a Codex sub-agent is a thread of its own on the same app-server
      const rpc = await servers.get(m).catch(() => null);
      if (!rpc) return [];
      const spawn = sub.agent ? undefined : (await codexHistory(rpc, t.sessionId)).events.find(e => e.t === 'sub' && e.id === sub.id);
      const agent = sub.agent ?? (spawn?.t === 'sub' ? spawn.agent : undefined);
      return agent ? (await codexHistory(rpc, agent)).events : [];
    },
    driver(t: ThreadMeta, host: ChatHost): ChatDriver {
      lastHost = host;
      if (t.harness === 'agy') return agyDriver(t, host);
      return t.harness === 'claude' ? new ClaudeDriver(t.id, host, deps.claudeQuery ?? sdkQuery) : codexDriver(t, host);
    },
    async start(t: ThreadMeta, host: ChatHost): Promise<ThreadMeta> {
      if (t.harness === 'claude' || t.sessionId) return t;
      await (t.harness === 'agy' ? agyDriver(t, host) : codexDriver(t, host)).prepare();
      return host.thread(t.id);
    },
    async attach(t: ThreadMeta) {
      if (t.harness !== 'codex' || !t.sessionId) return null;
      const d = codexDrivers.get(t.id) ?? (lastHost ? codexDriver(t, lastHost) : null);
      return d ? d.attachArgs() : null;
    },
    forget(id: string) {
      const d = codexDrivers.get(id);
      if (d) { codexDrivers.delete(id); d.dispose(); }
      const a = agyDrivers.get(id);
      if (a) { agyDrivers.delete(id); a.dispose(); }
    },
    options: (m, h) => options.get(m, h),
    commands: (m, h, dir) => commands.get(m, h, dir),
    async sessions(m, limit) {
      const quiet = (h: string) => (e: Error) => { log('discover', m.id, h, e.message); return []; };
      const [claude, codex, anti] = await Promise.all([
        // an SSH machine that can't be reached throws, so the caller hears of it
        m.ssh ? claudeRemote(m, limit) : claudeLocal(limit).catch(quiet('claude')),
        servers.get(m).then(rpc => codexThreads(rpc, limit)).catch(quiet('codex')),
        // only where agy is installed: starting it to find nothing costs a process
        m.has.includes('agy') ? agySessions(agyReaders, m, limit).catch(quiet('agy')) : [],
      ]);
      return [...claude, ...codex, ...anti].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    dispose() { servers.dispose(); agy.dispose(); agyReaders.dispose(); },
  };
}
