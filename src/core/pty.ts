// Terminals: node-pty for local programs, `ssh -tt` for remote ones. One manager, ids are opaque strings.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { PtySpec } from '../shared/api';
import type { Machine } from '../shared/types';
import { emit } from './events';
import { LINK_FAILED, loginWrap, run, sshBase, sshBin, sshHooks } from './exec';
import { log } from './log';
import { sq, sqPath, which } from './shell';
import { killLine, wrap } from './ssh/persist';

type IPty = import('node-pty').IPty;
let ptyMod: typeof import('node-pty') | null = null;
let ptyError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ptyMod = require('node-pty');
} catch (e) { ptyError = (e as Error).message; log('pty', 'node-pty failed to load', ptyError); }
export const ptyAvailable = () => !!ptyMod;

// macOS: node-pty's spawn-helper must be executable (scripts/postinstall.mjs fixes it too; this covers copies)
if (process.platform === 'darwin') {
  try {
    const dir = dirname(require.resolve('node-pty/package.json'));
    for (const d of readdirSync(join(dir, 'prebuilds'))) { const h = join(dir, 'prebuilds', d, 'spawn-helper'); if (existsSync(h)) chmodSync(h, 0o755); }
  } catch { /* not there: built from source */ }
}

const TERM_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Skein' };

/** argv for a harness TUI. */
export function harnessArgv(run: PtySpec['run'], exists = false): string[] {
  if (run.kind === 'claude') return ['claude', ...(run.session ? [exists ? '--resume' : '--session-id', run.session] : []), ...(run.args || [])];
  if (run.kind === 'codex') return ['codex', ...(run.remote ? ['--remote', run.remote] : []), ...(run.resume ? ['resume', run.resume] : []), ...(run.args || [])];
  return [];
}

function localShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = which('pwsh');
    return { file: pwsh || 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] };
}

/** What to spawn for a spec, before node-pty sees it. Exported for tests. */
export function plan(m: Machine, spec: PtySpec): { file: string; args: string[]; cwd?: string; env?: Record<string, string>; kept?: boolean } {
  if (m.ssh) {
    const cd = spec.cwd ? `cd ${sqPath(spec.cwd)} 2>/dev/null; ` : '';
    let line: string;
    if (spec.run.kind === 'claude' && spec.run.session) {
      // resume when the transcript exists there, else start the session under this id
      const id = sq(spec.run.session), rest = (spec.run.args || []).map(sq).join(' ');
      line = `${cd}if ls ~/.claude/projects/*/${id}.jsonl >/dev/null 2>&1; then exec claude --resume ${id} ${rest}; else exec claude --session-id ${id} ${rest}; fi`;
    } else {
      const argv = harnessArgv(spec.run);
      line = argv.length ? cd + 'exec ' + argv.map(sq).join(' ') : cd + 'exec "$SHELL" -l';
    }
    // a harness thread runs inside a persistent session so a dropped link reattaches (G5)
    const kept = !!(spec.thread && m.persist && spec.run.kind !== 'shell');
    if (kept) line = wrap(line, spec.thread!, m.persist!);
    return { file: sshBin(), args: [...sshBase(m, { tty: true }), loginWrap(line)], env: sshHooks.env(m.id), kept };
  }
  const cwd = expand(spec.cwd);
  const argv = harnessArgv(spec.run, spec.run.kind === 'claude' && !!spec.run.session && claudeTranscriptExists(spec.run.session));
  if (!argv.length) return { ...localShell(), cwd };
  const exe = which(argv[0]);
  if (!exe) throw new Error(`${argv[0]} is not installed on this computer, or not on PATH`);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', exe, ...argv.slice(1)], cwd };
  return { file: exe, args: argv.slice(1), cwd };
}

/** Is there a local Claude Code transcript for this session id? */
export function claudeTranscriptExists(id: string): boolean {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  try { return readdirSync(root).some(d => existsSync(join(root, d, id + '.jsonl'))); } catch { return false; }
}

const expand = (p?: string) => {
  if (!p) return homedir();
  const x = p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? homedir() + p.slice(1) : p;
  return existsSync(x) ? x : homedir();
};

/** How the terminal manager follows an SSH link: report a drop, wait for the link to come back. */
export interface PtyLink { whenUp(machine: string): Promise<unknown> }

interface Live { spec: PtySpec; env: Record<string, string>; term?: IPty; kept: boolean; closed: boolean; handoff?: boolean }

export class Ptys {
  private ptys = new Map<string, Live>();
  private n = 0;
  constructor(private machine: (id: string) => Machine, private link?: PtyLink) {}

  spawn(spec: PtySpec, env: Record<string, string> = {}): string {
    if (!ptyMod) throw new Error(`Terminals are unavailable: node-pty did not load (${ptyError}). Run pnpm doctor.`);
    const id = 'pty' + ++this.n;
    const live: Live = { spec: { ...spec }, env, kept: false, closed: false };
    this.start(id, live);
    this.ptys.set(id, live);
    return id;
  }

  private start(id: string, live: Live) {
    const m = this.machine(live.spec.machine);
    const p = plan(m, live.spec);
    live.kept = !!p.kept;
    const term = ptyMod!.spawn(p.file, p.args, {
      name: 'xterm-256color', cols: live.spec.cols || 80, rows: live.spec.rows || 24, cwd: p.cwd || homedir(),
      env: { ...process.env, ...TERM_ENV, ...(p.env || {}), ...live.env } as Record<string, string>,
      useConpty: true,
    });
    live.term = term;
    // output goes to the window at most every 5 ms, as one message (as VS Code does): a flood (a build log, `cat` of a
    // big file) was thousands of IPC messages a second, which kept the main process busy
    let out = '', timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { if (timer) clearTimeout(timer); timer = null; if (out) emit({ type: 'pty.data', id, data: out }); out = ''; };
    term.onData(data => { out += data; timer ??= setTimeout(flush, 5); });
    term.onExit(({ exitCode }) => {
      flush();
      if (live.term !== term) return;
      live.term = undefined;
      // the link dropped under a persistent session: the program is still running there, so wait for the
      // link and reattach under the same id (the view keeps its terminal and shows the reconnecting note)
      if (live.kept && !live.closed && exitCode === LINK_FAILED && this.link) {
        log('pty', id, 'link dropped, will reattach');
        sshHooks.lost(m.id);
        void this.link.whenUp(m.id).then(() => { if (!live.closed && this.ptys.get(id) === live) { try { this.start(id, live); } catch (e) { this.end(id, live, null, (e as Error).message); } } });
        return;
      }
      this.end(id, live, exitCode);
    });
  }

  private end(id: string, live: Live, code: number | null, why?: string) {
    if (this.ptys.get(id) === live) this.ptys.delete(id);
    if (why) emit({ type: 'pty.data', id, data: `\r\n${why}\r\n` });
    emit({ type: 'pty.exit', id, code, ...(live.handoff ? { handoff: true } : {}) });
  }

  write(id: string, data: string) { this.ptys.get(id)?.term?.write(data); }
  /** A live terminal's spec and its local process id (for an SSH terminal, the ssh client's). */
  info(id: string): { spec: PtySpec; pid?: number } | undefined { const l = this.ptys.get(id); return l && { spec: l.spec, pid: l.term?.pid }; }
  /** A shell turned out to run a harness: the terminal now belongs to that thread (moving it closes it too). */
  tie(id: string, thread: string) { const l = this.ptys.get(id); if (l) l.spec.thread = thread; }
  resize(id: string, cols: number, rows: number) {
    const l = this.ptys.get(id); if (!l) return;
    l.spec.cols = Math.max(2, cols); l.spec.rows = Math.max(1, rows);
    try { l.term?.resize(l.spec.cols, l.spec.rows); } catch { /* exited */ }
  }
  /** Close on purpose: the program ends, including a persistent remote session. Resolves once that is gone.
   *  `handoff`: chat takes the thread (core/handoff), so the view starts the program again instead of showing an exit. */
  kill(id: string, o: { handoff?: boolean } = {}): Promise<void> {
    const l = this.ptys.get(id); if (!l) return Promise.resolve();
    l.closed = true; l.handoff = o.handoff; this.ptys.delete(id);
    // wait for the program to exit (a few seconds at most), so nothing it writes on the way out lands after the
    // next writer has started
    const term = l.term;
    const gone = term ? new Promise<void>(res => { const t = setTimeout(res, 3000); term.onExit(() => { clearTimeout(t); res(); }); }) : Promise.resolve();
    try { term?.kill(); } catch { /* gone */ }
    const m = this.machine(l.spec.machine);
    if (l.kept && m.persist && l.spec.thread) return Promise.all([gone, run(m, killLine(l.spec.thread, m.persist)).catch(() => undefined)]).then(() => undefined);
    return gone;
  }
  /** Is a terminal of this thread open (its program writes the thread's transcript)? */
  hasThread(thread: string) { for (const l of this.ptys.values()) if (l.spec.thread === thread && !l.closed) return true; return false; }
  /** Close every terminal tied to a thread (it is moving, or chat takes it over: `handoff`). */
  async killThread(thread: string, o: { handoff?: boolean } = {}) { await Promise.all([...this.ptys].filter(([, l]) => l.spec.thread === thread).map(([id]) => this.kill(id, o))); }
  /** App quit: let persistent remote sessions keep running, so a turn survives restarting Skein. */
  killAll() { for (const [id, l] of [...this.ptys]) { l.closed = true; this.ptys.delete(id); try { l.term?.kill(); } catch { /* gone */ } } }
}
