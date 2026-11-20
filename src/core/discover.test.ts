import { describe, expect, it } from 'vitest';
import { parseClaudeHead, parseCodexHead } from './discover';
import { plan } from './pty';
import { sq, sqPath } from './shell';

describe('discovery', () => {
  it('reads a Claude Code transcript head', () => {
    const text = [
      { type: 'user', isMeta: true, message: { content: '<command-name>/clear</command-name>' }, cwd: '/w/app', sessionId: 'abc', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'user', message: { content: [{ type: 'text', text: 'Fix the   restore race' }] }, cwd: '/w/app', gitBranch: 'main' },
    ].map(o => JSON.stringify(o)).join('\n');
    expect(parseClaudeHead(text)).toMatchObject({ harness: 'claude', dir: '/w/app', title: 'Fix the restore race', branch: 'main', sessionId: 'abc' });
  });
  it('reads a Codex rollout head', () => {
    const text = [
      { type: 'session_meta', payload: { id: 'x1', cwd: '/w/x', timestamp: '2026-01-01T00:00:00Z', git: { branch: 'dev' } } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Profile the slow query' } },
    ].map(o => JSON.stringify(o)).join('\n');
    expect(parseCodexHead(text)).toMatchObject({ harness: 'codex', sessionId: 'x1', dir: '/w/x', title: 'Profile the slow query', branch: 'dev' });
  });
});

describe('remote commands', () => {
  it('quotes for a POSIX shell and keeps ~ expandable', () => {
    expect(sq('a b')).toBe("'a b'");
    expect(sq("it's")).toBe("'it'\\''s'");
    expect(sqPath('~/my repo')).toBe("~/'my repo'");
  });
  it('runs a Claude thread over ssh as resume-or-create', () => {
    const m = { id: 'l', name: 'l', ssh: { host: 'dev' }, link: 'up' as const, has: [] };
    const p = plan(m, { machine: 'l', cwd: '~/repo', run: { kind: 'claude', session: 'S1' }, cols: 80, rows: 24 });
    expect(p.file).toMatch(/ssh(\.exe)?$/i); // ssh.exe from System32\OpenSSH on Windows
    expect(p.args).toContain('-tt');
    expect(p.args.at(-1)).toContain('--resume S1');
    expect(p.args.at(-1)).toContain('--session-id S1');
  });
});
