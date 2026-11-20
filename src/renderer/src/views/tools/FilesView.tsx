// Files: the folder's project tree. j k move, l / enter open a folder or the file, h closes a folder or goes to
// its parent, / searches every file, gg G ends, ctrl-d ctrl-u half pages. A file opens in a tab of its own.
import { useRef } from 'react';
import type { Tab } from '../../state/layout';
import { machine as machineOf, update, useApp } from '../../state/store';
import { Icon, IconButton } from '../../ui/primitives';
import { VimField, type VimFieldHandle } from '../../ui/VimField';
import { openFile } from './open';
import { ProjectTree, toggleDir, useLister, visible, type Node, type TreeState } from './ProjectTree';
import { ctxOf, refreshNow, useRepo, viewState } from './repo';
import { halfPage, nativeTarget, useSurface } from './surface';

export function FilesView({ t, focused }: { t: Tab; focused: boolean }) {
  useApp();
  const ctx = ctxOf(t);
  const re = useRepo(ctx.machine, ctx.dir);
  const l = useLister(ctx, re);
  const st = viewState<TreeState & { g: boolean }>(t.id, () => ({ open: new Set(), cur: null, q: '', g: false }));
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<VimFieldHandle>(null);
  const rows = visible(l, st);
  const at = Math.max(0, rows.findIndex(r => r.rel === st.cur));
  if (rows.length && !rows.some(r => r.rel === st.cur)) st.cur = rows[Math.min(at, rows.length - 1)].rel;

  const open = (n: Node) => {
    if (n.dir) toggleDir(l, st, n.rel);
    else openFile(ctx, n.rel, { from: t });
  };
  const go = (i: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, i))]; if (r) { st.cur = r.rel; update(); } };
  const { own } = useSurface(t.id, focused, {
    mode: () => 'NORMAL',
    key: k => {
      if (nativeTarget() && (k === 'enter' || k === 'space')) return false;
      const r = rows[at];
      if (st.g) { st.g = false; if (k === 'g') go(0); return true; }
      switch (k) {
        case 'j': case 'down': go(at + 1); return true;
        case 'k': case 'up': go(at - 1); return true;
        case 'g': st.g = true; return true;
        case 'G': case 'end': go(rows.length - 1); return true;
        case 'home': go(0); return true;
        case 'ctrl-d': case 'pagedown': go(at + halfPage(body.current, 26)); return true;
        case 'ctrl-u': case 'pageup': go(at - halfPage(body.current, 26)); return true;
        case 'enter': case 'o': case 'l': case 'right': if (r) { if (r.dir && (k === 'l' || k === 'right')) toggleDir(l, st, r.rel, true); else open(r); } return true;
        case 'h': case 'left': {
          if (!r) return true;
          if (r.dir && st.open.has(r.rel)) { toggleDir(l, st, r.rel, false); return true; }
          const parent = r.rel.includes('/') ? r.rel.replace(/\/[^/]*$/, '') : null;
          if (parent && !st.q) { st.cur = parent; toggleDir(l, st, parent, false); }
          return true;
        }
        case '/': requestAnimationFrame(() => search.current?.focus(true)); return true;
        case 'esc': if (st.q) { st.q = ''; update(); return true; } return false;
      }
      return k.length === 1;
    },
  });

  const m = machineOf(ctx.machine);
  return (
    <div className="files-v" onMouseDown={e => { if (!(e.target as HTMLElement).closest('.tq')) own(); }}>
      <header className="tool-h">
        {m?.ssh && <Icon name="host" />}
        <span className="path" title={ctx.dir}>{ctx.dir}</span>
        {re.repo?.branch && <span className="dim br"><Icon name="branch" size="sm" /> {re.repo.branch}</span>}
        <span className="sp" />
        <IconButton icon="retry" small label="Refresh" onClick={() => { void refreshNow(ctx.machine, ctx.dir); update(); }} />
      </header>
      <div className="tool-b" data-read ref={body}>
        <label className="tq"><Icon name="search" size="sm" />
          <VimField ref={search} tabId={t.id} value={st.q} onChange={x => { st.q = x.replace(/\n/g, ''); st.cur = null; update(); }} placeholder="Search files" className="tq-f"
            onEnter={() => { const first = visible(l, st)[0]; own(); (document.activeElement as HTMLElement | null)?.blur(); if (first && !first.dir) openFile(ctx, first.rel, { from: t }); }}
            onLeave={() => { own(); (document.activeElement as HTMLElement | null)?.blur(); }} />
        </label>
        <ProjectTree l={l} st={st} cursor={focused} onOpen={n => { own(); open(n); }} label="Files" />
      </div>
    </div>
  );
}
