// The implementation of SkeinApi: thin glue from IPC to the core modules. No Electron imports here except
// through the `shell` argument, so the same object could sit behind another transport.
import type { SkeinApi } from '../shared/api';
import type { Settings } from '../shared/types';
import { unimplemented, type ChatDriver, type Harnesses } from '../core/chat';
import { emit } from '../core/events';
import { Forwards } from '../core/forward';
import { log } from '../core/log';
import * as files from '../core/files';
import * as git from '../core/git';
import { toInbox } from '../core/images';
import { Machines } from '../core/machines';
import { Ptys, ptyAvailable } from '../core/pty';
import type { Store } from '../core/store';
import { Threads } from '../core/threads';

export const DEFAULT_VIMRC = `" Skein vimrc
" Applies to composers, readers (terminal scrollback included) and app NORMAL.
" A terminal's input line belongs to the program running in it, so these maps do not apply there.

inoremap jk <Esc>
`;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system', vim: true, leader: 'ctrl-space', sideView: 'grouped', defaultView: 'chat', notify: 'waiting', vimrc: DEFAULT_VIMRC,
};

export interface ShellHooks {
  version: string;
  home: string;
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string, thread?: string): void;
  /** The keys Skein keeps while a Browser tab's page has focus (main's before-input-event reads them). */
  browserKeys?(keys: string[]): void;
}

export function createServices(store: Store, shell: ShellHooks, harnesses: Harnesses = unimplemented) {
  const machines = new Machines(store);
  const threads = new Threads(store);
  const ptys = new Ptys(id => machines.get(id), { whenUp: id => machines.whenUp(id) });
  // each time an SSH machine comes up, pick up sessions that were started there outside Skein
  machines.onUp(m => { threads.discover(m.id, m).catch(e => log('ssh', m.id, 'discovery failed', (e as Error).message)); });
  const drivers = new Map<string, ChatDriver>();
  const host = {
    machine: (id: string) => machines.get(id),
    thread: (id: string) => threads.get(id),
    update: (id: string, patch: object) => { threads.update(id, patch); },
    event: (thread: string, event: import('../shared/types').ThreadEvent, replace?: boolean) => emit({ type: 'chat', thread, event, replace }),
  };
  const driver = (id: string) => {
    let d = drivers.get(id);
    if (!d) { d = harnesses.driver(threads.get(id), host); drivers.set(id, d); }
    return d;
  };
  const M = (id: string) => machines.get(id);
  const forwards = new Forwards(M);

  const api: SkeinApi = {
    app: {
      info: async () => ({ platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', version: shell.version, home: shell.home, pty: ptyAvailable() }),
      load: async key => store.get(key),
      save: async (key, value) => store.set(key, value),
      settings: async () => ({ ...DEFAULT_SETTINGS, ...store.get<Partial<Settings>>('settings') }),
      setSettings: async patch => { const s = { ...DEFAULT_SETTINGS, ...store.get<Partial<Settings>>('settings'), ...patch }; store.set('settings', s); return s; },
      openExternal: url => shell.openExternal(url),
      notify: async (title, body, thread) => shell.notify(title, body, thread),
    },
    machines: {
      list: async () => machines.all(),
      add: async (name, ssh) => machines.add(name, ssh),
      remove: async id => machines.remove(id),
      connect: id => machines.connect(id),
      answer: async (id, value) => machines.answer(id, value),
      sshHosts: async () => machines.sshHosts(),
    },
    fs: {
      list: (m, dir) => files.list(M(m), dir),
      read: (m, p) => files.read(M(m), p),
      write: (m, p, text) => files.write(M(m), p, text),
      resolve: (m, p) => files.resolve(M(m), p),
      find: (m, d) => files.find(M(m), d),
    },
    threads: {
      list: async () => threads.list(),
      discover: async m => threads.discover(m, m === 'local' ? undefined : machines.get(m)),
      create: async spec => {
        // store the folder as an absolute path, the way discovered sessions record it, so both land in one project
        const t = threads.create({ ...spec, dir: await files.resolve(M(spec.machine), spec.dir).catch(() => spec.dir) });
        if (!harnesses.start) return t;
        // Codex: the thread exists on the app-server before either view opens, so both views share one session id
        try { const s = await harnesses.start(t, host); return s.sessionId && s.sessionId !== t.sessionId ? threads.update(t.id, { sessionId: s.sessionId }) : t; }
        catch (e) { log('chat', 'start failed', (e as Error).message); return t; }
      },
      update: async (id, patch) => threads.update(id, patch),
      history: async id => { const t = threads.get(id); return harnesses.history(t, M(t.machine)); },
    },
    chat: {
      send: (id, msg) => driver(id).send(msg),
      interrupt: id => driver(id).interrupt(),
      answer: (id, req, opt) => driver(id).answer(req, opt),
      drive: async (id, view) => {
        if (view === 'term') { const d = drivers.get(id); if (d) { await d.release(); drivers.delete(id); } }
        threads.update(id, { drive: view });
      },
    },
    pty: {
      spawn: async spec => {
        // a Codex thread's terminal attaches to the app-server the chat view drives (one live session, G4)
        const t = spec.thread ? threads.list().find(x => x.id === spec.thread) : undefined;
        if (t && spec.run.kind === 'codex' && harnesses.attach) {
          const a = await harnesses.attach(t).catch(() => null);
          if (a) return ptys.spawn({ ...spec, run: { kind: 'codex', args: [...a.args, ...(spec.run.args || [])] } }, a.env);
        }
        return ptys.spawn(spec);
      },
      write: (id, data) => ptys.write(id, data),
      resize: (id, c, r) => ptys.resize(id, c, r),
      kill: id => ptys.kill(id),
    },
    images: { toInbox: (m, png, name) => toInbox(M(m), png, name) },
    git: {
      status: (m, d) => git.status(M(m), d),
      diff: (m, d, o) => git.diff(M(m), d, o),
      stage: (m, d, p, on) => git.stage(M(m), d, p, on),
      revert: (m, d, p) => git.revert(M(m), d, p),
      unrevert: (m, d, u) => git.unrevert(M(m), d, u),
      commit: (m, d, msg, o) => git.commit(M(m), d, msg, o),
      log: (m, d, n) => git.log(M(m), d, n),
      repo: (m, d) => git.repo(M(m), d),
      changes: (m, r, s) => git.changes(M(m), r, s),
      counts: (m, r, s) => git.counts(M(m), r, s),
      show: (m, r, p, rev) => git.show(M(m), r, p, rev),
      commits: (m, r, n) => git.commits(M(m), r, n),
      branches: (m, r) => git.branches(M(m), r),
      switch: (m, r, b, c) => git.switchBranch(M(m), r, b, c),
      push: (m, r) => git.push(M(m), r),
      snapshot: (m, r) => git.snapshot(M(m), r),
      files: (m, r) => git.files(M(m), r),
    },
    browser: {
      forward: (m, port) => forwards.forward(m, port),
      keys: keys => shell.browserKeys?.(keys),
    },
  };
  return { api, dispose: () => { ptys.killAll(); forwards.dispose(); machines.dispose(); } };
}
