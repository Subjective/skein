import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthPrompt, Machine } from '../../shared/types';
import { parseRemoteDiscovery, remoteDiscoverScript } from '../discover';
import { sshBase, sshFailure } from '../exec';
import { parseProbe } from '../machines';
import { plan } from '../pty';
import { Askpass, classify } from './askpass';
import { backoff, BACKOFF, DOWN_AFTER } from './link';
import { killLine, sessionName, tmuxConf, tmuxVersion, wrap } from './persist';

const M: Machine = { id: 'dev', name: 'dev', ssh: { host: 'devbox', user: 'me', port: 2222 }, link: 'up', has: [] };

describe('ssh options', () => {
  it('multiplexes on macOS and Linux', () => {
    const a = sshBase(M, { platform: 'darwin' });
    expect(a.join(' ')).toContain('ControlMaster=auto');
    expect(a.join(' ')).toContain('ControlPersist=10m');
    expect(a).toContain('-T');
    expect(a.slice(-1)[0]).toBe('me@devbox');
    expect(a.join(' ')).toContain('-p 2222');
  });
  it('switches multiplexing off on Windows, even if the user config turns it on', () => {
    const a = sshBase(M, { platform: 'win32', tty: true }).join(' ');
    expect(a).toContain('ControlMaster=no');
    expect(a).toContain('ControlPath=none');
    expect(a).not.toContain('ControlPersist');
    expect(a).toContain('-tt');
  });
  it('detects a dead link within about 30 seconds', () => {
    const a = sshBase(M).join(' ');
    expect(a).toContain('ServerAliveInterval=10');
    expect(a).toContain('ServerAliveCountMax=3');
    expect(a).toContain('ConnectTimeout=15');
  });
  it('says why a connection failed in plain words', () => {
    expect(sshFailure('ssh: Could not resolve hostname devbox: nodename nor servname provided', 'devbox')).toBe("Can't find devbox");
    expect(sshFailure('ssh: connect to host devbox port 22: Connection refused', 'devbox')).toBe('devbox refused the connection');
    expect(sshFailure('ssh: connect to host devbox port 22: Operation timed out', 'devbox')).toBe('No answer from devbox');
    expect(sshFailure('me@devbox: Permission denied (publickey).', 'devbox')).toBe('Sign-in failed');
    expect(sshFailure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'devbox')).toMatch(/host key for devbox changed/);
    expect(sshFailure('ENOENT: ssh not found', 'devbox', 'win32')).toMatch(/OpenSSH Client/);
  });
});

describe('askpass prompts', () => {
  it('tells the kinds apart', () => {
    expect(classify("Enter passphrase for key '/Users/j/.ssh/id_ed25519': ")).toMatchObject({ kind: 'passphrase', secret: true });
    expect(classify("me@devbox's password: ")).toMatchObject({ kind: 'password', secret: true });
    expect(classify('Verification code: ')).toMatchObject({ kind: 'code', secret: false });
    expect(classify('(me@devbox) Duo two-factor login. Passcode or option (1-3): ')).toMatchObject({ kind: 'code' });
    const hk = classify("The authenticity of host 'devbox (10.0.0.5)' can't be established.\nED25519 key fingerprint is SHA256:abcDEF123.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ", 'confirm');
    expect(hk).toMatchObject({ kind: 'hostkey', secret: false, host: 'devbox (10.0.0.5)', fingerprint: 'ED25519 SHA256:abcDEF123' });
    expect(classify("The authenticity of host 'h' can't be established.\nED25519 key fingerprint is: SHA256:x/Y+z1.\nAre you sure?", 'confirm').fingerprint).toBe('ED25519 SHA256:x/Y+z1');
    expect(classify('Allow use of key id_ed25519?', 'confirm')).toMatchObject({ kind: 'other', secret: false });
  });
});

/** Run the helper script the way ssh would, with the environment Askpass hands out. */
function helper(a: Askpass, machine: string, prompt: string, conn?: string): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...a.env(machine), ...(conn ? { SKEIN_CONN: conn } : {}) };
  const p = process.platform === 'win32'
    ? spawn(env.SSH_ASKPASS!, [JSON.stringify(prompt)], { env, shell: true, windowsHide: true })
    : spawn(env.SSH_ASKPASS!, [prompt], { env });
  let out = '';
  p.stdout.on('data', d => (out += d));
  return new Promise(res => p.on('close', code => res({ code, out })));
}

describe('askpass server', () => {
  let a: Askpass | null = null;
  afterEach(() => { a?.stop(); a = null; });
  const make = () => {
    const prompts: AuthPrompt[] = []; const done: string[] = [];
    a = new Askpass({ prompt: p => prompts.push(p), done: id => done.push(id) });
    return { a, prompts, done };
  };
  const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 25)); expect(f()).toBe(true); };

  it('relays a prompt and prints the answer for ssh', async () => {
    const { a, prompts, done } = make(); await a.start();
    const r = helper(a, 'dev', "Enter passphrase for key '/home/me/.ssh/id_ed25519': ");
    await until(() => prompts.length === 1);
    expect(prompts[0]).toMatchObject({ machine: 'dev', kind: 'passphrase', secret: true });
    a.answer(prompts[0].id, 'hunter2');
    expect(await r).toEqual({ code: 0, out: 'hunter2\n' });
    expect(done).toEqual([prompts[0].id]);
  });

  it('remembers a passphrase for later connections, but asks again if it was wrong', async () => {
    const { a, prompts } = make(); await a.start();
    const text = "Enter passphrase for key '/k': ";
    const first = helper(a, 'dev', text, 'c1');
    await until(() => prompts.length === 1);
    a.answer(prompts[0].id, 'pw');
    await first;
    // a new connection gets it without a dialog
    expect(await helper(a, 'dev', text, 'c2')).toEqual({ code: 0, out: 'pw\n' });
    expect(prompts.length).toBe(1);
    // the same connection asking again means it was wrong: ask the person
    const again = helper(a, 'dev', text, 'c2');
    await until(() => prompts.length === 2);
    a.answer(prompts[1].id, 'right');
    expect((await again).out).toBe('right\n');
  });

  it('shares one dialog between connections asking the same thing at once', async () => {
    const { a, prompts } = make(); await a.start();
    const x = helper(a, 'dev', 'Verification code: ', 'c1');
    const y = helper(a, 'dev', 'Verification code: ', 'c2');
    await until(() => prompts.length === 1);
    await new Promise(r => setTimeout(r, 200));
    expect(prompts.length).toBe(1);
    a.answer(prompts[0].id, '123456');
    expect((await x).out).toBe('123456\n');
    expect((await y).out).toBe('123456\n');
  });

  it('cancel fails the prompt and refuses more for that machine until the person connects again', async () => {
    const { a, prompts } = make(); await a.start();
    const r = helper(a, 'dev', "me@dev's password: ");
    await until(() => prompts.length === 1);
    a.answer(prompts[0].id, null);
    expect((await r).code).not.toBe(0);
    expect(a.wasCancelled('dev')).toBe(true);
    expect((await helper(a, 'dev', "me@dev's password: ")).code).not.toBe(0);
    expect(prompts.length).toBe(1);
    a.unblock('dev');
    const r2 = helper(a, 'dev', "me@dev's password: ");
    await until(() => prompts.length === 2);
    a.answer(prompts[1].id, 'ok');
    expect((await r2).code).toBe(0);
  });

  it('closes the dialog when ssh stops waiting', async () => {
    const { a, prompts, done } = make(); await a.start();
    const env: NodeJS.ProcessEnv = { ...process.env, ...a.env('dev') };
    const p = process.platform === 'win32' ? spawn(env.SSH_ASKPASS!, ['"Password: "'], { env, shell: true }) : spawn(env.SSH_ASKPASS!, ['Password: '], { env });
    await until(() => prompts.length === 1);
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']); else p.kill();
    await until(() => done.length === 1);
    expect(a.list()).toEqual([]);
  });

  it('answers even when the answer comes back synchronously', async () => {
    let a2: Askpass;
    a2 = new Askpass({ prompt: p => a2.answer(p.id, 'now'), done: () => {} });
    a = a2; await a2.start();
    expect(await helper(a2, 'dev', 'Password: ')).toEqual({ code: 0, out: 'now\n' });
  });

  it('refuses a caller without the token', async () => {
    const { a, prompts } = make(); await a.start();
    const env: NodeJS.ProcessEnv = { ...process.env, ...a.env('dev'), SKEIN_ASKPASS_TOKEN: 'nope' };
    const p = process.platform === 'win32' ? spawn(env.SSH_ASKPASS!, ['x'], { env, shell: true }) : spawn(env.SSH_ASKPASS!, ['x'], { env });
    const code = await new Promise(r => p.on('close', r));
    expect(code).not.toBe(0);
    expect(prompts.length).toBe(0);
  });
});

describe('connect probe', () => {
  it('reads OS, home, harnesses and what keeps sessions alive, ignoring a chatty profile', () => {
    const p = parseProbe('Welcome to devbox!\nskein:os:Linux\nskein:home:/home/me\nskein:has:claude\nskein:tmux:tmux 3.4\nskein:screen\n');
    expect(p).toEqual({ os: 'Linux', home: '/home/me', has: ['claude'], persist: 'tmux', tmux: 3.4 });
    expect(parseProbe('skein:os:Darwin\nskein:screen\n')).toMatchObject({ os: 'macOS', persist: 'screen', has: [] });
  });
});

describe('persistent sessions', () => {
  it('writes a tmux config that stays out of the way', () => {
    expect(tmuxVersion('tmux 3.3a')).toBeCloseTo(3.3);
    const c = tmuxConf(3.4);
    expect(c).toContain('set -g status off');
    expect(c).toContain('set -g prefix None');
    expect(c).toContain('unbind-key -a');
    expect(c).toContain('smcup@:rmcup@');
    expect(c).toContain('allow-passthrough on');
    expect(tmuxConf(2.9)).not.toContain('allow-passthrough');
    expect(tmuxConf(2.9)).not.toContain('prefix None');
  });
  it('wraps a thread in a session that reattaches', () => {
    expect(sessionName('t-1a2b/3')).toBe('skein-t-1a2b-3');
    expect(wrap('exec claude', 't-1', 'tmux')).toBe("exec tmux -L skein -f ~/.skein/tmux.conf new-session -A -s skein-t-1 'exec claude'");
    expect(wrap('exec codex', 't-1', 'screen')).toContain('screen -U -D -RR -S skein-t-1');
    expect(killLine('t-1', 'tmux')).toContain('kill-session -t =skein-t-1');
  });
  it('runs a remote harness thread inside it, and a plain shell without it', () => {
    const m: Machine = { ...M, persist: 'tmux' };
    const t = plan(m, { machine: 'dev', cwd: '~/repo', run: { kind: 'codex' }, cols: 80, rows: 24, thread: 't-9' });
    expect(t.kept).toBe(true);
    expect(t.args.at(-1)).toContain('new-session -A -s skein-t-9');
    const s = plan(m, { machine: 'dev', cwd: '~', run: { kind: 'shell' }, cols: 80, rows: 24, thread: 't-9' });
    expect(s.kept).toBe(false);
    const none = plan({ ...M }, { machine: 'dev', cwd: '~', run: { kind: 'codex' }, cols: 80, rows: 24, thread: 't-9' });
    expect(none.kept).toBe(false);
  });
});

describe('remote discovery', () => {
  it('parses framed transcript heads from both harnesses', () => {
    const claude = [{ type: 'user', message: { content: 'Fix the flaky test' }, cwd: '/home/me/app', sessionId: 'c-1', timestamp: '2026-01-01T00:00:00Z' }].map(o => JSON.stringify(o)).join('\n');
    const codex = [{ type: 'session_meta', payload: { id: 'x-1', cwd: '/home/me/svc', timestamp: '2026-01-02T00:00:00Z' } }, { type: 'event_msg', payload: { type: 'user_message', message: 'Speed up the build' } }].map(o => JSON.stringify(o)).join('\n');
    const out = `\x1eclaude\t1767225600\t/home/me/.claude/projects/-home-me-app/c-1.jsonl\n${claude}\n{"type":"user","trunc\n\x1ecodex\t1767312000\t/home/me/.codex/sessions/2026/01/02/rollout-x.jsonl\n${codex}\n\x1ecodex\t1\t/bad.jsonl\nnot json\n`;
    const f = parseRemoteDiscovery(out);
    expect(f.map(x => [x.harness, x.sessionId, x.dir, x.title])).toEqual([
      ['codex', 'x-1', '/home/me/svc', 'Speed up the build'],
      ['claude', 'c-1', '/home/me/app', 'Fix the flaky test'],
    ]);
    expect(f[0].updatedAt).toBe(1767312000_000);
  });
  it('the script is plain sh with no single quotes, so any login shell passes it through', () => {
    const s = remoteDiscoverScript(10);
    expect(s).not.toContain("'");
    expect(s).toContain('head -n 10');
  });
});

describe('reconnect backoff', () => {
  it('backs off, turns red after about two minutes, then retries every minute', () => {
    expect(backoff(0)).toBe(1);
    expect(BACKOFF.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(100);
    expect(backoff(DOWN_AFTER)).toBe(60);
    expect(backoff(50)).toBe(60);
  });
});
