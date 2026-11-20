// The sidebar: threads across workspaces, pinned first, then machine > project > thread (or most recent).
// It is a pane (VIM-MODEL section 4): leader h / alt-h from the leftmost pane focuses it.
import { useEffect, useRef, useState } from 'react';
import type { Machine, ThreadMeta } from '@shared/types';
import { kb } from '../input/platform';
import type { Surface } from '../input/dispatcher';
import { api } from '../api';
import * as A from '../state/actions';
import { allTabs, mkTab } from '../state/layout';
import { S, toast, update, useApp, ws } from '../state/store';
import { cx, Dot, Icon, IconButton, Spinner } from '../ui/primitives';
import { animate, MOTION } from '../ui/motion';
import { run } from './commands';
import { projectName } from './meta';
import { moveMenu, startThreadDrag } from './move';
import { openAddProject, openMachines, openMenu, openSettings } from './overlays';
import { showAuth } from './AuthDialog';
import { pending, useChat } from '../views/chat/state';
import { dragEdge, restoreEdge, SIDEBAR_EDGE } from '../ui/resize';

const LINK: Record<Machine['link'], ['green' | 'amber' | 'red', boolean, string]> = {
  up: ['green', false, 'Connected'], connecting: ['amber', true, 'Connecting'], reconnecting: ['amber', true, 'Reconnecting'], auth: ['amber', false, 'Needs you to sign in'], down: ['red', false, 'Not connected'],
};
const age = (t: number) => { const a = (Date.now() - t) / 60000; return a < 1 ? '' : a < 60 ? `${Math.round(a)}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`; };

export function ThreadStatus({ t }: { t: ThreadMeta }) {
  switch (t.status) {
    case 'running': return <Spinner />;
    case 'unread': return <Dot color="blue" label="Unread reply" />;
    case 'wait': return <WaitIcon id={t.id} />;
    case 'error': return <span className="thread-state" role="img" aria-label="Turn failed" title="Turn failed"><Icon name="alert" /></span>;
    default: return null;
  }
}

/** Waiting on you: an approval (a plan's own wording when it is a plan), from the thread's pending requests. */
function WaitIcon({ id }: { id: string }) {
  useChat();
  const plan = pending(id).some(e => e.request.kind === 'plan'), label = plan ? 'Awaiting plan approval' : 'Awaiting approval';
  return <span className="thread-state" role="img" aria-label={label} title={label}><Icon name="shield" /></span>;
}

/** Items in sidebar order, for j / k: headings ('fold:<key>') and threads (ids). */
function navOrder(): string[] {
  const out: string[] = [];
  const live = S.threads.filter(t => !t.archived && !t.side);
  const pinned = live.filter(t => t.pinned), rest = live.filter(t => !t.pinned);
  if (pinned.length) { out.push('fold:h:pinned'); if (!S.collapsed['h:pinned']) out.push(...pinned.map(t => t.id)); }
  if (S.settings.sideView === 'recent') { out.push('fold:h:recent'); if (!S.collapsed['h:recent']) out.push(...[...rest].sort((a, b) => b.updatedAt - a.updatedAt).map(t => t.id)); }
  else for (const m of S.machines) {
    const ts = rest.filter(t => t.machine === m.id); if (!hasProjects(m.id, ts)) continue;
    out.push('fold:h:' + m.id); if (S.collapsed['h:' + m.id]) continue;
    for (const d of dirsOf(m.id, ts)) { const k = m.id + ':' + d; out.push('fold:' + k); if (!S.collapsed[k]) out.push(...ts.filter(t => t.dir === d).sort((a, b) => b.updatedAt - a.updatedAt).map(t => t.id)); }
  }
  return out;
}
/** A machine's projects: folders with threads (most recent first) and folders added with its +, in the order
 *  they were dragged into. */
function dirsOf(m: string, ts: ThreadMeta[]): string[] {
  const dirs = new Set([...[...ts].sort((a, b) => b.updatedAt - a.updatedAt).map(t => t.dir), ...(S.projects[m] || [])]);
  const saved = (S.dirOrder[m] || []).filter(d => dirs.delete(d));
  return saved.concat([...dirs]);
}
const hasProjects = (m: string, ts: ThreadMeta[]) => ts.length > 0 || (S.projects[m] || []).length > 0;

const fold = (k: string) => update(s => { s.collapsed = { ...s.collapsed, [k]: !s.collapsed[k] }; });
const archive = (t: ThreadMeta) => { void api.threads.update(t.id, { archived: !t.archived }); };
const pin = (t: ThreadMeta) => { void api.threads.update(t.id, { pinned: !t.pinned }); };
function newIn(machine: string, dir: string) {
  const p = A.focusedPane();
  update(s => { A.addTab(p, mkTab('new', { machine, dir })); s.sideFocus = false; s.tick++; });
}

/** A machine's +: a folder with no threads yet becomes a project in the sidebar (Folders, or Browse the machine). */
function addProject(mid: string, el: HTMLElement) {
  openAddProject(mid, el.getBoundingClientRect(), d => {
    const k = mid + ':' + d;
    update(s => {
      if (!S.threads.some(t => t.machine === mid && t.dir === d) && !(s.projects[mid] || []).includes(d)) s.projects = { ...s.projects, [mid]: [...(s.projects[mid] || []), d] };
      s.collapsed = { ...s.collapsed, ['h:' + mid]: false, [k]: false }; s.sideCursor = 'fold:' + k;
    });
    A.save();
    toast(<span>Added <b>{projectName(mid, d)}</b></span>, { icon: 'folder' });
  });
}
function machineActions(mid: string, el: HTMLElement) {
  const k = 'h:' + mid;
  openMenu<() => void>({
    anchor: el.getBoundingClientRect(), place: 'bottom-start', width: 200,
    items: [
      { label: S.collapsed[k] ? 'Expand section' : 'Collapse section', icon: <Icon name="tree" />, data: () => fold(k) },
      { label: 'Machine settings', icon: <Icon name="sliders" />, data: () => openSettings('Machines', Math.max(0, S.machines.findIndex(m => m.id === mid))) },
    ],
    onPick: it => it.data?.(),
  });
}
/** Rename in place (double-click a thread or project): enter keeps it, esc puts the old name back. */
function NameEdit({ value, onDone, label }: { value: string; onDone: (v: string | null) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (v: string | null) => { if (done.current) return; done.current = true; update(s => { s.sideEdit = null; }); onDone(v); };
  return <input ref={ref} className="sidebar-name-input" aria-label={label} defaultValue={value} spellCheck={false}
    onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
    onKeyDown={e => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(e.currentTarget.value.trim()); }
    }}
    onBlur={e => finish(e.currentTarget.value.trim())} />;
}
const renameThread = (t: ThreadMeta, v: string | null) => { if (v && v !== t.title) void api.threads.update(t.id, { title: v }); };
const renameProject = (m: string, d: string, v: string | null) => {
  if (v == null || v === projectName(m, d)) return;
  update(s => { const n = { ...s.names }; if (v) n[m + ':' + d] = v; else delete n[m + ':' + d]; s.names = n; }); A.save();
};

/** Drag a project row up or down among its machine's projects. */
function startProjectDrag(e: React.MouseEvent, m: string, d: string) {
  if (e.button !== 0 || S.sideEdit) return;
  const src = e.currentTarget as HTMLElement, x0 = e.clientX, y0 = e.clientY;
  let on = false, over: HTMLElement | null = null, edge: 'before' | 'after' = 'before', preview: HTMLElement | null = null;
  const unmark = () => { if (over) delete over.dataset.dropEdge; over = null; };
  const mv = (ev: MouseEvent) => {
    if (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!on) {
      on = true; src.classList.add('drag-source'); document.body.classList.add('dragging-thread'); document.getSelection()?.removeAllRanges();
      // the project's folder and name follow the pointer (the mockup's drag image)
      preview = document.createElement('div'); preview.className = 's-d drag-preview';
      for (const sel of ['.project-folder', '.t']) { const n = src.querySelector(sel); if (n) preview.append(n.cloneNode(true)); }
      document.body.append(preview);
    }
    if (preview) preview.style.transform = `translate(${ev.clientX - 12}px, ${ev.clientY - 15}px)`;
    unmark();
    const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('#side .s-d');
    if (!row || row === src || row.dataset.machine !== m) return;
    const r = row.getBoundingClientRect(); edge = ev.clientY < r.top + r.height / 2 ? 'before' : 'after';
    row.dataset.dropEdge = edge; over = row;
  };
  const up = () => {
    removeEventListener('mousemove', mv); removeEventListener('mouseup', up, true);
    if (!on) return;
    preview?.remove(); preview = null;
    src.classList.remove('drag-source'); document.body.classList.remove('dragging-thread');
    const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', swallow, true); setTimeout(() => removeEventListener('click', swallow, true), 0);
    const target = over?.dataset.dir; unmark();
    if (!target) return;
    const order = dirsOf(m, S.threads.filter(t => t.machine === m && !t.archived && !t.side && !t.pinned)).filter(x => x !== d);
    order.splice(order.indexOf(target) + (edge === 'after' ? 1 : 0), 0, d);
    update(s => { s.dirOrder = { ...s.dirOrder, [m]: order }; }); A.save();
  };
  addEventListener('mousemove', mv); addEventListener('mouseup', up, true);
}

const sideSurface: Surface = {
  kind: 'list',
  mode: () => 'NORMAL',
  key: k => {
    const order = navOrder(), i = order.indexOf(S.sideCursor || ''), cur = order[i];
    const go = (j: number) => { const n = order[Math.max(0, Math.min(order.length - 1, j))]; if (n) update(s => { s.sideCursor = n; }); };
    const isFold = !!cur?.startsWith('fold:'), key = cur?.slice(5), t = !isFold ? S.threads.find(x => x.id === cur) : undefined;
    switch (k) {
      case 'j': case 'down': go(i + 1); return true;
      case 'k': case 'up': go(i - 1); return true;
      case 'g': go(0); return true;
      case 'G': go(order.length - 1); return true;
      case 'h': case 'left':
        if (isFold && !S.collapsed[key!]) { fold(key!); return true; }
        if (t) { const parent = S.settings.sideView === 'recent' ? 'fold:h:recent' : t.pinned ? 'fold:h:pinned' : `fold:${t.machine}:${t.dir}`; update(s => { s.sideCursor = parent; }); }
        return true;
      case 'l': case 'right':
        if (isFold && S.collapsed[key!]) { fold(key!); return true; }
        if (isFold) { go(i + 1); return true; }
        A.sideFocus(false); return true;
      case 'enter': case 'o': case 'O': case 'shift-enter':
        if (isFold) { fold(key!); return true; }
        if (t) A.openThread(t.id, { split: k === 'O' || k === 'shift-enter' });
        return true;
      case '/': searchSidebar(); return true;
      case 'x': if (t) { go(i + 1); archive(t); } return true;
      case 'p': if (t) pin(t); return true;
      case 'm': {
        const row = t && !t.archived ? document.querySelector<HTMLElement>(`#side .row[data-thread="${CSS.escape(t.id)}"]`) : null;
        if (t && row) moveMenu(t.id, row);
        return true;
      }
      case 'c': {
        const target = t || (key && !key.startsWith('h:') ? { machine: key.split(':')[0], dir: key.slice(key.indexOf(':') + 1) } : null);
        if (target) newIn(target.machine, target.dir); return true;
      }
      case 'esc': A.sideFocus(false); return true;
    }
    return false;   // the app's NORMAL layer gets the rest (: H L | \ ?); the dispatcher drops what nobody takes
  },
};
export const sidebarSurface = sideSurface;

/** `/` in the sidebar (or app NORMAL with the sidebar cursor showing): filter its threads by title, project or
 *  machine. Enter puts the sidebar cursor on the pick (VIM-MODEL rule 22: `/` is always a search where you are). */
export function searchSidebar() {
  const rows = navOrder().filter(x => !x.startsWith('fold:')).map(id => S.threads.find(t => t.id === id)).filter((t): t is ThreadMeta => !!t);
  const top = document.querySelector('#side .s-nav')?.getBoundingClientRect() ?? document.querySelector('#side')?.getBoundingClientRect() ?? null;
  openMenu<string>({
    anchor: top, place: 'bottom-start', width: Math.max(220, (top?.width ?? 260) - 8), className: 'side-q',
    search: { placeholder: 'Filter threads', prefix: '/' }, empty: 'No matching threads',
    items: rows.map(t => ({ label: t.title, hint: `${projectName(t.machine, t.dir)}`, icon: <Icon name={t.harness} size="hm" />, data: t.id })),
    onPick: it => { if (!it.data) return; const id = it.data; update(s => { s.sideFocus = true; s.sideOpen = true; s.sideCursor = id; s.tick++; }); requestAnimationFrame(() => document.querySelector(`#side .row[data-thread="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })); },
  });
}

/** App NORMAL with nothing to type into (the layout surface): j / k (and the arrows) move the sidebar cursor among
 *  threads without focusing the sidebar, enter / o open it, O / shift-enter in a split (mockup keys.js App NORMAL). */
export function cursorKey(k: string): boolean {
  const letters = S.settings.vim;
  const step = k === 'down' || (letters && k === 'j') ? 1 : k === 'up' || (letters && k === 'k') ? -1 : 0;
  if (step) {
    const order = navOrder().filter(x => !x.startsWith('fold:'));
    if (!order.length) return true;
    let i = order.indexOf(S.sideCursor || '');
    if (i < 0) { const t = A.currentTab(); i = t.thread ? order.indexOf(t.thread) : -1; }
    const n = order[Math.max(0, Math.min(order.length - 1, i + step))];
    update(s => { s.sideCursor = n; s.tick++; });
    requestAnimationFrame(() => document.querySelector(`#side .row[data-thread="${CSS.escape(n)}"]`)?.scrollIntoView({ block: 'nearest' }));
    return true;
  }
  const open = k === 'enter' || (letters && k === 'o'), split = k === 'shift-enter' || (letters && k === 'O');
  if (open || split) {
    const t = S.sideCursor && S.threads.find(x => x.id === S.sideCursor);
    if (t) A.openThread(t.id, { split });
    return true;
  }
  return false;
}

/** Fold or unfold under a heading: its chevron turns from where it was (the mockup's redrawDisclosure). */
function turn(head: HTMLElement, change: () => void) {
  const ch = head.querySelector('.ch'); const from = ch && getComputedStyle(ch).transform;
  change();
  requestAnimationFrame(() => { if (ch && from) animate(ch, [{ transform: from }, { transform: getComputedStyle(ch).transform }], MOTION.base); });
}

/** A click in the sidebar gives it the keys (a click in the panes takes them back); the cursor is re-picked
 *  when it is on nothing visible: the thread on screen, else the first row. */
function takeKeys() {
  if (S.sideFocus) return;
  const order = navOrder();
  update(s => {
    s.sideFocus = true;
    if (!s.sideCursor || !order.includes(s.sideCursor)) { const t = A.currentTab(); s.sideCursor = t.thread && order.includes(t.thread) ? t.thread : order[0] ?? null; }
    s.tick++;
  });
}

/** A new thread's row, or one just moved, flashes (.fresh) for a few seconds. */
const fresh = new Set<string>();
let seen: Map<string, string> | null = null;
function noticeFresh() {
  const now = new Map(S.threads.filter(t => !t.side).map(t => [t.id, t.machine + '\0' + t.dir]));
  if (seen) for (const t of S.threads) {
    if (t.side || t.discovered || t.archived) continue;
    const was = seen.get(t.id);
    if (was === undefined || was !== now.get(t.id)) {
      fresh.add(t.id);
      setTimeout(() => { fresh.delete(t.id); update(); }, 3000);
    }
  }
  seen = now;
}

/** Open in some tab of this workspace (the row is tinted). */
const shown = (id: string) => allTabs(ws()).some(x => x.tab.kind === 'thread' && x.tab.thread === id);

let rowClick: ReturnType<typeof setTimeout> | undefined;
function Row({ t, d, sfx }: { t: ThreadMeta; d?: number; sfx?: boolean }) {
  const s = useApp();
  const ft = A.currentTab();
  const m = s.machines.find(x => x.id === t.machine);
  const ref = useRef<HTMLDivElement>(null);
  const cur = s.sideCursor === t.id;
  const editing = s.sideEdit === 'thread:' + t.id;
  useEffect(() => { if (cur && s.sideFocus) ref.current?.scrollIntoView({ block: 'nearest' }); }, [cur, s.sideFocus]);
  return (
    <div ref={ref} className={cx('row', shown(t.id) && 'vis', fresh.has(t.id) && 'fresh', ft.kind === 'thread' && ft.thread === t.id && 'foc', cur && 'cur')} style={{ ['--d' as string]: d || 0 }} data-thread={t.id}
      title={`${t.title} · ${m?.name ?? t.machine} ${t.dir}`}
      onClick={e => {
        // a double-click renames, so a plain click waits to see if a second one follows (as the mockup does)
        clearTimeout(rowClick);
        if (editing || e.detail > 1) return;
        // any modifier opens it in a split; opening hands the keys to the thread
        const mod = e.shiftKey || e.altKey || e.ctrlKey || e.metaKey;
        if (mod || !e.detail) { A.openThread(t.id, { split: mod }); return; }
        rowClick = setTimeout(() => A.openThread(t.id), 350);
      }}
      onDoubleClick={() => { clearTimeout(rowClick); if (!t.archived) update(x => { x.sideEdit = 'thread:' + t.id; }); }}
      onMouseDown={e => { if (!editing) startThreadDrag(e, t); }}>
      <Icon name={t.harness} size="hm" />
      <span className="t">{editing ? <NameEdit value={t.title} label="Thread name" onDone={v => renameThread(t, v)} /> : t.title}</span>
      {sfx && <span className={cx('sfx', m?.ssh && 'ssh')}>{m?.ssh && <Icon name="host" />}<span>{projectName(t.machine, t.dir)}</span></span>}
      <span className="row-actions">
        {!t.archived && <button aria-label={t.pinned ? 'Unpin' : 'Pin'} title={t.pinned ? 'Unpin' : 'Pin'} onClick={e => { e.stopPropagation(); pin(t); }}><Icon name="pin" /></button>}
        <button aria-label={t.archived ? 'Restore thread' : 'Archive thread'} title={t.archived ? 'Restore thread' : 'Archive thread'} onClick={e => { e.stopPropagation(); archive(t); }}><Icon name={t.archived ? 'retry' : 'archive'} /></button>
      </span>
      <span className="st">{t.status === 'idle' ? <span className="age">{age(t.updatedAt)}</span> : <ThreadStatus t={t} />}</span>
    </div>
  );
}

function Head({ k, label, m }: { k: string; label: string; m?: Machine }) {
  const s = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const cur = s.sideFocus && s.sideCursor === 'fold:' + k;
  const toggle = () => { if (ref.current) turn(ref.current, () => fold(k)); };
  return (
    <div ref={ref} className={cx('s-h', s.collapsed[k] && 'shut', cur && 'cur')} onClick={toggle} title={m ? (m.ssh ? 'Remote machine (SSH)' : 'Local machine') : undefined} data-machine={m?.id}>
      <span>{label}</span>
      {m && <Icon name={m.ssh ? 'host' : 'laptop'} className="machine-kind" />}
      {m?.ssh && (m.link === 'auth' || m.link === 'down'
        ? <button className="mlink" title={m.link === 'auth' ? `Sign in to ${m.name}` : m.note || LINK[m.link][2]} aria-label={m.link === 'auth' ? `Sign in to ${m.name}` : `Connect to ${m.name}`} onClick={e => { e.stopPropagation(); if (m.link !== 'auth' || !showAuth(m.id)) void api.machines.connect(m.id); }}><Dot color={LINK[m.link][0]} label={LINK[m.link][2]} /></button>
        : <Dot color={LINK[m.link][0]} pulse={LINK[m.link][1]} label={LINK[m.link][2]} />)}
      <Icon name="chev" className="ch" />
      {m && <span className="machine-actions" onClick={e => e.stopPropagation()}>
        <IconButton icon="dots" label={`Actions for ${m.name}`} small onClick={e => machineActions(m.id, e.currentTarget)} />
        <IconButton icon="plus" label={`Add a project on ${m.name}`} small onClick={e => addProject(m.id, e.currentTarget)} />
      </span>}
    </div>
  );
}

function Group({ k, children }: { k: string; children: React.ReactNode }) {
  const s = useApp();
  return <div className="sidebar-group" inert={!!s.collapsed[k]}><div>{children}</div></div>;
}

/** The sidebar's width: drag its right edge (200 px to 60% of the window). Kept on this computer. */
const resizeSide = dragEdge(SIDEBAR_EDGE);

export function Sidebar() {
  const s = useApp();
  if (s.threads.length || seen) noticeFresh();   // threads change in place, so compare every render (cheap)
  // ages ("3m", "2h") move on by themselves: redraw twice a minute
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(i); }, []);
  useEffect(() => restoreEdge(SIDEBAR_EDGE), []);
  const live = s.threads.filter(t => !t.archived && !t.side);
  const pinned = live.filter(t => t.pinned), rest = live.filter(t => !t.pinned), archived = s.threads.filter(t => t.archived && !t.side);
  return (
    <aside id="side" className={cx(s.sideFocus && 'focus')} onMouseDown={e => { if (!(e.target as HTMLElement).closest('input, .s-top, .s-nav, .s-foot, .side-resize')) takeKeys(); }}>
      <div className="s-top">
        <IconButton icon="sidebar" label="Hide sidebar" keys="ldr b" onClick={() => run('sidebar')} />
        <IconButton icon="search" label="Search" keys="mod-k" onClick={() => run('palette')} />
        <span className="sp" />
        <IconButton icon={s.settings.sideView === 'grouped' ? 'tree' : 'clock'} label={s.settings.sideView === 'grouped' ? 'Grouped by machine and folder' : 'Most recently active'} title={`${s.settings.sideView === 'grouped' ? 'Grouped by machine and folder' : 'Most recently active'} · click to switch`}
          onClick={async () => { const v = await api.app.setSettings({ sideView: s.settings.sideView === 'grouped' ? 'recent' : 'grouped' }); update(x => { x.settings = v; }); }} />
      </div>
      <div className="s-nav"><button className="nav" onClick={() => run('tabnew')}><Icon name="compose" /><span>New thread</span></button></div>
      <div className="s-list">
        {pinned.length > 0 && <><Head k="h:pinned" label="Pinned" /><Group k="h:pinned">{pinned.map(t => <Row key={t.id} t={t} />)}</Group></>}
        {s.settings.sideView === 'recent'
          ? <><Head k="h:recent" label="Recent" /><Group k="h:recent">{[...rest].sort((a, b) => b.updatedAt - a.updatedAt).map(t => <Row key={t.id} t={t} sfx />)}</Group></>
          : s.machines.map(m => {
            const ts = rest.filter(t => t.machine === m.id);
            if (!hasProjects(m.id, ts) && !m.ssh) return null;
            return (
              <div key={m.id}>
                <Head k={'h:' + m.id} label={m.name} m={m} />
                <Group k={'h:' + m.id}>
                  {dirsOf(m.id, ts).map(d => {
                    const k = m.id + ':' + d, shut = s.collapsed[k], editing = s.sideEdit === 'dir:' + k;
                    return (
                      <div key={k}>
                        <div className={cx('s-d', s.sideFocus && s.sideCursor === 'fold:' + k && 'cur')} onClick={() => { if (!editing) fold(k); }} title={d} data-machine={m.id} data-dir={d}
                          onDoubleClick={() => update(x => { x.sideEdit = 'dir:' + k; })} onMouseDown={e => { if (!editing && !(e.target as HTMLElement).closest('button')) startProjectDrag(e, m.id, d); }}>
                          <Icon name={shut ? 'folder' : 'folderOpen'} className="project-folder" />
                          <span className="t">{editing ? <NameEdit value={projectName(m.id, d)} label="Project name" onDone={v => renameProject(m.id, d, v)} /> : projectName(m.id, d)}</span>
                          <IconButton icon="compose" label={`New thread in ${d}`} small className="add" onClick={e => { e.stopPropagation(); newIn(m.id, d); }} />
                        </div>
                        <div className="project-threads" inert={!!shut}><div>{ts.filter(t => t.dir === d).sort((a, b) => b.updatedAt - a.updatedAt).map(t => <Row key={t.id} t={t} d={1} />)}</div></div>
                      </div>
                    );
                  })}
                </Group>
              </div>
            );
          })}
        <div className={cx('s-arch', s.archiveOpen && 'expanded')} onClick={e => turn(e.currentTarget, () => update(x => { x.archiveOpen = !x.archiveOpen; }))}><Icon name="chev" className="ch" /><span>Archived</span></div>
        {s.archiveOpen && archived.map(t => <Row key={t.id} t={t} sfx />)}
      </div>
      <div className="s-foot">
        <button className="mbtn" title="Machines" aria-label="Machines" onClick={e => openMachines(e.currentTarget.getBoundingClientRect())}><Icon name="host" /></button>
        <span className="sp" />
        <IconButton icon="keyboard" label="Keyboard" keys="?" onClick={() => run('keys')} />
        <IconButton icon="sliders" label="Settings" onClick={() => run('settings')} />
      </div>
      <div className="side-resize" title="Drag to resize sidebar" onPointerDown={resizeSide} />
    </aside>
  );
}
export { kb };
