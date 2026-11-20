// The ctrl-tab workspace switcher (mockup WS.cycle). Most recent first: the first press lands on the workspace you
// were in last, tab again (still holding ctrl) walks further back, shift-tab walks forward, and letting go of ctrl
// switches. A quick tap flips between the last two. j / k / enter work too, esc cancels.
import { allTabs, type Node, type Workspace } from '../state/layout';
import * as A from '../state/actions';
import { machine, openLayer, S, thread, update, ws } from '../state/store';
import { Menu, type MenuItem } from '../ui/Menu';

/** A workspace's layout drawn small: the picture you recognise it by. */
export function WsMini({ tree }: { tree: Node }) {
  const d = (n: Node): React.ReactNode => n.type === 'pane' ? <i key={n.id} />
    : <span key={n.id} className={n.dir === 'row' ? 'r' : 'c'}>
        <span style={{ flex: n.ratio.toFixed(2) }}>{d(n.a)}</span>
        <span style={{ flex: (1 - n.ratio).toFixed(2) }}>{d(n.b)}</span>
      </span>;
  return <span className="wmini" aria-hidden="true">{d(tree)}</span>;
}

/** A thread in it waits on you. */
export const wsWaiting = (w: Workspace) => allTabs(w).some(({ tab }) => !!tab.thread && thread(tab.thread)?.status === 'wait');

export const wsRow = (w: Workspace): MenuItem<string> => ({
  label: w.name, hint: `${machine(w.machine)?.name ?? w.machine} · ${w.dir}`, icon: <WsMini tree={w.tree} />, on: w.id === S.wid, data: w.id,
  right: wsWaiting(w) ? <i className="wdot" title="A thread here is waiting for you" /> : undefined,
});

const recent = () => [...S.workspaces].sort((a, b) => b.usedAt - a.usedAt);

let open: { sel: number; n: number; close: () => void; pick: () => void } | null = null;

export function cycleWorkspaces(d: 1 | -1) {
  if (open) { const o = open; update(() => { o.sel = (o.sel + d + o.n) % o.n; }); return; }
  const list = recent();
  if (list.length < 2) return;
  const cur = list.findIndex(w => w.id === S.wid);
  if (cur > 0) { list.splice(cur, 1); list.unshift(ws()); }   // the one on screen is first
  const state = { sel: d > 0 ? 1 : list.length - 1, n: list.length, close: () => {}, pick: () => {} };
  const go = (id?: string) => { done(); state.close(); if (id && id !== S.wid) A.switchWorkspace(id); };
  const up = (e: KeyboardEvent) => { if (e.key === 'Control') go(list[state.sel]?.id); };
  const blur = () => go(list[state.sel]?.id);
  // a key pressed without ctrl (the keyup was lost to a page or another window): the hold is over
  const down = (e: KeyboardEvent) => { if (!e.ctrlKey && e.key !== 'Shift' && !['Enter', 'Escape', 'Tab', 'j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) go(list[state.sel]?.id); };
  const done = () => { open = null; removeEventListener('keyup', up, true); removeEventListener('blur', blur); removeEventListener('keydown', down, true); };
  addEventListener('keyup', up, true); addEventListener('blur', blur); addEventListener('keydown', down, true);
  state.pick = () => go(list[state.sel]?.id);
  open = state;
  const rows = list.map(wsRow).map(r => ({ ...r, on: false }));   // made once: a new list each render would re-register the surface forever
  state.close = openLayer(c => (
    <Menu<string> modal className="pal ws wsw" items={rows} select={state.sel}
      onSelect={i => { state.sel = i; }} onPick={it => { done(); if (it.data && it.data !== S.wid) A.switchWorkspace(it.data); }} onClose={() => { done(); c(); }} />
  ), done);
}
