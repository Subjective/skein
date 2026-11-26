// The real chat drivers: Claude Code through the Agent SDK, Codex through `codex app-server`.
import type { ChatDriver, ChatHost, Harnesses } from '../chat';
import type { Machine, ThreadEvent, ThreadMeta } from '../../shared/types';
import { ClaudeDriver, type QueryFn } from './claude/driver';
import { claudeHistory, claudeSubHistory } from './claude/history';
import { CodexDriver, CodexServers, type Launch } from './codex/driver';
import { codexHistory } from './codex/history';
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
}

const sdkQuery = async (): Promise<QueryFn> => (await import('@anthropic-ai/claude-agent-sdk')).query as QueryFn;

export function createHarnesses(deps: HarnessDeps = {}): Harnesses {
  const servers = new CodexServers(deps.codexLaunch);
  const options = harnessOptions(deps.claudeQuery ?? sdkQuery, servers);
  const commands = harnessCommands(deps.claudeQuery ?? sdkQuery, servers, homedir());
  const codexDrivers = new Map<string, CodexDriver>();
  let lastHost: ChatHost | null = null;
  const codexDriver = (t: ThreadMeta, host: ChatHost) => {
    lastHost = host;
    let d = codexDrivers.get(t.id);
    if (!d) { d = new CodexDriver(t.id, host, servers); codexDrivers.set(t.id, d); }
    return d;
  };
  return {
    async history(t: ThreadMeta, m: Machine): Promise<ThreadEvent[]> {
      if (t.harness === 'claude') return claudeHistory(m, t.sessionId);
      if (!t.sessionId) return [];
      // through the machine's app-server, which reads its own records (see codex/history.ts)
      const rpc = await servers.get(m).catch(() => null);
      return rpc ? (await codexHistory(rpc, t.sessionId)).events : [];
    },
    async subHistory(t: ThreadMeta, m: Machine, sub: { id: string; agent?: string }): Promise<ThreadEvent[]> {
      if (t.harness === 'claude') return claudeSubHistory(m, t.sessionId, sub.id, sub.agent);
      // a Codex sub-agent is a thread of its own on the same app-server
      const rpc = await servers.get(m).catch(() => null);
      if (!rpc) return [];
      const spawn = sub.agent ? undefined : (await codexHistory(rpc, t.sessionId)).events.find(e => e.t === 'sub' && e.id === sub.id);
      const agent = sub.agent ?? (spawn?.t === 'sub' ? spawn.agent : undefined);
      return agent ? (await codexHistory(rpc, agent)).events : [];
    },
    driver(t: ThreadMeta, host: ChatHost): ChatDriver {
      lastHost = host;
      return t.harness === 'claude' ? new ClaudeDriver(t.id, host, deps.claudeQuery ?? sdkQuery) : codexDriver(t, host);
    },
    async start(t: ThreadMeta, host: ChatHost): Promise<ThreadMeta> {
      if (t.harness !== 'codex' || t.sessionId) return t;
      await codexDriver(t, host).prepare();
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
    },
    options: (m, h) => options.get(m, h),
    commands: (m, h, dir) => commands.get(m, h, dir),
    async sessions(m, limit) {
      const quiet = (h: string) => (e: Error) => { log('discover', m.id, h, e.message); return []; };
      const [claude, codex] = await Promise.all([
        // an SSH machine that can't be reached throws, so the caller hears of it
        m.ssh ? claudeRemote(m, limit) : claudeLocal(limit).catch(quiet('claude')),
        servers.get(m).then(rpc => codexThreads(rpc, limit)).catch(quiet('codex')),
      ]);
      return [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    dispose() { servers.dispose(); },
  };
}
