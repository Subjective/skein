// End to end against a real OpenSSH server on 127.0.0.1 (Linux, where sshd can run unprivileged).
// A key with a passphrase and an unknown host key, so the whole sign-in goes through askpass; then remote
// discovery, a link drop with automatic reconnect, and a thread whose tmux session reattaches.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SkeinEvent } from '../../shared/api';
import { discoverRemote } from '../discover';
import { setSink } from '../events';
import { Machines } from '../machines';
import { Ptys, ptyAvailable } from '../pty';
import { Store } from '../store';

const has = (p: string) => existsSync(p);
const runnable = process.platform === 'linux' && has('/usr/sbin/sshd') && has('/usr/bin/ssh-keygen') && has('/usr/bin/ssh');
const freePort = () => new Promise<number>(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const until = async (f: () => boolean, ms = 20000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise(r => setTimeout(r, 50)); if (!f()) throw new Error('timed out'); };

describe.skipIf(!runnable).each([['multiplexed (macOS, Linux)', false], ['one connection per command (Windows)', true]])('ssh end to end, %s', (_name, noMux) => {
  let dir = '', sshd: ChildProcess | null = null, machines: Machines, cfg = '', up = false;
  const events: SkeinEvent[] = [];
  const of = <T extends SkeinEvent['type']>(t: T) => events.filter(e => e.type === t) as Extract<SkeinEvent, { type: T }>[];

  /** Stop the shared connection, as a network drop would: every ssh riding it exits 255. */
  const dropLink = () => noMux
    ? execFileSync('pkill', ['-P', String(sshd!.pid)], { stdio: 'ignore' }) // end every session the server holds
    : execFileSync('ssh', ['-F', cfg, '-o', 'ControlPath=~/.ssh/skein-%C', '-O', 'exit', 'e2e'], { stdio: 'ignore' });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skein-e2e-'));
    chmodSync(dir, 0o755);
    const port = await freePort();
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'open sesame', '-f', join(dir, 'client')]);
    writeFileSync(join(dir, 'authorized_keys'), execFileSync('cat', [join(dir, 'client.pub')]));
    mkdirSync(join(dir, 'bin'));
    // a stand-in harness: says READY, then echoes lines back
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\necho READY\nwhile IFS= read -r l; do echo "got:$l"; done\n', { mode: 0o755 });
    mkdirSync(join(dir, 'claude', 'projects', '-w-app'), { recursive: true });
    writeFileSync(join(dir, 'claude', 'projects', '-w-app', 'c-e2e.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Remote claude thread' }, cwd: '/w/app', sessionId: 'c-e2e' }) + '\n');
    mkdirSync(join(dir, 'codex', 'sessions', '2026', '11', '20'), { recursive: true });
    writeFileSync(join(dir, 'codex', 'sessions', '2026', '11', '20', 'rollout-x.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'x-e2e', cwd: '/w/svc', timestamp: '2026-11-20T00:00:00Z' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Remote codex thread' } }) + '\n');
    writeFileSync(join(dir, 'sshd_config'), [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host')}`, `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
      'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'PermitRootLogin yes',
      `PidFile ${join(dir, 'sshd.pid')}`,
      `SetEnv CLAUDE_CONFIG_DIR=${join(dir, 'claude')} CODEX_HOME=${join(dir, 'codex')} PATH=${join(dir, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
      '',
    ].join('\n'));
    sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' });
    cfg = join(dir, 'ssh_config');
    writeFileSync(cfg, [`Host e2e`, '  HostName 127.0.0.1', `  Port ${port}`, `  User ${userInfo().username}`, `  IdentityFile ${join(dir, 'client')}`,
      '  IdentitiesOnly yes', '  IdentityAgent none', `  UserKnownHostsFile ${join(dir, 'known_hosts')}`, '  StrictHostKeyChecking ask', ''].join('\n'));
    process.env.SKEIN_SSH_CONFIG = cfg;
    if (noMux) process.env.SKEIN_SSH_NO_MUX = '1';
    // a CI image without a usable sshd skips these instead of failing on infrastructure
    const listening = () => new Promise<boolean>(res => { const c = connect(port, '127.0.0.1', () => { c.end(); res(true); }).on('error', () => res(false)); });
    for (let i = 0; i < 40 && !(up = await listening()); i++) await new Promise(r => setTimeout(r, 100));
    if (!up) console.warn('sshd did not start; skipping the ssh end-to-end tests');
    events.length = 0;
    setSink(e => { events.push(e); });
    machines = new Machines(new Store(':memory:'));
  }, 30000);

  afterAll(() => {
    machines?.dispose();
    if (!noMux) try { dropLink(); } catch { /* none */ }
    try { execFileSync('tmux', ['-L', 'skein', 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
    sshd?.kill();
    delete process.env.SKEIN_SSH_CONFIG; delete process.env.SKEIN_SSH_NO_MUX;
    rmSync(dir, { recursive: true, force: true });
  });

  it('signs in through one dialog: new host key, then the key passphrase', async ctx => {
    if (!up) return ctx.skip();
    machines.add('e2e', { host: 'e2e' });
    const done = machines.connect('e2e');
    await until(() => of('auth').length === 1);
    const hk = of('auth')[0].prompt;
    expect(hk).toMatchObject({ machine: 'e2e', kind: 'hostkey' });
    expect(hk.fingerprint).toMatch(/^ED25519 SHA256:/);
    expect(machines.get('e2e').link).toBe('auth');
    machines.answer(hk.id, 'yes');
    await until(() => of('auth').length === 2);
    const pp = of('auth')[1].prompt;
    expect(pp).toMatchObject({ kind: 'passphrase', secret: true });
    machines.answer(pp.id, 'open sesame');
    const m = await done;
    expect(m.link).toBe('up');
    expect(m.os).toBe('Linux');
    expect(m.persist).toBe(existsSync('/usr/bin/tmux') ? 'tmux' : undefined);
    const links = of('machine').map(e => e.machine.link);
    expect(links).toEqual(expect.arrayContaining(['connecting', 'auth', 'up']));
    expect(of('auth.done').length).toBe(2);
  }, 30000);

  it('finds the sessions already on the remote', async ctx => {
    if (!up) return ctx.skip();
    const f = await discoverRemote(machines.get('e2e'));
    expect(f.map(x => [x.harness, x.sessionId, x.title]).sort()).toEqual([['claude', 'c-e2e', 'Remote claude thread'], ['codex', 'x-e2e', 'Remote codex thread']]);
  }, 30000);

  it('reconnects by itself when the link drops, without asking again', async ctx => {
    if (!up) return ctx.skip();
    const before = of('auth').length;
    dropLink();
    await until(() => machines.get('e2e').link === 'reconnecting', 10000);
    await until(() => machines.get('e2e').link === 'up', 20000);
    expect(of('auth').length).toBe(before); // the passphrase was remembered
  }, 40000);

  it.skipIf(!ptyAvailable() || !existsSync('/usr/bin/tmux'))('keeps a thread running across a dropped link and reattaches', async ctx => {
    if (!up) return ctx.skip();
    const ptys = new Ptys(id => machines.get(id), { whenUp: id => machines.whenUp(id) });
    const id = ptys.spawn({ machine: 'e2e', cwd: '~', run: { kind: 'codex' }, cols: 80, rows: 24, thread: 't-e2e' });
    const data = () => of('pty.data').filter(e => e.id === id).map(e => e.data).join('');
    await until(() => data().includes('READY'));
    ptys.write(id, 'one\r');
    await until(() => data().includes('got:one'));
    dropLink();
    await until(() => machines.get('e2e').link !== 'up', 10000);
    await until(() => machines.get('e2e').link === 'up', 20000);
    // reattached to the same program: it still answers, and the view never saw an exit
    await new Promise(r => setTimeout(r, 1500));
    ptys.write(id, 'two\r');
    await until(() => data().includes('got:two'), 10000);
    expect(of('pty.exit').filter(e => e.id === id)).toEqual([]);
    expect(execFileSync('tmux', ['-L', 'skein', 'list-sessions', '-F', '#S']).toString()).toContain('skein-t-e2e');
    // closing the tab on purpose ends the remote session
    ptys.kill(id);
    await until(() => { try { return !execFileSync('tmux', ['-L', 'skein', 'list-sessions', '-F', '#S'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().includes('skein-t-e2e'); } catch { return true; } }, 10000);
  }, 60000);
});
