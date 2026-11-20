// Panes, splits, tab bars and popups for the workspace on screen.
import { useEffect, useRef, type ReactNode } from 'react';
import * as A from '../state/actions';
import { activeTab, leaves, type Node, type Pane, type Split, type Tab } from '../state/layout';
import { S, thread, update, useApp, ws } from '../state/store';
import { cx, Icon, IconButton, Seg } from '../ui/primitives';
import { ChatView } from '../views/chat/ChatView';
import { TerminalView } from '../views/terminal/TerminalView';
import { ThreadTerminal } from '../views/terminal/ThreadTerminal';
import { ToolView } from '../views/tools/ToolView';
import { Launcher } from './Launcher';
import { tabMeta } from './meta';
import { ThreadStatus } from './Sidebar';
import { run } from './commands';
import { VimrcView } from './VimrcView';
import { startTabDrag } from './tabdrag';

export function TabBody({ t, focused }: { t: Tab; focused: boolean }) {
  switch (t.kind) {
    case 'new': return <Launcher t={t} focused={focused} />;
    case 'shell': return <TerminalView t={t} focused={focused} spec={{ machine: t.machine || 'local', cwd: t.dir || '~', run: { kind: 'shell' }, cols: 80, rows: 24 }} />;
    case 'thread': return t.view === 'chat' ? <ChatView t={t} focused={focused} /> : <ThreadTerminal t={t} focused={focused} />;
    case 'vimrc': return <VimrcView t={t} focused={focused} />;
    case 'sub': return <ChatView t={t} focused={focused} />;
    default: return <ToolView t={t} focused={focused} />;
  }
}

function ViewSeg({ t }: { t: Tab }) {
  const th = thread(t.thread);
  if (!th) return null;
  const drv = th.harness === 'claude' ? (th.drive === 'term' ? 'term' : 'chat') : null;
  return <Seg label="Chat or terminal" value={t.view || 'term'} mark={drv} onChange={v => A.setView(t, v)}
    options={[{ v: 'chat', icon: 'chat', label: drv === 'term' ? 'Chat · read-only while the terminal drives' : 'Chat' }, { v: 'term', icon: 'terminal', label: drv === 'chat' ? 'Terminal · takes the thread' : 'Terminal' }]} />;
}

function TabEl({ t, on, pane }: { t: Tab; on: boolean; pane: Pane }) {
  const m = tabMeta(t), th = thread(t.thread);
  return (
    <div className={cx('tab', on && 'on')} title={m.title} role="tab" aria-selected={on}
      onMouseDown={e => { if (e.button === 1) { e.preventDefault(); A.closeTab(t.id); } else if (!(e.target as HTMLElement).closest('.tx')) startTabDrag(e, t, pane.id); }}
      onClick={() => A.activate(pane.id, t.id)}>
      <Icon name={m.icon} />{m.ssh && <Icon name="host" />}
      <span className="t">{m.title}</span>
      {th && t.kind === 'thread' && <ThreadStatus t={th} />}
      <button className="tx" aria-label="Close tab" title="Close tab · alt-click pops it out" onClick={e => { e.stopPropagation(); if (e.altKey) A.popOut(t.id); else A.closeTab(t.id); }}><Icon name="x" /><Icon name="popout" /></button>
    </div>
  );
}

function TabBar({ g }: { g: Pane }) {
  const s = useApp(), w = ws();
  const a = activeTab(g);
  const corner = !s.sideOpen && g === leaves(w.tree)[0];
  const tabs = useRef<HTMLDivElement>(null);
  useEffect(() => { tabs.current?.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [g.active]);
  return (
    <header className={cx('tb', corner && 'corner', corner && s.info.platform === 'mac' && 'lights-pad')}>
      {corner && <><IconButton icon="sidebar" label="Show sidebar" keys="ldr b" onClick={() => run('sidebar')} /><IconButton icon="search" label="Search" keys="mod-k" onClick={() => run('palette')} /></>}
      <div className="tabs" ref={tabs} role="tablist" onWheel={e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
        {g.tabs.map(t => <TabEl key={t.id} t={t} on={t.id === a.id} pane={g} />)}
      </div>
      <IconButton icon="plus" label="New tab" keys="ldr c" small onClick={() => { A.focusPane(g.id); run('tabnew'); }} />
      <span className="drag" />
      {a.kind === 'thread' && <ViewSeg t={a} />}
      <IconButton icon="down" label="Search this pane" keys="mod-shift-a" small onClick={() => { A.focusPane(g.id); run('panesearch'); }} />
    </header>
  );
}

function PaneEl({ g }: { g: Pane }) {
  const s = useApp(), w = ws();
  const focused = g.id === w.focus && !w.pf && !s.sideFocus && !s.layers.length;
  const a = activeTab(g);
  return (
    <section className={cx('pane', g.id === w.focus && !w.pf && !s.sideFocus && 'focus')} data-pane={g.id} onMouseDown={() => { if (w.focus !== g.id || w.pf || s.sideFocus) A.focusPane(g.id); }}>
      <TabBar g={g} />
      <div className="body" data-tab={a.id}>
        {/* Keep every tab mounted so terminals and drafts live on; only the active one shows. */}
        {g.tabs.map(t => <Keep key={t.id} on={t.id === a.id}><TabBody t={t} focused={focused && t.id === a.id} /></Keep>)}
      </div>
    </section>
  );
}
const Keep = ({ on, children }: { on: boolean; children: ReactNode }) => <div className="keep" style={on ? undefined : { display: 'none' }}>{children}</div>;

function SplitEl({ n }: { n: Split }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect(), dv = e.currentTarget as HTMLElement;
    dv.classList.add('on');
    const mv = (ev: MouseEvent) => { const r = n.dir === 'row' ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height; n.ratio = Math.min(0.85, Math.max(0.15, r)); update(); };
    const up = () => { dv.classList.remove('on'); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); A.save(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  };
  return (
    <div ref={ref} className={cx('split', `d-${n.dir}`)}>
      <div className="cell" style={{ flex: n.ratio }}><NodeEl n={n.a} /></div>
      <div className="dv" onMouseDown={drag} onDoubleClick={() => { n.ratio = 0.5; update(); A.save(); }} />
      <div className="cell" style={{ flex: 1 - n.ratio }}><NodeEl n={n.b} /></div>
    </div>
  );
}
const NodeEl = ({ n }: { n: Node }) => (n.type === 'pane' ? <PaneEl g={n} /> : <SplitEl n={n} />);

function Popups() {
  const s = useApp(), w = ws();
  return <>{w.pops.map((p, i) => {
    const m = tabMeta(p.tab), focus = w.pf === p.tab.id && !s.layers.length;
    const style: React.CSSProperties = p.x == null ? { right: 28 + i * 26, top: 56 + i * 26 } : { left: p.x, top: p.y };
    if (p.w) { style.width = p.w; style.height = p.h; }
    const move = (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(), dx = e.clientX - box.left, dy = e.clientY - box.top;
      const mv = (ev: MouseEvent) => { p.x = Math.max(0, ev.clientX - dx); p.y = Math.max(0, ev.clientY - dy); update(); };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); A.save(); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    };
    return (
      <section key={p.tab.id} className={cx('peek wide', w.pf === p.tab.id && 'focus')} data-tab={p.tab.id} style={style} onMouseDown={() => { if (w.pf !== p.tab.id) update(x => { w.pf = p.tab.id; x.sideFocus = false; x.tick++; }); }}>
        <header className="tb" onMouseDown={move}><Icon name={m.icon} /><span className="pt">{m.title}</span><span className="drag" />{p.tab.kind === 'thread' && <ViewSeg t={p.tab} />}
          <button className="ib sm px" aria-label="Close" title="Close · alt-click puts it back as a tab" onClick={e => { if (e.altKey) A.dock(p.tab.id); else update(x => { A.closePopup(p.tab.id); x.tick++; }); }}><Icon name="x" /><Icon name="dockin" /></button>
        </header>
        <div className="body"><TabBody t={p.tab} focused={focus} /></div>
      </section>
    );
  })}</>;
}

export function Workspace() {
  const s = useApp(), w = ws();
  const many = leaves(w.tree).length > 1;
  const f = A.focusedPane(w);
  return (
    <div id="work">
      <div className={cx('panes', many ? 'many' : 'one')}>{w.zoom && many ? <PaneEl g={f} /> : <NodeEl n={w.tree} />}</div>
      {w.zoom && many && <div className="rail">{leaves(w.tree).map(g => { const t = activeTab(g), m = tabMeta(t); return <button key={g.id} className={cx(g.id === f.id && 'on')} title={m.title} onClick={() => A.focusPane(g.id)}><Icon name={m.icon} /></button>; })}</div>}
      <Popups />
      {s.layers.length === 0 && null}
    </div>
  );
}
export { S };
