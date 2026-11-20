// Watching an SSH link (G5). While a machine is up, one quiet ssh process stays open to it (on macOS / Linux it
// also rides the ControlMaster). ServerAliveInterval notices a dead network within ~30s, ssh exits, and the
// machine goes to 'reconnecting'. Reconnecting retries with backoff; after about two minutes the dot turns
// red ('down') and Skein keeps trying once a minute, quietly, until the link is back.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Machine } from '../../shared/types';
import { sshBase, sshBin, sshEnv } from '../exec';

/** Seconds to wait before each reconnect attempt. Pure, for tests. */
export const BACKOFF = [1, 2, 4, 8, 15, 30, 30, 30];
export const SLOW_RETRY = 60;
export const backoff = (attempt: number) => (attempt < BACKOFF.length ? BACKOFF[attempt] : SLOW_RETRY);
/** Attempts after which a reconnecting machine shows as down (sum of BACKOFF ~ 2 minutes). */
export const DOWN_AFTER = BACKOFF.length;

export class LinkWatch {
  private procs = new Map<string, ChildProcess>();
  constructor(private onDrop: (machine: string) => void) {}

  /** Start watching an up machine. Replaces an earlier watcher. */
  watch(m: Machine) {
    this.stop(m.id);
    // `cat` holds the session open until our stdin closes; nothing is printed
    const p = spawn(sshBin(), [...sshBase(m), 'exec cat >/dev/null'], { windowsHide: true, env: sshEnv(m), stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin?.on('error', () => {});
    p.on('error', () => {});
    this.procs.set(m.id, p);
    p.on('exit', () => { if (this.procs.get(m.id) === p) { this.procs.delete(m.id); this.onDrop(m.id); } });
  }
  watching(id: string) { return this.procs.has(id); }
  stop(id: string) { const p = this.procs.get(id); if (p) { this.procs.delete(id); p.stdin?.end(); p.kill(); } }
  stopAll() { for (const id of [...this.procs.keys()]) this.stop(id); }
}
