// Port forwards against a stand-in `ssh` on PATH: it reads `-L 127.0.0.1:<local>:localhost:<port>` and relays
// that port, or fails the way ssh does for an unreachable host. The real ssh is covered by its arguments.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Machine } from '../shared/types';
import { Forwards, forwardArgs } from './forward';

const linux: Machine = { id: 'linux', name: 'linux', os: 'Linux', link: 'up', has: [], ssh: { host: 'devbox', user: 'me', port: 2222 } };
const bad: Machine = { ...linux, id: 'bad', ssh: { host: 'nowhere' } };
const local: Machine = { id: 'local', name: 'This PC', os: 'Linux', link: 'up', has: [] };

describe('forwardArgs', () => {
  it('puts -N -L before the host, on a connection of its own', () => {
    const a = forwardArgs(linux, 41000, 5173);
    expect(a[a.length - 1]).toBe('me@devbox');
    expect(a.slice(-6, -1)).toEqual(['-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:41000:localhost:5173']);
    expect(a).toContain('ControlPath=none');
    expect(a.join(' ')).toContain('-p 2222');
  });
});

describe.skipIf(process.platform === 'win32')('Forwards', () => {
  let dir = '', web: Server, webPort = 0, path0 = process.env.PATH;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skein-fwd-'));
    writeFileSync(join(dir, 'ssh'), `#!/usr/bin/env node
const net = require('net');
const a = process.argv.slice(2);
if (a[a.length - 1] === 'nowhere') { process.stderr.write('ssh: Could not resolve hostname nowhere: Name or service not known\\n'); process.exit(255); }
const [, lp, , rp] = a[a.indexOf('-L') + 1].split(':');
net.createServer(c => { const r = net.connect(+rp, '127.0.0.1'); c.pipe(r).pipe(c); r.on('error', () => c.destroy()); c.on('error', () => r.destroy()); })
  .listen(+lp, '127.0.0.1');
`);
    chmodSync(join(dir, 'ssh'), 0o755);
    process.env.PATH = dir + delimiter + path0;
    web = createServer((_q, r) => r.end('hello from the remote'));
    await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
    webPort = (web.address() as { port: number }).port;
  });
  afterAll(() => { process.env.PATH = path0; web?.close(); rmSync(dir, { recursive: true, force: true }); });

  it('forwards a port, and reuses the forward', async () => {
    const f = new Forwards(id => (id === 'linux' ? linux : local));
    const lp = await f.forward('linux', webPort);
    expect(lp).not.toBe(webPort);
    expect(await (await fetch(`http://127.0.0.1:${lp}/`)).text()).toBe('hello from the remote');
    expect(await f.forward('linux', webPort)).toBe(lp);
    f.dispose();
  });

  it('leaves a local machine alone', async () => {
    const f = new Forwards(() => local);
    expect(await f.forward('local', 5173)).toBe(5173);
  });

  it('says why it failed, and tries again after a failure', async () => {
    const f = new Forwards(() => bad);
    await expect(f.forward('bad', 5173)).rejects.toThrow("Can't find nowhere");
    await expect(f.forward('bad', 5173)).rejects.toThrow("Can't find nowhere");
    await expect(f.forward('bad', 0)).rejects.toThrow('Not a port');
  });
});
