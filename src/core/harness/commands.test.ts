import { describe, expect, it } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { Machine } from '../../shared/types';
import { CODEX_COMMANDS } from '../../shared/commands';
import type { QueryFn } from './claude/driver';
import { absDir, claudeCommands, codexCommands, codexSkills, harnessCommands } from './commands';
import { skillInputs, type CodexServers } from './codex/driver';
import type { Rpc } from './codex/rpc';

const local: Machine = { id: 'local', name: 'here', os: 'Linux', link: 'up', has: ['claude', 'codex'], home: '/home/me' };

describe('harness commands', () => {
  it('splits Claude Code\'s list: built-ins are commands, the rest (custom commands and skills) go under Skills', () => {
    const r = claudeCommands([
      { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
      { name: 'deploy', description: 'Ship it', argumentHint: '' },
      { name: 'clear', description: 'Start over', argumentHint: '[name]', builtin: true, aliases: ['reset'] },
      { name: '__remote-workflow', description: 'internal', argumentHint: '', builtin: true },
      { name: 'clear', description: 'a custom clear shadowed by the built-in', argumentHint: '' },
    ]);
    expect(r.source).toBe('harness');
    expect(r.commands.map(c => c.cmd)).toEqual(['/clear', '/compact']);
    expect(r.commands[1]).toMatchObject({ name: 'compact', hint: 'Free up context', args: '<instructions>', source: 'built-in' });
    expect(r.skills).toEqual([{ cmd: '/deploy', name: 'deploy', hint: 'Ship it', source: 'custom' }]);
  });

  it('lists Codex skills as $name with its built-in commands, disabled ones left out', () => {
    const r = codexCommands([
      { name: 'pdf', description: 'Long', interface: { shortDescription: 'Read PDFs' }, path: '/s/pdf/SKILL.md', scope: 'system', enabled: true },
      { name: 'off', description: 'x', path: '/s/off/SKILL.md', scope: 'user', enabled: false },
      { name: 'notes', description: 'Release notes', path: '/r/notes/SKILL.md', scope: 'repo', enabled: true },
    ]);
    expect(r.commands).toBe(CODEX_COMMANDS);
    expect(r.skills).toEqual([
      { cmd: '$notes', name: 'notes', hint: 'Release notes', source: 'repo' },
      { cmd: '$pdf', name: 'pdf', hint: 'Read PDFs', source: 'system' },
    ]);
  });

  it('asks Codex for the folder\'s skills with an absolute cwd', async () => {
    let asked: unknown;
    const rpc = { request: async (_m: string, p: unknown) => { asked = p; return { data: [{ cwd: '/home/me/p', skills: [{ name: 'a', path: '/a' }] }] }; } } as unknown as Rpc;
    expect((await codexSkills(rpc, absDir(local, '~/p', '/x'))).map(s => s.name)).toEqual(['a']);
    expect(asked).toEqual({ cwds: ['/home/me/p'] });
  });

  it('runs Claude\'s no-prompt query in the thread\'s folder, cached per machine, harness and folder', async () => {
    const cwds: (string | undefined)[] = [];
    const q: QueryFn = ({ options }) => {
      cwds.push(options?.cwd);
      return { initializationResult: async () => ({ commands: [{ name: 'compact', description: '', argumentHint: '', builtin: true }] }), close: () => {} } as unknown as Query;
    };
    const cmds = harnessCommands(async () => q, {} as CodexServers, '/home/me');
    await cmds.get(local, 'claude', '/tmp');
    await cmds.get(local, 'claude', '/tmp');
    await cmds.get(local, 'claude', '/');
    expect(cwds).toEqual(['/tmp', '/']);
  });

  it('falls back to the bundled lists when the harness can\'t be asked', async () => {
    const servers = { get: async () => { throw new Error('codex: not found'); } } as unknown as CodexServers;
    const r = await harnessCommands(async () => { throw new Error('no sdk'); }, servers, '/home/me').get(local, 'codex', '~');
    expect(r).toMatchObject({ source: 'bundled', error: 'codex: not found' });
    expect(r.commands.map(c => c.cmd)).toContain('/compact');
  });

  it('sends a $skill in the text as a Codex skill input', async () => {
    const rpc = { request: async <T,>(): Promise<T> => ({ data: [{ skills: [{ name: 'pdf', path: '/s/pdf/SKILL.md' }, { name: 'off', path: '/o', enabled: false }] }] }) as T };
    expect(await skillInputs(rpc, 'use $pdf and $off on a.pdf, costs $5', '/p')).toEqual([{ type: 'skill', name: 'pdf', path: '/s/pdf/SKILL.md' }]);
    expect(await skillInputs({ request: async <T,>(): Promise<T> => { throw new Error('never asked'); } }, 'no skills here', '/p')).toEqual([]);
  });
});
