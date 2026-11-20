// Panes, splits, tab bars and popups for the workspace on screen.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import * as A from '../state/actions';
import { activeTab, leaves, type Node, type Pane, type Split, type Tab } from '../state/layout';
import { S, thread, update, useApp, ws } from '../state/store';
import { cx, Icon, IconButton, Seg, Spinner } from '../ui/primitives';
import { log, useChat } from '../views/chat/state';
import { LangBadge } from '../views/tools/code';
import { fileDirty } from '../views/tools/FileView';
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
  // Claude Code: a mark shows which view drives the thread (G4); the other one is read-only until it takes over
  const drv = th.harness === 'claude' ? (th.drive === 'term' ? 'term' : 'chat') : null;
  const name = (v: 'chat' | 'term', n: string) => n + (drv === v ? ' · driving' : drv ? ' · read-only while the other view drives' : '');
  return <Seg label="Chat or terminal · ldr t" value={t.view || 'term'} mark={drv} onChange={v => A.setView(t, v)}
    options={[{ v: 'chat', icon: 'chat', label: name('chat', 'Chat') }, { v: 'term', icon: 'terminal', label: name('term', 'Terminal') }]} />;
}

/** What a tab shows after its title: a thread's state, or a spinner while a subagent runs. */
function TabState({ t }: { t: Tab }) {
  useChat();
  const th = thread(t.thread);
  if (t.kind === 'thread') return th ? <ThreadStatus t={th} /> : null;
  if (t.kind === 'sub' && t.thread) {
    const e = log(t.thread).events.find(x => x.t === 'sub' && x.id === t.sub);
    return e?.t === 'sub' && e.status === 'running' ? <Spinner /> : null;
  }
  return null;
}
/** A tab's icon: a file shows its language badge (TS, CSS...), everything else its kind's icon. */
const TabIcon = ({ t, icon }: { t: Tab; icon: string }) => (t.kind === 'file' && t.path ? <LangBadge path={t.path} /> : <Icon name={icon} />);

function TabEl({ t, on, pane }: { t: Tab; on: boolean; pane: Pane }) {
  const m = tabMeta(t);
  return (
    <div className={cx('tab', on && 'on', t.kind === 'file' && fileDirty(t) && 'dirty')} title={m.title} role="tab" aria-selected={on} data-id={t.id}
      onMouseDown={e => { if (e.button === 1) { e.preventDefault(); A.closeTab(t.id); } else if (!(e.target as HTMLElement).closest('.tx')) startTabDrag(e, t, pane.id); }}
      onClick={() => A.activate(pane.id, t.id)}>
      <TabIcon t={t} icon={m.icon} />{m.ssh && <Icon name="host" />}
      <span className="t">{m.title}</span>
      <TabState t={t} />
      <button className="tx" aria-label={t.kind === 'file' && fileDirty(t) ? 'Close tab (unsaved changes)' : 'Close tab'} title="Close tab · hold alt to pop it out" onClick={e => { e.stopPropagation(); if (e.altKey) A.popOut(t.id); else A.closeTab(t.id); }}><i className="dd" aria-hidden="true" /><Icon name="x" /><Icon name="popout" /></button>
    </div>
  );
}

function TabBar({ g }: { g: Pane }) {
  const s = useApp(), w = ws();
  const a = activeTab(g);
  const corner = !s.sideOpen && g === leaves(w.tree)[0];
  const tabs = useRef<HTMLDivElement>(null);
  // B8: tabs that don't fit scroll sideways inside their bar; the bar fades at the edge that has more (ovl / ovr)
  const mark = () => { const b = tabs.current; if (!b) return; b.classList.toggle('ovl', b.scrollLeft > 1); b.classList.toggle('ovr', b.scrollLeft + b.clientWidth < b.scrollWidth - 1); };
  useEffect(() => {   // the active tab is always scrolled into view (within the bar only)
    const b = tabs.current, on = b?.querySelector<HTMLElement>('.tab.on'); if (!b || !on) return;
    const l = on.offsetLeft - (on.offsetParent === b ? 0 : b.offsetLeft), r = l + on.offsetWidth;
    if (l < b.scrollLeft || on.offsetWidth > b.clientWidth) b.scrollLeft = Math.max(0, l - 4); else if (r > b.scrollLeft + b.clientWidth) b.scrollLeft = r - b.clientWidth + 4;
    mark();
  }, [g.active, g.tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const b = tabs.current; if (!b) return; const ro = new ResizeObserver(mark); ro.observe(b); return () => ro.disconnect(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(mark);
  return (
    <header className={cx('tb', corner && 'corner', corner && s.info.platform === 'mac' && 'lights-pad')}>
      {corner && <><IconButton icon="sidebar" label="Show sidebar" keys="ldr b" onClick={() => run('sidebar')} /><IconButton icon="search" label="Search" keys="mod-k" onClick={() => run('palette')} /></>}
      <div className="tabs" ref={tabs} role="tablist" onScroll={mark} onWheel={e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
        {g.tabs.map(t => <TabEl key={t.id} t={t} on={t.id === a.id} pane={g} />)}
      </div>
      <IconButton icon="plus" label="New tab" keys="ldr c" small onClick={() => { A.focusPane(g.id); run('tabnew'); }} />
      <span className="drag" />
      {a.kind === 'thread' && <ViewSeg t={a} />}
      <IconButton icon="down" label="Search this pane" keys="mod-shift-a" small on={!!w.zoom} onClick={() => { A.focusPane(g.id); run('panesearch'); }} />
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
  // drag the divider: the pointer is captured (the cursor stays a resize cursor), the two cells are sized
  // directly while it moves, and the layout is stored once it is let go
  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const dv = e.currentTarget as HTMLElement, [a, , b] = [...ref.current!.children] as HTMLElement[];
    dv.setPointerCapture(e.pointerId); dv.classList.add('on');
    const mv = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      n.ratio = Math.min(0.88, Math.max(0.12, n.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height));
      a.style.flex = String(n.ratio); b.style.flex = String(1 - n.ratio);
    };
    const up = () => { dv.classList.remove('on'); dv.removeEventListener('pointermove', mv); dv.removeEventListener('pointerup', up); dv.removeEventListener('lostpointercapture', up); update(); A.save(); };
    dv.addEventListener('pointermove', mv); dv.addEventListener('pointerup', up); dv.addEventListener('lostpointercapture', up);
  };
  return (
    <div ref={ref} className={cx('split', `d-${n.dir}`)}>
      <div className="cell" style={{ flex: n.ratio }}><NodeEl n={n.a} /></div>
      <div className="dv" onPointerDown={drag} onDoubleClick={() => { n.ratio = 0.5; update(); A.save(); }} />
      <div className="cell" style={{ flex: 1 - n.ratio }}><NodeEl n={n.b} /></div>
    </div>
  );
}
const NodeEl = ({ n }: { n: Node }) => (n.type === 'pane' ? <PaneEl g={n} /> : <SplitEl n={n} />);

const GRIPS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
/** A remembered popup place, kept inside the work area as it is now (the window may have shrunk). */
function clampPop(g: { x: number; y: number; w: number; h: number }) {
  const r = document.getElementById('work')?.getBoundingClientRect(), W = r?.width || innerWidth, H = r?.height || innerHeight;
  const w = Math.max(MW, Math.min(g.w, W)), h = Math.max(MH, Math.min(g.h, H));
  return { x: Math.max(0, Math.min(g.x, W - w)), y: Math.max(0, Math.min(g.y, H - h)), w, h };
}
const MW = 300, MH = 220;   // the smallest a popup gets (skein.css .peek min-width / min-height)

/** Where a popup sits in #work, from its element (it may still be in its default spot, placed by right / top). */
function placeOf(el: HTMLElement) {
  const w = document.getElementById('work')!.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { work: w, x: r.left - w.left, y: r.top - w.top, w: r.width, h: r.height };
}

function Popups() {
  const s = useApp(), w = ws();
  return <>{w.pops.map((p, i) => {
    const m = tabMeta(p.tab), focus = w.pf === p.tab.id && !s.layers.length;
    // a tab that floated before comes back where it was (its last place, kept on the tab), inside the window
    if (p.x == null && p.tab.pop) Object.assign(p, clampPop(p.tab.pop));
    const style: React.CSSProperties = p.x == null ? { right: 28 + i * 26, top: 56 + i * 26 } : { left: p.x, top: p.y };
    if (p.w) { style.width = p.w; style.height = p.h; }
    const keep = () => { if (p.x != null && p.y != null && p.w && p.h) p.tab.pop = { x: p.x, y: p.y, w: p.w, h: p.h }; A.save(); };
    // drag it by its header (kept inside the work area)
    const move = (e: React.MouseEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, .seg')) return;
      e.preventDefault();
      // taking hold of a popup leaves any field: the keys are back in NORMAL
      const f = document.activeElement as HTMLElement | null; if (f?.matches('textarea, input, [contenteditable]')) f.blur();
      const o = placeOf(e.currentTarget.parentElement as HTMLElement), dx = e.clientX - o.work.left - o.x, dy = e.clientY - o.work.top - o.y;
      const mv = (ev: MouseEvent) => { p.x = Math.max(0, Math.min(o.work.width - 80, ev.clientX - o.work.left - dx)); p.y = Math.max(0, Math.min(o.work.height - 40, ev.clientY - o.work.top - dy)); p.w ||= o.w; p.h ||= o.h; update(); };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); keep(); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    };
    // resize it from any edge or corner
    const resize = (e: React.MouseEvent, d: string) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const o = placeOf(e.currentTarget.parentElement as HTMLElement), px = e.clientX, py = e.clientY;
      const mv = (ev: MouseEvent) => {
        let { x, y, w: ww, h } = o; const dx = ev.clientX - px, dy = ev.clientY - py;
        if (d.includes('e')) ww = Math.max(MW, o.w + dx);
        if (d.includes('s')) h = Math.max(MH, o.h + dy);
        if (d.includes('w')) { ww = Math.max(MW, o.w - dx); x = o.x + o.w - ww; }
        if (d.includes('n')) { h = Math.max(MH, o.h - dy); y = o.y + o.h - h; }
        Object.assign(p, { x, y, w: ww, h }); update();
      };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); document.body.classList.remove('resizing'); keep(); };
      document.body.classList.add('resizing');
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    };
    return (
      <section key={p.tab.id} className={cx('peek', !(p.tab.kind === 'thread' && thread(p.tab.thread)?.side) && 'wide', w.pf === p.tab.id && 'focus')} data-tab={p.tab.id} style={style} onMouseDown={() => { if (w.pf !== p.tab.id) update(x => { w.pf = p.tab.id; x.sideFocus = false; x.tick++; }); }}>
        {GRIPS.map(d => <i key={d} className={`rz rz-${d}`} data-rz={d} onMouseDown={e => resize(e, d)} />)}
        <header className="tb" onMouseDown={move}><TabIcon t={p.tab} icon={m.icon} /><span className="pt">{m.title}</span><TabState t={p.tab} /><span className="drag" />{p.tab.kind === 'thread' && <ViewSeg t={p.tab} />}
          <button className="ib sm px" aria-label="Close" title="Close · hold alt to put it back as a tab" onClick={e => { if (e.altKey) A.dock(p.tab.id); else update(x => { A.closePopup(p.tab.id); x.tick++; }); }}><Icon name="x" /><Icon name="dockin" /></button>
        </header>
        <div className="body"><TabBody t={p.tab} focused={focus} /></div>
      </section>
    );
  })}</>;
}

/** While alt / option is held, a tab's ✕ shows "pop out" and a popup's ✕ shows "back into the focused pane". */
function useAltMark() {
  useEffect(() => {
    const set = (on: boolean) => document.body.classList.toggle('alt', on);
    const down = (e: KeyboardEvent) => { if (e.key === 'Alt') set(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt') set(false); };
    const off = () => set(false);
    // a mouse move tells the truth when the key was let go elsewhere (another window had the focus)
    const mv = (e: MouseEvent) => { if (e.altKey !== document.body.classList.contains('alt')) set(e.altKey); };
    addEventListener('keydown', down, true); addEventListener('keyup', up, true); addEventListener('blur', off); addEventListener('mousemove', mv, true);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('blur', off); removeEventListener('mousemove', mv, true); off(); };
  }, []);
}

export function Workspace() {
  const s = useApp(), w = ws();
  useAltMark();
  const many = leaves(w.tree).length > 1;
  const f = A.focusedPane(w);
  return (
    <div id="work">
      <div className={cx('panes', many ? 'many' : 'one')}>{w.zoom && many ? <PaneEl g={f} /> : <NodeEl n={w.tree} />}</div>
      {w.zoom && many && <div className="rail">{leaves(w.tree).map(g => { const t = activeTab(g), m = tabMeta(t); return <button key={g.id} className={cx(g.id === f.id && 'on')} title={m.title} aria-label={m.title} onClick={() => A.focusPane(g.id)}><Icon name={m.icon} /><TabState t={t} /></button>; })}</div>}
      <Popups />
      {s.layers.length === 0 && null}
    </div>
  );
}
export { S };
