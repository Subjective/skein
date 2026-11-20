// The real chat drivers: Claude Code through the Agent SDK, Codex through `codex app-server`.
import type { ChatDriver, ChatHost, Harnesses } from '../chat';
import type { Machine, ThreadEvent, ThreadMeta } from '../../shared/types';
import { ClaudeDriver, type QueryFn } from './claude/driver';
import { claudeHistory } from './claude/history';
import { CodexDriver, CodexServers, type Launch } from './codex/driver';
import { codexHistory } from './codex/history';
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
    dispose() { servers.dispose(); },
  };
}
