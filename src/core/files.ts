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

// Text files come in more than UTF-8: Windows tools write XML, .reg and logs as UTF-16, and Visual Studio puts a
// BOM on .csproj and .resx. Read the bytes, decode by BOM (or by the zero bytes of BOM-less UTF-16), and write back
// in the encoding the file had, so opening and saving one never turns it into "binary" or changes its encoding.
/** utf16le / utf16be have a BOM; the -nobom forms were found without one and are written back without one. */
export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'utf16le-nobom' | 'utf16be-nobom';
export function decodeText(b: Uint8Array): { text: string; enc: TextEncoding } {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), enc: 'utf8bom' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), enc: 'utf16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: Buffer.from(buf.subarray(2)).swap16().toString('utf16le'), enc: 'utf16be' };
  // BOM-less UTF-16: mostly-ASCII text has a zero in every other byte, and only there
  const n = Math.min(buf.length, 4096) & ~1;
  if (n >= 4) {
    let even = 0, odd = 0;
    for (let i = 0; i < n; i += 2) { if (buf[i] === 0) even++; if (buf[i + 1] === 0) odd++; }
    const half = n / 2;
    if (odd > half * 0.4 && even === 0) return { text: buf.subarray(0, buf.length & ~1).toString('utf16le'), enc: 'utf16le-nobom' };
    if (even > half * 0.4 && odd === 0) return { text: Buffer.from(buf.subarray(0, buf.length & ~1)).swap16().toString('utf16le'), enc: 'utf16be-nobom' };
  }
  return { text: buf.toString('utf8'), enc: 'utf8' };
}
export function encodeText(text: string, enc: TextEncoding): Buffer {
  if (enc === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (enc === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  if (enc === 'utf16le-nobom') return Buffer.from(text, 'utf16le');
  if (enc === 'utf16be-nobom') return Buffer.from(text, 'utf16le').swap16();
  return Buffer.from(text, 'utf8');
}
/** The encoding each file was read in, so a save writes it back the same way. */
const encodings = new Map<string, TextEncoding>();

/** A file's bytes, as they are (a copy between machines keeps the encoding). */
export async function readBytes(m: Machine, path: string): Promise<Buffer> {
  if (!m.ssh) return readFile(expandLocal(path));
  // base64, so the bytes survive the trip (stdout is read as UTF-8)
  const r = await run(m, `base64 < ${sqPath(path)}`);
  if (r.code !== 0) throw new Error(r.stderr.trim());
  return Buffer.from(r.stdout, 'base64');
}

export async function read(m: Machine, path: string): Promise<string> {
  const { text, enc } = decodeText(await readBytes(m, path));
  if (enc === 'utf8') encodings.delete(m.id + '\0' + path); else encodings.set(m.id + '\0' + path, enc);
  return text;
}

export async function write(m: Machine, path: string, text: string | Uint8Array, sent?: (pct: number) => void): Promise<void> {
  const enc = typeof text === 'string' ? encodings.get(m.id + '\0' + path) : undefined;
  if (enc) text = encodeText(text as string, enc);
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
