// Helpers both harness adapters share: error kinds (G9), text tidying, throttled streaming, reading
// a harness's files on a machine (local disk, or `cat` over ssh).
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Machine, ThreadEvent } from '../../shared/types';
import { run } from '../exec';
import { sq } from '../shell';

export type ErrorKind = Extract<ThreadEvent, { t: 'error' }>['kind'];

/** Sort a harness failure into the kinds the chat view offers one action for (G9). */
export function errorKind(text: string, code?: string | number | null): ErrorKind {
  const s = `${code ?? ''} ${text}`.toLowerCase();
  if (/\benoent\b|command not found|not recognized as an internal|no such file or directory.*(claude|codex)|exit(ed)? (with )?code 127|cli not found|executable not found/.test(s)) return 'missing';
  if (/rate.?limit|usage.?limit|overloaded|\b429\b|\b529\b|too many requests|quota|ratelimit|serveroverloaded|usagelimitexceeded/.test(s)) return 'rate';
  if (/auth|login|log in|sign in|unauthori[sz]ed|\b401\b|\b403\b|api key|credential|token (has )?expired|oauth|forbidden/.test(s)) return 'auth';
  return 'other';
}

/** One line, trimmed to n characters. */
export const tidy = (s: string, n = 80) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** Long tool output is cut so a chat event stays small; the full text lives in the harness's history. */
export const clip = (s: string, n = 6000) => (s.length > n ? s.slice(0, n) + `\n… ${s.length - n} more characters` : s);

/** Text blocks of an Anthropic-style or Codex-style content array. */
export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string' ? (c as { text: string }).text : '')).filter(Boolean).join('\n');
};

/** Calls fn at most every `ms`, always delivering the last value. */
export function throttle<T>(ms: number, fn: (v: T) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null, last: { v: T } | null = null, at = 0;
  const fire = () => { timer = null; if (last) { const v = last.v; last = null; at = Date.now(); fn(v); } };
  return {
    push(v: T) { last = { v }; if (timer) return; const wait = Math.max(0, ms - (Date.now() - at)); if (wait === 0) fire(); else timer = setTimeout(fire, wait); },
    flush() { if (timer) { clearTimeout(timer); timer = null; } fire(); },
  };
}

/** Line counts of a unified diff, or of an old / new text pair. */
export function countDiff(diff: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) add++; else if (l.startsWith('-')) del++;
  }
  return { add, del };
}

/** A minimal unified diff of a string replacement: enough for the chat's edit row, not a real LCS diff. */
export function replaceDiff(path: string, before: string, after: string): string {
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : [];
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const out = [`--- a/${path}`, `+++ b/${path}`, `@@ -${s + 1},${a.length - s - e} +${s + 1},${b.length - s - e} @@`];
  for (const l of a.slice(s, a.length - e)) out.push('-' + l);
  for (const l of b.slice(s, b.length - e)) out.push('+' + l);
  return out.join('\n');
}

export const home = (m: Machine) => (m.ssh ? m.home ?? '~' : homedir());

/** Read the first file matching a glob under the user's home on the machine (e.g. ['.claude', 'projects', '*', 'ID.jsonl']).
 *  `parts` are path segments; '*' inside a segment is a wildcard. Returns null when nothing matches. */
export async function readHarnessFile(m: Machine, parts: string[]): Promise<string | null> {
  if (m.ssh) {
    // Only the wildcard segments stay unquoted, so ids and names cannot inject shell syntax.
    const glob = parts.map(p => p.split('*').map(x => (x ? sq(x) : '')).join('*')).join('/');
    const r = await run(m, `for f in "$HOME"/${glob}; do [ -f "$f" ] && cat "$f" && exit 0; done; exit 3`, { timeout: 60_000 });
    return r.code === 0 ? r.stdout : null;
  }
  const found = await findLocal(homedir(), parts);
  return found ? readFile(found, 'utf8') : null;
}

/** The name of the first file under the home folder matching `parts` (as readHarnessFile) that contains `text`. */
export async function harnessFileWith(m: Machine, parts: string[], text: string): Promise<string | null> {
  if (m.ssh) {
    const glob = parts.map(p => p.split('*').map(x => (x ? sq(x) : '')).join('*')).join('/');
    const r = await run(m, `grep -l -F -- ${sq(text)} "$HOME"/${glob} 2>/dev/null | head -n 1`, { timeout: 60_000 });
    const f = r.stdout.trim();
    return f ? f.replace(/^.*\//, '') : null;
  }
  const hit = await findLocal(homedir(), parts, f => readFile(f, 'utf8').then(s => s.includes(text), () => false));
  return hit ? hit.replace(/^.*[\\/]/, '') : null;
}

async function findLocal(dir: string, parts: string[], ok?: (file: string) => Promise<boolean>): Promise<string | null> {
  if (!parts.length) return (await stat(dir).then(s => s.isFile(), () => false)) && (!ok || await ok(dir)) ? dir : null;
  const [p, ...rest] = parts;
  if (!p.includes('*')) return findLocal(join(dir, p), rest, ok);
  const re = new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  const names = (await readdir(dir).catch(() => [] as string[])).filter(n => re.test(n));
  for (const n of names.sort().reverse()) { const f = await findLocal(join(dir, n), rest, ok); if (f) return f; }
  return null;
}

/** JSON lines, skipping any that do not parse (a file being written ends mid-line). */
export const jsonLines = (text: string): Record<string, unknown>[] =>
  text.split('\n').flatMap(l => { if (!l.trim()) return []; try { const o = JSON.parse(l); return o && typeof o === 'object' ? [o] : []; } catch { return []; } });

/** A promise you can settle from outside. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
