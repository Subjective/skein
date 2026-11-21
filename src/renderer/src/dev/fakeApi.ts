// A stand-in for the main process, for looking at and testing the UI in a plain browser (`pnpm dev:web`).
// Data is a small sample; terminals echo what you type.
import type { SkeinBridge, SkeinEvent } from '@shared/api';
import type { Machine, Settings, ThreadMeta } from '@shared/types';
import { moveBlocked } from '@shared/move';
import { fakeFs, fakeGit } from './fakeRepo';
import { extraThreads, fakeChat } from './fakeChat';
import { fakeCommands, fakeOptions } from './fakeOptions';
import { bundledCommands } from '@shared/commands';
import { bundledOptions } from '@shared/models';

const listeners = new Set<(e: SkeinEvent) => void>();
const emit = (e: SkeinEvent) => setTimeout(() => listeners.forEach(f => f(e)), 0);
const now = Date.now(), min = 60_000;
const machines: Machine[] = [
  { id: 'local', name: 'This PC', os: 'Windows', link: 'up', has: ['claude', 'codex'], home: 'C:\\Users\\you' },
  { id: 'linux', name: 'linux', os: 'Linux', link: 'up', has: ['claude', 'codex'], ssh: { host: 'linux-dev' }, home: '/home/you' },
  { id: 'build', name: 'build-07', os: 'Linux', link: 'down', has: ['codex'], ssh: { host: 'build-07' }, note: 'Connection timed out' },
];
const T = (id: string, harness: 'claude' | 'codex', machine: string, dir: string, title: string, ageMin: number, x: Partial<ThreadMeta> = {}): ThreadMeta =>
  ({ id, harness, machine, dir, title, sessionId: id + '-session', createdAt: now - ageMin * min - 3600_000, updatedAt: now - ageMin * min, status: 'idle', drive: harness === 'claude' ? 'chat' : undefined, ...x });
const threads: ThreadMeta[] = [
  T('t1', 'claude', 'local', '~/projects/skein', 'Fix session-restore race', 0, { status: 'running' }),
  T('t2', 'claude', 'local', '~/projects/skein', 'Plan image paste over SSH', 5, { status: 'wait', pinned: true }),
  T('t3', 'codex', 'local', '~/projects/skein', 'Add timestamps to chat rows', 1440),
  T('t4', 'claude', 'local', '~/projects/dotfiles', 'Tidy PowerShell profile', 5760),
  T('t5', 'codex', 'linux', '~/repo/trade-ticker', 'Refactor queue worker', 2, { status: 'running' }),
  T('t6', 'codex', 'linux', '~/repo/trade-ticker', 'Profile slow orders query', 14),
  T('t7', 'claude', 'linux', '~/repo/etl-config', 'Migrate ETL config to TOML', 30, { status: 'unread' }),
  T('t8', 'codex', 'build', '~/ci', 'Bump lockfile to fix CI', 300, { status: 'error' }),
];
threads.push(...extraThreads(T));
Object.assign(threads[0], { model: 'opus', effort: 'medium', perm: 'acceptEdits', ctx: 38, branch: 'fix/restore-race' });
Object.assign(threads[6], { drive: 'term' });
const chat = fakeChat(emit, threads);
let settings: Settings = { theme: 'dark', vim: true, leader: 'ctrl-space', sideView: 'grouped', defaultView: 'chat', notify: 'waiting', vimrc: '" Skein vimrc\n\ninoremap jk <Esc>\n' };
const kv = new Map<string, unknown>();
let ptyN = 0;
const lines = new Map<string, string>();
// the shell's last command and the spec it runs under, so `claude` / `codex` typed in a shell is adopted (pty.adopt)
const ran = new Map<string, { cmd: string; machine: string; cwd: string; thread?: string }>();
/** Which thread each fake terminal runs. */
const termOf = new Map<string, string>();

// SSH scenes (G5), chosen with ?ssh= in the URL so other UI tests see no dialogs:
//   auth: connecting build-07 asks for a key passphrase   code: a verification code   hostkey: a new host key
//   drop: linux drops its link after a second and reconnects   (no flag: build-07 stays down)
const sshScene = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('ssh') : null;
const setM = (m: Machine, p: Partial<Machine>) => { Object.assign(m, p); emit({ type: 'machine', machine: { ...m } }); };
const waiting = new Map<string, Machine>();
async function fakeConnect(id: string): Promise<Machine> {
  const m = machines.find(x => x.id === id)!;
  if (!m.ssh) return m;
  if (m.link === 'up') {
    if (sshScene === 'drop' && id === 'linux') setTimeout(() => { setM(m, { link: 'reconnecting', persist: 'tmux' }); setTimeout(() => setM(m, { link: 'up' }), 3000); }, 1000);
    return m;
  }
  setM(m, { link: 'connecting', note: undefined });
  const kind = sshScene === 'auth' ? 'passphrase' : sshScene === 'code' ? 'code' : sshScene === 'hostkey' ? 'hostkey' : null;
  setTimeout(() => {
    if (!kind) { setM(m, { link: 'down', note: 'Connection timed out' }); return; }
    const pid = 'ap-' + Math.random().toString(36).slice(2, 8);
    waiting.set(pid, m);
    setM(m, { link: 'auth' });
    emit({ type: 'auth', prompt: kind === 'hostkey'
      ? { machine: id, id: pid, kind, secret: false, host: m.ssh!.host, fingerprint: 'ED25519 SHA256:9vVq3b+Kd2h0Lr7XcP1mN8tYw4sQe6uJ5aZ0fG2iH1o', text: `The authenticity of host '${m.ssh!.host}' can't be established.` }
      : kind === 'code' ? { machine: id, id: pid, kind, secret: false, text: 'Verification code: ' }
      : { machine: id, id: pid, kind, secret: true, text: "Enter passphrase for key '/home/you/.ssh/id_ed25519': " } });
  }, 400);
  return m;
}
async function fakeAnswer(pid: string, v: string | null) {
  const m = waiting.get(pid); if (!m) return;
  waiting.delete(pid);
  emit({ type: 'auth.done', id: pid });
  if (v === null) { setM(m, { link: 'down', note: 'Sign-in cancelled' }); return; }
  setM(m, { link: 'connecting' });
  setTimeout(() => setM(m, { link: 'up', note: undefined, persist: 'tmux' }), 600);
}

export const fakeApi: SkeinBridge = {
  on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  setTheme: () => {},
  app: {
    info: async () => ({ platform: /Mac/.test(navigator.platform) ? 'mac' : 'win', version: 'dev', home: '~', pty: true }),
    load: async k => kv.get(k), save: async (k, v) => { kv.set(k, v); },
    settings: async () => settings, setSettings: async p => (settings = { ...settings, ...p }),
    reveal: async p => { (window as unknown as { __revealed?: string[] }).__revealed = [...((window as unknown as { __revealed?: string[] }).__revealed || []), p]; },
    openExternal: async url => { (window as unknown as { __external?: string[] }).__external = [...((window as unknown as { __external?: string[] }).__external || []), url]; }, notify: async () => {},
  },
  machines: {
    list: async () => machines, add: async (name, ssh) => { const m: Machine = { id: name, name, ssh, link: 'down', has: [] }; machines.push(m); return m; },
    remove: async () => {}, connect: async id => fakeConnect(id), answer: async (id, v) => fakeAnswer(id, v), sshHosts: async () => ['devbox', 'gpu-01'],
  },
  fs: {
    list: async (_m, dir) => fakeFs.owns(dir) ? fakeFs.list(dir) : (dir.split(/[\\/]/).length > 4 ? [] : ['projects', 'repo', 'scratch', '.config', 'notes.md'].map(n => ({ name: n, dir: !n.includes('.') || n === '.config', hidden: n.startsWith('.') }))),
    read: async (_m, p) => (fakeFs.owns(p) ? fakeFs.read(p) : ''), write: async (_m, p, t) => { if (fakeFs.owns(p)) await fakeFs.write(p, t); }, resolve: async (_m, p) => p,
    find: async (_m, dir) => (fakeFs.owns(dir) ? fakeFs.files() : ['README.md', 'package.json', 'src/main/index.ts', 'src/core/pty.ts', 'src/core/files.ts', 'src/renderer/src/shell/App.tsx', 'src/renderer/src/shell/overlays.tsx', 'docs/VIM-MODEL.md']),
  },
  threads: {
    list: async () => threads, discover: async () => [],
    create: async spec => {
      const t = T('n' + Date.now(), spec.harness, spec.machine, spec.dir, spec.side ? 'New side chat' : 'New thread', 0, { parent: spec.parent, side: spec.side, model: spec.model, effort: spec.effort, perm: spec.perm });
      threads.unshift(t); chat.fork(spec, t); return t;
    },
    update: async (id, patch) => { const t = threads.find(x => x.id === id)!; Object.assign(t, patch); emit({ type: 'thread', thread: t }); return t; },
    history: async id => chat.history(id),
    // a subagent's turns are all in its event here
    sub: async () => [],
    // moving copies nothing here: the record follows after a short wait, or the reason it can't comes back
    move: async (id, machine, dir) => {
      const t = threads.find(x => x.id === id)!, m = machines.find(x => x.id === machine)!;
      const why = moveBlocked(t, m, dir);
      await new Promise(r => setTimeout(r, 250));
      if (why) throw new Error(why);
      Object.assign(t, { machine, dir, status: 'idle', updatedAt: Date.now() });
      emit({ type: 'thread', thread: { ...t } });
      return { ...t };
    },
  },
  // Claude Code's one writer (core/handoff): chat's first send closes the thread's parked terminal, which resumes later
  chat: {
    send: async (id, msg) => {
      const t = threads.find(x => x.id === id);
      if (t?.harness === 'claude') for (const [pid, th] of termOf) if (th === id) { termOf.delete(pid); emit({ type: 'pty.exit', id: pid, code: null, handoff: true }); }
      return chat.send(id, msg);
    },
    interrupt: chat.interrupt, answer: chat.answer, drive: async (id, view) => { await fakeApi.threads.update(id, { drive: view }); }, follow: () => {},
  },
  pty: {
    spawn: async spec => {
      const id = 'fake' + ++ptyN; lines.set(id, ''); if (spec.run.kind === 'shell') ran.set(id, { cmd: '', machine: spec.machine, cwd: spec.cwd });
      if (spec.thread) termOf.set(id, spec.thread);
      const prompt = spec.run.kind === 'shell' ? 'PS ' + spec.cwd + '> ' : `\x1b[1m${spec.run.kind}\x1b[0m (mock terminal: no harness in a browser)\r\n> `;
      emit({ type: 'pty.data', id, data: prompt });
      return id;
    },
    write: (id, d) => {
      if (d === '\r' && ran.has(id)) ran.get(id)!.cmd = lines.get(id) || '';
      if (d === '\r') { emit({ type: 'pty.data', id, data: '\r\n' + (lines.get(id) ? 'mock: ' + lines.get(id) + '\r\n' : '') + '> ' }); lines.set(id, ''); return; }
      if (d === '\x7f') { lines.set(id, (lines.get(id) || '').slice(0, -1)); emit({ type: 'pty.data', id, data: '\b \b' }); return; }
      lines.set(id, (lines.get(id) || '') + d); emit({ type: 'pty.data', id, data: d });
    },
    resize: () => {}, kill: id => { termOf.delete(id); },
    adopt: async id => {
      const r = ran.get(id), h = r?.cmd.trim().split(/\s+/)[0];
      if (!r || r.thread || (h !== 'claude' && h !== 'codex')) return null;
      const t = await fakeApi.threads.create({ harness: h, machine: r.machine, dir: r.cwd, view: 'term' });
      r.thread = t.id; if (h === 'claude') t.drive = 'term'; emit({ type: 'thread', thread: { ...t } });
      return t;
    },
  },
  // a forward "succeeds" on the port itself (the page loads from this computer); a machine that is down fails
  browser: {
    forward: async (m, port) => { await new Promise(r => setTimeout(r, 150)); const x = machines.find(y => y.id === m); if (x?.ssh && x.link !== 'up') throw new Error(x.note || 'Connection timed out'); return port; },
    keys: () => {},
  },
  images: { toInbox: async (_m, _png, name) => '~/.skein/inbox/' + (name || 'paste.png') },
  git: fakeGit,
  // what the harnesses answer (fakeOptions: Claude Code 2.1.329's list, Codex model/list shaped); a machine that is down can't be asked
  harness: {
    options: async (m, h) => {
      await new Promise(r => setTimeout(r, 60));
      const x = machines.find(y => y.id === m);
      return x?.ssh && x.link !== 'up' ? bundledOptions(h, x.note || 'Connection timed out') : fakeOptions(h);
    },
    commands: async (m, h, dir) => {
      await new Promise(r => setTimeout(r, 60));
      const x = machines.find(y => y.id === m);
      return x?.ssh && x.link !== 'up' ? bundledCommands(h, x.note || 'Connection timed out') : fakeCommands(h, dir);
    },
  },
};
