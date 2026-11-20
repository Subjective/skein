// Terminals: node-pty for local programs, `ssh -tt` for remote ones. One manager, ids are opaque strings.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { PtySpec } from '../shared/api';
import type { Machine } from '../shared/types';
import { emit } from './events';
import { loginWrap, sshBase } from './exec';
import { log } from './log';
import { sq, sqPath, which } from './shell';

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
export function plan(m: Machine, spec: PtySpec): { file: string; args: string[]; cwd?: string } {
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
    return { file: 'ssh', args: [...sshBase(m, { tty: true }), loginWrap(line)] };
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

export class Ptys {
  private ptys = new Map<string, IPty>();
  private n = 0;
  constructor(private machine: (id: string) => Machine) {}

  spawn(spec: PtySpec): string {
    if (!ptyMod) throw new Error(`Terminals are unavailable: node-pty did not load (${ptyError}). Run pnpm doctor.`);
    const m = this.machine(spec.machine);
    const p = plan(m, spec);
    const id = 'pty' + ++this.n;
    const term = ptyMod.spawn(p.file, p.args, {
      name: 'xterm-256color', cols: spec.cols || 80, rows: spec.rows || 24, cwd: p.cwd || homedir(),
      env: { ...process.env, ...TERM_ENV } as Record<string, string>,
      useConpty: true,
    });
    this.ptys.set(id, term);
    term.onData(data => emit({ type: 'pty.data', id, data }));
    term.onExit(({ exitCode }) => { this.ptys.delete(id); emit({ type: 'pty.exit', id, code: exitCode }); });
    return id;
  }
  write(id: string, data: string) { this.ptys.get(id)?.write(data); }
  resize(id: string, cols: number, rows: number) { try { this.ptys.get(id)?.resize(Math.max(2, cols), Math.max(1, rows)); } catch { /* exited */ } }
  kill(id: string) { const p = this.ptys.get(id); if (p) { this.ptys.delete(id); try { p.kill(); } catch { /* gone */ } } }
  killAll() { for (const id of [...this.ptys.keys()]) this.kill(id); }
}
