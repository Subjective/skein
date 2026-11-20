// Folder browsing and file read / write on a machine.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DirEntry, Machine } from '../shared/types';
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

export async function write(m: Machine, path: string, text: string | Uint8Array): Promise<void> {
  if (!m.ssh) { const p = expandLocal(path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, text); return; }
  const r = await run(m, `mkdir -p "$(dirname ${sqPath(path)})" && cat > ${sqPath(path)}`, { input: text });
  if (r.code !== 0) throw new Error(r.stderr.trim());
}

export async function resolve(m: Machine, path: string): Promise<string> {
  if (!m.ssh) return expandLocal(path);
  if (!path.startsWith('~')) return path;
  return (m.home || '~') + path.slice(1);
}
