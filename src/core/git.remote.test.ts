// The remote code paths (one POSIX sh line per round trip) run through a local sh instead of ssh.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../shared/types';

vi.mock('./exec', () => ({
  run: async (_m: Machine, line: string, o: { input?: string } = {}) => {
    const r = spawnSync('/bin/sh', ['-c', line], { input: o.input ?? '', encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  },
}));
const git = await import('./git');

const remote: Machine = { id: 'r', name: 'r', link: 'up', has: [], ssh: { host: 'nowhere' } };
let dir = '';
const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

describe.skipIf(process.platform === 'win32')('git backend over a remote shell', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "skein git '"));   // a space and a quote, to prove the quoting
    sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@e.com'); sh('config', 'user.name', 'T'); sh('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'a.txt'), '1\n2\n'); sh('add', '-A'); sh('commit', '-qm', 'first');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads, diffs, counts, reverts and undoes', async () => {
    writeFileSync(join(dir, 'a.txt'), '1\nTWO\n'); writeFileSync(join(dir, 'n e w.txt'), 'x\n');
    const r = (await git.repo(remote, dir))!;
    expect(r.branch).toBe('main');
    const ch = await git.changes(remote, r.root, { scope: 'uncommitted' });
    expect(ch.map(f => [f.path, f.status, f.staged])).toEqual([['a.txt', 'M', 'no'], ['n e w.txt', 'A', 'no']]);
    expect(await git.counts(remote, r.root, [{ scope: 'uncommitted' }, { scope: 'staged' }])).toEqual([{ files: 2, add: 2, del: 1 }, { files: 0, add: 0, del: 0 }]);
    expect(await git.show(remote, r.root, 'a.txt', 'worktree')).toBe('1\nTWO\n');
    const u = await git.revert(remote, r.root, ['a.txt', 'n e w.txt']);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('1\n2\n');
    expect(existsSync(join(dir, 'n e w.txt'))).toBe(false);
    await git.unrevert(remote, r.root, u);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('1\nTWO\n');
    expect(existsSync(join(dir, 'n e w.txt'))).toBe(true);
  });
});
