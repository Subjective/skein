// Running things on a machine: locally with child_process, remotely through the system `ssh`.
// Every remote command goes through here so connection options, the askpass environment and link-loss
// detection live in one place.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Machine } from '../shared/types';
import { sq, which } from './shell';

/** Set once by services: the askpass environment for an ssh process, and who to tell when a link drops. */
export const sshHooks: { env(machine: string): Record<string, string>; lost(machine: string): void } = {
  env: () => ({}),
  lost: () => {},
};

/** The OpenSSH client. On Windows it is an optional feature in System32\OpenSSH. */
export function sshBin(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return 'ssh';
  const found = which('ssh', env);
  if (found) return found;
  const sys = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  return existsSync(sys) ? sys : 'ssh';
}

/** Options every ssh invocation shares. ControlMaster keeps one connection per host on macOS / Linux.
 *  Windows OpenSSH has no multiplexing (a ControlMaster line in the user's config makes it fail), so it is
 *  switched off there and each call opens its own connection; askpass answers cover the repeats. */
export function sshBase(m: Machine, o: { tty?: boolean; batch?: boolean; compress?: boolean; platform?: NodeJS.Platform } = {}): string[] {
  if (!m.ssh) throw new Error(`${m.name} is not an SSH machine`);
  // SKEIN_SSH_CONFIG: use another ssh config file (tests; also handy for a work-only config)
  const a = [...(process.env.SKEIN_SSH_CONFIG ? ['-F', process.env.SKEIN_SSH_CONFIG] : []), '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15'];
  // SKEIN_SSH_NO_MUX: behave as on Windows (tests run the Windows connection model on Linux this way)
  if ((o.platform ?? process.platform) === 'win32' || process.env.SKEIN_SSH_NO_MUX) a.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none');
  else a.push('-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/skein-%C', '-o', 'ControlPersist=10m');
  if (o.batch) a.push('-o', 'BatchMode=yes');
  if (o.compress) a.push('-C');
  if (m.ssh.port) a.push('-p', String(m.ssh.port));
  a.push(o.tty ? '-tt' : '-T');
  a.push(m.ssh.user ? `${m.ssh.user}@${m.ssh.host}` : m.ssh.host);
  return a;
}

/** Environment for an ssh child: ours plus askpass. */
export const sshEnv = (m: Machine): NodeJS.ProcessEnv => ({ ...process.env, ...sshHooks.env(m.id) });

/** ssh exits 255 when the connection itself failed (as opposed to the remote command's own status). */
export const LINK_FAILED = 255;

/** Spawn a process on the machine. For SSH, `cmd` is joined into one POSIX command line run by the login shell. */
export function spawnOn(m: Machine, cmd: string[], o: SpawnOptions & { cwd?: string; posixCwd?: string } = {}): ChildProcess {
  if (!m.ssh) return spawn(cmd[0], cmd.slice(1), { ...o, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd[0]) });
  const line = (o.posixCwd ? `cd ${o.posixCwd} && ` : '') + 'exec ' + cmd.map(sq).join(' ');
  const { cwd: _cwd, posixCwd: _p, ...rest } = o;
  const p = spawn(sshBin(), [...sshBase(m), loginWrap(line)], { ...rest, env: { ...sshEnv(m), ...(rest.env || {}) }, windowsHide: true });
  p.on('exit', code => { if (code === LINK_FAILED) sshHooks.lost(m.id); });
  return p;
}

/** Run through the remote user's login shell so PATH includes ~/.local/bin, nvm, etc. */
export const loginWrap = (line: string) => `exec "$SHELL" -lc ${sq(line)}`;

export interface RunResult { code: number | null; stdout: string; stderr: string }

/** Run a shell command line on the machine and collect its output. */
export function run(m: Machine, line: string, o: { input?: string | Uint8Array; timeout?: number; batch?: boolean } = {}): Promise<RunResult> {
  if (m.ssh) return collect(spawn(sshBin(), [...sshBase(m, { batch: o.batch }), loginWrap(line)], { windowsHide: true, env: sshEnv(m) }), o, m);
  const win = process.platform === 'win32';
  return collect(spawn(win ? 'powershell.exe' : process.env.SHELL || '/bin/sh', win ? ['-NoProfile', '-NonInteractive', '-Command', line] : ['-c', line], { windowsHide: true }), o);
}

/** Run a POSIX sh script on an SSH machine, sent on stdin (`sh -s`), so no quoting survives two shells and the
 *  user's login shell (fish, csh) never parses it. Not a login shell: use `"$SHELL" -lc` inside for PATH. */
export function runScript(m: Machine, script: string, o: { timeout?: number; batch?: boolean; compress?: boolean } = {}): Promise<RunResult> {
  if (!m.ssh) throw new Error('runScript is for SSH machines');
  return collect(spawn(sshBin(), [...sshBase(m, { batch: o.batch, compress: o.compress }), 'sh -s'], { windowsHide: true, env: sshEnv(m) }), { ...o, input: script }, m);
}

function collect(p: ChildProcess, o: { input?: string | Uint8Array; timeout?: number }, m?: Machine): Promise<RunResult> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', spawnErr = false;
    p.stdout?.setEncoding('utf8'); p.stderr?.setEncoding('utf8');
    p.stdout?.on('data', d => (stdout += d));
    p.stderr?.on('data', d => (stderr += d));
    const timer = o.timeout ? setTimeout(() => p.kill(), o.timeout) : null;
    p.on('error', e => { spawnErr = true; stderr += (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ENOENT: ssh not found' : e.message; });
    p.on('close', code => {
      if (timer) clearTimeout(timer);
      if (m && code === LINK_FAILED && !spawnErr) sshHooks.lost(m.id);
      resolve({ code: spawnErr ? -1 : code, stdout, stderr });
    });
    p.stdin?.on('error', () => {});
    if (o.input != null) p.stdin?.end(o.input); else p.stdin?.end();
  });
}

/** Plain words for why ssh failed, from its stderr. Pure, for tests. */
export function sshFailure(stderr: string, host: string, platform = process.platform): string {
  const s = stderr;
  if (/ENOENT: ssh not found/.test(s)) return platform === 'win32' ? 'OpenSSH Client is not installed. Add it in Settings > System > Optional features' : 'ssh is not installed on this computer';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return `The host key for ${host} changed. If that is expected, remove the old key with ssh-keygen -R ${host}`;
  if (/Host key verification failed/i.test(s)) return 'Host key not trusted';
  if (/Could not resolve hostname/i.test(s)) return `Can't find ${host}`;
  if (/Connection refused/i.test(s)) return `${host} refused the connection`;
  if (/timed out|No route to host|Network is unreachable/i.test(s)) return `No answer from ${host}`;
  if (/Permission denied|Too many authentication failures/i.test(s)) return 'Sign-in failed';
  if (/Connection closed|Connection reset|Broken pipe/i.test(s)) return 'The connection closed';
  const last = s.trim().split(/\r?\n/).filter(l => !/^Warning: Permanently added/.test(l)).pop();
  return last || 'Could not connect';
}
