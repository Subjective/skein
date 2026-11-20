// Git, run on the thread's machine. Powers the Changes and Files views.
import type { GitStatus } from '../shared/api';
import type { Machine } from '../shared/types';
import { run } from './exec';
import { sq, sqPath } from './shell';

/** Remote git: one command line through the login shell. */
const git = (m: Machine, dir: string, args: string, input?: string) => run(m, `cd ${sqPath(dir)} && git -c core.quotepath=off ${args}`, { input });

/** Local git runs with cwd instead of `cd`, which PowerShell would treat differently. */
async function g(m: Machine, dir: string, args: string, input?: string) {
  if (m.ssh) return git(m, dir, args, input);
  const { spawn } = await import('node:child_process');
  const { expandLocal } = await import('./files');
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(res => {
    const p = spawn('git', ['-c', 'core.quotepath=off', ...splitArgs(args)], { cwd: expandLocal(dir), windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => (stdout += d)); p.stderr.on('data', d => (stderr += d));
    p.on('error', e => res({ code: -1, stdout, stderr: e.message }));
    p.on('close', code => res({ code, stdout, stderr }));
    p.stdin.end(input ?? '');
  });
}
/** Our own arg strings only: split on spaces, honouring single quotes made by sq(). */
const splitArgs = (s: string) => (s.match(/'(?:[^']|'\\'')*'|\S+/g) || []).map(a => (a.startsWith("'") ? a.slice(1, -1).replace(/'\\''/g, "'") : a));

const ok = (r: { code: number | null; stderr: string }) => { if (r.code !== 0) throw new Error(r.stderr.trim() || 'git failed'); };

export async function status(m: Machine, dir: string): Promise<GitStatus> {
  const r = await g(m, dir, 'status --porcelain=v1 -b');
  if (r.code !== 0) return { isRepo: false, files: [] };
  const [head, ...rest] = r.stdout.split('\n');
  const br = /^## ([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(head);
  const nums = await g(m, dir, 'diff --numstat HEAD');
  const counts = new Map<string, [number, number]>();
  for (const l of nums.stdout.split('\n')) { const [a, d, p] = l.split('\t'); if (p) counts.set(p, [+a || 0, +d || 0]); }
  const files = rest.filter(Boolean).map(l => {
    const x = l[0], y = l[1], path = l.slice(3).replace(/^.* -> /, '');
    const st = (x === '?' ? '?' : (x !== ' ' ? x : y)) as GitStatus['files'][number]['status'];
    const [add, del] = counts.get(path) || [0, 0];
    return { path, status: st, add, del, staged: x !== ' ' && x !== '?' };
  });
  return { isRepo: true, branch: br?.[1], ahead: br?.[2] ? +br[2] : 0, behind: br?.[3] ? +br[3] : 0, files };
}

export async function diff(m: Machine, dir: string, o: { path?: string; staged?: boolean; range?: string }) {
  const r = await g(m, dir, `diff ${o.range ? sq(o.range) : o.staged ? '--cached' : 'HEAD'}${o.path ? ' -- ' + sq(o.path) : ''}`);
  return r.stdout;
}
export async function stage(m: Machine, dir: string, paths: string[], on: boolean) { ok(await g(m, dir, `${on ? 'add' : 'reset -q HEAD'} -- ${paths.map(sq).join(' ')}`)); }
export async function revert(m: Machine, dir: string, paths: string[]) { ok(await g(m, dir, `checkout HEAD -- ${paths.map(sq).join(' ')}`)); }
export async function commit(m: Machine, dir: string, message: string, o: { branch?: string; all?: boolean } = {}) {
  if (o.branch) ok(await g(m, dir, `switch -c ${sq(o.branch)}`));
  ok(await g(m, dir, `commit ${o.all ? '-a ' : ''}-F -`, message));
}
export async function log(m: Machine, dir: string, n: number) {
  const r = await g(m, dir, `log -n ${n} --format=%h%x09%s%x09%cr`);
  return r.stdout.split('\n').filter(Boolean).map(l => { const [hash, subject, when] = l.split('\t'); return { hash, subject, when }; });
}
