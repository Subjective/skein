// Moving a thread to another folder or machine (DECISIONS "Moving a thread"): `m` on a sidebar thread picks the
// place (a project on any machine, or another folder through the folder menu), dragging a thread onto a project
// or a machine heading does the same with the mouse. Either way a small dialog shows the route and why it
// can't move, if it can't. The dialog's buttons are a row (VIM-MODEL rule 16): h / l move, enter presses, esc cancels.
import { useEffect, useRef, useState } from 'react';
import type { ThreadMeta } from '@shared/types';
import { moveBlocked } from '@shared/move';
import { api } from '../api';
import { machine, openLayer, S, thread, toast, update, useApp } from '../state/store';
import { Dialog, useDialogSurface } from '../ui/Dialog';
import { Button, Icon, Spinner } from '../ui/primitives';
import { detachThread } from '../views/terminal/TerminalView';
import { knownDirs, openFolderPicker, openMenu } from './overlays';
import { base, projectName } from './meta';
import { threadDrag, type PaneDrag } from './tabdrag';

const reason = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Projects (folders with threads) on a machine, most recent first. */
const projectsOn = (m: string) => [...new Set(S.threads.filter(t => t.machine === m && !t.archived && !t.side).sort((a, b) => b.updatedAt - a.updatedAt).map(t => t.dir))];

/** Can't go to that machine at all (offline, no CLI): the dialog says why rather than a folder picker. */
const machineBlocked = (t: ThreadMeta, mid: string) => { const m = machine(mid); return !m || (m.ssh && m.link !== 'up') || !m.has.includes(t.harness); };

/** Where can this thread go: every project on every machine, and any other folder. */
export function moveMenu(id: string, anchor: HTMLElement) {
  const t = thread(id); if (!t) return;
  openMenu<{ m: string; d?: string }>({
    anchor: anchor.getBoundingClientRect(), place: 'bottom-start', width: 320, className: 'move-to', search: { placeholder: 'Move to a project or folder' },
    items: S.machines.flatMap(m => [
      { head: true, label: m.name, icon: <Icon name={m.ssh ? 'host' : 'laptop'} /> },
      ...projectsOn(m.id).filter(d => !(m.id === t.machine && d === t.dir)).map(d => ({ label: projectName(m.id, d), hint: d, icon: <Icon name="folder" />, data: { m: m.id, d } })),
      { label: 'Other folder…', hint: m.name, icon: <Icon name="folderOpen" />, data: { m: m.id } },
    ]),
    onPick: it => {
      const to = it.data!;
      if (to.d) openMove(id, to.m, to.d); else pickFolder(id, to.m, anchor);
    },
  });
}

/** The folder menu on a machine, then the dialog. */
export function pickFolder(id: string, mid: string, anchor: HTMLElement) {
  const t = thread(id), m = machine(mid); if (!t || !m) return;
  if (machineBlocked(t, mid)) { openMove(id, mid, '~'); return; }
  // the shared folder field (known folders, typed paths, browse), as a new thread's folder chip
  openFolderPicker(mid, anchor.getBoundingClientRect(), d => openMove(id, mid, d), { place: 'bottom-start', width: 320, exclude: d => mid === t.machine && d === t.dir });
}

/** A thread dropped on a machine heading: a folder there with the same repo name goes straight to the dialog
 *  (mockup B19); a machine it can't go to shows why; else the folder field. */
export function dropOnMachine(id: string, mid: string, anchor: HTMLElement) {
  const t = thread(id); if (!t) return;
  const repo = base(t.dir), match = knownDirs(mid).find(d => base(d) === repo && !(mid === t.machine && d === t.dir));
  if (match) { openMove(id, mid, match); return; }
  pickFolder(id, mid, anchor);
}

/** The confirm dialog: from -> to, the reason it can't move if it can't, then Move. */
export function openMove(id: string, to: string, dir: string) {
  const t = thread(id); if (!t || (t.machine === to && t.dir === dir)) return;
  openLayer(close => <MoveDialog id={id} to={to} dir={dir} close={close} />);
}

/** Move, restarting the thread's open terminals at the new place (or the old one if it fails). */
async function move(id: string, to: string, dir: string): Promise<ThreadMeta> {
  const before = thread(id)!;
  const restart = detachThread(id);
  try {
    const t = await api.threads.move(id, to, dir);
    update(s => { const i = s.threads.findIndex(x => x.id === id); if (i >= 0) s.threads[i] = t; s.collapsed = { ...s.collapsed, ['h:' + t.machine]: false, [t.machine + ':' + t.dir]: false }; s.sideCursor = id; });
    restart({ machine: t.machine, cwd: t.dir });
    return t;
  } catch (e) {
    restart({ machine: before.machine, cwd: before.dir });
    throw new Error(reason(e));
  }
}

function moved(t: ThreadMeta, from: { machine: string; dir: string }) {
  toast(`Moved to ${machine(t.machine)?.name ?? t.machine} ${t.dir}`, {
    icon: 'check',
    action: { label: 'Undo', run: () => { void move(t.id, from.machine, from.dir).then(() => toast('Moved back', { icon: 'check' }), e => toast(`Couldn’t move back: ${reason(e)}`, { icon: 'alert' }, 6000)); } },
  }, 7000);
}

function Where({ m, dir }: { m?: string; dir: string }) {
  const mm = machine(m);
  return <span className="mv-at"><Icon name={mm?.ssh ? 'host' : 'laptop'} /><b>{mm?.name ?? m}</b><span title={dir}>{dir}</span></span>;
}

function MoveDialog({ id, to, dir, close }: { id: string; to: string; dir: string; close: () => void }) {
  useApp();
  const t = thread(id), m = machine(to);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const block = !t || !m ? 'This thread or machine is gone.' : moveBlocked(t, m, dir);
  const btns = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)];
  const [btn, setBtn] = useState(block ? 0 : 1);
  useEffect(() => { btns[btn].current?.focus(); }, [btn, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    if (!t || block || busy) return;
    const from = { machine: t.machine, dir: t.dir };
    setBusy(true); setErr('');
    try { const nt = await move(id, to, dir); close(); moved(nt, from); }
    catch (e) { setErr(reason(e)); setBusy(false); }
  };
  const press = (i: number) => (i === 0 ? close() : void go());
  useDialogSurface({
    onEsc: () => { if (!busy) close(); },
    key: k => {
      if (k === 'h' || k === 'left' || k === 'shift-tab') { setBtn(0); return true; }
      if ((k === 'l' || k === 'right' || k === 'tab') && !block) { setBtn(1); return true; }
      if (k === 'enter' || k === 'space') { press(btn); return true; }
      if (k === 'q') { if (!busy) close(); return true; }
      return k.length === 1;
    },
  }, [btn, block, busy]);

  if (!t) return null;
  const note = block || err;
  return (
    <Dialog onClose={() => { if (!busy) close(); }} className="auth mv" label={`Move “${t.title}”`}>
      <header><Icon name={t.harness} /><h3>Move “{t.title}”</h3></header>
      <div className="mv-route"><span>From</span><Where m={t.machine} dir={t.dir} /><span>To</span><Where m={to} dir={dir} /></div>
      {note && <p className="mv-note bad" role="alert"><Icon name="alert" /><span>{note}</span></p>}
      {!block && <p className="dim">Only the conversation moves. Changes to files stay in {t.dir}.</p>}
      <div className="af kbrow">
        <span className="sp" />
        <Button ref={btns[0]} onClick={close} disabled={busy} onFocus={() => setBtn(0)}>Cancel</Button>
        <Button ref={btns[1]} variant="primary" onClick={() => void go()} disabled={!!block || busy} onFocus={() => setBtn(1)}>{busy ? <><Spinner />Moving</> : 'Move'}</Button>
      </div>
    </Dialog>
  );
}

// ---------- the mouse: drag a thread row onto a project or a machine heading, or into the panes ----------
// Over the sidebar the row moves the thread (projects and machine headings); over the panes it is a tab, as a
// dragged tab is (shell/tabdrag.ts): onto a tab bar, a pane's middle or an edge, it opens the thread there.

const TARGETS = '#side .s-d[data-machine], #side .s-h[data-machine]';

/** Start following a press on a thread row. Below 5px of travel it stays a click. */
export function startThreadDrag(e: React.MouseEvent, t: ThreadMeta) {
  if (e.button !== 0 || t.archived || (e.target as HTMLElement).closest('button')) return;
  const x0 = e.clientX, y0 = e.clientY;
  const src = e.currentTarget as HTMLElement;
  let lift: HTMLElement | null = null, over: HTMLElement | null = null, pane: PaneDrag | null = null, inPanes = false;
  const mark = (el: HTMLElement | null) => { if (over === el) return; over?.classList.remove('drop-into'); over = el; over?.classList.add('drop-into'); };
  const mv = (ev: MouseEvent) => {
    if (!lift && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!lift) {
      const r = src.getBoundingClientRect();
      lift = src.cloneNode(true) as HTMLElement;
      lift.classList.remove('cur', 'foc', 'drag-source'); lift.removeAttribute('data-thread');
      lift.classList.add('lift');
      Object.assign(lift.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
      (src.closest('#side') || document.body).appendChild(lift);
      src.classList.add('drag-source');
      document.getSelection()?.removeAllRanges();
      document.body.classList.add('dragging-thread');
    }
    lift.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
    // into the panes: the row becomes a tab there
    const work = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('#work');
    if (work) { pane ||= threadDrag(t.id); pane.show(true); inPanes = pane.track(ev.clientX, ev.clientY); lift.style.visibility = 'hidden'; mark(null); return; }
    if (pane) { pane.show(false); inPanes = false; }
    lift.style.visibility = '';
    const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(TARGETS) ?? null;
    // its own project is not a place to move to
    mark(hit && hit.matches('.s-d') && hit.dataset.machine === t.machine && hit.dataset.dir === t.dir ? null : hit);
  };
  const up = (ev: MouseEvent) => {
    removeEventListener('mousemove', mv); removeEventListener('mouseup', up, true);
    if (!lift) return; // a click
    if (pane) { if (inPanes) pane.drop(ev.clientX, ev.clientY); else pane.cancel(); }
    if (inPanes) mark(null);
    lift.remove(); src.classList.remove('drag-source'); document.body.classList.remove('dragging-thread');
    // the click that ends a drag does not open the thread
    const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', swallow, true); setTimeout(() => removeEventListener('click', swallow, true), 0);
    const target = over; mark(null);
    if (!target) return;
    const mid = target.dataset.machine!;
    if (target.matches('.s-d')) openMove(t.id, mid, target.dataset.dir!);
    else dropOnMachine(t.id, mid, target);
  };
  addEventListener('mousemove', mv); addEventListener('mouseup', up, true);
}
