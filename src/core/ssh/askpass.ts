// SSH prompts in one dialog (G5). Every `ssh` Skein starts gets SSH_ASKPASS pointing at a tiny helper, with
// SSH_ASKPASS_REQUIRE=force, so passphrase, password, verification code and new-host-key questions come here
// instead of a terminal. The helper connects back over a local socket (a named pipe on Windows), waits for the
// answer and prints it for ssh.
//
// Answers to passphrase and password prompts are kept in memory for this app session, so later connections
// (each one on Windows, which has no ControlMaster) don't ask again. A cached answer that gets asked for again
// by the same connection was wrong, so it is dropped and the person is asked. Nothing is written to disk.
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthPrompt } from '../../shared/types';

export interface AskpassHooks {
  prompt(p: AuthPrompt): void;
  /** The prompt was answered, cancelled, or ssh stopped waiting for it. */
  done(id: string, machine: string): void;
}

interface Ask { token: string; machine: string; conn: string; prompt: string; type: string }

/** What kind of question ssh is asking, from its prompt text. Pure, for tests. */
export function classify(text: string, type = ''): Pick<AuthPrompt, 'kind' | 'secret' | 'host' | 'fingerprint'> {
  if (/authenticity of host|continue connecting|known_hosts/i.test(text)) {
    const host = /authenticity of host '([^']+)'/i.exec(text)?.[1];
    // "ED25519 key fingerprint is SHA256:..." (OpenSSH 10 adds a colon after "is")
    const fp = /\b((?:SHA256|MD5):[^\s.]+(?:\.[^\s.]+)*)/.exec(text)?.[1];
    const alg = /^\s*(\S+) key fingerprint is/im.exec(text)?.[1];
    return { kind: 'hostkey', secret: false, host, fingerprint: fp ? (alg ? `${alg} ${fp}` : fp) : undefined };
  }
  if (type === 'confirm') return { kind: 'other', secret: false };
  if (/passphrase/i.test(text)) return { kind: 'passphrase', secret: true };
  if (/password/i.test(text)) return { kind: 'password', secret: true };
  if (/verification|one[- ]time|\bcode\b|\botp\b|token|passcode|duo/i.test(text)) return { kind: 'code', secret: false };
  return { kind: 'other', secret: true };
}

const HELPER_JS = `// Skein askpass helper: relays an ssh prompt to the Skein window and prints the answer.
const net = require('net');
const e = process.env;
const c = net.connect(e.SKEIN_ASKPASS_SOCK, () => c.write(JSON.stringify({ token: e.SKEIN_ASKPASS_TOKEN, machine: e.SKEIN_MACHINE, conn: e.SKEIN_CONN, prompt: process.argv.slice(2).join(' '), type: e.SSH_ASKPASS_PROMPT || '' }) + '\\n'));
let buf = '';
c.on('data', d => {
  buf += d; const i = buf.indexOf('\\n'); if (i < 0) return;
  let r; try { r = JSON.parse(buf.slice(0, i)); } catch { process.exit(1); }
  if (r.ok) process.stdout.write(r.value + '\\n', () => process.exit(0)); else process.exit(1);
});
c.on('error', () => process.exit(1));
c.on('close', () => process.exit(1));
`;

interface Pending { prompt: AuthPrompt; key: string; waiters: Set<Socket> }

export class Askpass {
  private server: Server | null = null;
  private sock = '';
  private token = randomBytes(16).toString('hex');
  private dir = '';
  private helper = '';
  private pending = new Map<string, Pending>();
  private cache = new Map<string, string>();
  /** cache keys each connection has been given, to spot a wrong cached answer */
  private given = new Map<string, Set<string>>();
  /** machines whose sign-in the person cancelled: further prompts are refused until they connect again */
  private blocked = new Set<string>();
  private cancelled = new Set<string>();

  constructor(private hooks: AskpassHooks, private node = process.execPath) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.dir = join(tmpdir(), `skein-${process.getuid?.() ?? 'u'}-${process.pid}`);
    mkdirSync(this.dir, { recursive: true });
    const js = join(this.dir, 'askpass.js');
    writeFileSync(js, HELPER_JS);
    if (process.platform === 'win32') {
      // ssh.exe starts this with CreateProcess, which runs .cmd files through cmd.exe
      this.helper = join(this.dir, 'askpass.cmd');
      writeFileSync(this.helper, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${this.node}" "${js}" %*\r\n`);
      this.sock = `\\\\.\\pipe\\skein-askpass-${process.pid}-${randomBytes(4).toString('hex')}`;
    } else {
      this.helper = join(this.dir, 'askpass.sh');
      writeFileSync(this.helper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${this.node.replace(/'/g, `'\\''`)}' '${js.replace(/'/g, `'\\''`)}' "$@"\n`);
      chmodSync(this.helper, 0o755);
      this.sock = join(this.dir, 'askpass.sock');
      rmSync(this.sock, { force: true });
    }
    this.server = createServer(s => this.accept(s));
    await new Promise<void>((res, rej) => { this.server!.once('error', rej); this.server!.listen(this.sock, () => res()); });
  }

  stop() {
    for (const p of this.pending.values()) for (const w of p.waiters) w.destroy();
    this.pending.clear();
    this.server?.close(); this.server = null;
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* in use */ }
  }

  /** Environment for an ssh process on `machine`. Each call is a new connection id. */
  env(machine: string): Record<string, string> {
    if (!this.server) return {};
    return {
      SSH_ASKPASS: this.helper, SSH_ASKPASS_REQUIRE: 'force',
      // OpenSSH before 8.4 (Windows 10 ships 8.1) only uses askpass when DISPLAY is set and there is no terminal
      DISPLAY: process.env.DISPLAY || ':0',
      SKEIN_ASKPASS_SOCK: this.sock, SKEIN_ASKPASS_TOKEN: this.token, SKEIN_MACHINE: machine, SKEIN_CONN: randomUUID(),
    };
  }

  /** The person's answer; null cancels (and refuses further prompts for that machine until unblock). */
  answer(id: string, value: string | null) {
    const p = this.pending.get(id);
    if (!p) return;
    if (value === null) { this.blocked.add(p.prompt.machine); this.cancelled.add(p.prompt.machine); }
    else if (p.prompt.kind === 'passphrase' || p.prompt.kind === 'password') this.cache.set(p.key, value);
    this.finish(p, value);
  }

  /** The person asked to connect: prompts may show again. */
  unblock(machine: string) { this.blocked.delete(machine); this.cancelled.delete(machine); }
  /** Did the person cancel a sign-in for this machine since the last unblock? */
  wasCancelled(machine: string) { return this.cancelled.has(machine); }
  /** Drop remembered secrets (after a failed sign-in, or when the machine is removed). */
  forget(machine: string) { for (const k of [...this.cache.keys()]) if (k.startsWith(machine + '\n')) this.cache.delete(k); }
  /** Cancel what is waiting for this machine. */
  cancelAll(machine: string) { for (const p of [...this.pending.values()]) if (p.prompt.machine === machine) this.finish(p, null); }
  list(): AuthPrompt[] { return [...this.pending.values()].map(p => p.prompt); }

  private finish(p: Pending, value: string | null) {
    this.pending.delete(p.prompt.id);
    const reply = JSON.stringify(value === null ? { ok: false } : { ok: true, value }) + '\n';
    for (const w of p.waiters) { w.end(reply); }
    this.hooks.done(p.prompt.id, p.prompt.machine);
  }

  private accept(s: Socket) {
    let buf = '';
    s.setEncoding('utf8');
    s.on('error', () => {});
    s.on('data', d => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) { if (buf.length > 65536) s.destroy(); return; }
      let a: Ask;
      try { a = JSON.parse(buf.slice(0, i)); } catch { s.destroy(); return; }
      s.removeAllListeners('data');
      this.ask(a, s);
    });
  }

  private ask(a: Ask, s: Socket) {
    if (a.token !== this.token || !a.machine) { s.end(JSON.stringify({ ok: false }) + '\n'); return; }
    const text = a.prompt.trim();
    const key = `${a.machine}\n${text}`;
    if (this.blocked.has(a.machine)) { s.end(JSON.stringify({ ok: false }) + '\n'); return; }
    const c = classify(text, a.type);
    // a remembered secret, unless this same connection already got it (then it was wrong)
    const seen = this.given.get(a.conn) ?? new Set<string>();
    const cached = this.cache.get(key);
    if (cached !== undefined && !seen.has(key)) {
      seen.add(key); this.given.set(a.conn, seen);
      if (this.given.size > 500) this.given.delete(this.given.keys().next().value!);
      s.end(JSON.stringify({ ok: true, value: cached }) + '\n');
      return;
    }
    if (cached !== undefined) this.cache.delete(key);
    seen.add(key); this.given.set(a.conn, seen);
    // several connections asking the same thing at once share one dialog
    const known = [...this.pending.values()].find(x => x.key === key);
    const pend: Pending = known ?? { key, waiters: new Set(), prompt: { machine: a.machine, id: 'ap-' + randomBytes(6).toString('hex'), text, ...c } };
    pend.waiters.add(s);
    // ssh gave up (timeout, killed): when nobody waits any more the dialog goes away
    s.on('close', () => {
      pend.waiters.delete(s);
      if (!pend.waiters.size && this.pending.get(pend.prompt.id) === pend) { this.pending.delete(pend.prompt.id); this.hooks.done(pend.prompt.id, pend.prompt.machine); }
    });
    if (!known) { this.pending.set(pend.prompt.id, pend); this.hooks.prompt(pend.prompt); }
  }
}
