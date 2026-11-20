// Folder browsing and file read / write on a machine.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DirEntry, Machine } from '../shared/types';
import { execFile } from 'node:child_process';
import { run } from './exec';
import { sqPath } from './shell';

export const expandLocal = (p: string) => (p === '~' ? homedir() : /^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p);

export async function list(m: Machine, dir: string): Promise<DirEntry[]> {
  if (!m.ssh) {
    const es = await readdir(expandLocal(dir), { withFileTypes: true });
    return sortEntries(es.map(e => ({ name: e.name, dir: e.isDirectory(), hidden: e.name.startsWith('.') })));
  }
  const r = await run(m, `ls -1pA ${sqPath(dir)}`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Could not list ${dir}`);
  return sortEntries(r.stdout.split('\n').filter(Boolean).map(l => ({ name: l.replace(/\/$/, ''), dir: l.endsWith('/'), hidden: l.startsWith('.') })));
}
const sortEntries = (es: DirEntry[]) => es.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

export async function read(m: Machine, path: string): Promise<string> {
  if (!m.ssh) return readFile(expandLocal(path), 'utf8');
  const r = await run(m, `cat ${sqPath(path)}`);
  if (r.code !== 0) throw new Error(r.stderr.trim());
  return r.stdout;
}

export async function write(m: Machine, path: string, text: string | Uint8Array, sent?: (pct: number) => void): Promise<void> {
  if (!m.ssh) { const p = expandLocal(path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, text); return; }
  const r = await run(m, `mkdir -p "$(dirname ${sqPath(path)})" && cat > ${sqPath(path)}`, { input: text, sent });
  if (r.code !== 0) throw new Error(r.stderr.trim());
}

export async function resolve(m: Machine, path: string): Promise<string> {
  if (!m.ssh) return expandLocal(path);
  if (!path.startsWith('~')) return path;
  return (m.home || '~') + path.slice(1);
}

// ---------- file search ----------
const FIND_CAP = 20000;
const SKIP = new Set(['node_modules', 'out', 'dist', 'build', 'target', '__pycache__', 'venv']);

/** Every file under dir, relative to it: git's list (tracked and untracked, ignores applied) in a repo, else a capped
 *  walk that skips hidden folders (a home folder's .cache would otherwise fill the list). */
export async function find(m: Machine, dir: string): Promise<string[]> {
  const root = await resolve(m, dir);
  if (m.ssh) {
    const r = await run(m, `cd ${sqPath(root)} && { git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path '*/.*/*' -not -path '*/node_modules/*' | sed 's#^\\./##'; } | head -n ${FIND_CAP}`);
    if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || `Could not search ${dir}`);
    return r.stdout.split('\n').filter(Boolean);
  }
  const git = await new Promise<string[] | null>(res => {
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, maxBuffer: 64 << 20, windowsHide: true }, (e, out) => res(e ? null : out.split('\n').filter(Boolean).slice(0, FIND_CAP)));
  });
  if (git) return git;
  const out: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (out.length >= FIND_CAP || depth > 12) return;
    let es;
    try { es = await readdir(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (out.length >= FIND_CAP) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(p, depth + 1); } else if (e.isFile()) out.push(p);
    }
  };
  await walk('', 0);
  return out;
}
