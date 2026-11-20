// Running things on a machine: locally with child_process, remotely through the system `ssh`.
// Every remote command goes through here so connection options live in one place.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Machine } from '../shared/types';
import { sq } from './shell';

/** Options every ssh invocation shares. ControlMaster keeps one connection per host on macOS / Linux;
 *  Windows OpenSSH has no multiplexing, so each call opens its own connection there. */
export function sshBase(m: Machine, o: { tty?: boolean; batch?: boolean } = {}): string[] {
  if (!m.ssh) throw new Error(`${m.name} is not an SSH machine`);
  const a = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  if (process.platform !== 'win32') a.push('-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/skein-%C', '-o', 'ControlPersist=10m');
  if (o.batch) a.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10');
  if (m.ssh.port) a.push('-p', String(m.ssh.port));
  a.push(o.tty ? '-tt' : '-T');
  a.push(m.ssh.user ? `${m.ssh.user}@${m.ssh.host}` : m.ssh.host);
  return a;
}

/** Spawn a process on the machine. For SSH, `cmd` is joined into one POSIX command line run by the login shell. */
export function spawnOn(m: Machine, cmd: string[], o: SpawnOptions & { cwd?: string; posixCwd?: string } = {}): ChildProcess {
  if (!m.ssh) return spawn(cmd[0], cmd.slice(1), { ...o, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd[0]) });
  const line = (o.posixCwd ? `cd ${o.posixCwd} && ` : '') + 'exec ' + cmd.map(sq).join(' ');
  const { cwd: _cwd, posixCwd: _p, ...rest } = o;
  return spawn('ssh', [...sshBase(m), loginWrap(line)], { ...rest, windowsHide: true });
}

/** Run through the remote user's login shell so PATH includes ~/.local/bin, nvm, etc. */
export const loginWrap = (line: string) => `exec "$SHELL" -lc ${sq(line)}`;

export interface RunResult { code: number | null; stdout: string; stderr: string }

/** Run a shell command line on the machine and collect its output. */
export function run(m: Machine, line: string, o: { input?: string | Uint8Array; timeout?: number; batch?: boolean } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const p = m.ssh
      ? spawn('ssh', [...sshBase(m, { batch: o.batch ?? true }), loginWrap(line)], { windowsHide: true })
      : spawn(process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh', process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', line] : ['-c', line], { windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout?.on('data', d => (stdout += d));
    p.stderr?.on('data', d => (stderr += d));
    const timer = o.timeout ? setTimeout(() => p.kill(), o.timeout) : null;
    p.on('error', e => { stderr += e.message; });
    p.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (o.input != null) p.stdin?.end(o.input); else p.stdin?.end();
  });
}
