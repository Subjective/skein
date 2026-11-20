// Opening tool tabs and files, from commands, the palette, Changes, Files and the open file itself.
import { api } from '../../api';
import * as A from '../../state/actions';
import { allTabs, mkTab, type Tab } from '../../state/layout';
import { toast, update, ws } from '../../state/store';
import { tabHook } from './hooks';
import { ctxOf, viewState, type Ctx } from './repo';

/** The file view's state that outlives a render: history and where to put the cursor next. */
export interface FileNav { hist: { path: string; line: number }[]; hi: number; goto?: { line: number; col?: number } }
export const fileNav = (t: Tab) => viewState<FileNav>(t.id + ':nav', () => ({ hist: [{ path: t.path || '', line: 1 }], hi: 0 }));

/** Changes, Files or a Browser beside the current tab: an open one for the same folder is reused. */
export function openTool(kind: 'changes' | 'files' | 'browser', from: Tab = A.currentTab()) {
  const c = ctxOf(from);
  const hit = allTabs(ws()).find(x => x.tab.kind === kind && ctxOf(x.tab).dir === c.dir && ctxOf(x.tab).machine === c.machine);
  if (hit?.pane) { A.activate(hit.pane.id, hit.tab.id); return; }
  if (hit) { update(() => { ws().pf = hit.tab.id; }); return; }
  const t = mkTab(kind, { machine: c.machine, dir: c.dir, thread: from.kind === 'thread' ? from.thread : from.thread });
  A.split('row', t);
}

/** Open `path` (relative to `ctx.dir`). From an open file it moves that tab (with history); otherwise an open
 *  tab for the file is reused, or a new tab opens in the focused pane. */
export function openFile(ctx: Ctx, path: string, o: { line?: number; col?: number; from?: Tab; newTab?: boolean } = {}) {
  const from = o.from;
  if (from?.kind === 'file' && !o.newTab && from.dir === ctx.dir) {
    const nav = fileNav(from);
    const cur = nav.hist[nav.hi];
    if (cur.path === path) { nav.goto = { line: o.line || 1, col: o.col }; update(); return; }
    nav.hist = [...nav.hist.slice(0, nav.hi + 1), { path, line: o.line || 1 }];
    nav.hi = nav.hist.length - 1;
    nav.goto = { line: o.line || 1, col: o.col };
    update(() => { from.path = path; });
    A.save();
    return;
  }
  const hit = allTabs(ws()).find(x => x.tab.kind === 'file' && x.tab.path === path && x.tab.dir === ctx.dir && (x.tab.machine || 'local') === ctx.machine);
  const t = hit?.tab || mkTab('file', { machine: ctx.machine, dir: ctx.dir, path, thread: from?.thread });
  fileNav(t).goto = { line: o.line || 1, col: o.col };
  if (hit?.pane) { A.activate(hit.pane.id, t.id); return; }
  if (hit) { update(() => { ws().pf = t.id; }); return; }
  update(s => {
    const g = A.focusedPane(), a = g.tabs.find(x => x.id === g.active);
    if (a?.kind === 'new') { g.tabs[g.tabs.indexOf(a)] = t; g.active = t.id; } else A.addTab(g, t);
    ws().pf = null; s.sideFocus = false; s.tick++;
  });
  A.save();
}

export function saveFile() { if (!tabHook(A.currentTab().id, 'save')) toast('Nothing to save here'); }

/** Read a file as text, refusing what is clearly binary. */
export async function readText(ctx: Ctx, path: string): Promise<{ text: string } | { binary: true } | { error: string }> {
  try {
    const text = await api.fs.read(ctx.machine, ctx.dir.replace(/[\\/]+$/, '') + '/' + path);
    if (text.slice(0, 8000).includes('\u0000')) return { binary: true };
    return { text };
  } catch (e) { return { error: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) }; }
}
