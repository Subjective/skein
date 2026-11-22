// The git backend against a real repository in a temp folder (git is on every CI runner).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Machine } from '../shared/types';
import * as git from './git';
import { blobUrl, parseDiff, parseNumstat, prUrl } from './gitparse';
import { gutterMarks } from '../shared/gutter';

const local: Machine = { id: 'local', name: 'local', link: 'up', has: [] };
let dir = '';
const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
const w = (p: string, t: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), t); };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skein-git-'));
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com'); sh('config', 'user.name', 'T'); sh('config', 'commit.gpgsign', 'false'); sh('config', 'core.autocrlf', 'false');
  w('a.txt', 'one\ntwo\nthree\n'); w('src/b.ts', 'export const b = 1;\n');
  sh('add', '-A'); sh('commit', '-q', '-m', 'first');
  w('a.txt', 'one\nTWO\nthree\nfour\n');
  sh('commit', '-qam', 'second');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('git backend', () => {
  it('reads the repository', async () => {
    const r = await git.repo(local, join(dir, 'src'));
    expect(r?.branch).toBe('main');
    expect(r?.prefix).toBe('src');
    expect(r?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.repo(local, tmpdir())).toBeNull();
  });

  it('shows each scope, new files included, with stage state', async () => {
    w('a.txt', 'one\nTWO\nthree\nfour\nfive\n');
    w('src/new.ts', 'export {};\n');
    w('src/b.ts', 'export const b = 2;\n'); sh('add', 'src/b.ts');
    const root = (await git.repo(local, dir))!.root;
    const all = await git.changes(local, root, { scope: 'uncommitted' });
    expect(all.map(f => [f.path, f.status, f.staged]).sort()).toEqual([['a.txt', 'M', 'no'], ['src/b.ts', 'M', 'yes'], ['src/new.ts', 'A', 'no']]);
    expect((await git.changes(local, root, { scope: 'staged' })).map(f => f.path)).toEqual(['src/b.ts']);
    expect((await git.changes(local, root, { scope: 'unstaged' })).map(f => f.path).sort()).toEqual(['a.txt', 'src/new.ts']);
    const [u, s, un] = await git.counts(local, root, [{ scope: 'uncommitted' }, { scope: 'staged' }, { scope: 'unstaged' }]);
    expect(u).toEqual({ files: 3, add: 3, del: 1 });
    expect(s).toEqual({ files: 1, add: 1, del: 1 });
    expect(un.files).toBe(2);
    // nothing in the user's index or tree moved
    expect(sh('status', '--porcelain')).toContain('?? src/new.ts');
    expect((await git.repo(local, dir))?.changed).toEqual({ 'a.txt': 'M', 'src/b.ts': 'M', 'src/new.ts': 'A' });
  });

  it('diffs a turn from its snapshot and a run of commits', async () => {
    const root = (await git.repo(local, dir))!.root;
    const snap = await git.snapshot(local, root);
    w('a.txt', 'zero\none\nTWO\nthree\nfour\nfive\n');
    const turn = await git.changes(local, root, { scope: 'turn', base: snap });
    expect(turn.map(f => f.path)).toEqual(['a.txt']);
    expect(turn[0].add).toBe(1);
    const cs = await git.commits(local, root, 10);
    expect(cs.map(c => c.subject)).toEqual(['second', 'first']);
    const run = await git.changes(local, root, { scope: 'commits', base: cs[1].hash, head: cs[0].hash });
    expect(run.map(f => f.path).sort()).toEqual(['a.txt', 'src/b.ts']);
    const one = await git.changes(local, root, { scope: 'commits', base: cs[0].hash, head: cs[0].hash });
    expect(one.map(f => [f.path, f.add, f.del])).toEqual([['a.txt', 2, 1]]);
  });

  it('stages, reverts with undo, commits on a new branch', async () => {
    const root = (await git.repo(local, dir))!.root;
    await git.stage(local, root, ['src/new.ts'], true);
    expect(sh('diff', '--cached', '--name-only')).toContain('src/new.ts');
    await git.stage(local, root, ['src/new.ts'], false);
    expect(sh('diff', '--cached', '--name-only')).not.toContain('src/new.ts');

    const before = readFileSync(join(dir, 'a.txt'), 'utf8');
    const u = await git.revert(local, root, ['a.txt', 'src/new.ts', 'src/b.ts']);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\nfour\n');
    expect(existsSync(join(dir, 'src/new.ts'))).toBe(false);
    expect(sh('status', '--porcelain')).toBe('');
    await git.unrevert(local, root, u);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'src/new.ts'))).toBe(true);
    expect(sh('diff', '--cached', '--name-only').trim()).toBe('src/b.ts');

    await git.commit(local, root, 'third', { branch: 'work', all: true });
    expect(sh('log', '-1', '--format=%s').trim()).toBe('third');
    expect((await git.branches(local, root)).find(b => b.current)?.name).toBe('work');
    // only the staged file went in, since something was staged
    expect(sh('status', '--porcelain')).toContain('a.txt');
    await git.commit(local, root, 'fourth', { all: true });
    expect(sh('status', '--porcelain')).toBe('');
    expect(await git.files(local, root)).toEqual(['a.txt', 'src/b.ts', 'src/new.ts']);
    expect(await git.show(local, root, 'src/b.ts', 'HEAD')).toBe('export const b = 2;\n');
    await git.switchBranch(local, root, 'main');
    expect((await git.repo(local, root))?.branch).toBe('main');
  });
});

describe('git parsers', () => {
  it('parses renames, new and deleted files, odd names', () => {
    const d = parseDiff([
      'diff --git a/x.ts b/y.ts', 'similarity index 90%', 'rename from x.ts', 'rename to y.ts', '@@ -1,2 +1,2 @@', ' a', '-b', '+c',
      'diff --git "a/sp ace\\303\\251.md" "b/sp ace\\303\\251.md"', 'new file mode 100644', '--- /dev/null', '+++ "b/sp ace\\303\\251.md"', '@@ -0,0 +1 @@', '+hi',
      'diff --git a/gone b/gone', 'deleted file mode 100644', '--- a/gone', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
      'diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ',
    ].join('\n'));
    expect(d.map(f => [f.path, f.status, f.add, f.del])).toEqual([['y.ts', 'R', 1, 1], ['sp aceé.md', 'A', 1, 0], ['gone', 'D', 0, 1], ['img.png', 'M', 0, 0]]);
    expect(d[0].old).toBe('x.ts');
    expect(d[3].binary).toBe(true);
    expect(d[0].hunks[0].lines.map(l => [l.k, l.a, l.b])).toEqual([[' ', 1, 1], ['-', 2, undefined], ['+', undefined, 2]]);
  });
  it('reads numstat renames', () => {
    expect(parseNumstat('1\t2\tsrc/{a => b}/f.ts\n-\t-\tlogo.png\n3\t0\told.ts => new.ts\n')).toEqual([
      { path: 'src/b/f.ts', add: 1, del: 2 }, { path: 'logo.png', add: 0, del: 0 }, { path: 'new.ts', add: 3, del: 0 }]);
  });
  it('marks added, changed and deleted lines for the gutter', () => {
    const [f] = parseDiff(['diff --git a/f b/f', '@@ -1,6 +1,6 @@', ' a', '-b', '+B', ' c', '+new', ' d', '-e', ' f'].join('\n'));
    expect(gutterMarks(f.hunks)).toEqual({ add: [4], chg: [2], del: [6] });
  });
  it('knows where to open a pull request', () => {
    expect(prUrl('git@github.com:o/r.git', 'feat/x')).toBe('https://github.com/o/r/compare/feat%2Fx?expand=1');
    expect(prUrl('https://github.com/o/r', 'b')).toBe('https://github.com/o/r/compare/b?expand=1');
    expect(prUrl('https://gitlab.example.com/g/r.git', 'b')).toContain('/-/merge_requests/new');
    expect(prUrl('ssh://git@host.internal:2222/x/y.git', 'b')).toBeNull();
  });
  it('builds a file\'s web address on the forge', () => {
    expect(blobUrl('git@github.com:o/r.git', 'feat/x', 'src/a b.ts')).toBe('https://github.com/o/r/blob/feat/x/src/a%20b.ts');
    expect(blobUrl('https://gitlab.com/g/r.git', 'main', 'a.ts')).toBe('https://gitlab.com/g/r/-/blob/main/a.ts');
    expect(blobUrl('git@bitbucket.org:o/r.git', 'main', 'a.ts')).toBe('https://bitbucket.org/o/r/src/main/a.ts');
    expect(blobUrl('ssh://git@host.internal:2222/x/y.git', 'main', 'a.ts')).toBeNull();
  });
});

describe('a file\'s remote URL', () => {
  it('uses the upstream branch, else the default branch, else the commit; null without a remote', async () => {
    expect(await git.webUrl(local, dir, 'a.txt')).toBeNull();
    sh('remote', 'add', 'origin', 'git@github.com:o/r.git');
    const head = sh('rev-parse', 'HEAD').trim();
    expect(await git.webUrl(local, dir, 'a.txt')).toBe(`https://github.com/o/r/blob/${head}/a.txt`);
    sh('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await git.webUrl(local, dir, 'src/b.ts')).toBe('https://github.com/o/r/blob/main/src/b.ts');
    sh('update-ref', 'refs/remotes/origin/feat/x', 'HEAD');
    sh('config', 'branch.main.remote', 'origin'); sh('config', 'branch.main.merge', 'refs/heads/feat/x');
    expect(await git.webUrl(local, dir, 'a.txt')).toBe('https://github.com/o/r/blob/feat/x/a.txt');
  });
});
