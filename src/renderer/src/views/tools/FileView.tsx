// An open file. It reads like any other text (a Vim cursor, visual mode, y to copy, / to find) until an editing
// key: then the source becomes a Vim field at that spot and the key acts there, with u / ctrl-r undo and redo.
// esc from NORMAL goes back to reading; :w, ctrl-s / cmd-s or Save writes it. Unsaved text stays with the file
// (closing the tab keeps it for this session) and is what Preview shows.
// The header has back / forward (ctrl-o / ctrl-i, through the jump list), the path (each folder opens a list of
// what is in it; - opens the file's own folder), the language, and the project tree. Lines changed since the last
// commit get a bar in the gutter: green added, amber changed, a red notch where lines were removed.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { gutterMarks } from '@shared/gutter';
import { api } from '../../api';
import type { Mode } from '../../input/dispatcher';
import type { KeyLike } from '../../input/keys';
import { kb } from '../../input/platform';
import { tabSurface } from '../../input/surfaces';
import { setText, step, vrange, init, type TextState } from '../../input/vimtext';
import type { Tab } from '../../state/layout';
import { S, toast, update, useApp } from '../../state/store';
import { openCmdline, openMenu } from '../../shell/overlays';
import type { MenuItem } from '../../ui/Menu';
import { Button, cx, Icon, IconButton, Seg, Spinner } from '../../ui/primitives';
import { VimField, type VimFieldHandle } from '../../ui/VimField';
import { CodeLine, LangBadge, type Paint } from './code';
import { baseName, indentUnit, langOf, tokenizeAll, type Tok } from './highlight';
import { registerHooks } from './hooks';
import { diffLines, toHunks } from './linediff';
import { Markdown } from './md';
import { fileNav, openFile, readText } from './open';
import { ProjectTree, toggleDir, useLister, type TreeState } from './ProjectTree';
import { ctxOf, join, refreshNow, useRepo, viewState } from './repo';
import { halfPage, nativeTarget, useSideTree, useSurface } from './surface';

interface Doc { disk?: string; err?: string; binary?: boolean; gen: number; base?: string | null; baseGen?: number; loading?: boolean }
/** Loaded files and unsaved text, by machine + folder + path. Unsaved text outlives the tab, for this session. */
const docs = new Map<string, Doc>();
const bufs = new Map<string, string>();
const EDIT_N = new Set(['i', 'a', 'I', 'A', 'o', 'O', 's', 'S', 'c', 'C', 'd', 'D', 'x', 'X', 'r', 'p', 'P', 'J', '~', 'u', 'ctrl-r', 'delete']);
const EDIT_V = new Set(['d', 'x', 'c', 's', 'J', '~', 'r', 'delete']);
const HL_MAX = 8000;   // lines highlighted; the rest of a huge file is plain

interface View { rs: TextState; mode: 'read' | 'edit'; md: 'preview' | 'source'; tree: boolean; treeN?: boolean; ts: TreeState; find: string; opened: string }

const fakeKey = (k: string): KeyLike => ({ key: k.length === 1 ? k : k === 'esc' ? 'Escape' : k, code: '', ctrlKey: k.startsWith('ctrl-'), altKey: false, shiftKey: false, metaKey: false });
const lineStarts = (t: string) => { const a = [0]; for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) a.push(i + 1); return a; };
const lineAt = (ls: number[], pos: number) => { let lo = 0, hi = ls.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ls[m] <= pos) lo = m; else hi = m - 1; } return lo; };
const smart = (q: string) => (q !== q.toLowerCase() ? '' : 'i');

export function FileView({ t, focused }: { t: Tab; focused: boolean }) {
  useApp();
  const ctx = ctxOf(t);
  const path = t.path || '';
  const re = useRepo(ctx.machine, ctx.dir);
  const repo = re.repo;
  const lister = useLister(ctx, re);
  const nav = fileNav(t);
  const v = viewState<View>(t.id, () => ({ rs: init('', 'NORMAL'), mode: 'read', md: 'preview', tree: true, ts: { open: new Set(), cur: null, q: '' }, find: '', opened: '' }));
  const side = useSideTree(v);
  const key = `${ctx.machine}\u0000${ctx.dir}\u0000${path}`;
  const doc = docs.get(key) || { gen: -1 };
  const lang = langOf(path);
  const isMd = !!lang.md;
  const text = bufs.get(key) ?? doc.disk ?? '';
  const dirty = bufs.has(key) && bufs.get(key) !== doc.disk;
  const field = useRef<VimFieldHandle>(null);
  const body = useRef<HTMLDivElement>(null);

  // ---------- load the file, and its last committed text for the gutter ----------
  useEffect(() => {
    const d = docs.get(key);
    if (d && (d.gen === re.gen || d.loading)) return;
    const next: Doc = { ...(d || {}), gen: re.gen, loading: true };
    docs.set(key, next);
    void readText(ctx, path).then(r => {
      const was = next.disk;
      Object.assign(next, { loading: false, err: 'error' in r ? r.error : undefined, binary: 'binary' in r, disk: 'text' in r ? r.text : undefined });
      // the file changed on disk under unsaved text that matched it: nothing to keep
      if (was != null && bufs.get(key) === was) bufs.delete(key);
      update();
    });
  }, [key, re.gen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!repo || doc.baseGen === re.gen) return;
    doc.baseGen = re.gen;
    const rel = repo.prefix ? repo.prefix + '/' + path : path;
    const st = repo.changed[rel];
    if (!st) { doc.base = undefined; update(); return; }   // unchanged since the last commit: no marks
    if (st === 'A') { doc.base = ''; update(); return; }
    void api.git.show(ctx.machine, repo.root, rel, 'HEAD').then(b => { doc.base = b; update(); }, () => { doc.base = ''; update(); });
  }, [key, re.gen, !!repo, doc.disk != null]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the reader's text in step with the file
  if (v.rs.text !== text) v.rs = setText(v.rs, text, Math.min(v.rs.pos, Math.max(0, text.length - 1)));
  // a new file in this tab: open its folders in the tree, start at the top (or where asked)
  if (v.opened !== path) {
    v.opened = path; v.mode = 'read'; v.md = 'preview';
    const parts = path.split('/'); for (let i = 1; i < parts.length; i++) v.ts.open.add(parts.slice(0, i).join('/'));
    v.rs = { ...init(text, 'NORMAL'), pos: 0 };
  }

  const lines = useMemo(() => text.split('\n'), [text]);
  const starts = useMemo(() => lineStarts(text), [text]);
  const toks = useMemo<Tok[][]>(() => {
    const hl = tokenizeAll(lines.slice(0, HL_MAX), lang);
    return lines.length > HL_MAX ? [...hl, ...lines.slice(HL_MAX).map(l => [['', l]] as Tok[])] : hl;
  }, [lines, lang]);
  const unit = useMemo(() => indentUnit(lines), [lines]);
  const marks = useMemo(() => {
    if (doc.base == null) return null;
    const base = doc.base === '' ? [] : doc.base.replace(/\n$/, '').split('\n');
    const m = gutterMarks(toHunks(diffLines(base, text.replace(/\n$/, '').split('\n')), 0));
    const out = new Map<number, string>();
    m.add.forEach(n => out.set(n, 'g-add')); m.chg.forEach(n => out.set(n, 'g-chg')); m.del.forEach(n => { if (!out.has(n)) out.set(n, 'g-del'); });
    return out;
  }, [doc.base, text]);

  // where to put the cursor when asked (opened at a line, back / forward)
  useEffect(() => {
    const g = nav.goto; if (!g || doc.disk == null) return;
    nav.goto = undefined;
    const ln = Math.max(0, Math.min(starts.length - 1, g.line - 1));
    v.rs = { ...v.rs, pos: Math.min(starts[ln] + (g.col || 0), text.length), mode: 'NORMAL', anchor: 0 };
    if (isMd && g.line > 1) v.md = 'source';
    update();
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const curLine = lineAt(starts, v.rs.pos);
  nav.hist[nav.hi] && (nav.hist[nav.hi].line = curLine + 1);
  const preview = isMd && v.md === 'preview' && v.mode === 'read';

  // ---------- actions ----------
  const save = async () => {
    const now = bufs.get(key);
    if (now == null || !dirty) { if (now != null) bufs.delete(key); toast('No changes to save'); return; }
    try {
      await api.fs.write(ctx.machine, join(ctx.dir, path), now);
      const d = docs.get(key); if (d) d.disk = now;
      bufs.delete(key);
      toast(`Saved ${baseName(path)}`, { icon: 'check' });
      void refreshNow(ctx.machine, ctx.dir);
      update();
    } catch (e) { toast(`Could not save: ${e instanceof Error ? e.message : e}`, { icon: 'alert' }); }
  };
  const histStep = (d: number) => {
    const i = nav.hi + d; if (i < 0 || i >= nav.hist.length) return false;
    nav.hi = i; nav.goto = { line: nav.hist[i].line };
    update(() => { t.path = nav.hist[i].path; });
    return true;
  };
  useEffect(() => registerHooks(t.id, { back: () => histStep(-1), forward: () => histStep(1), save: () => { void save(); return true; } }));

  const edBox = useRef<HTMLDivElement>(null);
  const startEdit = (k?: string) => {
    const f = field.current, box = edBox.current;
    if (doc.disk == null || doc.binary || !f || !box) return;
    if (isMd) v.md = 'source';
    const vis = v.rs.mode === 'VISUAL' || v.rs.mode === 'V-LINE' ? { anchor: v.rs.anchor, mode: v.rs.mode } : undefined;
    const pending = v.rs.pending;
    v.mode = 'edit'; v.rs = { ...v.rs, pending: '', mode: 'NORMAL' };
    // the editor is always there, hidden while reading: show it and hand over in the same key press
    box.style.display = '';
    f.focus(); f.at(v.rs.pos, vis);
    const s = tabSurface(t.id);
    for (const c of [...pending.replace(/\s/g, '')]) s?.key(c, fakeKey(c));
    if (k) s?.key(k, fakeKey(k));
    update(x => { x.tick++; });
  };
  const stopEdit = () => {
    const st = field.current?.state();
    v.mode = 'read';
    if (st) v.rs = { ...v.rs, text: st.text, pos: Math.min(st.pos, Math.max(0, st.text.length - 1)), mode: 'NORMAL', pending: '' };
    (document.activeElement as HTMLElement | null)?.blur();
    own(); update();
  };
  const onEdit = (x: string) => { if (x === doc.disk) bufs.delete(key); else bufs.set(key, x); update(); };

  // find in file: a menu of matching lines; n / N step through them afterwards
  const hits = useMemo(() => {
    if (!v.find) return [] as { line: number; col: number }[];
    const re = new RegExp(v.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + smart(v.find)), out: { line: number; col: number }[] = [];
    lines.forEach((l, i) => { re.lastIndex = 0; let m; while ((m = re.exec(l)) && out.length < 5000) { out.push({ line: i, col: m.index }); if (!m[0]) re.lastIndex++; } });
    return out;
  }, [v.find, lines]);
  const gotoPos = (line: number, col: number) => { v.rs = { ...v.rs, pos: Math.min(starts[line] + col, text.length), mode: 'NORMAL' }; if (preview) v.md = 'source'; update(); };
  const find = (anchor?: DOMRect | null) => {
    openMenu<{ line: number; col: number }>({
      anchor: anchor ?? body.current?.closest('.file-v')?.querySelector('[data-k=find]')?.getBoundingClientRect() ?? null, place: 'bottom-end', width: 420,
      search: { placeholder: 'Find in file', value: v.find }, empty: 'No matches',
      items: q => {
        if (!q) return [];
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), smart(q)), out: MenuItem<{ line: number; col: number }>[] = [];
        for (let i = 0; i < lines.length && out.length < 200; i++) { const m = re.exec(lines[i]); if (m) out.push({ label: lines[i].trim() || ' ', hint: q, right: <span className="age">{i + 1}</span>, data: { line: i, col: m.index } }); }
        // the menu filters by label: keep every line that matched
        return out.map(it => ({ ...it, label: it.label.toLowerCase().includes(q.toLowerCase()) ? it.label : `${it.label} ${q}` }));
      },
      onPick: (it, q) => { v.find = q; if (it.data) gotoPos(it.data.line, it.data.col); },
    });
  };
  const nextHit = (d: number) => {
    if (!hits.length) { toast(v.find ? `No “${v.find}” in this file` : 'Nothing to find yet: press /'); return; }
    const col = v.rs.pos - starts[curLine];
    const i = d > 0 ? hits.findIndex(h => h.line > curLine || (h.line === curLine && h.col > col)) : hits.findLastIndex(h => h.line < curLine || (h.line === curLine && h.col < col));
    const h = hits[i < 0 ? (d > 0 ? 0 : hits.length - 1) : i];
    gotoPos(h.line, h.col);
  };
  // the folder list behind a crumb: subfolders, then files; a folder opens its own list
  const crumbMenu = (dir: string, anchor?: DOMRect | null) => {
    const a = anchor ?? body.current?.closest('.file-v')?.querySelector(`.crumb[data-d="${CSS.escape(dir)}"]`)?.getBoundingClientRect() ?? null;
    const kids = lister.kids(dir);
    const show = (es: { name: string; rel: string; dir: boolean; ign?: boolean }[]) => openMenu<{ rel: string; dir: boolean }>({
      anchor: a, place: 'bottom-start', width: 280, search: { placeholder: `Go to a file in ${dir || baseName(ctx.dir)}` }, normal: true, empty: 'Empty folder',
      items: [...(dir ? [{ label: '..', icon: <Icon name="folder" />, hint: 'Up', data: { rel: dir.includes('/') ? dir.replace(/\/[^/]*$/, '') : '', dir: true } }] : []),
        ...es.map(e => ({ label: e.dir ? e.name + '/' : e.name, icon: e.dir ? <Icon name="folder" /> : <LangBadge path={e.rel} />, on: e.rel === path, dis: e.ign && e.name === '.git', data: { rel: e.rel, dir: e.dir } }))],
      onPick: it => { if (!it.data) return; if (it.data.dir) crumbMenu(it.data.rel, a); else openFile(ctx, it.data.rel, { from: t }); },
    });
    if (kids) show(kids);
    else void api.fs.list(ctx.machine, join(ctx.dir, dir)).then(es => show(es.map(e => ({ name: e.name, rel: dir ? dir + '/' + e.name : e.name, dir: e.dir })))).catch(e => toast(String(e)));
  };

  // ---------- keys while reading ----------
  const scrollBy = (px: number) => body.current?.scrollBy({ top: px });
  const { own } = useSurface(t.id, focused, {
    mode: (): Mode => (v.rs.mode === 'INSERT' ? 'NORMAL' : v.rs.mode),
    key: k => {
      if (nativeTarget() && (k === 'enter' || k === 'space')) return false;
      if (doc.disk == null) return k.length === 1;
      const visual = v.rs.mode === 'VISUAL' || v.rs.mode === 'V-LINE';
      if (v.rs.pending.endsWith('g') && k === 'p' && isMd) { v.rs = { ...v.rs, pending: '' }; v.md = v.md === 'preview' ? 'source' : 'preview'; update(); return true; }
      if (!v.rs.pending || /^\d+$/.test(v.rs.pending)) {
        if (k === '/') { find(); return true; }
        if (k === 'n' && !visual) { nextHit(1); return true; }
        if (k === 'N' && !visual) { nextHit(-1); return true; }
        if (k === '-' && !visual) { crumbMenu(path.includes('/') ? path.replace(/\/[^/]*$/, '') : ''); return true; }
        if (k === ':' && !visual) { openCmdline(); return true; }
        if (k === 'ctrl-d' || k === 'ctrl-u' || k === 'pagedown' || k === 'pageup') {
          const n = halfPage(body.current, 20) * (k === 'ctrl-d' || k === 'pagedown' ? 1 : -1);
          if (preview) { scrollBy(n * 20); return true; }
          const ln = Math.max(0, Math.min(starts.length - 1, curLine + n)); v.rs = { ...v.rs, pos: starts[ln] + Math.min(v.rs.pos - starts[curLine], Math.max(0, lines[ln].length - 1)) }; update(); return true;
        }
        if (k === 'esc' && !visual && v.find) { v.find = ''; update(); return true; }
        if (k === 'enter' && !visual) { startEdit(); return true; }
        if (preview) {
          if (k === 'j' || k === 'down') { scrollBy(40); return true; }
          if (k === 'k' || k === 'up') { scrollBy(-40); return true; }
          if (k === 'G') { body.current?.scrollTo({ top: 1e9 }); return true; }
        }
        if (!visual && EDIT_N.has(k) && !(preview && k === 'u')) { startEdit(k); return true; }
        if (visual && EDIT_V.has(k)) { startEdit(k); return true; }
      }
      if (preview && v.rs.pending === 'g' && k === 'g') { v.rs = { ...v.rs, pending: '' }; body.current?.scrollTo({ top: 0 }); update(); return true; }
      if (/^[dcr]/.test(v.rs.pending.replace(/^\d+/, ''))) { startEdit(k); return true; }   // an operator typed while reading
      const r = step(v.rs, k);
      if (!r.handled) return k.length === 1;
      if (r.fx.includes('yank')) { void navigator.clipboard?.writeText(r.s.reg.text).catch(() => {}); toast(`Copied ${r.s.reg.text.split('\n').length > 1 ? r.s.reg.text.split('\n').length + ' lines' : 'selection'}`); }
      if (r.fx.includes('leave')) { v.rs = { ...r.s, mode: 'NORMAL' }; update(); return false; }
      if (r.s.text !== v.rs.text) { startEdit(k); return true; }   // anything that would change the text edits instead
      v.rs = { ...r.s, mode: r.s.mode === 'INSERT' ? 'NORMAL' : r.s.mode }; update();
      return true;
    },
  });

  // keep the cursor in sight, and the editor's caret too
  useLayoutEffect(() => {
    if (v.mode !== 'read' || preview) return;
    body.current?.querySelector('.src .dl.curl')?.scrollIntoView({ block: 'nearest' });
  }, [v.rs.pos, v.mode, preview, focused]);
  useEffect(() => {
    if (v.mode !== 'edit') return;
    const onSel = () => {
      const el = field.current?.el(), b = body.current; if (!el || document.activeElement !== el || !b) return;
      const ln = lineAt(lineStarts(el.value.slice(0, el.selectionEnd)), el.selectionEnd);
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 19.8, top = el.offsetTop + ln * lh;
      if (top < b.scrollTop + 8) b.scrollTop = top - 8; else if (top + lh > b.scrollTop + b.clientHeight - 8) b.scrollTop = top + lh - b.clientHeight + 8;
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [v.mode]);

  // ---------- mouse: a click puts the cursor there, a double click starts editing ----------
  const posFromPoint = (e: React.MouseEvent): number | null => {
    const row = (e.target as HTMLElement).closest('.dl') as HTMLElement | null; if (!row) return null;
    const ln = +(row.dataset.ln || 0), c = row.querySelector('.c'); if (!c) return null;
    const cr = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
    let col = lines[ln].length;
    if (cr && c.contains(cr.startContainer)) {
      col = 0;
      const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT); let n: Node | null;
      while ((n = w.nextNode())) { if (n === cr.startContainer) { col += cr.startOffset; break; } col += (n.textContent || '').length; }
    }
    return starts[ln] + Math.min(col, Math.max(0, lines[ln].length - 1));
  };

  // ---------- render ----------
  const parts = path.split('/');
  const sel = v.rs.mode === 'VISUAL' || v.rs.mode === 'V-LINE' ? vrange(v.rs) : null;
  const findRe = v.find ? new RegExp(v.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + smart(v.find)) : null;
  const paintFor = (i: number): Paint[] | undefined => {
    const out: Paint[] = [];
    const s = starts[i], e = s + lines[i].length;
    if (findRe && lines[i]) { findRe.lastIndex = 0; let m; while ((m = findRe.exec(lines[i]))) { out.push({ from: m.index, to: m.index + Math.max(1, m[0].length), cls: 'hit' }); if (!m[0]) findRe.lastIndex++; } }
    if (sel && sel[0] <= e && sel[1] >= s) out.push({ from: Math.max(0, sel[0] - s), to: Math.min(lines[i].length + 1, sel[1] - s), cls: 'vs' });
    if (focused && i === curLine && v.mode === 'read') out.push({ from: v.rs.pos - s, to: v.rs.pos - s + 1, cls: 'vc' });
    return out.length ? out : undefined;
  };
  const showLines = v.mode === 'read' && !preview && doc.disk != null && !doc.binary;
  return (
    <div className="file-v" ref={side.ref} onMouseDown={e => { if (v.mode === 'read' && !(e.target as HTMLElement).closest('.ctree, .tool-h')) own(); }}>
      <header className={cx('tool-h', dirty && 'dirty')}>
        <IconButton icon="chev" className="flip" small label="Back" keys="ctrl-o" disabled={nav.hi === 0} onClick={() => histStep(-1)} />
        <IconButton icon="chev" small label="Forward" keys="ctrl-i" disabled={nav.hi >= nav.hist.length - 1} onClick={() => histStep(1)} />
        <nav className="crumbs" aria-label="Path">
          <button type="button" className="crumb" data-d="" title={`${ctx.dir} · ${kb('-')} lists this file's folder`} onClick={e => crumbMenu('', e.currentTarget.getBoundingClientRect())}>{baseName(ctx.dir) || ctx.dir}</button>
          {parts.slice(0, -1).map((d, i) => {
            const rel = parts.slice(0, i + 1).join('/');
            return <span key={rel} className="cr"><Icon name="chev" className="sep" /><button type="button" className="crumb" data-d={rel} onClick={e => crumbMenu(rel, e.currentTarget.getBoundingClientRect())}>{d}</button></span>;
          })}
          <Icon name="chev" className="sep" /><span className="crumb now"><LangBadge path={path} />&nbsp;{parts[parts.length - 1]}</span>
        </nav>
        <span className="mod dim"><span className="mod-dot" />Modified</span>
        <span className="sp" />
        {dirty && <Button small className="mod" onClick={() => void save()} title={`Save · :w · ${kb('mod-s')}`}>Save</Button>}
        {isMd && <Seg text label="Preview or source" value={preview ? 'preview' : 'source'} onChange={x => { if (v.mode === 'edit') stopEdit(); v.md = x; update(); }}
          options={[{ v: 'preview', label: 'Preview' }, { v: 'source', label: 'Source' }]} />}
        <IconButton data-k="find" icon="search" small label="Find in file" keys="/" onClick={e => find(e.currentTarget.getBoundingClientRect())} />
        <IconButton icon="panelR" small on={side.show} aria-pressed={side.show} label="Project files" onClick={side.toggle} />
      </header>
      <div className={cx('cbody', side.show && 'tree')}>
        <div className={cx('tool-b', focused && v.mode === 'read' && 'rd')} data-read ref={body}>
          {doc.err ? <div className="r-empty"><Icon name="alert" size="xl" /><span>{doc.err}</span></div>
            : doc.binary ? <div className="r-empty bin"><Icon name="file" size="xl" /><span>Binary file, not shown</span></div>
            : doc.disk == null ? <div className="r-empty"><Spinner label="Opening" /></div>
            : (
              <div className="ed" ref={edBox} style={v.mode === 'edit' ? undefined : { display: 'none' }}>
                <pre className="ed-n" aria-hidden="true">{lines.map((_, i) => i + 1).join('\n')}</pre>
                <VimField key={key} ref={field} tabId={t.id} value={text} onChange={onEdit} mono className="rc-ed file-ed" maxHeight={1e7} startMode="NORMAL"
                  onLeave={stopEdit} onKey={(k, mode) => {
                    if (k === 'ctrl-s' || k === 'cmd-s') { void save(); return true; }
                    if (k === ':' && mode === 'NORMAL') { openCmdline(); return true; }
                    return false;
                  }} />
              </div>
            )}
          {showLines && (
            <div className="src" role="textbox" aria-readonly="true" aria-label={path} aria-multiline="true"
              onMouseDown={e => { if (e.detail > 1) return; const p = posFromPoint(e); if (p != null) { v.rs = { ...v.rs, pos: p, mode: 'NORMAL' }; update(); } }}
              onDoubleClick={e => { const p = posFromPoint(e); if (p != null) { v.rs = { ...v.rs, pos: p, mode: 'NORMAL' }; startEdit('i'); } }}>
              {lines.map((_, i) => (
                <div key={i} data-ln={i} className={cx('dl', marks?.get(i + 1), i === curLine && 'curl', sel && v.rs.mode === 'V-LINE' && starts[i] >= sel[0] && starts[i] <= sel[1] && 'vsel')}>
                  <span className="n">{i + 1}</span><span className="c"><CodeLine toks={toks[i] || []} unit={unit} paint={paintFor(i)} /></span>
                </div>
              ))}
            </div>
          )}
          {v.mode === 'read' && preview && doc.disk != null && <article className="doc prose" onDoubleClick={() => startEdit('i')}><Markdown text={text} /></article>}
        </div>
        {side.show && (
          <aside className="ctree" aria-label="Project files">
            <ProjectTree l={lister} st={v.ts} active={path} label="Project files" onOpen={n => { if (n.dir) toggleDir(lister, v.ts, n.rel); else openFile(ctx, n.rel, { from: t }); }} />
          </aside>
        )}
      </div>
    </div>
  );
}

void S;
