// Opt-in (SKEIN_REAL_CLAUDE=1): ask the installed Agent SDK / Claude Code for its models, as Skein does.
import { describe, expect, it } from 'vitest';
import type { Machine } from '../../shared/types';
import type { QueryFn } from './claude/driver';
import { askClaude } from './options';
import { harnessCommands } from './commands';
import type { CodexServers } from './codex/driver';

const on = !!process.env.SKEIN_REAL_CLAUDE;

describe.skipIf(!on)('real Claude Code options', () => {
  it('lists models with effort levels', async () => {
    // a session inside Claude Code would hand its own env to the child
    for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|CLAUDECODE$)/.test(k)) delete process.env[k];
    const query = (await import('@anthropic-ai/claude-agent-sdk')).query as QueryFn;
    const local: Machine = { id: 'local', name: 'here', os: 'Linux', link: 'up', has: ['claude'] };
    const o = await askClaude(local, query);
    console.log(o.models.map(m => `${m.id} | ${m.label} | ${m.efforts.join(',')}${m.ultra ? ' | ultra' : ''}${m.speeds ? ' | ' + m.speeds.map(s => s.id).join(',') : ''}`).join('\n'));
    console.log(o.perms.map(p => p.id).join(', '));
    expect(o.source).toBe('harness');
    expect(o.models.find(m => m.isDefault)).toBeTruthy();
    expect(o.models.some(m => m.efforts.length > 0)).toBe(true);
  }, 60_000);

  it('lists commands and skills in a folder', async () => {
    const query = (await import('@anthropic-ai/claude-agent-sdk')).query as QueryFn;
    const local: Machine = { id: 'local', name: 'here', os: 'Linux', link: 'up', has: ['claude'] };
    const r = await harnessCommands(async () => query, {} as CodexServers, process.env.HOME || '/').get(local, 'claude', process.cwd());
    console.log('commands:', r.commands.map(c => c.name).join(' '));
    console.log('skills:', r.skills.map(c => c.name).join(' '));
    expect(r.source).toBe('harness');
    expect(r.commands.some(c => c.name === 'compact')).toBe(true);
  }, 60_000);
});
