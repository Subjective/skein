// The machines Skein knows: this computer, plus SSH hosts the user added.
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { Harness, Machine, SshTarget } from '../shared/types';
import { emit } from './events';
import { run } from './exec';
import { which } from './shell';
import type { Store } from './store';

const localName = () => (process.platform === 'darwin' ? 'This Mac' : process.platform === 'win32' ? 'This PC' : hostname());
const localOs = () => (process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux');

export class Machines {
  private list: Machine[] = [];
  constructor(private store: Store) {
    const local: Machine = { id: 'local', name: localName(), os: localOs(), home: homedir(), link: 'up', has: this.localHarnesses() };
    this.list = [local, ...store.rows<Machine>('machines').map(m => ({ ...m, link: 'down' as const }))];
  }
  all() { return this.list; }
  get(id: string): Machine {
    const m = this.list.find(x => x.id === id);
    if (!m) throw new Error(`Unknown machine ${id}`);
    return m;
  }
  localHarnesses(): Harness[] { return (['claude', 'codex'] as Harness[]).filter(h => which(h)); }

  add(name: string, ssh: SshTarget): Machine {
    const id = (name || ssh.host).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const m: Machine = { id, name: name || ssh.host, ssh, link: 'down', has: [] };
    this.list = [...this.list.filter(x => x.id !== id), m];
    this.store.put('machines', id, { ...m, link: undefined });
    emit({ type: 'machine', machine: m });
    return m;
  }
  remove(id: string) { if (id === 'local') return; this.list = this.list.filter(x => x.id !== id); this.store.del('machines', id); }

  private set(m: Machine, patch: Partial<Machine>) {
    Object.assign(m, patch);
    if (m.ssh) this.store.put('machines', m.id, { ...m, link: undefined });
    emit({ type: 'machine', machine: { ...m } });
  }

  /** Probe the machine: OS, home and harness CLIs. Uses BatchMode, so a key that needs a passphrase shows as 'auth'. */
  async connect(id: string): Promise<Machine> {
    const m = this.get(id);
    if (!m.ssh) { this.set(m, { has: this.localHarnesses(), link: 'up' }); return m; }
    this.set(m, { link: m.link === 'up' ? 'reconnecting' : 'connecting', note: undefined });
    const r = await run(m, 'uname -s; echo "$HOME"; command -v claude >/dev/null && echo has:claude; command -v codex >/dev/null && echo has:codex; true', { timeout: 20000 });
    if (r.code !== 0) {
      const needsYou = /Permission denied|passphrase|Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(r.stderr);
      this.set(m, { link: needsYou ? 'auth' : 'down', note: r.stderr.trim().split('\n').pop() || 'Could not connect' });
      return m;
    }
    const lines = r.stdout.trim().split('\n');
    const os = /Darwin/.test(lines[0]) ? 'macOS' : /Linux/.test(lines[0]) ? 'Linux' : lines[0];
    this.set(m, { link: 'up', os, home: lines[1], has: lines.filter(l => l.startsWith('has:')).map(l => l.slice(4) as Harness) });
    return m;
  }

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
