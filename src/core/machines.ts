// The machines Skein knows: this computer, plus SSH hosts the user added.
// For SSH machines this owns the link (G5): connect, the sign-in prompts (askpass), watching the link while it
// is up, and reconnecting with backoff when it drops.
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { AuthPrompt, Harness, LinkState, Machine, SshTarget } from '../shared/types';
import { emit } from './events';
import { runScript, sshFailure, sshHooks } from './exec';
import { log } from './log';
import { which } from './shell';
import { Askpass } from './ssh/askpass';
import { backoff, DOWN_AFTER, LinkWatch } from './ssh/link';
import { tmuxVersion, writeConfScript, type Keeper } from './ssh/persist';
import type { Store } from './store';

const localName = () => (process.platform === 'darwin' ? 'This Mac' : process.platform === 'win32' ? 'This PC' : hostname());
const localOs = () => (process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux');

/** What a connect learns about the remote. Runs in plain sh; the login shell is asked for PATH-dependent tools. */
export const PROBE = `echo "skein:os:$(uname -s)"
echo "skein:home:$HOME"
"\${SHELL:-/bin/sh}" -lc 'command -v claude >/dev/null 2>&1 && echo skein:has:claude; command -v codex >/dev/null 2>&1 && echo skein:has:codex; command -v agy >/dev/null 2>&1 && echo skein:has:agy; command -v tmux >/dev/null 2>&1 && tmux -V | sed s/^/skein:tmux:/; command -v screen >/dev/null 2>&1 && echo skein:screen; true' </dev/null 2>/dev/null
true
`;

export interface Probe { os?: string; home?: string; has: Harness[]; persist?: Keeper; tmux?: number }

/** Parse PROBE's output. Pure, for tests. Lines without the prefix (a chatty login profile) are ignored. */
export function parseProbe(out: string): Probe {
  const p: Probe = { has: [] };
  for (const raw of out.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l.startsWith('skein:')) continue;
    const [, k, ...rest] = l.split(':'); const v = rest.join(':');
    if (k === 'os') p.os = /Darwin/.test(v) ? 'macOS' : /Linux/.test(v) ? 'Linux' : v || undefined;
    if (k === 'home') p.home = v;
    if (k === 'has' && (v === 'claude' || v === 'codex' || v === 'agy') && !p.has.includes(v)) p.has.push(v);
    if (k === 'tmux') { p.tmux = tmuxVersion(v); if (p.tmux >= 1.8) p.persist = 'tmux'; }
    if (k === 'screen' && !p.persist) p.persist = 'screen';
  }
  return p;
}

type UpFn = (m: Machine) => void;

export class Machines {
  private list: Machine[] = [];
  readonly askpass: Askpass;
  private watch: LinkWatch;
  private inflight = new Map<string, Promise<Machine>>();
  private retry = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();
  private ups = new Set<UpFn>();
  private ready: Promise<void>;

  constructor(private store: Store, o: { askpass?: Askpass } = {}) {
    const local: Machine = { id: 'local', name: localName(), os: localOs(), home: homedir(), link: 'up', has: this.localHarnesses() };
    this.list = [local, ...store.rows<Machine>('machines').map(m => ({ ...m, link: 'down' as const, note: undefined }))];
    this.askpass = o.askpass ?? new Askpass({
      prompt: p => this.prompted(p),
      done: (id, machine) => this.answered(id, machine),
    });
    this.watch = new LinkWatch(id => this.lost(id));
    this.ready = this.askpass.start().catch(e => log('ssh', 'askpass server failed to start', (e as Error).message));
    // ControlPath lives in ~/.ssh; without the folder every multiplexed ssh would fail
    if (process.platform !== 'win32') { try { mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 }); } catch { /* read-only home */ } }
    sshHooks.env = id => this.askpass.env(id);
    sshHooks.lost = id => this.lost(id);
  }

  all() { return this.list; }
  get(id: string): Machine {
    const m = this.list.find(x => x.id === id);
    if (!m) throw new Error(`Unknown machine ${id}`);
    return m;
  }
  localHarnesses(): Harness[] { return (['claude', 'codex', 'agy'] as Harness[]).filter(h => which(h)); }
  /** Run `fn` each time an SSH machine's link comes up (first connect and every reconnect). */
  onUp(fn: UpFn) { this.ups.add(fn); return () => this.ups.delete(fn); }
  /** Resolves the next time the machine is up (now, if it is). */
  whenUp(id: string): Promise<Machine> {
    const m = this.get(id);
    if (m.link === 'up') return Promise.resolve(m);
    return new Promise(res => { const off = this.onUp(x => { if (x.id === id) { off(); res(x); } }); });
  }

  add(name: string, ssh: SshTarget): Machine {
    const id = (name || ssh.host).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (id === 'local') throw new Error('That name is taken by this computer');
    this.drop(id);
    const m: Machine = { id, name: name || ssh.host, ssh, link: 'down', has: [] };
    this.list = [...this.list.filter(x => x.id !== id), m];
    this.save(m);
    emit({ type: 'machine', machine: { ...m } });
    return m;
  }
  remove(id: string) {
    if (id === 'local') return;
    this.drop(id);
    this.list = this.list.filter(x => x.id !== id); this.store.del('machines', id);
  }
  /** Stop everything for a machine: watcher, retries, prompts, remembered secrets. */
  private drop(id: string) {
    this.watch.stop(id); this.stopRetry(id);
    this.askpass.cancelAll(id); this.askpass.forget(id);
  }
  dispose() { this.watch.stopAll(); for (const id of [...this.retry.keys()]) this.stopRetry(id); this.askpass.stop(); }

  answer(promptId: string, value: string | null) { this.askpass.answer(promptId, value); }
  prompts(): AuthPrompt[] { return this.askpass.list(); }

  private save(m: Machine) { this.store.put('machines', m.id, { ...m, link: undefined, note: undefined }); }
  private set(m: Machine, patch: Partial<Machine>) {
    Object.assign(m, patch);
    if (m.ssh) this.save(m);
    emit({ type: 'machine', machine: { ...m } });
  }

  private prompted(p: AuthPrompt) {
    emit({ type: 'auth', prompt: p });
    const m = this.list.find(x => x.id === p.machine);
    if (m && m.link !== 'up') this.set(m, { link: 'auth', note: undefined });
  }
  private answered(id: string, machine: string) {
    emit({ type: 'auth.done', id });
    const m = this.list.find(x => x.id === machine);
    if (m && m.link === 'auth' && !this.askpass.list().some(p => p.machine === machine)) this.set(m, { link: this.retry.has(machine) ? 'reconnecting' : 'connecting' });
  }

  /** Connect (or refresh) a machine. `auto` is a background reconnect: it keeps the 'reconnecting' state and
   *  leaves the decision to give up to the retry loop. A person's connect cancels any pending retry. */
  connect(id: string, o: { auto?: boolean } = {}): Promise<Machine> {
    const m = this.get(id);
    if (!m.ssh) { this.set(m, { has: this.localHarnesses(), link: 'up' }); return Promise.resolve(m); }
    const busy = this.inflight.get(id);
    if (busy) return busy;
    if (!o.auto) { this.stopRetry(id); this.askpass.unblock(id); }
    const p = this.attempt(m, !!o.auto).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async attempt(m: Machine, auto: boolean): Promise<Machine> {
    await this.ready;
    const wasUp = m.link === 'up';
    if (!auto) this.set(m, { link: wasUp ? 'reconnecting' : 'connecting', note: undefined });
    const r = await runScript(m, PROBE);
    if (!this.list.includes(m)) return m; // removed meanwhile
    if (r.code !== 0) {
      const cancelled = this.askpass.wasCancelled(m.id);
      const note = cancelled ? 'Sign-in cancelled' : sshFailure(r.stderr, m.ssh!.host);
      if (note === 'Sign-in failed') this.askpass.forget(m.id);
      log('ssh', m.id, 'connect failed', r.code, r.stderr.trim().split('\n').pop());
      if (auto && !cancelled && !/host key/i.test(note)) this.set(m, { note });
      else { this.stopRetry(m.id); this.set(m, { link: 'down', note }); }
      return m;
    }
    const p = parseProbe(r.stdout);
    if (p.persist) await runScript(m, writeConfScript(p.tmux || 0)).catch(() => undefined);
    this.stopRetry(m.id);
    this.set(m, { link: 'up', note: undefined, os: p.os ?? m.os, home: p.home || m.home, has: p.has, persist: p.persist });
    this.watch.watch(m);
    for (const f of [...this.ups]) { try { f(m); } catch (e) { log('ssh', 'onUp', e); } }
    return m;
  }

  /** The link dropped (watcher exited, or an ssh command failed to connect). Only an up machine reacts. */
  lost(id: string) {
    const m = this.list.find(x => x.id === id);
    if (!m?.ssh || m.link !== 'up' || this.inflight.has(id)) return;
    log('ssh', id, 'link lost');
    this.watch.stop(id);
    this.set(m, { link: 'reconnecting', note: undefined });
    this.schedule(m, 0);
  }

  private schedule(m: Machine, attempt: number) {
    this.stopRetry(m.id);
    const link: LinkState = attempt < DOWN_AFTER ? 'reconnecting' : 'down';
    if (m.link !== link && m.link !== 'auth') this.set(m, { link, ...(link === 'down' ? { note: (m.note ? m.note + '. ' : '') + 'Trying again every minute' } : {}) });
    const timer = setTimeout(async () => {
      const r = await this.connect(m.id, { auto: true });
      // a fatal failure or a person's connect clears the entry; otherwise keep trying
      if (r.link !== 'up' && this.retry.get(m.id)?.timer === timer) this.schedule(m, attempt + 1);
    }, backoff(attempt) * 1000);
    this.retry.set(m.id, { timer, attempt });
  }
  private stopRetry(id: string) { const t = this.retry.get(id); if (t) { clearTimeout(t.timer); this.retry.delete(id); } }

  /** Host aliases from ~/.ssh/config (no wildcards) that are not added yet. */
  sshHosts(): string[] {
    let text = '';
    try { text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8'); } catch { return []; }
    const hosts = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*Host\s+(.+)$/i.exec(line);
      if (m) for (const h of m[1].trim().split(/\s+/)) if (!/[*?!]/.test(h)) hosts.add(h);
    }
    const added = new Set(this.list.map(m => m.ssh?.host));
    return [...hosts].filter(h => !added.has(h));
  }
}
