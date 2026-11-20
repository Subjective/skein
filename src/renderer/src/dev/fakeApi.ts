// A stand-in for the main process, for looking at and testing the UI in a plain browser (`pnpm dev:web`).
// Data is a small sample; terminals echo what you type.
import type { SkeinBridge, SkeinEvent } from '@shared/api';
import type { Machine, Settings, ThreadMeta } from '@shared/types';
import { extraThreads, fakeChat } from './fakeChat';

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
let settings: Settings = { theme: 'dark', vim: true, leader: 'ctrl-space', sideView: 'grouped', defaultView: 'term', notify: 'waiting', vimrc: '" Skein vimrc\n\ninoremap jk <Esc>\n' };
const kv = new Map<string, unknown>();
let ptyN = 0;
const lines = new Map<string, string>();

export const fakeApi: SkeinBridge = {
  on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  setTheme: () => {},
  app: {
    info: async () => ({ platform: /Mac/.test(navigator.platform) ? 'mac' : 'win', version: 'dev', home: '~', pty: true }),
    load: async k => kv.get(k), save: async (k, v) => { kv.set(k, v); },
    settings: async () => settings, setSettings: async p => (settings = { ...settings, ...p }),
    openExternal: async () => {}, notify: async () => {},
  },
  machines: {
    list: async () => machines, add: async (name, ssh) => { const m: Machine = { id: name, name, ssh, link: 'down', has: [] }; machines.push(m); return m; },
    remove: async () => {}, connect: async id => machines.find(m => m.id === id)!, answer: async () => {}, sshHosts: async () => ['devbox', 'gpu-01'],
  },
  fs: {
    list: async (_m, dir) => (dir.split(/[\\/]/).length > 4 ? [] : ['projects', 'repo', 'scratch', '.config', 'notes.md'].map(n => ({ name: n, dir: !n.includes('.') || n === '.config', hidden: n.startsWith('.') }))),
    read: async () => '', write: async () => {}, resolve: async (_m, p) => p,
    find: async () => ['README.md', 'package.json', 'src/main/index.ts', 'src/core/pty.ts', 'src/core/files.ts', 'src/renderer/src/shell/App.tsx', 'src/renderer/src/shell/overlays.tsx', 'docs/VIM-MODEL.md'],
  },
  threads: {
    list: async () => threads, discover: async () => [],
    create: async spec => {
      const t = T('n' + Date.now(), spec.harness, spec.machine, spec.dir, spec.side ? 'New side chat' : 'New thread', 0, { parent: spec.parent, side: spec.side, model: spec.model, effort: spec.effort, perm: spec.perm });
      threads.unshift(t); chat.fork(spec, t); return t;
    },
    update: async (id, patch) => { const t = threads.find(x => x.id === id)!; Object.assign(t, patch); emit({ type: 'thread', thread: t }); return t; },
    history: async id => chat.history(id),
  },
  chat: { send: chat.send, interrupt: chat.interrupt, answer: chat.answer, drive: async (id, view) => { await fakeApi.threads.update(id, { drive: view }); } },
  pty: {
    spawn: async spec => {
      const id = 'fake' + ++ptyN; lines.set(id, '');
      const prompt = spec.run.kind === 'shell' ? 'PS ' + spec.cwd + '> ' : `\x1b[1m${spec.run.kind}\x1b[0m (mock terminal: no harness in a browser)\r\n> `;
      emit({ type: 'pty.data', id, data: prompt });
      return id;
    },
    write: (id, d) => {
      if (d === '\r') { emit({ type: 'pty.data', id, data: '\r\n' + (lines.get(id) ? 'mock: ' + lines.get(id) + '\r\n' : '') + '> ' }); lines.set(id, ''); return; }
      if (d === '\x7f') { lines.set(id, (lines.get(id) || '').slice(0, -1)); emit({ type: 'pty.data', id, data: '\b \b' }); return; }
      lines.set(id, (lines.get(id) || '') + d); emit({ type: 'pty.data', id, data: d });
    },
    resize: () => {}, kill: () => {},
  },
  images: { toInbox: async (_m, _png, name) => '~/.skein/inbox/' + (name || 'paste.png') },
  git: { status: async () => ({ isRepo: true, branch: 'main', files: [] }), diff: async () => '', stage: async () => {}, revert: async () => {}, commit: async () => {}, log: async () => [] },
};
