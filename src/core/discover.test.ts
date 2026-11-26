import { describe, expect, it } from 'vitest';
import { codexThreads, parseClaudeTranscript } from './discover';
import { plan } from './pty';
import { sq, sqPath } from './shell';

describe('discovery', () => {
  it('reads a Claude Code transcript: folder and branch from its head, the title Claude Code ranks first', () => {
    const head = [
      { type: 'user', isMeta: true, message: { content: '<command-name>/clear</command-name>' }, cwd: '/w/app', sessionId: 'abc', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'user', message: { content: [{ type: 'text', text: 'Fix the   restore race' }] }, cwd: '/w/app', gitBranch: 'main' },
    ];
    const text = (...more: object[]) => [...head, ...more].map(o => JSON.stringify(o)).join('\n');
    expect(parseClaudeTranscript(text())).toMatchObject({ dir: '/w/app', title: 'Fix the restore race', branch: 'main', sessionId: 'abc' });
    // the generated title is appended after the first reply; a /rename beats it; a line cut by head/tail is skipped
    expect(parseClaudeTranscript(text({ type: 'ai-title', aiTitle: 'Fix restore race' }))?.title).toBe('Fix restore race');
    expect(parseClaudeTranscript(text({ type: 'custom-title', customTitle: 'Mine' }, { type: 'ai-title', aiTitle: 'Later' }) + '\n{"type":"ai-ti')?.title).toBe('Mine');
  });
  it('shows no branch where Claude Code wrote HEAD (no repo, or detached), and no title before a prompt', () => {
    const text = JSON.stringify({ type: 'user', message: { content: '<environment_context>' }, cwd: '/root', sessionId: 's', gitBranch: 'HEAD' });
    expect(parseClaudeTranscript(text)).toMatchObject({ branch: undefined, title: undefined });
  });
  it('lists Codex threads from the app-server: its name, else its preview, paged to the limit', async () => {
    const th = (id: string, name: string | null, preview: string) => ({ id, name, preview, cwd: '/w/x', gitInfo: { branch: 'dev', sha: null, originUrl: null }, createdAt: 1, updatedAt: 2 });
    const calls: unknown[] = [];
    const rpc = { request: async (m: string, p: { cursor?: string | null }) => {
      calls.push([m, p]);
      return p.cursor ? { data: [th('b', null, 'Profile the   slow query'), th('c', null, 'x')], nextCursor: 'more' } : { data: [th('a', 'Speed up CI', 'first prompt')], nextCursor: 'p2' };
    } } as never;
    const f = await codexThreads(rpc, 2);
    expect(f.map(x => [x.sessionId, x.title, x.branch, x.dir])).toEqual([['a', 'Speed up CI', 'dev', '/w/x'], ['b', 'Profile the slow query', 'dev', '/w/x']]);
    expect(f[0].updatedAt).toBe(2000);
    expect(calls).toEqual([['thread/list', { limit: 2, cursor: null, sortKey: 'updated_at' }], ['thread/list', { limit: 1, cursor: 'p2', sortKey: 'updated_at' }]]);
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
