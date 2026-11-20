// Where a tool tab works (machine + folder), the repository there, and per-tab view state.
// Repositories are polled while a view shows them: `git status` is cheap, and a changed key reloads the rest.
// Agent turns: when a thread starts running, the working tree is snapshotted, so "Last agent turn" can show
// exactly what that turn changed (snapshot at the start .. snapshot at the end, or the live tree while it runs).
import { useEffect } from 'react';
import type { RepoState } from '@shared/api';
import { api } from '../../api';
import type { Tab } from '../../state/layout';
import { machine as machineOf, S, thread, update, ws } from '../../state/store';

export interface Ctx { machine: string; dir: string }
export const ctxOf = (t: Tab): Ctx => {
  const th = thread(t.thread);
  if (t.kind === 'file' && t.dir) return { machine: t.machine || th?.machine || ws().machine, dir: t.dir };
  if (th) return { machine: th.machine, dir: th.dir };
  return { machine: t.machine || ws().machine, dir: t.dir || ws().dir };
};
export const isRemote = (m: string) => !!machineOf(m)?.ssh;
/** Join a folder and a path relative to it, keeping the folder's own separators style simple (/ works everywhere). */
export const join = (dir: string, rel: string) => (rel ? dir.replace(/[\\/]+$/, '') + '/' + rel : dir);

// ---------------- repositories ----------------

export interface RepoEntry {
  key: string;
  machine: string;
  dir: string;
  /** undefined while the first look is running; null when the folder is not in a repository */
  repo: RepoState | null | undefined;
  error?: string;
  users: number;
  /** bumped whenever the repository's key changes, so views reload what depends on it */
  gen: number;
}
const repos = new Map<string, RepoEntry>();
const rkey = (m: string, d: string) => m + '\u0000' + d;

export function repoEntry(machine: string, dir: string): RepoEntry {
  const k = rkey(machine, dir);
  let e = repos.get(k);
  if (!e) { e = { key: k, machine, dir, repo: undefined, users: 0, gen: 0 }; repos.set(k, e); void refresh(e); }
  return e;
}

const inflight = new Map<string, Promise<void>>();
export function refresh(e: RepoEntry): Promise<void> {
  const running = inflight.get(e.key);
  if (running) return running;
  const p = (async () => {
    try {
      const r = await api.git.repo(e.machine, e.dir);
      const changed = (r?.key ?? null) !== (e.repo?.key ?? null) || r?.root !== e.repo?.root || r?.branch !== e.repo?.branch || e.repo === undefined;
      e.error = undefined;
      if (changed) { e.repo = r; e.gen++; update(); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== e.error || e.repo === undefined) { e.error = msg; if (e.repo === undefined) e.repo = null; e.gen++; update(); }
    }
  })().finally(() => inflight.delete(e.key));
  inflight.set(e.key, p);
  return p;
}
/** Refresh every repository on a machine + folder (after an action that changed it). */
export const refreshNow = (machine: string, dir: string) => refresh(repoEntry(machine, dir));

let timer: ReturnType<typeof setInterval> | null = null;
let tickN = 0;
function poll() {
  if (typeof document !== 'undefined' && document.hidden) return;
  tickN++;
  for (const e of repos.values()) if (e.users > 0 && (!isRemote(e.machine) || tickN % 3 === 0)) void refresh(e);
}

/** Keep a repository fresh while the calling view is mounted. */
export function useRepo(machine: string, dir: string): RepoEntry {
  const e = repoEntry(machine, dir);
  useEffect(() => {
    e.users++;
    if (!timer) {
      timer = setInterval(poll, 2000);
      window.addEventListener('focus', () => { for (const x of repos.values()) if (x.users > 0) void refresh(x); });
    }
    return () => { e.users--; };
  }, [e]);
  return e;
}

// ---------------- agent turns ----------------

export interface Turn { thread: string; root: string; machine: string; base: string; head?: string; at: number }
let turns: Turn[] = [];
let turnsStarted = false;
const lastStatus = new Map<string, string>();

export function watchTurns() {
  if (turnsStarted) return; turnsStarted = true;
  void api.app.load('tools.turns').then(v => { if (Array.isArray(v)) turns = [...(v as Turn[]), ...turns]; }).catch(() => {});
  const save = () => void api.app.save('tools.turns', turns.slice(-40)).catch(() => {});
  api.on(async ev => {
    if (ev.type !== 'thread.status' && ev.type !== 'thread') return;
    const id = ev.type === 'thread' ? ev.thread.id : ev.id, status = ev.type === 'thread' ? ev.thread.status : ev.status;
    const was = lastStatus.get(id) ?? thread(id)?.status; lastStatus.set(id, status);
    if ((status === 'running') === (was === 'running')) return;
    const th = thread(id) || (ev.type === 'thread' ? ev.thread : undefined);
    if (!th) return;
    try {
      const r = await api.git.repo(th.machine, th.dir);
      if (!r) return;
      const tree = await api.git.snapshot(th.machine, r.root);
      if (status === 'running') turns.push({ thread: id, root: r.root, machine: th.machine, base: tree, at: Date.now() });
      else { const t = [...turns].reverse().find(x => x.thread === id && !x.head); if (t) t.head = tree; }
      save(); update();
    } catch { /* not a repository, or the machine is away: no turn to show */ }
  });
}
/** The turn Changes shows for a tab: its thread's last turn, else the newest turn in the same repository. */
export function turnFor(t: Tab, machine: string, root: string): Turn | undefined {
  const inRepo = turns.filter(x => x.machine === machine && x.root === root);
  return [...inRepo].reverse().find(x => x.thread === t.thread) || inRepo[inRepo.length - 1];
}
/** For tests and the dev fake: record a turn directly. */
export function addTurn(x: Turn) { turns.push(x); update(); }

// ---------------- per-tab view state ----------------

const views = new Map<string, unknown>();
/** View state that lives as long as the tab (scope, folds, cursor, history). Not persisted. */
export function viewState<T extends object>(tabId: string, init: () => T): T {
  let v = views.get(tabId) as T | undefined;
  if (!v) { v = init(); views.set(tabId, v); }
  return v;
}

export { S };
