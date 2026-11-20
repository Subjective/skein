// Git, run on the thread's machine. Powers the Changes and Files views.
//
// Every scope Changes shows is a diff between two trees:
//   H = HEAD's tree, I = the index's tree (`git write-tree`), W = the working tree, new files included
//   (built in a throwaway index: copy the real one, `git add -A`, `git write-tree`; nothing the user sees changes).
//   uncommitted H..W, staged H..I, unstaged I..W, last agent turn S..W (S = W when the turn began), commits A^..B.
// Remote machines get one ssh round trip per batch (`multi`), since Windows OpenSSH cannot share connections.
import { randomBytes } from 'node:crypto';
import type { Branch, Commit, FileDiff, GitStatus, RepoState, RevertUndo, ScopeCounts, ScopeSpec } from '../shared/api';
import type { Machine } from '../shared/types';
import { run } from './exec';
import { expandLocal } from './files';
import { parseDiff, parseNumstat, prUrl } from './gitparse';
import { sq, sqPath } from './shell';

type R = { code: number | null; stdout: string; stderr: string };
const BASE = ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'core.pager=cat'];
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

/** Run git in `dir`. Locally: spawn with cwd (no shell, so Windows quoting never matters). Remotely: POSIX sh over ssh. */
async function g(m: Machine, dir: string, args: string[], o: { input?: string; env?: Record<string, string> } = {}): Promise<R> {
  if (m.ssh) {
    const env = Object.entries(o.env || {}).map(([k, v]) => `${k}=${sq(v)} `).join('');
    return run(m, `sh -c ${sq(`cd ${sqPath(dir)} && ${env}git ${[...BASE, ...args].map(sq).join(' ')}`)}`, { input: o.input });
  }
  const { spawn } = await import('node:child_process');
  return new Promise<R>(res => {
    const p = spawn('git', [...BASE, ...args], { cwd: expandLocal(dir), windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...o.env } });
    let stdout = '', stderr = '';
    p.stdout.setEncoding('utf8').on('data', d => (stdout += d));
    p.stderr.setEncoding('utf8').on('data', d => (stderr += d));
    p.on('error', e => res({ code: -1, stdout, stderr: e.message }));
    p.on('close', code => res({ code, stdout, stderr }));
    p.stdin.on('error', () => {}); p.stdin.end(o.input ?? '');
  });
}

/** Several git commands, one round trip. Each result is its stdout (empty when it failed). */
async function multi(m: Machine, dir: string, cmds: string[][]): Promise<R[]> {
  if (!m.ssh) return Promise.all(cmds.map(c => g(m, dir, c)));
  const line = `cd ${sqPath(dir)} && ` + cmds.map(c => `git ${[...BASE, ...c].map(sq).join(' ')} 2>/dev/null; printf '\\001SKEIN%s\\001' $?`).join('; ');
  const r = await run(m, `sh -c ${sq(line)}`);
  const parts = r.stdout.split(/\u0001SKEIN(\d+)\u0001/);
  return cmds.map((_, i) => ({ code: parts[i * 2 + 1] == null ? -1 : +parts[i * 2 + 1], stdout: parts[i * 2] ?? '', stderr: i === 0 ? r.stderr : '' }));
}

const ok = (r: R, what = 'git') => { if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `${what} failed`); return r; };
const paths = (ps: string[]) => ['--', ...ps];

// ---------------- repository state ----------------

export async function repo(m: Machine, dir: string): Promise<RepoState | null> {
  const [top, st, ns, trunk] = await multi(m, dir, [
    ['rev-parse', '--show-toplevel', '--show-prefix'],
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
    ['diff', '--numstat', 'HEAD'],
    ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'],
  ]);
  if (top.code !== 0 || !top.stdout.trim()) return null;
  const [root, prefix = ''] = top.stdout.split('\n');
  const s: RepoState = { root: root.trim(), prefix: prefix.trim().replace(/\/$/, ''), ahead: 0, behind: 0, key: st.stdout + '\n' + ns.stdout, changed: {} };
  for (const l of st.stdout.split('\n')) {
    let x;
    if ((x = /^# branch\.oid (\S+)/.exec(l)) && x[1] !== '(initial)') s.head = x[1];
    else if ((x = /^# branch\.head (.+)/.exec(l)) && x[1] !== '(detached)') s.branch = x[1];
    else if ((x = /^# branch\.upstream (.+)/.exec(l))) s.upstream = x[1];
    else if ((x = /^# branch\.ab \+(\d+) -(\d+)/.exec(l))) { s.ahead = +x[1]; s.behind = +x[2]; }
    else if ((x = /^1 (\S\S) (?:\S+ ){6}(.+)$/.exec(l))) s.changed[unquote(x[2])] = mark(x[1]);
    else if ((x = /^2 (\S\S) (?:\S+ ){7}(.+?)\t/.exec(l))) s.changed[unquote(x[2])] = 'R';
    else if ((x = /^u (?:\S+ ){9}(.+)$/.exec(l))) s.changed[unquote(x[1])] = 'M';
    else if ((x = /^\? (.+)$/.exec(l))) s.changed[unquote(x[1])] = 'A';
  }
  s.trunk = trunk.stdout.trim().replace(/^origin\//, '') || undefined;
  return s;
}

const mark = (xy: string): 'M' | 'A' | 'D' => (xy.includes('A') ? 'A' : xy.includes('D') ? 'D' : 'M');
const unquote = (p: string) => { if (!p.startsWith('"')) return p; try { return JSON.parse(p) as string; } catch { return p; } };

/** Kept for callers outside the tools views (the sidebar's branch). */
export async function status(m: Machine, dir: string): Promise<GitStatus> {
  const r = await g(m, dir, ['status', '--porcelain=v1', '-b']);
  if (r.code !== 0) return { isRepo: false, files: [] };
  const [head, ...rest] = r.stdout.split('\n');
  const br = /^## ([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(head);
  const counts = new Map(parseNumstat((await g(m, dir, ['diff', '--numstat', 'HEAD'])).stdout).map(x => [x.path, x]));
  const files = rest.filter(Boolean).map(l => {
    const x = l[0], y = l[1], path = l.slice(3).replace(/^.* -> /, '');
    const st = (x === '?' ? '?' : (x !== ' ' ? x : y)) as GitStatus['files'][number]['status'];
    const c = counts.get(path);
    return { path, status: st, add: c?.add || 0, del: c?.del || 0, staged: x !== ' ' && x !== '?' };
  });
  return { isRepo: true, branch: br?.[1], ahead: br?.[2] ? +br[2] : 0, behind: br?.[3] ? +br[3] : 0, files };
}

// ---------------- trees ----------------

const emptyTrees = new Map<string, string>();
async function emptyTree(m: Machine, root: string) {
  const k = m.id + root;
  if (!emptyTrees.has(k)) emptyTrees.set(k, ok(await g(m, root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.trim());
  return emptyTrees.get(k)!;
}

/** H, I and W for the repository at `root` (see the top of this file). */
async function trees(m: Machine, root: string): Promise<{ H: string; I: string | null; W: string }> {
  const tmpName = `skein-index-${randomBytes(4).toString('hex')}`;
  let W: string, H: string, I: string | null;
  if (m.ssh) {
    const script = `cd ${sqPath(root)} || exit 1
i=$(git rev-parse --git-path index); t=$(git rev-parse --git-path ${tmpName}); case "$t" in /*) ;; *) t="$PWD/$t";; esac
cp "$i" "$t" 2>/dev/null
echo "H $(git rev-parse -q --verify 'HEAD^{tree}')"
echo "I $(git write-tree 2>/dev/null)"
GIT_INDEX_FILE="$t" git add -A >/dev/null 2>&1; echo "W $(GIT_INDEX_FILE="$t" git write-tree)"; rm -f "$t"`;
    const r = await run(m, `sh -c ${sq(script)}`);
    const get = (k: string) => new RegExp(`^${k} (\\S*)$`, 'm').exec(r.stdout)?.[1] || '';
    H = get('H'); I = get('I') || null; W = get('W');
    if (!W) throw new Error(r.stderr.trim() || 'Could not read the working tree');
  } else {
    const { copyFile, rm } = await import('node:fs/promises');
    const { isAbsolute, join } = await import('node:path');
    const [ip, tp, h, i] = await multi(m, root, [['rev-parse', '--git-path', 'index'], ['rev-parse', '--git-path', tmpName], ['rev-parse', '-q', '--verify', 'HEAD^{tree}'], ['write-tree']]);
    const abs = (p: string) => (isAbsolute(p.trim()) ? p.trim() : join(expandLocal(root), p.trim()));
    const tmp = abs(tp.stdout);
    await copyFile(abs(ip.stdout), tmp).catch(() => {});
    try {
      const env = { GIT_INDEX_FILE: tmp };
      await g(m, root, ['add', '-A'], { env });
      W = ok(await g(m, root, ['write-tree'], { env })).stdout.trim();
    } finally { await rm(tmp, { force: true }); }
    H = h.stdout.trim(); I = i.code === 0 ? i.stdout.trim() : null;
  }
  return { H: H || await emptyTree(m, root), I, W };
}

/** The two sides of a scope, as revisions git diff takes. null I (a merge in progress) falls back to direct forms. */
async function sides(m: Machine, root: string, s: ScopeSpec, t?: Awaited<ReturnType<typeof trees>>): Promise<[string, string] | 'cached' | 'files'> {
  if (s.scope === 'commits') {
    if (!s.base || !s.head) throw new Error('No commits picked');
    const parent = await g(m, root, ['rev-parse', '-q', '--verify', `${s.base}^`]);
    return [parent.code === 0 ? parent.stdout.trim() : await emptyTree(m, root), s.head];
  }
  t ||= await trees(m, root);
  switch (s.scope) {
    case 'staged': return t.I ? [t.H, t.I] : 'cached';
    case 'unstaged': return t.I ? [t.I, t.W] : 'files';
    case 'turn': if (!s.base) throw new Error('No agent turn yet'); return [s.base, s.head || t.W];
    default: return [t.H, t.W];
  }
}
const diffArgs = (sd: [string, string] | 'cached' | 'files') => (sd === 'cached' ? ['--cached'] : sd === 'files' ? [] : sd);

export async function changes(m: Machine, root: string, s: ScopeSpec): Promise<FileDiff[]> {
  const t = s.scope === 'commits' ? undefined : await trees(m, root);
  const sd = await sides(m, root, s, t);
  const work = t && s.scope !== 'turn';
  const [d, st, un] = await multi(m, root, [
    [...DIFF, '-U3', ...diffArgs(sd), ...(s.path ? paths([s.path]) : [])],
    ...(work && t.I ? [['diff', '--name-only', '-M', t.H, t.I], ['diff', '--name-only', '-M', t.I, t.W]] : []),
  ]);
  if (d.code !== 0 && d.code !== 1) ok(d, 'git diff');
  const files = parseDiff(d.stdout);
  if (work && st && un) {
    const S = new Set(st.stdout.split('\n')), U = new Set(un.stdout.split('\n'));
    for (const f of files) f.staged = S.has(f.path) ? (U.has(f.path) ? 'part' : 'yes') : 'no';
  }
  return files;
}

export async function counts(m: Machine, root: string, specs: ScopeSpec[]): Promise<ScopeCounts[]> {
  const t = specs.some(s => s.scope !== 'commits') ? await trees(m, root) : undefined;
  const sds = await Promise.all(specs.map(s => sides(m, root, s, t).catch(() => null)));
  const rs = await multi(m, root, sds.map(sd => (sd ? ['diff', '--numstat', '-M', ...diffArgs(sd)] : ['--version'])));
  return rs.map((r, i) => {
    if (!sds[i]) return { files: 0, add: 0, del: 0 };
    const n = parseNumstat(r.stdout);
    return { files: n.length, add: n.reduce((a, x) => a + x.add, 0), del: n.reduce((a, x) => a + x.del, 0) };
  });
}

export async function show(m: Machine, root: string, path: string, rev: string): Promise<string> {
  if (rev === 'worktree') {
    if (!m.ssh) { const { readFile } = await import('node:fs/promises'); const { join } = await import('node:path'); return readFile(join(expandLocal(root), path), 'utf8'); }
    return ok(await run(m, `cat ${sqPath(root.replace(/\/$/, '') + '/' + path)}`), 'read').stdout;
  }
  return ok(await g(m, root, ['show', `${rev === 'index' ? '' : rev}:${path}`])).stdout;
}

export async function snapshot(m: Machine, root: string) { return (await trees(m, root)).W; }

export async function files(m: Machine, root: string): Promise<string[]> {
  const r = ok(await g(m, root, ['ls-files', '-co', '--exclude-standard', '--deduplicate']));
  return r.stdout.split('\n').filter(Boolean);
}

// ---------------- history and branches ----------------

export async function commits(m: Machine, root: string, n: number): Promise<Commit[]> {
  const r = await g(m, root, ['log', '-n', String(n), '--format=%H%x09%h%x09%cr%x09%an%x09%s']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map(l => { const [hash, short, when, author, ...s] = l.split('\t'); return { hash, short, when, author, subject: s.join('\t') }; });
}
export async function log(m: Machine, dir: string, n: number) {
  return (await commits(m, dir, n)).map(c => ({ hash: c.short, subject: c.subject, when: c.when }));
}

export async function branches(m: Machine, root: string): Promise<Branch[]> {
  const r = ok(await g(m, root, ['for-each-ref', '--sort=-committerdate', '--format=%(HEAD)%09%(refname:short)%09%(committerdate:relative)', 'refs/heads']));
  return r.stdout.split('\n').filter(Boolean).map(l => { const [h, name, when] = l.split('\t'); return { name, current: h === '*', when }; });
}

export async function switchBranch(m: Machine, root: string, branch: string, create?: boolean) {
  ok(await g(m, root, create ? ['switch', '-c', branch] : ['switch', branch]));
}

// ---------------- changing things ----------------

export async function stage(m: Machine, dir: string, ps: string[], on: boolean) {
  if (on) { ok(await g(m, dir, ['add', '-A', ...paths(ps)])); return; }
  const head = await g(m, dir, ['rev-parse', '-q', '--verify', 'HEAD']);
  ok(await g(m, dir, head.code === 0 ? ['reset', '-q', 'HEAD', ...paths(ps)] : ['rm', '-q', '--cached', '-r', '--ignore-unmatch', ...paths(ps)]));
}

/** Copy a file inside the machine (worktree <-> undo stash). Binary safe, keeps the mode. */
async function cp(m: Machine, root: string, from: string, to: string) {
  if (m.ssh) { ok(await run(m, `sh -c ${sq(`cd ${sqPath(root)} && mkdir -p "$(dirname ${sq(to)})" && cp -p ${sq(from)} ${sq(to)}`)}`), 'copy'); return; }
  const { copyFile, mkdir } = await import('node:fs/promises'); const { dirname, resolve } = await import('node:path');
  const r = expandLocal(root), dst = resolve(r, to);
  await mkdir(dirname(dst), { recursive: true }); await copyFile(resolve(r, from), dst);
}
async function rmFile(m: Machine, root: string, p: string) {
  if (m.ssh) { await run(m, `sh -c ${sq(`cd ${sqPath(root)} && rm -f ${sq(p)}`)}`); return; }
  const { rm } = await import('node:fs/promises'); const { join } = await import('node:path');
  await rm(join(expandLocal(root), p), { force: true });
}
async function exists(m: Machine, root: string, p: string) {
  if (m.ssh) return (await run(m, `sh -c ${sq(`cd ${sqPath(root)} && test -f ${sq(p)}`)}`)).code === 0;
  const { stat } = await import('node:fs/promises'); const { join } = await import('node:path');
  return stat(join(expandLocal(root), p)).then(s => s.isFile(), () => false);
}

/** Back to HEAD, index and working tree. Files HEAD does not have are removed. What was there is stashed in
 *  .git/skein-undo/<id> so `unrevert` can put the working file and its index entry back exactly. */
export async function revert(m: Machine, root: string, ps: string[]): Promise<RevertUndo> {
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const gitDir = ok(await g(m, root, ['rev-parse', '--git-path', `skein-undo/${id}`])).stdout.trim();
  const manifest: { path: string; had: boolean; index: string }[] = [];
  for (const [n, p] of ps.entries()) {
    const had = await exists(m, root, p);
    if (had) await cp(m, root, p, `${gitDir}/${n}`);
    const index = (await g(m, root, ['ls-files', '-s', ...paths([p])])).stdout.trim();
    manifest.push({ path: p, had, index });
    const inHead = (await g(m, root, ['cat-file', '-e', `HEAD:${p}`])).code === 0;
    if (inHead) ok(await g(m, root, ['checkout', '-q', 'HEAD', ...paths([p])]));
    else { await g(m, root, ['rm', '-q', '--cached', '--ignore-unmatch', ...paths([p])]); await rmFile(m, root, p); }
  }
  undos.set(id, { dir: gitDir, manifest });
  return { id, paths: ps };
}
const undos = new Map<string, { dir: string; manifest: { path: string; had: boolean; index: string }[] }>();

export async function unrevert(m: Machine, root: string, u: RevertUndo) {
  const rec = undos.get(u.id);
  if (!rec) throw new Error('Nothing to undo');
  for (const [n, f] of rec.manifest.entries()) {
    if (f.had) await cp(m, root, `${rec.dir}/${n}`, f.path); else await rmFile(m, root, f.path);
    const entries = f.index.split('\n').filter(Boolean);
    if (!entries.length) await g(m, root, ['rm', '-q', '--cached', '--ignore-unmatch', ...paths([f.path])]);
    for (const e of entries) {
      const [meta] = e.split('\t'); const [mode, sha] = meta.split(' ');
      ok(await g(m, root, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${f.path}`]));
    }
  }
  undos.delete(u.id);
}

export async function commit(m: Machine, dir: string, message: string, o: { branch?: string; all?: boolean } = {}) {
  if (o.branch) ok(await g(m, dir, ['switch', '-c', o.branch]));
  if (o.all) {
    const staged = await g(m, dir, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) ok(await g(m, dir, ['add', '-A']));
  }
  ok(await g(m, dir, ['commit', '-q', '-F', '-'], { input: message }));
}

export async function push(m: Machine, root: string): Promise<{ pr?: string }> {
  const [br, remotes] = await multi(m, root, [['symbolic-ref', '-q', '--short', 'HEAD'], ['remote']]);
  const branch = br.stdout.trim();
  if (!branch) throw new Error('Not on a branch');
  const remote = remotes.stdout.split('\n').includes('origin') ? 'origin' : remotes.stdout.split('\n').find(Boolean);
  if (!remote) throw new Error('This repository has no remote');
  ok(await g(m, root, ['push', '-u', remote, 'HEAD']), 'git push');
  const url = (await g(m, root, ['remote', 'get-url', remote])).stdout.trim();
  return { pr: prUrl(url, branch) || undefined };
}

export async function diff(m: Machine, dir: string, o: { path?: string; staged?: boolean; range?: string }) {
  const r = await g(m, dir, [...DIFF, ...(o.range ? [o.range] : o.staged ? ['--cached'] : ['HEAD']), ...(o.path ? paths([o.path]) : [])]);
  return r.stdout;
}
