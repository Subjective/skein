// Moving a thread to another folder or machine (DECISIONS "Moving a thread").
// Skein's record follows (machine, folder); the harness's own session file goes where the harness will look for it:
//   Claude Code: ~/.claude/projects/<slug of the cwd>/<session id>.jsonl (and its <session id>/ folder, if any).
//     The CLI resumes only transcripts under the project of its cwd, so a new folder needs a copy, on the
//     same machine too. The original is left where it was: nothing of the user's is deleted.
//   Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl. Resumed by id with the new cwd, so the same
//     machine needs no copy; another machine gets the rollout at the same relative path.
// Every touch of a machine goes through MoveIO, so tests run the whole plan against fakes.
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Harness, Machine, ThreadMeta } from '../shared/types';
import { runScript, spawnOn } from './exec';
import * as files from './files';
import { sq } from './shell';

/** Claude Code's folder name for a cwd under ~/.claude/projects: every character but letters and digits
 *  becomes a dash (/home/me/my.app -> -home-me-my-app, C:\\work\\app -> C--work-app). */
export const claudeSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export { moveBlocked } from '../shared/move';

/** What moving touches on the machines. */
export interface MoveIO {
  /** The harness's config folder on the machine, absolute: ~/.claude or ~/.codex (CLAUDE_CONFIG_DIR, CODEX_HOME). */
  root(m: Machine, h: Harness): Promise<string>;
  /** The session's file on the machine, absolute, or null when it has none (yet). */
  find(m: Machine, h: Harness, sessionId: string): Promise<string | null>;
  isDir(m: Machine, path: string): Promise<boolean>;
  /** Copy a file (or a folder's contents) within one machine, making parent folders. */
  copy(m: Machine, from: string, to: string, folder: boolean): Promise<void>;
  /** Copy a file (or a folder's contents) from one machine to another. */
  send(from: Machine, src: string, to: Machine, dst: string, folder: boolean): Promise<void>;
  log?(...a: unknown[]): void;
}

/** Path joining on the machine's side: POSIX over SSH, this computer's own separators locally. */
const pj = (m: Machine, ...parts: string[]) => (m.ssh ? parts.join('/').replace(/\/+/g, '/') : join(...parts));

export interface MoveResult {
  /** [from, to] of every copy made. */
  copied: [string, string][];
  /** Changes to the thread record beyond machine and folder (a Codex thread with no rollout starts afresh). */
  patch: Partial<ThreadMeta>;
}

/** Put the thread's session where the harness will find it at `dir` on `to`. `dir` is absolute. Does not touch
 *  Skein's record; the caller updates it once this resolves. Throws with a plain reason. */
export async function moveSession(t: ThreadMeta, from: Machine, to: Machine, dir: string, io: MoveIO): Promise<MoveResult> {
  const out: MoveResult = { copied: [], patch: {} };
  if (!(await io.isDir(to, dir))) throw new Error(`${dir} doesn’t exist on ${to.name}.`);
  const same = from.id === to.id;
  if (!t.sessionId || (same && t.harness === 'codex')) return out;
  const src = await io.find(from, t.harness, t.sessionId);
  if (!src) {
    // nothing written yet: Claude Code starts the session under its id wherever it runs; Codex needs a new thread there
    if (!same && t.harness === 'codex') out.patch.sessionId = undefined;
    return out;
  }
  const root = await io.root(to, t.harness);
  let dst: string;
  if (t.harness === 'claude') dst = pj(to, root, 'projects', claudeSlug(dir), `${t.sessionId}.jsonl`);
  else {
    // keep the date folders: sessions/YYYY/MM/DD/rollout-....jsonl
    const rel = src.split(/[\\/]sessions[\\/]/).pop()!.split(/[\\/]/);
    dst = pj(to, root, 'sessions', ...rel);
  }
  if (same && src === dst) return out;
  if (same) await io.copy(from, src, dst, false); else await io.send(from, src, to, dst, false);
  out.copied.push([src, dst]);
  // Claude Code keeps a session's subagent transcripts and large tool results in <id>/ next to the transcript
  if (t.harness === 'claude') {
    const sdir = src.replace(/\.jsonl$/, ''), ddir = dst.replace(/\.jsonl$/, '');
    if (await io.isDir(from, sdir)) {
      try { if (same) await io.copy(from, sdir, ddir, true); else await io.send(from, sdir, to, ddir, true); out.copied.push([sdir, ddir]); }
      catch (e) { io.log?.('move', `could not copy ${sdir}`, (e as Error).message); }
    }
  }
  return out;
}

// ---------- the real machines ----------

const ROOT_ENV: Record<Harness, [string, string]> = { claude: ['CLAUDE_CONFIG_DIR', '.claude'], codex: ['CODEX_HOME', '.codex'] };

async function sh(m: Machine, script: string): Promise<string> {
  const r = await runScript(m, script, { timeout: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `Failed on ${m.name}`);
  return r.stdout;
}
const exists = (p: string) => stat(p).then(s => s, () => null);

/** Session file patterns under the config root. */
const pattern = (h: Harness, id: string) => (h === 'claude' ? ['projects', '*', `${id}.jsonl`] : ['sessions', '*', '*', '*', `rollout-*${id}.jsonl`]);

async function findLocal(dir: string, parts: string[]): Promise<string | null> {
  if (!parts.length) return (await exists(dir))?.isFile() ? dir : null;
  const [p, ...rest] = parts;
  if (!p.includes('*')) return findLocal(join(dir, p), rest);
  const re = new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  for (const n of (await readdir(dir).catch(() => [] as string[])).filter(n => re.test(n)).sort().reverse()) { const f = await findLocal(join(dir, n), rest); if (f) return f; }
  return null;
}

function wait(p: ReturnType<typeof spawn>, what: string): Promise<void> {
  return new Promise((res, rej) => {
    let err = '';
    p.stderr?.setEncoding('utf8'); p.stderr?.on('data', d => (err += d));
    p.on('error', e => rej(e));
    p.on('close', code => (code === 0 ? res() : rej(new Error(err.trim().split('\n').pop() || `${what} exited with ${code}`))));
  });
}

export const machineIO: MoveIO = {
  async root(m, h) {
    const [env, dot] = ROOT_ENV[h];
    if (!m.ssh) return process.env[env] || join(homedir(), dot);
    return (await sh(m, `printf %s "\${${env}:-$HOME/${dot}}"`)).trim();
  },
  async find(m, h, id) {
    if (!/^[\w-]+$/.test(id)) return null;
    const root = await this.root(m, h);
    if (!m.ssh) return findLocal(root, pattern(h, id));
    const glob = pattern(h, id).map(p => p.split('*').map(x => (x ? sq(x) : '')).join('*')).join('/');
    const r = await runScript(m, `for f in ${sq(root)}/${glob}; do [ -f "$f" ] && printf %s "$f" && exit 0; done; exit 3\n`, { timeout: 60_000 });
    return r.code === 0 ? r.stdout : null;
  },
  async isDir(m, p) {
    if (!m.ssh) return !!(await exists(files.expandLocal(p)))?.isDirectory();
    const r = await runScript(m, `test -d ${sq(p)}\n`, { timeout: 30_000 });
    return r.code === 0;
  },
  async copy(m, from, to, folder) {
    if (!m.ssh) { await mkdir(folder ? to : dirname(to), { recursive: true }); await cp(from, to, { recursive: folder, force: true }); return; }
    await sh(m, folder ? `mkdir -p ${sq(to)} && cp -R ${sq(from)}/. ${sq(to)}/\n` : `mkdir -p "$(dirname ${sq(to)})" && cp ${sq(from)} ${sq(to)}\n`);
  },
  async send(from, src, to, dst, folder) {
    // a transcript is text: core/files reads it on one machine and writes it on the other
    if (!folder) { await files.write(to, dst, await files.readBytes(from, src)); return; }
    // a folder goes as a tar stream from one machine's tar to the other's
    if (!to.ssh) await mkdir(dst, { recursive: true });
    const a = spawnOn(from, ['tar', '-C', src, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const b = spawnOn(to, to.ssh ? ['sh', '-c', 'mkdir -p "$1" && exec tar -C "$1" -xf -', 'sh', dst] : ['tar', '-C', dst, '-xf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    a.stdout!.pipe(b.stdin!);
    await Promise.all([wait(a, 'tar'), wait(b, 'tar')]);
  },
};
