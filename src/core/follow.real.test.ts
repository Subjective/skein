// Opt-in (SKEIN_REAL_CLAUDE=1): a real `claude` process outside Skein writes a session while a Follows watches,
// as when the same thread runs in another terminal. Optional SKEIN_REAL_HOME: a throwaway HOME for the CLI.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine, ThreadEvent, ThreadMeta } from '../shared/types';
import { Follows, type TurnState } from './follow';

const on = !!process.env.SKEIN_REAL_CLAUDE;

function claude(args: string[], cwd: string, home: string): Promise<number | null> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_SESSION)/.test(k)) env[k] = v;
  env.HOME = home;
  const p = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => process.stdout.write('[claude] ' + d));
  return new Promise(r => p.on('close', r));
}

describe.skipIf(!on)('live follow with a real claude', () => {
  it('pushes the turns of a claude process running outside Skein, and reads its turn state', async () => {
    const home = process.env.SKEIN_REAL_HOME || homedir();
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
    const cwd = mkdtempSync(join(tmpdir(), 'skein-ext-')); mkdirSync(cwd, { recursive: true });
    const sid = randomUUID();
    const t: ThreadMeta = { id: 't-ext', harness: 'claude', sessionId: sid, machine: 'local', dir: cwd, title: 'x', createdAt: 0, updatedAt: 0, status: 'idle' };
    const pushed: ThreadEvent[] = [], acts: { state: TurnState; ended: boolean; at: number }[] = [];
    const local = { id: 'local', name: 'This computer', link: 'up' } as unknown as Machine;
    const f = new Follows({
      machine: () => local, thread: id => (id === t.id ? t : undefined), bySession: s => (s === sid ? t : undefined),
      owner: () => null, event: (_t, e) => pushed.push(e), activity: (_t, a) => acts.push({ ...a, at: Date.now() }),
    });
    try {
      await new Promise(r => setTimeout(r, 300));
      const t0 = Date.now();
      expect(await claude(['-p', 'Use the Bash tool to run: echo skein-follow-ok. Then reply with exactly: DONE', '--session-id', sid, '--allowedTools', 'Bash'], cwd, home)).toBe(0);
      await new Promise(r => setTimeout(r, 1500));
      console.log(`turn 1 took ${Date.now() - t0} ms; activity:`, acts.map(a => `${a.state}${a.ended ? ' (ended)' : ''} +${a.at - t0}ms`).join(', '));
      console.log('events pushed:', pushed.map(e => `${e.t}:${e.id.slice(0, 14)}${'status' in e ? ':' + e.status : ''}`).join(' '));
      expect(acts[0]?.state).toBe('running');
      expect(acts.at(-1)).toMatchObject({ state: 'idle', ended: true });
      expect(pushed.some(e => e.t === 'tool' && e.status === 'done' && /echo skein-follow-ok/.test(e.arg))).toBe(true);
      expect(pushed.some(e => e.t === 'text' && /DONE/.test(e.text))).toBe(true);

      // a second turn, resumed by another process: only the new turn arrives
      const n = pushed.length; acts.length = 0;
      expect(await claude(['-p', 'Reply with exactly: AGAIN', '--resume', sid], cwd, home)).toBe(0);
      await new Promise(r => setTimeout(r, 1500));
      const second = pushed.slice(n);
      console.log('turn 2 pushed:', second.map(e => `${e.t}:${e.id.slice(0, 14)}`).join(' '), 'activity:', acts.map(a => a.state).join(','));
      expect(second.some(e => e.t === 'user' && /AGAIN/.test(e.text))).toBe(true);
      expect(second.some(e => e.t === 'text' && /AGAIN/.test(e.text))).toBe(true);
      expect(second.some(e => e.t === 'text' && /DONE/.test(e.text))).toBe(false);
      expect(acts.at(-1)).toMatchObject({ state: 'idle', ended: true });

      // what the chat view would load from history now equals what it would have built from the pushes
      const hist = await f.history(t.id);
      const byId = new Map<string, string>(); for (const e of pushed) byId.set(e.id, JSON.stringify(e));
      for (const e of hist!) if (byId.has(e.id)) expect(byId.get(e.id)).toBe(JSON.stringify(e));
    } finally { f.dispose(); }
  }, 240_000);
});
