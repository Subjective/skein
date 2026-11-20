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
import { machineIO, moveBlocked, moveSession } from '../core/move';
import { Ptys, ptyAvailable } from '../core/pty';
import { cwdOf, harnessUnder, listProcs } from '../core/detect';
import { discoverLocal, discoverRemote } from '../core/discover';
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
  // A thread adopted from a shell learns its session id once the harness writes its transcript: look for a new
  // one of that harness (started after adoption, not known yet, its folder first) until it shows or the terminal ends.
  const watchSession = (thread: string, ptyId: string, since: number) => {
    let n = 0;
    const tick = async () => {
      const t = threads.list().find(x => x.id === thread);
      if (!t || t.sessionId || !ptys.info(ptyId) || ++n > 1200) return;
      const m = M(t.machine);
      const found = (m.ssh ? await discoverRemote(m, 10).catch(() => []) : discoverLocal(10))
        .filter(f => f.harness === t.harness && f.createdAt >= since - 5000 && !threads.bySession(f.sessionId))
        .sort((a, b) => Number(b.dir === t.dir) - Number(a.dir === t.dir) || b.createdAt - a.createdAt)[0];
      if (found) {
        log('detect', thread, 'session', found.sessionId);
        threads.update(thread, { sessionId: found.sessionId, dir: found.dir || t.dir, branch: found.branch, updatedAt: found.updatedAt, ...(t.title === 'New thread' && found.title ? { title: found.title } : {}) });
        return;
      }
      setTimeout(() => void tick(), m.ssh ? 6000 : 3000);
    };
    setTimeout(() => void tick(), 3000);
  };

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
      move: async (id, machine, dir) => {
        const t = threads.get(id), from = M(t.machine), to = M(machine);
        const abs = await files.resolve(to, dir).catch(() => dir);
        const why = moveBlocked(t, to, abs);
        if (why) throw new Error(why);
        // let go of the old place first: the chat driver, and any terminal running the harness there
        const d = drivers.get(id);
        if (d) { await d.release(); drivers.delete(id); }
        harnesses.forget?.(id);
        await ptys.killThread(id);
        const r = await moveSession(t, from, to, abs, { ...machineIO, log });
        log('move', id, `${from.id}:${t.dir} -> ${to.id}:${abs}`, r.copied.map(c => c.join(' -> ')).join('; ') || 'nothing copied');
        return threads.update(id, { ...r.patch, machine: to.id, dir: abs, status: 'idle' });
      },
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
      adopt: async (id, seen) => {
        const p = ptys.info(id);
        if (!p || p.spec.run.kind !== 'shell' || p.spec.thread) return null;
        const m = M(p.spec.machine);
        // this computer's shells: what really runs under the shell; an SSH shell: what the renderer saw
        const hit = !m.ssh && p.pid ? harnessUnder(await listProcs(), p.pid) : null;
        const harness = hit?.harness ?? (m.ssh ? seen : undefined);
        if (!harness) return null;
        const dir = (hit && cwdOf(hit.pid)) || await files.resolve(m, p.spec.cwd || '~').catch(() => p.spec.cwd);
        const made = threads.create({ harness, machine: m.id, dir, view: 'term' });
        // the session id comes from the harness's transcript, not from us (it was started without --session-id)
        const t = threads.update(made.id, { sessionId: undefined, status: 'idle' });
        ptys.tie(id, t.id);
        log('detect', id, `${harness} in a shell on ${m.id}: thread ${t.id}`);
        watchSession(t.id, id, Date.now());
        return t;
      },
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
