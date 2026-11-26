// Overlays opened by commands: palette, : line, pane search, workspaces, machines, keyboard sheet, settings.
// All are the shared Menu or Dialog, so they look and key the same.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { DirEntry, Machine, ThreadMeta } from '@shared/types';
import { ALIASES, COMMANDS, Keymap, parseVimrc, toVimKeys } from '../input/keymap';
import { kb } from '../input/platform';
import type { Surface } from '../input/dispatcher';
import { api } from '../api';
import * as A from '../state/actions';
import { allTabs, mkTab, type Tab, type Workspace } from '../state/layout';
import { machine, openLayer, S, thread, topLayer, update, useApp, ws } from '../state/store';
import { fuzzyTop } from '../ui/fuzzy';
import { FileIcon } from '../ui/FileIcon';
import { Menu, type MenuItem, type MenuProps } from '../ui/Menu';
import { Dialog, useDialogSurface } from '../ui/Dialog';
import { useKeyCursor } from '../ui/modality';
import { cx, Dot, Icon, IconButton, Spinner, Switch } from '../ui/primitives';
import { base, HARNESSES, harnessName, projectName, tabMeta, tildify } from './meta';
import { commandNames, run } from './commands';
import { WsMini, wsRow, wsWaiting } from './switcher';
import { ThreadStatus } from './Sidebar';
import { captureKeys } from './keyboard';
import { log } from '../views/chat/state';
import { openSide, openSub } from '../views/chat/threads';
import { openTool } from '../views/tools/open';
import { fileAction, fileItems } from '../views/tools/fileactions';
import { DENSITY, DENSITY_NAME } from '../views/chat/options';

/** Open any menu as an overlay. */
export function openMenu<D>(p: Omit<MenuProps<D>, 'onClose'> & { onClose?: () => void }) {
  const close = openLayer(c => <Menu<D> {...p} onClose={c} />, p.onClose);
  return close;
}

const ago = (t: number) => { const m = (Date.now() - t) / 60000; return m < 1 ? '' : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const rectOf = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;

/** Where the focused tab works: its thread's folder, or the tab's or workspace's. */
export function here(): { machine: string; dir: string } {
  const t = A.currentTab(), th = t.thread ? thread(t.thread) : undefined, w = ws();
  return th ? { machine: th.machine, dir: th.dir } : { machine: t.machine || w.machine, dir: t.dir || w.dir };
}

/** Folders the app knows on a machine, most recent first: ones with threads, projects, workspaces and folders
 *  picked before. A folder you have used is known from then on (the mockup's Dirs.use). */
const used: Record<string, string[]> = {};
export function knownDirs(m: string): string[] {
  const th = S.threads.filter(t => t.machine === m && !t.side).sort((a, b) => b.updatedAt - a.updatedAt).map(t => t.dir);
  const wsd = [...S.workspaces].sort((a, b) => b.usedAt - a.usedAt).filter(w => w.machine === m).map(w => w.dir);
  return [...new Set([...(used[m] || []), ...th, ...(S.projects[m] || []), ...wsd])].filter(d => d && d !== '~');
}
const useDir = (m: string, d: string) => { used[m] = [d, ...(used[m] || []).filter(x => x !== d)].slice(0, 30); void api.app.save('dirs', used); };
/** Folders picked before, kept across restarts. Called once at boot. */
export async function loadDirs() {
  try { const v = (await api.app.load('dirs')) as Record<string, string[]> | undefined; if (v && typeof v === 'object') for (const [m, l] of Object.entries(v)) if (Array.isArray(l)) used[m] = l.filter(x => typeof x === 'string'); } catch { /* none kept */ }
}

// ctrl-p opens at once: it shows the folder's last index while a fresh one is made in the background, and fills
// in when the first one arrives (a big repo, a slow disk or SSH used to hold the popup until the walk finished).
const found = new Map<string, { at: number; list: string[] }>();
const walking = new Map<string, Promise<string[]>>();
const STALE = 30_000;
function indexFiles(m: string, dir: string): Promise<string[]> {
  const key = m + '\0' + dir;
  let w = walking.get(key);
  if (!w) {
    w = api.fs.find(m, dir).then(list => { found.set(key, { at: Date.now(), list }); return list; }).finally(() => walking.delete(key));
    walking.set(key, w);
  }
  return w;
}
/** Index the focused folder ahead of ctrl-p, when its index is missing or old. */
export function prewarmFiles() {
  const { machine: m, dir } = here(), hit = found.get(m + '\0' + dir);
  if (!dir || (hit && Date.now() - hit.at < 5 * 60_000) || walking.has(m + '\0' + dir)) return;
  if (machine(m)?.ssh && machine(m)?.link !== 'up') return;
  indexFiles(m, dir).catch(() => {});
}
function FileSearch({ m, dir, close }: { m: string; dir: string; close: () => void }) {
  const key = m + '\0' + dir;
  const [list, setList] = useState<string[] | null>(() => found.get(key)?.list ?? null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const hit = found.get(key);
    if (!hit || Date.now() - hit.at > STALE) indexFiles(m, dir).then(l => { if (live) setList(l); }, e => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [key, m, dir]);
  const items = useCallback((q: string) => fuzzyTop(q, list ?? [], 60).map(p => ({ label: base(p), hint: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', icon: <FileIcon path={p} />, data: p })), [list]);
  const mc = machine(m);
  return <Menu<string> modal className="pal files" ranked onClose={close}
    empty={list === null ? (err ? `Couldn't list files in ${dir}: ${err}` : 'Listing files…') : list.length ? 'No matching files' : 'No files here'}
    search={{ placeholder: `Search files in ${mc?.ssh ? mc.name + ':' : ''}${tildify(m, dir)}` }}
    items={items} onPick={it => { if (it.data) A.openFile(m, dir, it.data); }} altPick={it => { if (it.data) A.openFile(m, dir, it.data, { split: true }); }} />;
}
function openFiles() {
  const { machine: m, dir } = here();
  openLayer(c => <FileSearch m={m} dir={dir} close={c} />);
}

// ---------- palette (mockup palette() and ACTIONS) ----------
/** The palette's actions, as the mockup lists them. Each runs a command, so keys and vimrc maps agree. */
const ACTIONS: [string, string, string][] = [
  ['New thread', 'compose', 'tabnew'], ['Split right', 'splitR', 'vsplit'], ['Split down', 'splitD', 'split'],
  ['Shell to the right', 'terminal', 'vshell'], ['Show thread as chat / terminal', 'chat', 'view'],
  ['Open changes beside', 'diff', 'changes'], ['Open files beside', 'file', 'files'], ['Open browser beside', 'globe', 'browser'],
  ['Zoom pane', 'zoom', 'zoom'], ['Close tab', 'x', 'q'],
  ['Workspaces', 'layers', 'workspace'], ['Switch branch', 'branch', 'branch'], ['Move thread', 'folderOpen', 'moveto'], ['Machines', 'host', 'machines'], ['Settings', 'sliders', 'settings'], ['Keyboard shortcuts', 'keyboard', 'keys'],
  ['Agent work: Compact', 'layers', 'compact'], ['Agent work: Balanced', 'layers', 'balanced'], ['Agent work: Detailed', 'layers', 'detailed'],
];
/** A thread's state on the right of a row, as in the sidebar: spinner, shield, dot, else its age. */
const threadRight = (id: string) => { const t = thread(id); if (!t) return undefined; return t.status === 'idle' ? <span className="age">{ago(t.updatedAt)}</span> : <ThreadStatus t={t} />; };

export function openPalette(mode: 'all' | 'file' = 'all') {
  if (mode === 'file') { openFiles(); return; }
  // every thread, as the mockup's: archived ones (last) and side chats too; a side chat opens as a popup
  const th = [...S.threads].sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.updatedAt - a.updatedAt);
  const where = (t: ThreadMeta) => [machine(t.machine)?.name ?? t.machine, projectName(t.machine, t.dir), t.side && 'side chat', t.archived && 'archived'].filter(Boolean).join(' · ');
  const ft = A.currentTab();
  const items: MenuItem<() => void>[] = [
    { head: true, label: 'Threads' },
    ...th.map(t => ({ label: t.title, hint: where(t), icon: <Icon name={t.side ? 'chat' : t.harness} size="hm" />, right: threadRight(t.id), data: () => (t.side ? openSide(t.id) : A.openThread(t.id)) })),
    { head: true, label: 'Actions' },
    ...ACTIONS.map(([label, icon, cmd]) => ({ label, icon: <Icon name={icon} />, data: () => run(cmd) })),
    // an open file in front: its ⋯ menu's actions too (views/tools/fileactions)
    ...(ft.kind === 'file' ? [{ head: true, label: `File · ${base(ft.path || '')}` },
      ...fileItems(ft).filter(it => !it.head).map(it => ({ ...it, icon: <Icon name="file" />, data: () => { if (it.data) fileAction(it.data, ft); } }))] : []),
  ];
  openMenu<() => void>({ modal: true, className: 'pal', search: { placeholder: 'Search threads and actions' }, items, onPick: it => it.data?.(), empty: 'No matches' });
}

// ---------- : line (mockup cmdline()) ----------
/** A small menu docked above the status bar, its field at the bottom. Names match by prefix; whatever follows
 *  the name is its arguments (`new linux ~/repo`). Every command runs through run(), like a key or a vimrc map. */
export function openCmdline(v = '') {
  const names = Object.keys(COMMANDS);
  const all = commandNames();
  openMenu<string>({
    className: 'cmd', anchor: rectOf('#status'), place: 'top-start', width: 420, search: { prefix: ':', value: v }, ranked: true,
    items: q => {
      const typed = q.trim(), w = typed.split(/\s+/)[0] || '';
      const hit = names.filter(n => (n.includes(' ') ? n.startsWith(typed) || typed.startsWith(n) || n.startsWith(w) && typed === w : n.startsWith(w)));
      if (hit.length || !w) return hit.sort((a, b) => +(b === w) - +(a === w)).map(n => ({ label: n, hint: COMMANDS[n], data: n }));   // :w is w, not workspace
      // another name for a command (tabclose), or a tab number
      if (all.includes(w) || ALIASES[w]) return [{ label: w, hint: COMMANDS[ALIASES[w] || w] || '', data: w }];
      if (/^\d+$/.test(w)) return [{ label: w, hint: `Tab ${w}`, data: w }];
      return [];
    },
    onPick: (it, q) => {
      const t = q.trim().replace(/\s+/g, ' '), n = it.data!;
      run(t === n || t.startsWith(n + ' ') ? t : [n, ...t.split(' ').slice(1)].join(' '));
    },
  });
}

// ---------- pane search (mockup act.tabSearch) ----------
type Run = () => void;
/** The pane's dropdown, also mod-shift-a: the thread in this pane (its side chats and subagents), its tabs wherever
 *  they are open in this workspace, the tools it has not opened yet, and what you can do to the pane. */
export function openPaneSearch(anchor?: DOMRect | null) {
  const w = ws(), g = A.focusedPane(w), cur = A.currentTab(w);
  const at = anchor || rectOf(`.pane[data-pane="${CSS.escape(g.id)}"] [aria-label="Search this pane"]`);
  const th = cur.thread ? thread(cur.thread) : undefined;
  const sid = th ? (th.side && th.parent ? th.parent.id : th.id) : undefined, s = sid ? thread(sid) : undefined;
  const ofThread = (t: Tab) => (t.thread && (t.thread === sid || thread(t.thread)?.parent?.id === sid)) || (!!s && (t.kind === 'shell' || t.kind === 'file' || t.kind === 'browser') && t.machine === s.machine && t.dir === s.dir);
  const tabs = s ? allTabs(w).filter(x => ofThread(x.tab)) : allTabs(w);
  const has = (k: string) => tabs.some(x => x.tab.kind === k);
  const mine: MenuItem<Run>[] = !s ? [] : [{ head: true, label: s.title },
    ...S.threads.filter(x => x.side && x.parent?.id === s.id && !x.archived).map(c => ({ label: c.title, icon: <Icon name="chat" />, hint: 'side chat', right: c.status === 'idle' ? undefined : <ThreadStatus t={c} />, data: () => openSide(c.id) })),
    ...log(s.id).events.flatMap(e => (e.t === 'sub' ? [{ label: e.name, icon: <Icon name="agent" />, hint: 'subagent', right: e.status === 'running' ? <Spinner /> : undefined, data: () => openSub(s, e.id) }] : []))];
  const tabRows: MenuItem<Run>[] = tabs.map(({ tab, pane }) => {
    const m = tabMeta(tab);
    return { label: m.title, icon: tab.kind === 'file' && tab.path ? <FileIcon path={tab.path} /> : <Icon name={m.icon} />, right: tab.kind === 'thread' && tab.thread ? threadRight(tab.thread) : undefined, on: tab.id === cur.id,
      data: () => (pane ? A.activate(pane.id, tab.id) : update(x => { w.pf = tab.id; x.tick++; })) };
  });
  const more: MenuItem<Run>[] = !s ? [] : [
    ...([['changes', 'diff', 'Changes'], ['files', 'folder', 'Files'], ['browser', 'globe', 'Browser']] as const).filter(([k]) => !has(k)).map(([k, i, label]) => ({ label, icon: <Icon name={i} />, data: () => openTool(k, cur) })),
    { label: 'Shell', icon: <Icon name="terminal" />, hint: tildify(s.machine, s.dir), data: () => { update(x => { A.addTab(g, mkTab('shell', { machine: s.machine, dir: s.dir })); x.tick++; }); A.save(); } },
  ];
  const pane: MenuItem<Run>[] = [
    { label: 'Split right', icon: <Icon name="splitR" />, data: () => run('vsplit') },
    { label: 'Split down', icon: <Icon name="splitD" />, data: () => run('split') },
    { label: 'Shell to the right', icon: <Icon name="terminal" />, data: () => run('vshell') },
    { label: w.zoom ? 'Unzoom' : 'Zoom pane', icon: <Icon name="zoom" />, data: () => run('zoom') },
    { label: 'Close pane', icon: <Icon name="x" />, data: () => { update(x => { A.closePane(g); x.tick++; }); A.save(); } },
  ];
  openMenu<Run>({
    anchor: at, modal: !at, place: 'bottom-end', width: 320, className: at ? undefined : 'pal', search: { placeholder: s ? 'Search this thread' : 'Search tabs' },
    items: [...mine, { head: true, label: 'Tabs' }, ...tabRows, ...more, { head: true, label: 'Pane' }, ...pane],
    onPick: it => it.data?.(),
  });
}

// ---------- folders (mockup Dirs) ----------
// Wherever a folder is chosen the field works the same way: nothing typed lists a few known folders and the
// machines to browse; text filters them; a path (~/..., /..., or machine:~/... where machines are allowed) lists
// that folder as you type. tab (l in NORMAL) goes into the folder under the cursor, h goes back up, enter picks.
interface DAct { dir?: { m: string; dir: string }; into?: string; run?: () => void; none?: boolean; ws?: string; make?: string }
type DRow = MenuItem<DAct>;
interface PathQ { m: Machine; pre: string; parent: string; leaf: string }
function parsePath(q: string, m0: string, hosts: boolean): PathQ | null {
  const x = /^(?:(.+?):)?\s*(~|~\/.*|\/.*)$/.exec(q.trim());
  if (!x || (x[1] && !hosts)) return null;
  const m = x[1] ? S.machines.find(mm => [mm.id, mm.name].some(n => n.toLowerCase() === x[1].trim().toLowerCase())) : machine(m0);
  if (!m) return null;
  const p = x[2] === '~' ? '~/' : x[2], parent = p.slice(0, p.lastIndexOf('/') + 1);
  return { m, pre: x[1] ? x[1] + ':' : '', parent, leaf: p.slice(parent.length) };
}
/** One folder up, or from the top back to the list. */
const upPath = (p: PathQ) => (p.parent.length > 2 ? p.pre + p.parent.slice(0, p.parent.lastIndexOf('/', p.parent.length - 2) + 1) : '');
export const linkDot = (m: Machine) => (m.ssh ? <Dot color={m.link === 'up' ? 'green' : m.link === 'down' ? 'red' : 'amber'} pulse={m.link === 'connecting' || m.link === 'reconnecting'} label={m.link === 'up' ? 'Connected' : m.link === 'down' ? 'Not connected' : m.link === 'auth' ? 'Needs you to sign in' : 'Connecting'} /> : null);
const isUp = (m: Machine) => !m.ssh || m.link === 'up';

interface Ctl { set: (q: string, ins?: boolean) => void; close: () => void; refresh: () => void }
interface DirPickerProps {
  close: () => void; anchor: DOMRect | null; place: MenuProps['place']; width: number; className?: string;
  placeholder?: string; prefix?: string; value?: string; m0: string; hosts: boolean;
  rows: (q: string, path: PathQ | null, dirRows: (p: PathQ) => DRow[]) => DRow[];
  pick: (d: DAct, ctl: Ctl) => void;
  keys?: (k: string, it: DRow | undefined, ctl: Ctl, q: string) => boolean;
}
function DirPicker(p: DirPickerProps) {
  const [st, setSt] = useState({ gen: 0, q: p.value || '', ins: true });
  const [ver, setVer] = useState(0);
  const cache = useRef(new Map<string, DirEntry[] | 'loading' | 'error'>()).current;
  const lastQ = useRef(st.q);
  const typing = () => topLayer()?.surface?.mode() === 'INSERT';
  const ctl: Ctl = { set: (q, ins) => setSt(s => ({ gen: s.gen + 1, q, ins: ins ?? typing() })), close: p.close, refresh: () => setVer(n => n + 1) };
  const dirRows = (pq: PathQ): DRow[] => {
    const m = pq.m;
    if (!isUp(m)) return [{ head: true, label: m.name }, { label: 'Not connected', icon: <Icon name="host" />, hint: 'open Machines to reconnect', right: <i className="wdot down" />, data: { run: () => openMachines() } }];
    const at = pq.parent.length > 1 ? pq.parent.slice(0, -1) : pq.parent, key = m.id + '\0' + at, got = cache.get(key);
    if (got === undefined) {
      cache.set(key, 'loading');
      api.fs.list(m.id, at).then(l => cache.set(key, l), () => cache.set(key, 'error')).finally(() => setVer(n => n + 1));
    }
    const ents = Array.isArray(got) ? got : [];
    const here: DRow[] = pq.parent.length > 2 && !pq.leaf && Array.isArray(got) ? [{ label: base(at), icon: <Icon name="folder" />, hint: 'this folder', data: { dir: { m: m.id, dir: at } } }] : [];
    const sub: DRow[] = ents.filter(e => e.dir && (!e.hidden || pq.leaf.startsWith('.')) && e.name.toLowerCase().startsWith(pq.leaf.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ label: e.name, icon: <Icon name="folder" />, hint: pq.parent + e.name, data: { dir: { m: m.id, dir: pq.parent + e.name }, into: pq.pre + pq.parent + e.name + '/' } }));
    const busy = got === undefined || got === 'loading';
    return [{ head: true, label: `${m.name} · ${pq.parent}` }, ...here, ...sub, ...(here.length + sub.length || busy ? [] : [{ label: 'No folder here', data: { none: true } }])];
  };
  const items = useCallback((q: string) => { lastQ.current = q; return p.rows(q, parsePath(q, p.m0, p.hosts), dirRows); }, [ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const into = (d: DAct | undefined) => { if (!d?.into) return false; if (d.dir) ctl.set(d.into); else ctl.set(d.into, true); return true; };
  return (
    <Menu<DAct> key={st.gen} anchor={p.anchor} modal={!p.anchor} place={p.place} width={p.width} className={cx(p.className, !p.anchor && 'pal')} ranked keep tabMoves normal={!st.ins}
      search={{ placeholder: p.placeholder, prefix: p.prefix, value: st.q }} items={items} onClose={p.close}
      onPick={it => {
        const d = it.data; if (!d || d.none) return;
        if (d.run) { p.close(); d.run(); return; }
        if (d.into && !d.dir) { into(d); return; }
        if (d.dir) useDir(d.dir.m, d.dir.dir);
        p.pick(d, ctl);
      }}
      keys={(k, it) => {
        const q = lastQ.current, pq = parsePath(q, p.m0, p.hosts);
        if ((k === 'tab' || k === 'l' || k === 'right') && into(it?.data)) return true;
        if ((k === 'h' || k === 'left') && pq) { ctl.set(upPath(pq)); return true; }
        return p.keys?.(k, it, ctl, q) ?? false;
      }} />
  );
}

// ---------- workspaces (mockup WS.menu, WS.rename) ----------
const closeWorkspace = (id: string) => {
  if (S.workspaces.length < 2) return;
  if (id === S.wid) A.switchWorkspace([...S.workspaces].filter(w => w.id !== id).sort((a, b) => b.usedAt - a.usedAt)[0].id);
  update(s => { s.workspaces = s.workspaces.filter(w => w.id !== id); s.tick++; });
  A.save();
};
const wsAnchor = () => rectOf('#status .wsb');

/** The one place to find, make and manage workspaces: type to filter or to name a new one; folders and machines
 *  as everywhere (a path may start with a machine, "linux:~/repo/"); r renames and d closes the one under the cursor. */
export function openWorkspaces(q0 = '') {
  openLayer(close => <DirPicker close={close} anchor={wsAnchor()} place="top-start" width={420} className="ws dirs" placeholder="Workspace, folder or path" value={q0}
    m0={ws().machine} hosts
    rows={(q, pq, dirRows) => {
      if (pq) return dirRows(pq);
      const name = q.trim(), lq = name.toLowerCase(), hit = (...t: string[]) => !lq || t.join(' ').toLowerCase().includes(lq);
      const many = S.workspaces.length > 1;
      const acts = (w: Workspace) => (
        <span className="wact">
          <button type="button" title="Rename · r" aria-label="Rename" onMouseDown={e => { e.preventDefault(); e.stopPropagation(); close(); renameWorkspace(w); }}><Icon name="pencil" /></button>
          <button type="button" title="Close workspace · d" aria-label="Close workspace" onMouseDown={e => { e.preventDefault(); e.stopPropagation(); closeWorkspace(w.id); close(); openWorkspaces(q); }}><Icon name="x" /></button>
        </span>);
      const known = S.machines.flatMap(m => knownDirs(m.id).map(dir => ({ m, dir }))).filter(x => !S.workspaces.some(w => w.machine === x.m.id && w.dir === x.dir) && hit(x.dir, x.m.name));
      const have = S.workspaces.some(w => w.name.toLowerCase() === lq);
      const c = here();
      const rows: DRow[] = [
        { head: true, label: 'Workspaces' },
        ...[...S.workspaces].sort((a, b) => b.usedAt - a.usedAt).filter(w => hit(w.name, w.dir, machine(w.machine)?.name ?? '')).map(w => {
          const r = wsRow(w);
          return { ...r, hint: `${machine(w.machine)?.name ?? w.machine} · ${tildify(w.machine, w.dir)}`, right: <>{wsWaiting(w) && <i className="wdot" title="A thread here is waiting for you" />}{many && acts(w)}</>, data: { ws: w.id } };
        }),
        { head: true, label: name ? 'Folders' : 'Recent folders' },
        ...known.slice(0, name ? 8 : 4).map(x => ({ label: base(x.dir), icon: <Icon name="folder" />, hint: `${x.m.name} · ${tildify(x.m.id, x.dir)}`, data: { dir: { m: x.m.id, dir: x.dir } } })),
        { head: true, label: 'Browse' },
        ...S.machines.filter(m => hit(m.name)).map(m => ({ label: m.name, icon: <Icon name={m.ssh ? 'host' : 'laptop'} />, hint: isUp(m) ? '~/' : 'not connected', right: m.ssh ? <i className={cx('wdot', isUp(m) ? 'up' : 'down')} /> : undefined, data: { into: m.name + ':~/' } })),
        ...(name ? [] : [{ label: 'Add a machine', icon: <Icon name="plus" />, data: { run: () => openMachines() } }]),
        ...(name && !have ? [{ head: true, label: 'New' }, { label: `New workspace “${name}”`, icon: <Icon name="plus" />, hint: 'in ' + tildify(c.machine, c.dir), data: { make: name } }] : []),
      ];
      return rows;
    }}
    keys={(k, it, ctl, q) => {
      const id = it?.data?.ws; if (!id) return false;
      const w = S.workspaces.find(x => x.id === id); if (!w) return false;
      if (k === 'r') { ctl.close(); renameWorkspace(w); return true; }
      if (k === 'd') { closeWorkspace(id); ctl.close(); openWorkspaces(q); return true; }
      return false;
    }}
    pick={(d, ctl) => {
      ctl.close();
      if (d.ws) { A.switchWorkspace(d.ws); return; }
      if (d.dir) { const hit = S.workspaces.find(w => w.machine === d.dir!.m && w.dir === d.dir!.dir); if (hit) A.switchWorkspace(hit.id); else A.newWorkspace(base(d.dir.dir), d.dir.m, d.dir.dir); return; }
      if (d.make) { const c = here(); A.newWorkspace(d.make, c.machine, c.dir); }
    }} />);
}

export function renameWorkspace(w: Workspace) {
  const a = wsAnchor();
  openMenu<string>({
    anchor: a, modal: !a, place: 'top-start', width: 400, className: cx('ws', !a && 'pal'), search: { prefix: 'Rename', value: w.name }, ranked: true,
    items: q => [{ label: q.trim() || w.name, icon: <WsMini tree={w.tree} />, hint: `${machine(w.machine)?.name ?? w.machine} · ${tildify(w.machine, w.dir)}`, data: w.id }],
    onPick: (_, q) => { const n = q.trim(); if (n) update(s => { w.name = n; s.tick++; }); A.save(); openWorkspaces(); },
  });
}

// ---------- a folder on one machine (mockup act.addProject, act.pickDir, Move.pickDir) ----------
/** The Dirs field for one machine: known folders (filtered as you type), the machine to browse, or a typed path.
 *  A machine's + (new project), a new thread's folder chip and Move's "Other folder…" all use it. */
export function openFolderPicker(mid: string, anchor: DOMRect | null, pick: (dir: string) => void,
  o: { place?: MenuProps['place']; width?: number; current?: string; exclude?: (dir: string) => boolean; recent?: boolean } = {}) {
  const m = machine(mid); if (!m) return;
  openLayer(close => <DirPicker close={close} anchor={anchor} place={o.place || 'bottom-start'} width={o.width || 320} className="dirs" placeholder={`Folder or path on ${m.name}`} m0={mid} hosts={false}
    rows={(q, pq, dirRows) => {
      if (pq) return dirRows(pq);
      const mm = machine(mid)!;
      if (!isUp(mm)) return dirRows({ m: mm, pre: '', parent: '~/', leaf: '' });
      const lq = q.trim().toLowerCase();
      const dirs = knownDirs(mid).filter(d => !o.exclude?.(d) && tildify(mid, d).toLowerCase().includes(lq)).slice(0, lq || !o.recent ? 8 : 5);
      return [{ head: true, label: o.recent && !lq ? 'Recent folders' : 'Folders' }, ...dirs.map(d => ({ label: tildify(mid, d), icon: <Icon name="folder" />, on: o.current === d, data: { dir: { m: mid, dir: d } } })),
        { head: true, label: 'Browse' }, { label: mm.name, icon: <Icon name={mm.ssh ? 'host' : 'laptop'} />, hint: '~/', data: { into: '~/' } }];
    }}
    pick={(d, ctl) => { if (!d.dir) return; ctl.close(); pick(d.dir.dir); }} />);
}

/** A machine's +: a folder with no threads yet becomes a project in the sidebar. */
export function openAddProject(mid: string, anchor: DOMRect, add: (dir: string) => void) {
  const known = (d: string) => S.threads.some(t => t.machine === mid && t.dir === d) || (S.projects[mid] || []).includes(d);
  openFolderPicker(mid, anchor, add, { exclude: known });
}

// ---------- machines (mockup act.machines) ----------
const marks = (m: Machine) => HARNESSES.map(h => <span key={h} className={cx('has', !m.has.includes(h) && 'no')} title={`${harnessName(h)} ${m.has.includes(h) ? 'installed' : 'not found'}`}><Icon name={h} /></span>);
export const sshAddr = (m: Machine) => (m.ssh ? `${m.ssh.user ? m.ssh.user + '@' : ''}${m.ssh.host}` : m.os || '');

/** Machines with their address, which harnesses they have and their link; picking one starts a new thread there. */
export function openMachines(anchor?: DOMRect | null) {
  const a = anchor || rectOf('#side .mbtn') || rectOf('#status');
  openMenu<string>({
    anchor: a, modal: !a, place: 'top-start', width: 330, className: cx('mach', !a && 'pal'),
    items: [{ head: true, label: 'Machines' },
      // the link's dot beside the name; the harness marks in one column at the right, lined up on every row
      ...S.machines.map(m => ({ label: m.name, display: <><span className="mn">{m.name}</span>{linkDot(m)}</>, icon: <Icon name={m.ssh ? 'host' : 'laptop'} />, hint: sshAddr(m), right: marks(m), data: m.id })),
      { label: 'Add SSH host', icon: <Icon name="plus" />, hint: 'from ~/.ssh/config', data: '' }],
    onPick: it => {
      if (!it.data) { void addHostMenu(); return; }
      const m = machine(it.data)!, p = A.focusedPane();
      update(s => { A.addTab(p, mkTab('new', { machine: m.id, dir: knownDirs(m.id)[0] || '~' })); ws().pf = null; s.sideFocus = false; s.tick++; });
      A.save();
      if (m.ssh && m.link !== 'up') void api.machines.connect(m.id);
    },
  });
}

let km: Keymap | null = null, kmSrc = '';
export function keymap(): Keymap {
  const src = S.settings.vimrc + '|' + S.info.platform;
  if (!km || kmSrc !== src) { km = Keymap.build(S.settings.vimrc, S.info.platform === 'mac' ? 'mac' : 'win'); kmSrc = src; }
  return km;
}

// ---------- vimrc ----------
/** The vimrc as a tab beside the current pane (an open one is reused). */
export function openVimrc() {
  const hit = allTabs(ws()).find(x => x.tab.kind === 'vimrc');
  if (hit?.pane) A.activate(hit.pane.id, hit.tab.id);
  else if (hit) update(s => { ws().pf = hit.tab.id; s.tick++; });
  else A.split('row', mkTab('vimrc'));
}
const setVimrc = async (text: string) => { const s = await api.app.setSettings({ vimrc: text }); update(st => { st.settings = s; }); };

// ---------- keyboard sheet (mockup Keys) ----------
// One short list. Rows whose action is a command can be rebound: enter (or a click), then the new key, optionally
// after the leader. The binding is written to the vimrc as an nnoremap line, so the sheet and the file agree.
interface KRow { label: string; def: string; cmd?: string }
const KEYS = (): [string, KRow[]][] => [
  ['Find', [{ label: 'Search threads and actions', def: kb('mod-k') }, { label: 'Search files in the project', def: kb('mod-p') }, { label: 'Search this pane and its thread', def: kb('mod-shift-a') }, { label: 'Search here: text, or filter the list', def: '/' }, { label: 'Command line', def: ':' }]],
  ['Panes', [{ label: 'Split right', cmd: 'vsplit', def: '|' }, { label: 'Split down', cmd: 'split', def: '\\' }, { label: 'Shell to the right', cmd: 'vshell', def: 'ldr %' },
    { label: 'Shell below', cmd: 'shell', def: 'ldr "' }, { label: 'Zoom pane', cmd: 'zoom', def: 'ldr z' }, { label: 'Focus a pane', def: kb('alt-h') + ' j k l' }]],
  ['Tabs', [{ label: 'New tab', cmd: 'tabnew', def: 'ldr c' }, { label: 'Close tab', cmd: 'q', def: 'ldr q' }, { label: 'Next tab', cmd: 'tabnext', def: 'L' },
    { label: 'Previous tab', cmd: 'tabprev', def: 'H' }, { label: 'Chat or terminal', cmd: 'view', def: 'ldr t' }]],
  ['Workspaces', [{ label: 'Switch workspace, most recent first', def: kb('ctrl-tab') }, { label: 'Search, create and manage', cmd: 'workspace', def: 'ldr w' }]],
  ['Threads', [{ label: 'Move in the sidebar', def: 'j k' }, { label: 'Open thread', def: 'enter' }, { label: 'Allow or deny a request', def: 'y n' },
    { label: 'Add selection to chat', def: kb('mod-l') }, { label: 'Add selection to a side chat', def: kb('mod-shift-s') },
    { label: 'Move to another folder or machine', cmd: 'moveto', def: 'ldr m' }]],
  ['Terminal', [{ label: 'Read the scrollback', def: 'ldr [' }, { label: 'Back to the program', def: 'i' }]],
  ['Editing', [{ label: 'Undo', def: 'u' }, { label: 'Redo', def: kb('ctrl-r') }]],
  ['Changes and files', [{ label: 'Switch or create a branch', cmd: 'branch', def: 'ldr g' }, { label: 'Search the file tree', def: 'f' }, { label: 'Stage the file under the cursor', def: 's' }, { label: 'Revert it (with Undo)', def: 'x' },
    { label: 'Show folded lines', def: 'enter' }, { label: 'Back, forward in an open file', def: kb('ctrl-o') + ' ' + kb('ctrl-i') }]],
];
const same = (a: string, b: string) => a === b || ALIASES[a] === b || ALIASES[b] === a;
/** The key the vimrc gives a command, if it gives one ('ldr x' for a leader map). */
function boundIn(vimrc: string, cmd: string): string | null {
  const rc = parseVimrc(vimrc);
  const l = rc.leader.filter(b => same(b.command, cmd)).pop(), n = rc.normal.filter(b => same(b.command, cmd)).pop();
  return l ? 'ldr ' + l.keys : n ? n.keys : null;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mapsTo = (cmd: string, l: string) => [cmd, ...Object.keys(ALIASES).filter(a => same(a, cmd))].some(c => new RegExp('^\\s*nnoremap\\s+\\S+\\s+:' + esc(c) + '<CR>', 'i').test(l));

export function openKeys() {
  openLayer(close => <KeysSheet close={close} />);
}
function KeysSheet({ close }: { close: () => void }) {
  const s = useApp();
  const groups = useState(KEYS)[0], rows = groups.flatMap(([, rs]) => rs);
  const [i, setI] = useState(0);
  const [cap, setCap] = useState<{ row: KRow; lead: boolean } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const edit = (n: number) => { setI(n); const r = rows[n]; if (r?.cmd) setCap({ row: r, lead: false }); };
  const reset = (n: number) => { setI(n); const r = rows[n]; if (r?.cmd) void setVimrc(S.settings.vimrc.split('\n').filter(l => !mapsTo(r.cmd!, l)).join('\n')); };
  // write the binding to the vimrc, replacing any line for this action or this key
  const bind = (r: KRow, key: string, lead: boolean) => {
    const lhs = (lead ? '<leader>' : '') + toVimKeys(key);
    const taken = (l: string) => { const m = /^\s*nnoremap\s+(\S+)\s/i.exec(l); return !!m && m[1] === lhs; };
    const lines = S.settings.vimrc.replace(/\n+$/, '').split('\n').filter(l => !mapsTo(r.cmd!, l) && !taken(l));
    lines.push(`nnoremap ${lhs} :${r.cmd}<CR>`, '');
    void setVimrc(lines.join('\n'));
  };
  // waiting for the new key: it takes every key first, the leader included
  useEffect(() => {
    if (!cap) return;
    captureKeys(e => {
      if (e.key === 'Escape') { setCap(null); return true; }
      if (e.ctrlKey && e.code === (S.settings.leader === 'ctrl-\\' ? 'Backslash' : 'Space')) { setCap({ ...cap, lead: true }); return true; }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey || e.key === ' ') return true;
      bind(cap.row, e.key, cap.lead); setCap(null); return true;
    });
    return () => captureKeys(null);
  }, [cap]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { list.current?.querySelector('.k-row.cur')?.scrollIntoView({ block: 'nearest' }); }, [i]);
  useDialogSurface({
    onEsc: close,
    key: k => {
      if (k === 'q' || k === '?') { close(); return true; }
      if (k === 'j' || k === 'down') { setI(Math.min(rows.length - 1, i + 1)); return true; }
      if (k === 'k' || k === 'up') { setI(Math.max(0, i - 1)); return true; }
      if (k === 'g') { setI(0); return true; }
      if (k === 'G') { setI(rows.length - 1); return true; }
      if (k === 'enter') { edit(i); return true; }
      if (k === 'x' || k === 'backspace') { reset(i); return true; }
      return k.length === 1;
    },
  }, [i, rows.length]);
  const chips = (str: string) => str.split(' ').map((x, n) => <kbd key={n}>{x}</kbd>);
  let n = -1;
  return (
    <Dialog onClose={close} className="keys2" label="Keyboard">
      <header><h3>Keyboard</h3><span className="sp" />
        <button type="button" className="btn sm" title="Bindings live in the vimrc" onClick={() => { close(); openVimrc(); }}><Icon name="sliders" />vimrc</button>
        <IconButton icon="x" label="Close" small onClick={close} />
      </header>
      <div className="k-list" ref={list}>
        {groups.map(([g, rs]) => <Fragment key={g}><h4>{g}</h4>
          {rs.map(r => {
            const at = ++n, set = r.cmd ? boundIn(s.settings.vimrc, r.cmd) : null, capping = cap?.row.label === r.label;
            return (
              <div key={r.label} className={cx('k-row', s.settings.vim && at === i && 'cur', r.cmd && 'can')} onClick={r.cmd ? () => edit(at) : undefined}>
                <span className="kl">{r.label}</span>
                {set && !capping && <button type="button" className="k-x" title={`Back to ${r.def}`} aria-label={`Back to ${r.def}`} onClick={e => { e.stopPropagation(); reset(at); }}><Icon name="retry" /></button>}
                <span className={cx('kk', capping && 'cap', set && 'set')}>{capping ? <>{cap!.lead && chips('ldr')}<i>press a key</i></> : chips(set || r.def)}</span>
              </div>);
          })}
        </Fragment>)}
      </div>
    </Dialog>
  );
}

// ---------- settings ----------
interface Row { label: string; desc?: string; seg?: [string, string][]; get?: () => string; set?: (v: string) => void; sw?: () => boolean; toggle?: () => void; btn?: string; run?: () => void; extra?: React.ReactNode; preview?: (v: string) => React.ReactNode }
/** A titled card of rows; the first group of a section usually has no title. */
interface Group { title?: string; rows: Row[] }

const SECTIONS = ['General', 'Appearance', 'Vim', 'Notifications', 'Machines'];
export function openSettings(section?: string, row?: number) { openLayer(close => <Settings close={close} section={section} row={row} />); }
export const setSetting = async (patch: Partial<typeof S.settings>) => { const s = await api.app.setSettings(patch); update(st => { st.settings = s; }); };

/** What a finished turn looks like at each density (Agent work), shown while choosing one. */
function DensityPreview({ d }: { d: string }) {
  const step = (verb: string, arg: string, diff?: boolean) => (
    <div className="dp-step"><span><b>{verb}</b> {arg}</span>{diff && <span className="dp-diff"><i className="del" /><i className="add" /><i className="add short" /></span>}</div>
  );
  return (
    <div className="dprev" aria-hidden>
      <div className="dp-fold">Worked for 42s<Icon name={d === 'compact' ? 'chev' : 'down'} size="sm" /></div>
      {d === 'balanced' && <div className="dp-run">Edited 2 files, ran 2 commands<Icon name="chev" size="sm" /></div>}
      {d === 'detailed' && <div className="dp-steps">{step('Edited', 'math.ts +4 -1', true)}{step('Edited', 'README.md +5 -1', true)}{step('Ran', 'npm test')}{step('Ran', 'npm run typecheck')}</div>}
      <div className="dp-answer">Fixed the rounding bug and added a test.</div>
    </div>
  );
}

// Keys (VIM-MODEL section 4, Settings): two lists side by side. The section list has the keys first: j / k move
// over sections (the page follows), l / enter / tab go into the section's rows. In the rows, j / k move,
// h / l lower and raise a row's value (a choice, a switch), enter presses it, and esc, shift-tab, or h on a row
// with no value go back to the section list. esc there closes. H / L (tabs elsewhere) do nothing in this dialog.
// The key cursor (a ring on the section, a filled row) shows only while the keys are in use (ui/modality).
function Settings({ close, section, row: row0 }: { close: () => void; section?: string; row?: number }) {
  const s = useApp();
  const [sec, setSec] = useState(() => Math.max(0, SECTIONS.indexOf(section || '')));
  const [row, setRow] = useState(row0 ?? 0);
  const [col, setCol] = useState<'nav' | 'rows'>(row0 != null ? 'rows' : 'nav');
  const [peek, setPeek] = useState<{ row: string; v: string } | null>(null);
  const { kb: keyed, onKey, pointer } = useKeyCursor();
  const cursor = s.settings.vim && keyed;
  const sections: [string, string, Group[]][] = [
    ['General', 'sliders', [{ rows: [
      { label: 'Default view', desc: 'How new threads open', seg: [['chat', 'Chat'], ['term', 'Terminal']], get: () => s.settings.defaultView, set: v => setSetting({ defaultView: v as never }) },
      { label: 'Sidebar', desc: 'How threads are listed', seg: [['grouped', 'By folder'], ['recent', 'Recent']], get: () => s.settings.sideView, set: v => setSetting({ sideView: v as never }) },
      { label: 'Messages during a turn', desc: 'Queue them for when it ends, or steer it now', seg: [['queue', 'Queue'], ['steer', 'Steer']], get: () => s.settings.followUp || 'queue', set: v => setSetting({ followUp: v as never }) },
      { label: 'On launch', desc: 'Reopen your last workspaces or start fresh', seg: [['restore', 'Restore'], ['empty', 'Start empty']], get: () => s.settings.launch || 'restore', set: v => setSetting({ launch: v as never }) },
    ] }]],
    ['Appearance', 'sun', [
      { rows: [{ label: 'Theme', desc: 'Light, dark, or match the system', seg: [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], get: () => s.settings.theme, set: v => setSetting({ theme: v as never }) }] },
      { title: 'Threads', rows: [
        { label: 'Agent work', desc: 'How much of each turn is shown', seg: DENSITY.map(d => [d, DENSITY_NAME[d]]), get: () => s.settings.density || 'compact', set: v => setSetting({ density: v as never }), preview: v => <DensityPreview d={v} /> },
      ] },
    ]],
    ['Vim', 'keyboard', [{ rows: [
      { label: 'Vim keys', desc: 'Modal editing in composers, menus and read-only text', sw: () => s.settings.vim, toggle: () => setSetting({ vim: !s.settings.vim }) },
      { label: 'Leader', desc: 'Starts pane and tab commands', seg: [['ctrl-space', kb('ctrl-space')], ['ctrl-\\', kb('ctrl-\\')]], get: () => s.settings.leader, set: v => setSetting({ leader: v as never }) },
      { label: 'vimrc', desc: '~/.config/skein/vimrc', btn: 'Edit', run: () => { close(); openVimrc(); } },
    ] }]],
    ['Notifications', 'bell', [{ rows: [
      { label: 'Notify me', desc: 'While Skein or the thread is out of sight', seg: [['waiting', 'Waiting on me'], ['replies', 'Every reply'], ['off', 'Never']], get: () => s.settings.notify, set: v => setSetting({ notify: v as never }) },
    ] }]],
    ['Machines', 'host', [{ rows: [
      ...s.machines.map(m => ({
        label: m.name, desc: m.ssh ? `${sshAddr(m)}${m.note && m.link !== 'up' ? ' · ' + m.note : ''}` : m.os,
        extra: <span className="s-meta">{marks(m)}{linkDot(m) || <span className="dot" style={{ visibility: 'hidden' }} />}</span>,
        btn: m.ssh && m.link !== 'up' ? 'Connect' : undefined, run: () => void api.machines.connect(m.id),
      })),
      { label: 'Add SSH host', desc: 'From ~/.ssh/config or user@host', btn: 'Add', run: () => addHostMenu() },
    ] }]],
  ];
  const groups = sections[sec][2];
  const rows = groups.flatMap(g => g.rows);
  const r = rows[Math.min(row, rows.length - 1)];
  const step = (x: Row, d: number) => { if (!x.seg || !x.get || !x.set) return; const i = x.seg.findIndex(o => o[0] === x.get!()); x.set(x.seg[(i + d + x.seg.length) % x.seg.length][0]); };
  const press = (x: Row) => { if (x.seg) step(x, 1); else if (x.toggle) x.toggle(); else x.run?.(); };
  const goSec = (i: number) => { setSec(Math.max(0, Math.min(sections.length - 1, i))); setRow(0); };
  useDialogSurface({
    onEsc: () => { onKey(); if (col === 'rows') setCol('nav'); else close(); },
    key: k => {
      onKey();
      if (k === 'q') { close(); return true; }
      if (col === 'nav') {
        if (k === 'j' || k === 'down') { goSec(sec + 1); return true; }
        if (k === 'k' || k === 'up') { goSec(sec - 1); return true; }
        if (k === 'G') { goSec(sections.length - 1); return true; }
        if (k === 'g') { goSec(0); return true; }
        if (k === 'l' || k === 'right' || k === 'enter' || k === 'tab' || k === 'space') { setCol('rows'); setRow(0); return true; }
        return k.length === 1 || k === 'shift-tab';
      }
      if (k === 'j' || k === 'down') { setRow(Math.min(rows.length - 1, row + 1)); return true; }
      if (k === 'k' || k === 'up') { setRow(Math.max(0, row - 1)); return true; }
      if (k === 'G') { setRow(rows.length - 1); return true; }
      if (k === 'g') { setRow(0); return true; }
      if (k === 'shift-tab') { setCol('nav'); return true; }
      if (k === 'l' || k === 'right') { if (r?.seg) step(r, 1); else if (r?.sw && !r.sw()) r.toggle?.(); return true; }
      if (k === 'h' || k === 'left') { if (r?.seg) step(r, -1); else if (r?.sw?.()) r.toggle?.(); else setCol('nav'); return true; }
      if (k === 'enter' || k === 'space') { if (r) press(r); return true; }
      return k.length === 1 || k === 'tab';
    },
  }, [sec, row, col, rows.length, s.settings]);
  let n = -1;
  return (
    <Dialog onClose={close} className="settings" label="Settings">
      <nav className={cx('settings-nav', cursor && col === 'nav' && 'kf')} {...pointer}><h4>Settings</h4>
        {sections.map(([name, i], k) => <button key={name} className={cx(k === sec && 'on')} aria-current={k === sec || undefined} onClick={() => { setSec(k); setRow(0); setCol('nav'); }}><Icon name={i} /><span>{name}</span></button>)}
      </nav>
      <section className="s-body" {...pointer}>
        <header><h3>{sections[sec][0]}</h3><IconButton icon="x" label="Close" small onClick={close} /></header>
        {groups.map((g, gi) => (
          <Fragment key={gi}>
            {g.title && <h4 className="s-group">{g.title}</h4>}
            <div className="s-card">
              {g.rows.map(x => {
                const i = ++n, cur = cursor && col === 'rows' && i === row;
                const shown = peek?.row === x.label ? peek.v : cur && x.preview && x.get ? x.get() : null;
                return (
                  <div key={x.label} className={cx('s-row', cur && 'cur')} onMouseMove={() => { if (i !== row || col !== 'rows') { setRow(i); setCol('rows'); } }}>
                    <div className="s-txt"><b>{x.label}</b>{x.desc && <span>{x.desc}</span>}</div>
                    {x.extra}
                    {x.seg ? <div className="seg txt" onMouseLeave={() => setPeek(null)}>{x.seg.map(([v, l]) => <button key={v} className={cx(x.get?.() === v && 'on')} aria-pressed={x.get?.() === v}
                        onMouseEnter={x.preview ? () => setPeek({ row: x.label, v }) : undefined} onClick={() => x.set?.(v)}>{l}</button>)}</div>
                      : x.sw ? <Switch large on={x.sw()} onChange={() => x.toggle?.()} label={x.label} />
                      : x.btn ? <button className="btn sm" onClick={() => x.run?.()}>{x.btn}</button> : null}
                    {shown && x.preview?.(shown)}
                  </div>
                );
              })}
            </div>
          </Fragment>
        ))}
      </section>
    </Dialog>
  );
}

export async function addHostMenu() {
  const hosts = await api.machines.sshHosts();
  openMenu<string>({
    modal: true, className: 'pal', search: { placeholder: 'Host from ~/.ssh/config, or user@host' },
    items: q => [...hosts.map(h => ({ label: h, icon: <Icon name="host" />, data: h })), ...(q.trim() && !hosts.includes(q.trim()) ? [{ label: `Add ${q.trim()}`, icon: <Icon name="plus" />, data: q.trim() }] : [])],
    empty: 'No hosts in ~/.ssh/config. Type user@host',
    onPick: async it => {
      const raw = it.data!; const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(raw);
      if (!m) return;
      const added = await api.machines.add(m[2], { host: m[2], user: m[1], port: m[3] ? +m[3] : undefined });
      update(s => { s.machines = [...s.machines.filter(x => x.id !== added.id), added]; });
      void api.machines.connect(added.id);
    },
  });
}

export type { Surface };
