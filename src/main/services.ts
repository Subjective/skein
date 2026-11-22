// The implementation of SkeinApi: thin glue from IPC to the core modules. No Electron imports here except
// through the `shell` argument, so the same object could sit behind another transport.
import type { SkeinApi } from '../shared/api';
import { bundledCommands } from '../shared/commands';
import { bundledOptions } from '../shared/models';
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
import { Handoff } from '../core/handoff';
import { cwdOf, harnessOf, harnessUnder, listProcs } from '../core/detect';
import { Follows } from '../core/follow';
import { discoverLocal, discoverRemote } from '../core/discover';
import type { Store } from '../core/store';
import { carriedPrompts, ownEvents } from '../core/side';
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
  /** Show a local file in the system's file manager. */
  reveal(path: string): void;
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
  // While Skein's chat driver runs a turn (and a few seconds after, for trailing writes), the transcript's new lines
  // are ours: the driver pushes them itself. Other writers are followed from the transcript (core/follow).
  const ownUntil = new Map<string, number>();
  const host = {
    machine: (id: string) => machines.get(id),
    thread: (id: string) => threads.get(id),
    update: (id: string, patch: Partial<import('../shared/types').ThreadMeta>) => {
      if (patch.status) ownUntil.set(id, patch.status === 'running' || patch.status === 'wait' ? Infinity : Date.now() + 5000);
      threads.update(id, patch);
    },
    event: (thread: string, event: import('../shared/types').ThreadEvent, replace?: boolean) => emit({ type: 'chat', thread, event, replace }),
  };
  const driver = (id: string) => {
    let d = drivers.get(id);
    if (!d) { d = harnesses.driver(threads.get(id), host); drivers.set(id, d); }
    return d;
  };
  const M = (id: string) => machines.get(id);
  const forwards = new Forwards(M);
  // Live follow (core/follow): sessions written outside Skein's chat driver show up as they happen, and one
  // written by another process is that process's until you take over (ThreadMeta.external).
  const follows = new Follows({
    machine: M,
    thread: id => threads.list().find(t => t.id === id),
    bySession: sid => threads.bySession(sid),
    owner: id => ((ownUntil.get(id) ?? 0) > Date.now() ? 'driver' : ptys.hasThread(id) ? 'pty' : null),
    event: (thread, event, replace) => emit({ type: 'chat', thread, event, replace }),
    activity: (id, a) => {
      const t = threads.list().find(x => x.id === id); if (!t) return;
      const patch: Partial<import('../shared/types').ThreadMeta> = t.external ? {} : { external: Date.now() };
      if (a.state === 'running' && t.status !== 'running' && t.status !== 'wait') patch.status = 'running';
      else if (a.state === 'idle' && t.status === 'running') patch.status = 'idle';
      // a whole turn landed between two looks: still go through running, so an unseen thread gets its blue dot
      else if (a.state === 'idle' && a.ended) { threads.update(id, { ...patch, status: 'running' }); patch.status = 'idle'; }
      if (Object.keys(patch).length) threads.update(id, patch);
      if (patch.external) watchOwner();
    },
    read: t => harnesses.history(t, M(t.machine)),
    unknown: () => { void threads.discover('local').then(added => { for (const t of added) emit({ type: 'thread', thread: t }); }, () => {}); },
  });
  /** A thread's whole record, read through the follower, so live pushes pick up exactly where it ends. */
  const historyOf = async (id: string) => {
    const t = threads.get(id);
    return (await follows.history(id).catch(() => null)) ?? harnesses.history(t, M(t.machine));
  };
  // Claude Code: one writer per session between the chat driver and Skein's terminal (core/handoff)
  const handoff = new Handoff({
    hasTerm: id => ptys.hasThread(id),
    closeTerm: id => ptys.killThread(id, { handoff: true }),
    turnState: (id, o) => follows.turnState(id, o),
  });
  // The outside writer is gone: its process exited (this computer), or it has been quiet for half an hour (an SSH
  // machine, or a platform where a process can't be matched to its session). Then Skein may drive again.
  let ownerTimer: ReturnType<typeof setInterval> | null = null;
  const QUIET = 30 * 60_000;
  const checkOwners = async () => {
    const out = threads.list().filter(t => t.external);
    if (!out.length) { if (ownerTimer) clearInterval(ownerTimer); ownerTimer = null; return; }
    const local = out.some(t => !M(t.machine).ssh) ? await listProcs().catch(() => null) : null;
    for (const t of out) {
      if (ptys.hasThread(t.id)) { threads.update(t.id, { external: 0 }); continue; }   // a Skein terminal has it now
      const quiet = Date.now() - Math.max(t.external || 0, t.updatedAt) > QUIET;
      if (M(t.machine).ssh || !local) { if (quiet) threads.update(t.id, { external: 0, ...(t.status === 'running' ? { status: 'idle' as const } : {}) }); continue; }
      const tuis = local.filter(p => harnessOf(p.cmd) === t.harness);
      const byId = tuis.some(p => !!t.sessionId && p.cmd.includes(t.sessionId));
      // Linux tells a process's folder: a TUI there may be this session (started plainly, then /resume)
      const byDir = process.platform === 'linux' && tuis.some(p => cwdOf(p.pid) === t.dir);
      const alive = byId || byDir || (process.platform !== 'linux' && !quiet);
      if (!alive && t.status !== 'running') threads.update(t.id, { external: 0 });
    }
  };
  const watchOwner = () => { if (!ownerTimer) { ownerTimer = setInterval(() => void checkOwners(), process.platform === 'win32' ? 60_000 : 15_000); ownerTimer.unref?.(); } };
  if (threads.list().some(t => t.external)) watchOwner();
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
      reveal: async p => shell.reveal(files.expandLocal(p)),
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
        // a side chat counts the messages it carries over now, while the parent still holds them (an edit there can drop them)
        const parent = spec.side && spec.parent ? { ...spec.parent, carried: carriedPrompts(await historyOf(spec.parent.id).catch(() => []), spec.parent.at) } : spec.parent;
        const t = threads.create({ ...spec, parent, dir: await files.resolve(M(spec.machine), spec.dir).catch(() => spec.dir) });
        if (!harnesses.start) return t;
        // Codex: the thread exists on the app-server before either view opens, so both views share one session id
        try { const s = await harnesses.start(t, host); return s.sessionId && s.sessionId !== t.sessionId ? threads.update(t.id, { sessionId: s.sessionId }) : t; }
        catch (e) { log('chat', 'start failed', (e as Error).message); return t; }
      },
      update: async (id, patch) => {
        return threads.update(id, patch);
      },
      history: async id => {
        const t = threads.get(id), evs = await historyOf(id);
        if (!t.side || !t.parent) return evs;
        // a side chat shows only its own turns; the parent's stay with the model as context. Side chats made before
        // `carried` was recorded count against the parent as it is now.
        const carried = t.parent.carried ?? carriedPrompts(await historyOf(t.parent.id).catch(() => []), t.parent.at);
        return ownEvents(evs, carried);
      },
      sub: async (id, sub) => {
        const t = threads.get(id);
        return harnesses.subHistory ? harnesses.subHistory(t, M(t.machine), sub) : [];
      },
      move: async (id, machine, dir) => {
        const t = threads.get(id), from = M(t.machine), to = M(machine);
        const abs = await files.resolve(to, dir).catch(() => dir);
        const why = moveBlocked(t, to, abs);
        if (why) throw new Error(why);
        // let go of the old place first: the chat driver, and any terminal running the harness there
        const d = drivers.get(id);
        if (d) { await d.release(); drivers.delete(id); }
        harnesses.forget?.(id);
        follows.forget(id);
        await ptys.killThread(id);
        const r = await moveSession(t, from, to, abs, { ...machineIO, log });
        log('move', id, `${from.id}:${t.dir} -> ${to.id}:${abs}`, r.copied.map(c => c.join(' -> ')).join('; ') || 'nothing copied');
        return threads.update(id, { ...r.patch, machine: to.id, dir: abs, status: 'idle' });
      },
    },
    chat: {
      send: async (id, msg) => {
        // one writer per session: another process has this one until you take over
        const t = threads.get(id);
        if (t.external) throw new Error('This thread is running in another terminal. Take over to send from here.');
        if (t.harness === 'claude') {
          if (t.drive === 'term' && !msg.sub) throw new Error('The terminal is driving this thread. Take it back to send from chat.');
          // the terminal's TUI holds the conversation from before this message: close it, its view resumes later
          await handoff.beforeSend(id);
        }
        return driver(id).send(msg);
      },
      interrupt: id => driver(id).interrupt(),
      answer: (id, req, opt) => driver(id).answer(req, opt),
      drive: async (id, view) => {
        if (view === 'term') {
          handoff.cancel(id);
          const d = drivers.get(id); if (d) { await d.release(); drivers.delete(id); }
        } else if (!(await handoff.toChat(id))) return; // the terminal took it back while its turn ran
        threads.update(id, { drive: view });
      },
      follow: (id, on) => follows.follow(id, on),
      steerQueued: (id, q) => driver(id).steerQueued(q),
      dropQueued: (id, q) => driver(id).dropQueued(q),
      editQueued: (id, q, text) => driver(id).editQueued(q, text),
      orderQueue: (id, ids) => driver(id).orderQueue(ids),
      resumeQueue: id => driver(id).resumeQueue(),
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
      webUrl: (m, r, p) => git.webUrl(M(m), r, p),
    },
    browser: {
      forward: (m, port) => forwards.forward(m, port),
      keys: keys => shell.browserKeys?.(keys),
    },
    harness: {
      // asked from the harness on that machine (core/harness/options.ts); the bundled lists when it can't be
      options: async (m, h) => {
        try { return harnesses.options ? await harnesses.options(M(m), h) : bundledOptions(h, 'Not asked: no chat backend'); }
        catch (e) { return bundledOptions(h, (e as Error).message); }
      },
      commands: async (m, h, dir) => {
        try { return harnesses.commands ? await harnesses.commands(M(m), h, dir) : bundledCommands(h, 'Not asked: no chat backend'); }
        catch (e) { return bundledCommands(h, (e as Error).message); }
      },
    },
  };
  return { api, dispose: () => { ptys.killAll(); forwards.dispose(); machines.dispose(); follows.dispose(); if (ownerTimer) clearInterval(ownerTimer); } };
}
