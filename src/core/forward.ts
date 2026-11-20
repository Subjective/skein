// Port forwards for Browser tabs: a thread on an SSH machine previews that machine's localhost through
// `ssh -N -L 127.0.0.1:<local>:localhost:<port>`. One forward per machine and port, kept until it dies or the
// app quits. Each forward has its own connection (no ControlMaster), so killing it really frees the port.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import type { Machine } from '../shared/types';
import { sshBase, sshBin, sshEnv, sshFailure } from './exec';

interface Fwd { ready: Promise<number>; proc?: ChildProcess }

/** A free TCP port on 127.0.0.1 (the OS picks; there is a small window before ssh binds it). */
export const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => (a && typeof a === 'object' ? res(a.port) : rej(new Error('no port')))); });
});

/** Whether something accepts connections on 127.0.0.1:port. */
const accepts = (port: number) => new Promise<boolean>(res => {
  const c = connect({ host: '127.0.0.1', port });
  c.once('connect', () => { c.destroy(); res(true); });
  c.once('error', () => res(false));
  c.setTimeout(1000, () => { c.destroy(); res(false); });
});

/** The ssh arguments for a forward. Pure, for tests: the host stays last, the forward options go before it. */
export function forwardArgs(m: Machine, local: number, port: number): string[] {
  const base = sshBase(m, { mux: false });
  const host = base.pop()!;
  return [...base, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${local}:localhost:${port}`, host];
}

export class Forwards {
  private live = new Map<string, Fwd>();
  constructor(private machine: (id: string) => Machine, private timeoutMs = 60_000) {}

  forward(id: string, port: number): Promise<number> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error(`Not a port: ${port}`));
    const m = this.machine(id);
    if (!m.ssh) return Promise.resolve(port); // a local machine's localhost is ours
    const key = `${id}:${port}`;
    const hit = this.live.get(key);
    if (hit && (!hit.proc || (hit.proc.exitCode === null && hit.proc.signalCode === null))) return hit.ready;
    const f: Fwd = { ready: Promise.resolve(0) };
    const drop = () => { if (this.live.get(key) === f) this.live.delete(key); };
    f.ready = (async () => {
      const local = await freePort();
      const proc = f.proc = spawn(sshBin(), forwardArgs(m, local, port), { stdio: ['ignore', 'ignore', 'pipe'], env: sshEnv(m), windowsHide: true });
      let err = '', gone: string | null = null;
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', d => { err = (err + d).slice(-4000); });
      proc.on('error', e => { gone = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ENOENT: ssh not found' : e.message; });
      proc.on('exit', () => { gone ??= err; drop(); });
      const until = Date.now() + this.timeoutMs;
      while (Date.now() < until) {
        if (gone !== null) throw new Error(sshFailure(gone || err, m.ssh!.host));
        if (await accepts(local)) return local;
        await new Promise(r => setTimeout(r, 200));
      }
      proc.kill();
      throw new Error(`No answer from ${m.ssh!.host}`);
    })();
    this.live.set(key, f);
    // a failed attempt is not kept, so Retry starts over
    f.ready.catch(drop);
    return f.ready;
  }

  dispose() { for (const f of this.live.values()) f.proc?.kill(); this.live.clear(); }
}
