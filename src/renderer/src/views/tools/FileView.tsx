// An open file, in the code editor (ui/editor/CodeEditor: CodeMirror with its Vim mode, the same everywhere code is
// edited). It opens in NORMAL: motions, counts, v / V and y read it; i, a, o, x, d, p ... edit it in place, with
// u / ctrl-r. / ? n N search through the shared search popup (ui/search.tsx). :w, ctrl-s / cmd-s or Save in the ⋯
// menu writes it. Unsaved text stays with the file (closing the tab keeps it for this session) and is what Preview shows.
// Markdown opens as a live Preview: the same editor and the same Vim, with the Markdown drawn as it reads while you
// edit it (ui/editor/markdown.ts); gp or the switch shows the plain source. Either way the file is the file's text.
// The header has back / forward (ctrl-o / ctrl-i, through the jump list), the path (each folder opens a list of
// what is in it; - opens the file's own folder), the language, the ⋯ menu (fileactions.tsx) and the project tree. Lines changed since the last
// commit get a bar in the gutter: green added, amber changed, a red notch where lines were removed.
// Links in the preview follow (mdlinks.ts): a file opens in this tab (ctrl-o comes back), a heading puts the cursor
// there, a web link opens in the system browser. tab / shift-tab move to the next or previous link, enter or g x on
// one follows it (shift-enter in a new split), as does a click with a modifier.
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
import { EditorView } from '@codemirror/view';
import { CodeEditor, type CodeEditorHandle } from '../../ui/editor/CodeEditor';
import { mdHeadings, mdLinks } from '../../ui/editor/markdown';
import { LangBadge } from './code';
import { useToolSel } from './mousesel';
import { baseName, langOf } from './highlight';
import { registerHooks } from './hooks';
import { numbersOn, openFileMenu, registerFile, wrapOn } from './fileactions';
import { diffLines, toHunks } from './linediff';
import { linkTarget, slugger, type LinkTarget } from './mdlinks';
import { fileNav, openFile, readText, splitClick, splitKey } from './open';
import { ProjectTree, toggleDir, useLister, type TreeState } from './ProjectTree';
import { ctxOf, join, refreshNow, useRepo, viewState } from './repo';
import { nativeTarget, useSideTree, useSurface } from './surface';
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
/** `then`: what to do once the source editor is on screen (a key from the preview, a jump from search). */
interface View { md: 'preview' | 'source'; tip?: string; diff?: boolean; tree: boolean; treeN?: boolean; ts: TreeState; find: string; opened: string; search: ReaderSearch; reader?: Searchable; then?: (ed: CodeEditorHandle) => void }

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
    const x: View = { md: 'preview', tree: true, ts: { open: new Set(), cur: null, q: '' }, find: '', opened: '', search: null as unknown as ReaderSearch };
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
    v.opened = path; v.md = 'preview'; v.find = '';
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
  const source = ready;

  /** Once the editor is on screen, do `then` in it. */
  const inEditor = (then: (e: CodeEditorHandle) => void) => {
    if (ed.current) { then(ed.current); return; }
    v.then = then; update();
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
    inEditor(e => e.at(pos));
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
    go: h => { const pos = Math.min(starts[h.i] + h.o, text.length); inEditor(e => e.at(pos)); },
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
    if (c.held === 'g' && k === 'p' && isMd) { v.md = preview ? 'source' : 'preview'; update(); return true; }
    if (preview && c.held === 'g' && (k === 'x' || k === 'f')) { const l = linkHere(); if (l) void follow(l.href); else toast(`No link under the cursor · ${kb('tab')} moves to one`); return true; }
    if (preview && c.mode === 'NORMAL' && c.idle && (k === 'tab' || k === 'shift-tab')) { ringLink(k === 'tab' ? 1 : -1); return true; }
    if (preview && c.mode === 'NORMAL' && c.idle && (k === 'enter' || k === 'shift-enter')) { const l = linkHere(); if (l) { void follow(l.href, splitKey(k)); return true; } }
    if (!c.idle) return false;
    if (k === '/' || k === '?' || ((k === 'n' || k === 'N') && v.search.active)) return v.search.key(k, 1);
    if (k === 'n' || k === 'N') { v.search.next(1); return true; }
    if (k === ':') { openCmdline(); return true; }
    if (k === '-') { folder(); return true; }
    if (k === 'esc') return v.search.clear();
    return false;
  };

  // ---------- links in the preview (the editor's syntax tree, ui/editor/markdown.ts) ----------
  const st = () => ed.current?.view()?.state;
  const linkHere = () => { const s = st(); if (!s) return null; const h = s.selection.main.head; return mdLinks(s).find(l => h >= l.from && h < l.to) ?? null; };
  const showHeading = (id: string) => {
    const s = st(); if (!s) return false;
    const next = slugger(), h = mdHeadings(s).find(x => next(x.text) === id); if (!h) return false;
    const vw = ed.current!.view()!;
    ed.current!.at(h.pos);
    vw.dispatch({ effects: EditorView.scrollIntoView(h.pos, { y: 'start', yMargin: 12 }) });
    return true;
  };
  const follow = async (href: string, split = false) => {
    const to = linkTarget(href, path);
    if (to.kind === 'none') { toast(`Skein does not open ${href.replace(/:.*/, ':')} links`); return; }
    if (to.kind === 'external') { void api.app.openExternal(to.url); return; }
    if (to.kind === 'anchor') { if (!showHeading(to.slug)) toast(`No heading #${to.slug} in ${baseName(path)}`); return; }
    // a file or a folder: look it up first, so a broken link says so instead of opening an error tab
    const dir = to.path.includes('/') ? to.path.replace(/\/[^/]*$/, '') : '', name = to.path.slice(dir ? dir.length + 1 : 0);
    const es = await api.fs.list(ctx.machine, join(ctx.dir, dir)).catch(() => []);
    const e = es.find(x => x.name === name) || es.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!e) { toast(`No file at ${to.path}`); return; }
    const rel = dir ? dir + '/' + e.name : e.name;
    if (e.dir) { crumbMenu(rel); return; }
    openFile(ctx, rel, { from: t, split, line: to.line, anchor: to.slug });
  };
  /** tab / shift-tab: the cursor to the next or previous link's text (wrapping). */
  const ringLink = (d: 1 | -1) => {
    const s = st(); if (!s) return;
    const ls = mdLinks(s), h = s.selection.main.head;
    if (!ls.length) { toast('No links in this file'); return; }
    const l = d > 0 ? ls.find(x => x.from > h) ?? ls[0] : [...ls].reverse().find(x => x.to <= h) ?? ls[ls.length - 1];
    ed.current!.at(l.from + 1);
    ed.current!.view()!.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: 'nearest' }) });
  };
  const tipOf = (href: string) => {
    const to: LinkTarget = linkTarget(href, path);
    return to.kind === 'external' ? to.url : to.kind === 'anchor' ? '#' + to.slug : to.kind === 'file' ? to.path + (to.line ? `#L${to.line}` : to.slug ? '#' + to.slug : '') : href;
  };
  // an anchor asked for when the file opened (openFile's `anchor`): the cursor to that heading
  useLayoutEffect(() => {
    if (!nav.anchor || doc.disk == null || !ed.current) return;
    if (isMd && v.md !== 'preview') { v.md = 'preview'; update(); return; }
    const id = nav.anchor; nav.anchor = undefined;
    if (nav.goto?.line === 1 && !nav.goto.col) nav.goto = undefined;   // the heading, not the top
    if (isMd && !showHeading(id)) toast(`No heading #${id} in ${baseName(path)}`);
  });
  // a click with a modifier on a link follows it (a plain click puts the cursor there, to edit)
  const linkClick = (e: React.MouseEvent) => {
    if (!preview || !splitClick(e) || !(e.target as Element).closest('.md-link')) return;
    const vw = ed.current?.view(), pos = vw?.posAtCoords({ x: e.clientX, y: e.clientY });
    const l = vw && pos != null ? mdLinks(vw.state).find(x => pos >= x.from && pos <= x.to) : null;
    if (!l) return;
    e.preventDefault(); e.stopPropagation();
    void follow(l.href, e.shiftKey);
  };
  // where the link under the cursor goes, as a browser shows a hovered one
  const onCursor = () => { const l = preview ? linkHere() : null, x = l ? tipOf(l.href) : undefined; if (x !== v.tip) { v.tip = x; update(); } };
  const tip = preview && focused ? v.tip : undefined;

  // ---------- keys while the file loads (or shows an error): a reader with nothing to read ----------
  const reader = useSurface(t.id, focused, {
    mode: (): Mode => 'NORMAL',
    key: k => {
      if (nativeTarget() && (k === 'enter' || k === 'space')) return false;
      if (k === '-') { folder(); return true; }
      return k.length === 1;
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
        <div className={cx('tool-b', source && 'code')} data-read ref={body} onMouseDown={e => { if (!source) reader.own(); else linkClick(e); }}>
          {doc.err ? <div className="r-empty"><Icon name="alert" size="xl" /><span>{doc.err}</span></div>
            : doc.binary ? <div className="r-empty bin"><Icon name="file" size="xl" /><span>Binary file, not shown</span></div>
            : doc.disk == null ? <div className="r-empty"><Spinner label="Opening" /></div>
            : <CodeEditor key={key} ref={ed} tabId={t.id} id={key} value={text} onChange={onEdit} path={path} marks={drows ? null : marks} diff={drows}
                numbers={numbersOn()} wrap={wrapOn()} live={preview && !drows} find={v.find || undefined} className="src" dataSrc={`file:${path}`} onKey={editorKey} onMouseSel={x => tsel.show(x)} onCursor={onCursor} />}
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
