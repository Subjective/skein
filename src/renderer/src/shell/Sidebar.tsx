// The sidebar: threads across workspaces, pinned first, then machine > project > thread (or most recent).
// It is a pane (VIM-MODEL section 4): leader h / alt-h from the leftmost pane focuses it.
import { useEffect, useRef } from 'react';
import type { Machine, ThreadMeta } from '@shared/types';
import { kb } from '../input/platform';
import type { Surface } from '../input/dispatcher';
import { api } from '../api';
import * as A from '../state/actions';
import { mkTab } from '../state/layout';
import { S, update, useApp } from '../state/store';
import { cx, Dot, Icon, IconButton, Spinner } from '../ui/primitives';
import { animate, MOTION } from '../ui/motion';
import { run } from './commands';
import { projectName } from './meta';
import { moveMenu, startThreadDrag } from './move';

const LINK: Record<Machine['link'], ['green' | 'amber' | 'red', boolean, string]> = {
  up: ['green', false, 'Connected'], connecting: ['amber', true, 'Connecting'], reconnecting: ['amber', true, 'Reconnecting'], auth: ['amber', false, 'Needs you to sign in'], down: ['red', false, 'Not connected'],
};
const age = (t: number) => { const a = (Date.now() - t) / 60000; return a < 1 ? '' : a < 60 ? `${Math.round(a)}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`; };

export function ThreadStatus({ t }: { t: ThreadMeta }) {
  switch (t.status) {
    case 'running': return <Spinner />;
    case 'unread': return <Dot color="blue" label="Unread reply" />;
    case 'wait': return <span className="thread-state" role="img" aria-label="Waiting on you" title="Waiting on you"><Icon name="shield" /></span>;
    case 'error': return <span className="thread-state" role="img" aria-label="Turn failed" title="Turn failed"><Icon name="alert" /></span>;
    default: return null;
  }
}


/** Items in sidebar order, for j / k: headings ('fold:<key>') and threads (ids). */
function navOrder(): string[] {
  const out: string[] = [];
  const live = S.threads.filter(t => !t.archived && !t.side);
  const pinned = live.filter(t => t.pinned), rest = live.filter(t => !t.pinned);
  if (pinned.length) { out.push('fold:h:pinned'); if (!S.collapsed['h:pinned']) out.push(...pinned.map(t => t.id)); }
  if (S.settings.sideView === 'recent') { out.push('fold:h:recent'); if (!S.collapsed['h:recent']) out.push(...[...rest].sort((a, b) => b.updatedAt - a.updatedAt).map(t => t.id)); }
  else for (const m of S.machines) {
    const ts = rest.filter(t => t.machine === m.id); if (!ts.length) continue;
    out.push('fold:h:' + m.id); if (S.collapsed['h:' + m.id]) continue;
    for (const d of dirsOf(ts)) { const k = m.id + ':' + d; out.push('fold:' + k); if (!S.collapsed[k]) out.push(...ts.filter(t => t.dir === d).sort((a, b) => b.updatedAt - a.updatedAt).map(t => t.id)); }
  }
  return out;
}
const dirsOf = (ts: ThreadMeta[]) => [...new Set([...ts].sort((a, b) => b.updatedAt - a.updatedAt).map(t => t.dir))];

const fold = (k: string) => update(s => { s.collapsed = { ...s.collapsed, [k]: !s.collapsed[k] }; });
const archive = (t: ThreadMeta) => { void api.threads.update(t.id, { archived: !t.archived }); };
const pin = (t: ThreadMeta) => { void api.threads.update(t.id, { pinned: !t.pinned }); };
function newIn(machine: string, dir: string) {
  const p = A.focusedPane();
  update(s => { A.addTab(p, mkTab('new', { machine, dir })); s.sideFocus = false; s.tick++; });
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
    return k.length === 1;
  },
};
export const sidebarSurface = sideSurface;

function Row({ t, d, sfx }: { t: ThreadMeta; d?: number; sfx?: boolean }) {
  const s = useApp();
  const ft = A.currentTab();
  const m = s.machines.find(x => x.id === t.machine);
  const ref = useRef<HTMLDivElement>(null);
  const cur = s.sideCursor === t.id;
  useEffect(() => { if (cur && s.sideFocus) ref.current?.scrollIntoView({ block: 'nearest' }); }, [cur, s.sideFocus]);
  return (
    <div ref={ref} className={cx('row', ft.kind === 'thread' && ft.thread === t.id && 'foc', cur && 'cur')} style={{ ['--d' as string]: d || 0 }} data-thread={t.id}
      title={`${t.title} · ${m?.name ?? t.machine} ${t.dir}`} onClick={e => A.openThread(t.id, { split: e.shiftKey })} onMouseDown={e => startThreadDrag(e, t)}>
      <Icon name={t.harness} size="hm" />
      <span className="t">{t.title}</span>
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
  const toggle = () => {
    const ch = ref.current?.querySelector('.ch'); const from = ch && getComputedStyle(ch).transform;
    fold(k);
    requestAnimationFrame(() => { if (ch && from) animate(ch, [{ transform: from }, { transform: getComputedStyle(ch).transform }], MOTION.base); });
  };
  return (
    <div ref={ref} className={cx('s-h', s.collapsed[k] && 'shut', cur && 'cur')} onClick={toggle} title={m ? (m.ssh ? 'Remote machine (SSH)' : 'Local machine') : undefined} data-machine={m?.id}>
      <span>{label}</span>
      {m && <Icon name={m.ssh ? 'host' : 'laptop'} className="machine-kind" />}
      {m?.ssh && (m.link === 'auth' || m.link === 'down'
        ? <button className="mlink" title={m.note || LINK[m.link][2]} onClick={e => { e.stopPropagation(); void api.machines.connect(m.id); }}><Dot color={LINK[m.link][0]} label={LINK[m.link][2]} /></button>
        : <Dot color={LINK[m.link][0]} pulse={LINK[m.link][1]} label={LINK[m.link][2]} />)}
      <Icon name="chev" className="ch" />
    </div>
  );
}

function Group({ k, children }: { k: string; children: React.ReactNode }) {
  const s = useApp();
  return <div className="sidebar-group" inert={!!s.collapsed[k]}><div>{children}</div></div>;
}

export function Sidebar() {
  const s = useApp();
  const live = s.threads.filter(t => !t.archived && !t.side);
  const pinned = live.filter(t => t.pinned), rest = live.filter(t => !t.pinned), archived = s.threads.filter(t => t.archived && !t.side);
  return (
    <aside id="side" className={cx(s.sideFocus && 'focus')} onMouseDown={() => { if (!s.sideFocus) update(x => { x.sideFocus = false; }); }}>
      <div className="s-top">
        <IconButton icon="sidebar" label="Hide sidebar" keys="ldr b" onClick={() => run('sidebar')} />
        <IconButton icon="search" label="Search" keys="mod-k" onClick={() => run('palette')} />
        <span className="sp" />
        <IconButton icon={s.settings.sideView === 'grouped' ? 'tree' : 'clock'} label={s.settings.sideView === 'grouped' ? 'Grouped by machine and folder' : 'Most recently active'}
          onClick={async () => { const v = await api.app.setSettings({ sideView: s.settings.sideView === 'grouped' ? 'recent' : 'grouped' }); update(x => { x.settings = v; }); }} />
      </div>
      <div className="s-nav"><button className="nav" onClick={() => run('tabnew')}><Icon name="compose" /><span>New thread</span></button></div>
      <div className="s-list">
        {pinned.length > 0 && <><Head k="h:pinned" label="Pinned" /><Group k="h:pinned">{pinned.map(t => <Row key={t.id} t={t} />)}</Group></>}
        {s.settings.sideView === 'recent'
          ? <><Head k="h:recent" label="Recent" /><Group k="h:recent">{[...rest].sort((a, b) => b.updatedAt - a.updatedAt).map(t => <Row key={t.id} t={t} sfx />)}</Group></>
          : s.machines.map(m => {
            const ts = rest.filter(t => t.machine === m.id);
            if (!ts.length && !m.ssh) return null;
            return (
              <div key={m.id}>
                <Head k={'h:' + m.id} label={m.name} m={m} />
                <Group k={'h:' + m.id}>
                  {dirsOf(ts).map(d => {
                    const k = m.id + ':' + d, shut = s.collapsed[k];
                    return (
                      <div key={k}>
                        <div className={cx('s-d', s.sideFocus && s.sideCursor === 'fold:' + k && 'cur')} onClick={() => fold(k)} title={d} data-machine={m.id} data-dir={d}>
                          <Icon name={shut ? 'folder' : 'folderOpen'} className="project-folder" />
                          <span className="t">{projectName(m.id, d)}</span>
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
        {archived.length > 0 && <div className={cx('s-arch', s.archiveOpen && 'expanded')} onClick={() => update(x => { x.archiveOpen = !x.archiveOpen; })}><Icon name="chev" className="ch" /><span>Archived</span></div>}
        {s.archiveOpen && archived.map(t => <Row key={t.id} t={t} sfx />)}
      </div>
      <div className="s-foot">
        <button className="mbtn" title="Machines" aria-label="Machines" onClick={() => run('settings')}><Icon name="host" /></button>
        <span className="sp" />
        <IconButton icon="keyboard" label="Keyboard" keys="?" onClick={() => run('keys')} />
        <IconButton icon="sliders" label="Settings" onClick={() => run('settings')} />
      </div>
    </aside>
  );
}
export { kb };
