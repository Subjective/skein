// An open file, in the code editor (ui/editor/CodeEditor: CodeMirror with its Vim mode, the same everywhere code is
// edited). It opens in NORMAL: motions, counts, v / V and y read it; i, a, o, x, d, p ... edit it in place, with
// u / ctrl-r. / ? n N search through the shared search popup (ui/search.tsx). :w, ctrl-s / cmd-s or Save in the ⋯
// menu writes it. Unsaved text stays with the file (closing the tab keeps it for this session) and is what Preview shows.
// Markdown opens as a preview (a reader: j / k scroll, gp or the switch shows the source); v or V there opens the
// source at the top of the view with that line selected, so y copies Markdown, not rendered text.
// The header has back / forward (ctrl-o / ctrl-i, through the jump list), the path (each folder opens a list of
// what is in it; - opens the file's own folder), the language, the ⋯ menu (fileactions.tsx) and the project tree. Lines changed since the last
// commit get a bar in the gutter: green added, amber changed, a red notch where lines were removed.
// Links in the Markdown preview follow (mdlinks.ts): a file opens in this tab (ctrl-o comes back), a heading
// scrolls into view, a web link opens in the system browser. tab / shift-tab ring them, enter or g x follows.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { gutterMarks } from '@shared/gutter';
import { api } from '../../api';
import type { Mode } from '../../input/dispatcher';
import { kb } from '../../input/platform';
import { ReaderSearch, type Searchable } from '../../ui/search';
import type { Tab } from '../../state/layout';
import { toast, update, useApp } from '../../state/store';
import { openCmdline, openMenu } from '../../shell/overlays';
import { cx, Icon, IconButton, Seg, Spinner } from '../../ui/primitives';
import { CodeEditor, type CodeEditorHandle } from '../../ui/editor/CodeEditor';
import { LangBadge } from './code';
import { useToolSel } from './mousesel';
import { baseName, langOf } from './highlight';
import { registerHooks } from './hooks';
import { numbersOn, openFileMenu, registerFile, wrapOn } from './fileactions';
import { diffLines, toHunks } from './linediff';
import { Markdown } from './md';
import { linkTarget, type LinkTarget } from './mdlinks';
import { fileNav, openFile, readText, splitClick, splitKey } from './open';
import { ProjectTree, toggleDir, useLister, type TreeState } from './ProjectTree';
import { ctxOf, join, refreshNow, useRepo, viewState } from './repo';
import { halfPage, nativeTarget, useSideTree, useSurface } from './surface';
import { dragEdge, ResizeHandle, resetEdge, TREE_EDGE } from '../../ui/resize';

const resizeTree = dragEdge(TREE_EDGE);

interface Doc { disk?: string; err?: string; binary?: boolean; gen: number; base?: string | null; baseGen?: number; loading?: boolean }
/** Loaded files and unsaved text, by machine + folder + path. Unsaved text outlives the tab, for this session. */
const docs = new Map<string, Doc>();
const bufs = new Map<string, string>();
/** An open file with edits not saved yet: its tab shows a dot after the name. */
export function fileDirty(t: Tab): boolean {
  const c = ctxOf(t), key = `${c.machine}\u0000${c.dir}\u0000${t.path || ''}`;
  return bufs.has(key) && bufs.get(key) !== docs.get(key)?.disk;
}
/** Keys that leave a Markdown preview for the source and act there. */
const TO_SOURCE = new Set(['i', 'a', 'I', 'A', 'o', 'O', 'enter', 'v', 'V']);

/** `then`: what to do once the source editor is on screen (a key from the preview, a jump from search). */
interface View { md: 'preview' | 'source'; lk: number; lkTip?: string; hover?: string; diff?: boolean; tree: boolean; treeN?: boolean; ts: TreeState; find: string; opened: string; search: ReaderSearch; reader?: Searchable; then?: (ed: CodeEditorHandle) => void; pend: string }

const lineStarts = (t: string) => { const a = [0]; for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) a.push(i + 1); return a; };
const lineAt = (ls: number[], pos: number) => { let lo = 0, hi = ls.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ls[m] <= pos) lo = m; else hi = m - 1; } return lo; };

export function FileView({ t, focused }: { t: Tab; focused: boolean }) {
  useApp();
  const ctx = ctxOf(t);
  const path = t.path || '';
  const re = useRepo(ctx.machine, ctx.dir);
  const repo = re.repo;
  const lister = useLister(ctx, re);
  const nav = fileNav(t);
  const v = viewState<View>(t.id, () => {
    const x: View = { md: 'preview', lk: -1, tree: true, ts: { open: new Set(), cur: null, q: '' }, find: '', opened: '', search: null as unknown as ReaderSearch, pend: '' };
    x.search = new ReaderSearch(() => x.reader!);
    return x;
  });
  const side = useSideTree(v);
  const key = `${ctx.machine}\u0000${ctx.dir}\u0000${path}`;
  const doc = docs.get(key) || { gen: -1 };
  const lang = langOf(path);
  const isMd = !!lang.md;
  const text = bufs.get(key) ?? doc.disk ?? '';
  const dirty = bufs.has(key) && bufs.get(key) !== doc.disk;
  const ed = useRef<CodeEditorHandle>(null);
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

  // a new file in this tab: open its folders in the tree, start at the top (or where asked)
  if (v.opened !== path) {
    v.opened = path; v.md = 'preview'; v.lk = -1; v.hover = undefined; v.find = '';
    const parts = path.split('/'); for (let i = 1; i < parts.length; i++) v.ts.open.add(parts.slice(0, i).join('/'));
  }

  const lines = useMemo(() => text.split('\n'), [text]);
  const starts = useMemo(() => lineStarts(text), [text]);
  const marks = useMemo(() => {
    if (doc.base == null) return null;
    const base = doc.base === '' ? [] : doc.base.replace(/\n$/, '').split('\n');
    const m = gutterMarks(toHunks(diffLines(base, text.replace(/\n$/, '').split('\n')), 0));
    const out = new Map<number, string>();
    m.add.forEach(n => out.set(n, 'g-add')); m.chg.forEach(n => out.set(n, 'g-chg')); m.del.forEach(n => { if (!out.has(n)) out.set(n, 'g-del'); });
    return out;
  }, [doc.base, text]);

  // the diff view: the last commit's removed lines drawn above where they were, added lines marked
  const diffv = !!v.diff && doc.base != null;
  const drows = useMemo(() => {
    if (!diffv) return null;
    const base = doc.base ? doc.base.replace(/\n$/, '').split('\n') : [];
    const gone = new Map<number, string[]>(), added = new Set<number>();
    let b = 0;
    for (const l of diffLines(base, text.replace(/\n$/, '').split('\n'))) {
      if (l.k === '-') gone.set(b, [...(gone.get(b) || []), l.text]);
      else { if (l.k === '+') added.add(b); b++; }
    }
    return { gone, added };
  }, [diffv, doc.base, text]);

  const ready = doc.disk != null && !doc.binary && !doc.err;
  const preview = isMd && v.md === 'preview';
  const source = ready && !preview;

  /** Show the source (from a preview) and, once the editor is there, do `then` in it. */
  const toSource = (then?: (e: CodeEditorHandle) => void) => {
    if (source && ed.current) { then?.(ed.current); return; }
    v.md = 'source'; v.then = then; update();
  };
  useLayoutEffect(() => {
    if (!source || !ed.current) return;
    if (focused && !body.current?.querySelector('.cm-editor')?.contains(document.activeElement) && !body.current?.closest('.file-v')?.querySelector('.ctree')?.contains(document.activeElement)) ed.current.focus();
    const then = v.then; v.then = undefined; then?.(ed.current);
  });

  // where to put the cursor when asked (opened at a line, back / forward)
  useEffect(() => {
    const g = nav.goto; if (!g || doc.disk == null) return;
    nav.goto = undefined;
    const ln = Math.max(0, Math.min(starts.length - 1, g.line - 1));
    const pos = Math.min(starts[ln] + (g.col || 0), text.length);
    if (isMd && g.line > 1) toSource(e => e.at(pos));
    else if (ed.current) ed.current.at(pos);
    else v.then = e => e.at(pos);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const curLine = () => (source && ed.current ? lineAt(starts, ed.current.pos()) : 0);

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
    nav.hist[nav.hi].line = curLine() + 1;
    nav.hi = i; nav.goto = { line: nav.hist[i].line };
    update(() => { t.path = nav.hist[i].path; });
    return true;
  };
  useEffect(() => registerHooks(t.id, { back: () => histStep(-1), forward: () => histStep(1), save: () => { void save(); return true; } }));
  // the ⋯ menu (fileactions.tsx) asks this tab what it can do
  useEffect(() => registerFile(t.id, {
    dirty: () => dirty, discard: () => { bufs.delete(key); update(); }, canDiff: () => doc.base != null, diff: () => !!v.diff,
    setDiff: on => { v.diff = on; if (on && isMd) v.md = 'source'; update(); },
    repo: () => (repo ? { root: repo.root, rel: repo.prefix ? repo.prefix + '/' + path : path } : null),
  }));
  // a mouse selection is VISUAL with the Add to Chat bar (VIM-MODEL rule 10); it goes when VISUAL does
  const tsel = useToolSel(t, () => {});
  const onEdit = (x: string) => { if (x === doc.disk) bufs.delete(key); else bufs.set(key, x); update(); };

  // / ? n N: the shared reader search (ui/search.tsx) over the file's lines; matches are painted with `hit`
  v.reader = {
    items: () => lines,
    at: () => { const i = curLine(); return { i, o: (ed.current?.pos() ?? 0) - starts[i] }; },
    go: h => { const pos = Math.min(starts[h.i] + h.o, text.length); toSource(e => e.at(pos)); },
    paint: q => { v.find = q; update(); },
    anchor: () => body.current?.getBoundingClientRect() ?? null,
    num: h => h.i + 1,
  };
  const find = () => v.search.prompt(1);
  // the folder list behind a crumb: subfolders, then files; a folder opens its own list
  const crumbMenu = (dir: string, anchor?: DOMRect | null) => {
    const a = anchor ?? body.current?.closest('.file-v')?.querySelector(`.crumb[data-d="${CSS.escape(dir)}"]`)?.getBoundingClientRect() ?? null;
    const kids = lister.kids(dir);
    const show = (es: { name: string; rel: string; dir: boolean; ign?: boolean }[]) => openMenu<{ rel: string; dir: boolean }>({
      anchor: a, place: 'bottom-start', width: 280, search: { placeholder: `Go to a file in ${dir || baseName(ctx.dir)}` }, empty: 'Empty folder',
      items: [...(dir ? [{ label: '..', icon: <Icon name="folder" />, data: { rel: dir.includes('/') ? dir.replace(/\/[^/]*$/, '') : '', dir: true } }] : []),
        ...es.map(e => ({ label: e.dir ? e.name + '/' : e.name, icon: e.dir ? <Icon name="folder" /> : <LangBadge path={e.rel} />, on: e.rel === path, dis: e.ign && e.name === '.git', data: { rel: e.rel, dir: e.dir } }))],
      onPick: it => { if (!it.data) return; if (it.data.dir) crumbMenu(it.data.rel, a); else openFile(ctx, it.data.rel, { from: t }); },
    });
    if (kids) show(kids);
    else void api.fs.list(ctx.machine, join(ctx.dir, dir)).then(es => show(es.map(e => ({ name: e.name, rel: dir ? dir + '/' + e.name : e.name, dir: e.dir })))).catch(e => toast(String(e)));
  };
  const folder = () => crumbMenu(path.includes('/') ? path.replace(/\/[^/]*$/, '') : '');

  // ---------- keys in the source: the file's own, before Vim (ui/editor/CodeEditor onKey) ----------
  const editorKey = (k: string, c: { mode: Mode; idle: boolean; held: string }) => {
    if (k === 'ctrl-s' || k === 'cmd-s') { void save(); return true; }
    if (c.held === 'g' && k === 'p' && isMd) { v.md = 'preview'; update(); return true; }
    if (!c.idle) return false;
    if (k === '/' || k === '?' || ((k === 'n' || k === 'N') && v.search.active)) return v.search.key(k, 1);
    if (k === 'n' || k === 'N') { v.search.next(1); return true; }
    if (k === ':') { openCmdline(); return true; }
    if (k === '-') { folder(); return true; }
    if (k === 'esc') return v.search.clear();
    return false;
  };

  // ---------- links in the preview ----------
  const links = () => [...(body.current?.querySelectorAll<HTMLElement>('.doc a.mlink') ?? [])];
  const showHeading = (id: string) => {
    const h = body.current?.querySelector<HTMLElement>(`.doc [data-slug="${CSS.escape(id)}"]`); if (!h) return false;
    h.scrollIntoView({ block: 'start' });
    h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash');
    return true;
  };
  const follow = async (a: HTMLElement, split = false) => {
    const href = a.dataset.href || '', to = linkTarget(href, path);
    if (to.kind === 'none') { toast(`Skein does not open ${href.replace(/:.*/, ':')} links`); return; }
    if (to.kind === 'external') { void api.app.openExternal(to.url); return; }
    if (to.kind === 'anchor') { if (!showHeading(to.slug)) toast(`No heading #${to.slug} in ${baseName(path)}`); return; }
    // a file or a folder: look it up first, so a broken link says so instead of opening an error tab
    const dir = to.path.includes('/') ? to.path.replace(/\/[^/]*$/, '') : '', name = to.path.slice(dir ? dir.length + 1 : 0);
    const es = await api.fs.list(ctx.machine, join(ctx.dir, dir)).catch(() => []);
    const e = es.find(x => x.name === name) || es.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!e) { toast(`No file at ${to.path}`); return; }
    const rel = dir ? dir + '/' + e.name : e.name;
    if (e.dir) { crumbMenu(rel, a.getBoundingClientRect()); return; }
    openFile(ctx, rel, { from: t, split, line: to.line, anchor: to.slug });
  };
  /** tab / shift-tab: the next or previous link, starting from what is on screen when the ringed one is not. */
  const ringLink = (d: 1 | -1) => {
    const ls = links(), b = body.current?.getBoundingClientRect();
    if (!ls.length || !b) { toast('No links in this file'); return; }
    const cur = ls[v.lk], seen = (r: DOMRect) => r.bottom > b.top && r.top < b.bottom;
    let i: number;
    if (cur && seen(cur.getBoundingClientRect())) i = (v.lk + d + ls.length) % ls.length;
    else if (d > 0) { i = ls.findIndex(a => a.getBoundingClientRect().top >= b.top); if (i < 0) i = 0; }
    else { i = ls.findLastIndex(a => a.getBoundingClientRect().bottom <= b.bottom); if (i < 0) i = ls.length - 1; }
    v.lk = i; v.lkTip = tipOf(ls[i]);
    ls[i].scrollIntoView({ block: 'nearest' });
    update();
  };
  const tipOf = (a: HTMLElement) => {
    const to: LinkTarget = linkTarget(a.dataset.href || '', path);
    return to.kind === 'external' ? to.url : to.kind === 'anchor' ? '#' + to.slug : to.kind === 'file' ? to.path + (to.line ? `#L${to.line}` : to.slug ? '#' + to.slug : '') : a.dataset.href;
  };
  // an anchor asked for when the file opened (openFile's `anchor`): show the preview there
  useLayoutEffect(() => {
    if (!nav.anchor || doc.disk == null) return;
    if (isMd && v.md !== 'preview') { v.md = 'preview'; update(); return; }
    const id = nav.anchor; nav.anchor = undefined;
    if (isMd && !showHeading(id)) toast(`No heading #${id} in ${baseName(path)}`);
  });
  // the ringed link shows while the keys are here; it, or the link under the pointer, shows where it goes
  useLayoutEffect(() => { links().forEach((a, i) => a.classList.toggle('kcur', focused && preview && i === v.lk)); });
  const hover = (e: React.MouseEvent) => {
    const a = e.type === 'mouseover' ? (e.target as Element).closest<HTMLElement>('a.mlink') : null, tip = a ? tipOf(a) : undefined;
    if (tip !== v.hover) { v.hover = tip; update(); }
  };
  const tip = preview ? v.hover ?? (focused && links()[v.lk] ? v.lkTip : undefined) : undefined;

  // ---------- keys in a Markdown preview (or while the file loads): a reader ----------
  const scrollBy = (px: number) => body.current?.scrollBy({ top: px });
  /** The source line at the top of the preview. */
  const topLine = () => {
    const b = body.current; if (!b) return 0;
    const top = b.getBoundingClientRect().top;
    const el = [...b.querySelectorAll<HTMLElement>('.doc [data-ln]')].find(x => x.getBoundingClientRect().bottom > top + 4);
    return el ? +(el.dataset.ln || 0) : 0;
  };
  const reader = useSurface(t.id, focused, {
    mode: (): Mode => 'NORMAL',
    key: k => {
      if (nativeTarget() && (k === 'enter' || k === 'space')) return false;
      if (!preview || doc.disk == null) return k.length === 1;
      const p = v.pend; v.pend = '';
      const n = Math.max(1, parseInt(p || '1', 10));
      if (/^\d$/.test(k) && (p || k !== '0')) { v.pend = p + k; return true; }
      if (p === 'g' && k === 'p') { toSource(); return true; }
      if (p === 'g' && (k === 'x' || k === 'f')) { const a = links()[v.lk]; if (a) void follow(a); else toast(`No link chosen · ${kb('tab')} moves to one`); return true; }
      if (k === 'tab' || k === 'shift-tab') { ringLink(k === 'tab' ? 1 : -1); return true; }
      const lk = links()[v.lk];
      if (lk && (k === 'enter' || k === 'o' || splitKey(k))) { void follow(lk, splitKey(k)); return true; }
      if (lk && k === 'esc') { v.lk = -1; v.lkTip = undefined; update(); return true; }
      if (p === 'g' && k === 'g') { body.current?.scrollTo({ top: 0 }); return true; }
      if (k === 'g') { v.pend = 'g'; return true; }
      if (k === 'j' || k === 'down') { scrollBy(40 * n); return true; }
      if (k === 'k' || k === 'up') { scrollBy(-40 * n); return true; }
      if (k === 'G') { body.current?.scrollTo({ top: 1e9 }); return true; }
      if (k === 'ctrl-d' || k === 'ctrl-u' || k === 'pagedown' || k === 'pageup') { scrollBy(halfPage(body.current, 20) * 20 * n * (k === 'ctrl-d' || k === 'pagedown' ? 1 : -1)); return true; }
      if (k === '/' || k === '?' || ((k === 'n' || k === 'N') && v.search.active)) { v.search.key(k, n); return true; }
      if (k === 'esc' && v.search.clear()) return true;
      if (k === '-') { folder(); return true; }
      if (TO_SOURCE.has(k)) {
        // the source, at the line on top of the preview: v / V select from there, the editing keys act there
        const pos = starts[Math.min(topLine(), starts.length - 1)];
        toSource(e => { e.at(pos); if (k === 'v' || k === 'V') e.at(pos, { anchor: pos, mode: k === 'V' ? 'V-LINE' : 'VISUAL' }); else if (k !== 'enter') e.feed(k); });
        return true;
      }
      return false;   // : H L and the rest: the NORMAL layer
    },
  });

  // ---------- render ----------
  const parts = path.split('/');
  return (
    <div className={cx('file-v', !numbersOn() && 'nonum', wrapOn() && 'wrap')} ref={side.ref}>
      <header className="tool-h">
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
        <span className="sp" />
        {isMd && <Seg text label="Preview or source" value={preview ? 'preview' : 'source'} onChange={x => { v.md = x; update(); }}
          options={[{ v: 'preview', label: 'Preview' }, { v: 'source', label: 'Source' }]} />}
        <IconButton data-k="find" icon="search" small label="Find in file" keys="/" onClick={() => find()} />
        <IconButton data-k="more" icon="dots" small label="More actions" onClick={e => openFileMenu(t, e.currentTarget.getBoundingClientRect())} />
        <IconButton icon="panelR" small on={side.show} aria-pressed={side.show} label="Project files" onClick={side.toggle} />
      </header>
      <div className={cx('cbody', side.show && 'tree')}>
        <div className={cx('tool-b', source && 'code')} data-read ref={body} onMouseDown={() => { if (!source) reader.own(); }}>
          {doc.err ? <div className="r-empty"><Icon name="alert" size="xl" /><span>{doc.err}</span></div>
            : doc.binary ? <div className="r-empty bin"><Icon name="file" size="xl" /><span>Binary file, not shown</span></div>
            : doc.disk == null ? <div className="r-empty"><Spinner label="Opening" /></div>
            : preview ? (
              <article className="doc prose" data-src={`file:${path}`} onMouseOver={hover} onMouseLeave={hover}
                onMouseUp={() => { const g = getSelection(); if (g && !g.isCollapsed && body.current?.contains(g.anchorNode)) tsel.show(g.toString()); }}
                onClick={e => {
                  const a = (e.target as Element).closest<HTMLElement>('a.mlink');
                  if (!a || getSelection()?.toString()) return;
                  e.preventDefault(); v.lk = -1; v.lkTip = undefined;
                  void follow(a, splitClick(e));
                }}>
                <Markdown text={text} />
              </article>)
            : <CodeEditor key={key} ref={ed} tabId={t.id} id={key} value={text} onChange={onEdit} path={path} marks={drows ? null : marks} diff={drows}
                numbers={numbersOn()} wrap={wrapOn()} find={v.find || undefined} className="src" dataSrc={`file:${path}`} onKey={editorKey} onMouseSel={x => tsel.show(x)} />}
        </div>
        {tip && <div className="link-tip" role="status">{tip}</div>}
        {side.show && (<>
          <ResizeHandle axis="x" label="Resize file tree" onPointerDown={resizeTree} onDoubleClick={() => resetEdge(TREE_EDGE)} />
          <aside className="ctree" aria-label="Project files">
            <ProjectTree l={lister} st={v.ts} active={path} label="Project files" onOpen={(n, split) => { if (n.dir) toggleDir(lister, v.ts, n.rel); else openFile(ctx, n.rel, { from: t, split }); }} />
          </aside>
        </>)}
      </div>
      {tsel.bar}
    </div>
  );
}
