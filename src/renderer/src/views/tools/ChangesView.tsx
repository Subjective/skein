// Changes: what a scope changed, file by file, with the changed files as a tree on the right.
// Scopes: last agent turn, uncommitted, staged, unstaged, and any unbroken run of commits.
// Keys (a reader over rows): j k move, { } between files, enter / o open or fold, h l fold and unfold,
// s stage, S stage all, x revert (u undoes it), / searches the tree, V selects lines and y copies them,
// gs scope, gb branch, c commit, C the commit menu, t the tree. The mouse reaches the same things.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Commit, DiffLine, DiffScope, FileDiff, RepoState, RevertUndo, ScopeCounts, ScopeSpec } from '@shared/api';
import { api } from '../../api';
import type { Mode } from '../../input/dispatcher';
import { kb } from '../../input/platform';
import { Count, findAll, searchRe } from '../../input/readerkeys';
import { yank as yankReg } from '../../input/register';
import type { Tab } from '../../state/layout';
import { openLayer, S, thread, toast, update, useApp } from '../../state/store';
import { openMenu } from '../../shell/overlays';
import { Menu, type MenuItem } from '../../ui/Menu';
import { ReaderSearch, type Searchable } from '../../ui/search';
import { animate, MOTION } from '../../ui/motion';
import { Checkbox, Chip, cx, Icon, IconButton, SplitButton, Spinner } from '../../ui/primitives';
import { VimField, type VimFieldHandle } from '../../ui/VimField';
import { CodeLine, LangBadge, Nums, selectPainted, type Paint } from './code';
import { colAt, nodeAt, selEnds, useToolSel } from './mousesel';
import { registerHooks } from './hooks';
import { openCommit, type CommitAction } from './CommitDialog';
import { baseName, langOf, tokenize, type HlState } from './highlight';
import { openFile, splitKey } from './open';
import { ctxOf, refreshNow, turnFor, useRepo, viewState } from './repo';
import { halfPage, nativeTarget, useSideTree, useSurface } from './surface';
import { dragEdge, ResizeHandle, resetEdge, TREE_EDGE } from '../../ui/resize';

const resizeTree = dragEdge(TREE_EDGE);

const SCOPES: { k: Exclude<DiffScope, 'commits'>; label: string; icon: string }[] = [
  { k: 'turn', label: 'Last agent turn', icon: 'retry' },
  { k: 'uncommitted', label: 'Uncommitted', icon: 'diff' },
  { k: 'staged', label: 'Staged', icon: 'check' },
  { k: 'unstaged', label: 'Unstaged', icon: 'pencil' },
  { k: 'all', label: 'All changes', icon: 'layers' },
];
const BIG = 1200;   // a file with a longer diff starts folded

interface View {
  scope: DiffScope;
  /** commits: [newest, oldest] indexes into `commits` (0 is the newest) */
  range: [number, number] | null;
  before: DiffScope;
  commits: Commit[];
  files: FileDiff[] | null;
  counts: Partial<Record<DiffScope, ScopeCounts>>;
  loadedKey: string;
  loading: boolean;
  err: string;
  /** folded files (by path); big files fold unless opened */
  closed: Set<string>;
  opened: Set<string>;
  /** unfolded runs of unchanged lines: key -> their text (null while loading) */
  gaps: Map<string, string[] | null>;
  texts: Map<string, Promise<string[]>>;
  tree: boolean;
  treeN?: boolean;
  tq: string;
  cur: number;
  anchor: number | null;
  /** n, V-LINE (V), or a mouse selection in the page (v: VISUAL with the Add to Chat bar, VIM-MODEL rule 10) */
  vmode: 'n' | 'V' | 'v';
  g: boolean;
  lastUndo: { undo: RevertUndo; name: string } | null;
  flash?: string;
  /** a count typed before a motion (5j, 3}) */
  count: Count;
  /** / ? n N over the diff's rows (ui/search.tsx); `find` is what is painted, `col` where in the row the cursor is */
  search: ReaderSearch;
  reader?: Searchable;
  find: string;
  col: number;
}

type Row =
  | { k: 'file'; f: FileDiff }
  | { k: 'line'; f: FileDiff; l: DiffLine; toks: [string, string][] }
  | { k: 'gap'; f: FileDiff; key: string; n: number; a: number; b: number }
  | { k: 'note'; f: FileDiff; text: string };

const scopeIcon = (s: DiffScope) => (s === 'commits' ? 'branch' : SCOPES.find(x => x.k === s)!.icon);
/** Scopes whose files can be staged and reverted: the working tree's own (all changes holds commits too). */
const working = (s: DiffScope) => s !== 'commits' && s !== 'all';
const isTrunk = (r?: RepoState | null) => !!r?.branch && (r.branch === r.trunk || (!r.trunk && /^(main|master|trunk|develop)$/.test(r.branch)));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function ChangesView({ t, focused }: { t: Tab; focused: boolean }) {
  useApp();
  const ctx = ctxOf(t);
  const re = useRepo(ctx.machine, ctx.dir);
  const repo = re.repo;
  const v = viewState<View>(t.id, () => {
    const x: View = {
      scope: 'uncommitted', range: null, before: 'uncommitted', commits: [], files: null, counts: {}, loadedKey: '', loading: false, err: '',
      closed: new Set(), opened: new Set(), gaps: new Map(), texts: new Map(), tree: true, tq: '', cur: 0, anchor: null, vmode: 'n', g: false, lastUndo: null,
      count: new Count(), search: null as unknown as ReaderSearch, find: '', col: -1,
    };
    x.search = new ReaderSearch(() => x.reader!);
    return x;
  });
  const body = useRef<HTMLDivElement>(null);
  const tq = useRef<VimFieldHandle>(null);
  const turn = repo ? turnFor(t, ctx.machine, repo.root) : undefined;
  const side = useSideTree(v);

  const spec = (s: DiffScope = v.scope): ScopeSpec | null => {
    if (s === 'turn') return turn ? { scope: 'turn', base: turn.base, head: turn.head } : null;
    if (s === 'commits') { const r = v.range, c = v.commits; return r && c[r[1]] && c[r[0]] ? { scope: 'commits', base: c[r[1]].hash, head: c[r[0]].hash } : null; }
    if (s === 'all') { const b = repo?.trunk ? `origin/${repo.trunk}` : repo?.upstream; return { scope: 'all', base: b }; }
    return { scope: s };
  };
  const cur = spec();
  const loadKey = `${re.gen}|${repo?.root}|${JSON.stringify(cur)}`;

  // load the scope's diff and every scope's counts whenever the repository or the scope changes
  useEffect(() => {
    if (!repo || v.loadedKey === loadKey) return;
    let gone = false;
    v.loading = true; update();
    const specs = SCOPES.map(x => spec(x.k));
    void (async () => {
      try {
        const [files, counts, commits] = await Promise.all([
          cur ? api.git.changes(ctx.machine, repo.root, cur) : Promise.resolve([] as FileDiff[]),
          api.git.counts(ctx.machine, repo.root, specs.map(s => s || { scope: 'uncommitted' })),
          api.git.commits(ctx.machine, repo.root, 60),
        ]);
        if (gone) return;
        // the commit list moved (a new commit): keep the same commits picked
        if (v.range && v.commits.length && commits[0]?.hash !== v.commits[0]?.hash) {
          const a = commits.findIndex(c => c.hash === v.commits[v.range![0]]?.hash), b = commits.findIndex(c => c.hash === v.commits[v.range![1]]?.hash);
          v.range = a >= 0 && b >= 0 ? [a, b] : null; if (!v.range) v.scope = v.before;
        }
        v.commits = commits;
        v.files = files; v.err = ''; v.loadedKey = loadKey;
        v.counts = Object.fromEntries(SCOPES.map((x, i) => [x.k, specs[i] ? counts[i] : undefined]));
        if (cur?.scope === 'commits') v.counts.commits = { files: files.length, add: files.reduce((a, f) => a + f.add, 0), del: files.reduce((a, f) => a + f.del, 0) };
        v.gaps = new Map([...v.gaps].filter(([, x]) => x)); v.texts = new Map();
      } catch (e) { if (!gone) { v.err = errText(e); v.loadedKey = loadKey; } }
      finally { if (!gone) { v.loading = false; update(); } }
    })();
    return () => { gone = true; };
  }, [loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = v.files || [];
  const staged = (f: FileDiff) => f.staged === 'yes' ? true : f.staged === 'part' ? 'mix' as const : false;
  const isOpen = (f: FileDiff) => !v.closed.has(f.path) && (v.opened.has(f.path) || f.hunks.reduce((a, h) => a + h.lines.length, 0) < BIG);
  const newRev = () => (v.scope === 'staged' ? 'index' : v.scope === 'commits' ? cur?.head || 'HEAD' : v.scope === 'turn' ? turn?.head || 'worktree' : 'worktree');

  // ---------- rows ----------
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const f of files) {
      out.push({ k: 'file', f });
      if (!isOpen(f)) continue;
      if (f.binary) { out.push({ k: 'note', f, text: 'Binary file' }); continue; }
      if (!f.hunks.length) { out.push({ k: 'note', f, text: f.status === 'R' ? `Renamed from ${f.old}` : 'No text changes' }); continue; }
      const lang = langOf(f.path);
      let st: HlState = '';
      let prevA = 1, prevB = 1;
      f.hunks.forEach((h, hi) => {
        const n = h.b - prevB;
        if (n > 0 && f.status !== 'A' && f.status !== 'D') {
          const key = `${f.path}:${hi}`, got = v.gaps.get(key);
          if (got) got.forEach((text, i) => out.push({ k: 'line', f, l: { k: ' ', a: prevA + i, b: prevB + i, text }, toks: tokenize(text, lang).toks }));
          else out.push({ k: 'gap', f, key, n, a: prevA, b: prevB });
        }
        for (const l of h.lines) { const r = tokenize(l.text, lang, st); if (l.k !== '-') st = r.state; out.push({ k: 'line', f, l, toks: r.toks }); }
        prevA = h.a + h.an; prevB = h.b + h.bn;
      });
    }
    return out;
  }, [v.files, v.closed.size, v.opened.size, v.gaps.size, [...v.gaps.values()].filter(Boolean).length]); // eslint-disable-line react-hooks/exhaustive-deps
  v.cur = Math.max(0, Math.min(v.cur, rows.length - 1));
  const rowFile = (i = v.cur) => rows[i]?.f;
  const fileRow = (p: string) => rows.findIndex(r => r.k === 'file' && r.f.path === p);

  // ---------- actions ----------
  const refresh = () => void refreshNow(ctx.machine, ctx.dir);
  const run = async (what: () => Promise<unknown>) => { try { await what(); } catch (e) { toast(errText(e), { icon: 'alert' }); } refresh(); };
  const stage = (ps: string[], on: boolean) => repo && run(() => api.git.stage(ctx.machine, repo.root, ps, on));
  const stageAll = () => { const all = files.every(f => f.staged === 'yes'); void stage(files.map(f => f.path), !all); };
  const revert = (f: FileDiff) => repo && run(async () => {
    const undo = await api.git.revert(ctx.machine, repo.root, [f.path]);
    const name = baseName(f.path);
    v.lastUndo = { undo, name };
    toast(`Reverted ${name}`, { icon: 'retry', action: { label: 'Undo', run: () => void unrevert(undo) } }, 6000);
  });
  const unrevert = (undo: RevertUndo) => repo && run(async () => {
    await api.git.unrevert(ctx.machine, repo.root, undo);
    if (v.lastUndo?.undo.id === undo.id) v.lastUndo = null;
  });
  const toggle = (f: FileDiff, open?: boolean) => {
    const now = isOpen(f), want = open ?? !now;
    if (want === now) return;
    if (want) { v.closed.delete(f.path); v.opened.add(f.path); } else { v.closed.add(f.path); v.opened.delete(f.path); }
    const i = fileRow(f.path); if (i >= 0 && !want) v.cur = i;
    update();
  };
  const openGap = (r: Extract<Row, { k: 'gap' }>) => {
    if (!repo) return;
    const rev = newRev(), tk = `${r.f.path}@${rev}`;
    let p = v.texts.get(tk);
    if (!p) { p = api.git.show(ctx.machine, repo.root, r.f.path, rev).then(x => x.split(/\r?\n/)); v.texts.set(tk, p); }
    v.gaps.set(r.key, null); update();
    p.then(ls => { v.gaps.set(r.key, ls.slice(r.b - 1, r.b - 1 + r.n)); update(); }, e => { v.gaps.delete(r.key); toast(errText(e)); update(); });
  };
  const jump = (p: string) => {
    const f = files.find(x => x.path === p); if (!f) return;
    toggle(f, true);
    requestAnimationFrame(() => {
      const i = fileRow(p); if (i >= 0) v.cur = i;
      v.flash = p; update();
      const el = body.current?.querySelector(`[data-p="${CSS.escape(p)}"]`);
      el?.scrollIntoView({ block: 'start', behavior: S.settings.vim ? 'auto' : 'smooth' });
      setTimeout(() => { if (v.flash === p) { v.flash = undefined; update(); } }, 700);
    });
  };
  const openAt = (r: Row, split = false) => {
    if (r.k !== 'line' || !repo) return;
    const line = r.l.b ?? r.l.a ?? 1;
    if (r.f.status === 'D' || r.l.k === '-' && r.l.b == null && v.scope !== 'commits') { /* the line is gone; open the file where it was */ }
    openFile({ machine: ctx.machine, dir: repo.root }, r.f.path, { line, from: t, newTab: true, split });
  };

  // ---------- header menus ----------
  const anchorOf = (sel: string) => body.current?.closest('.changes')?.querySelector(sel)?.getBoundingClientRect() || null;
  const pickScope = (anchor = anchorOf('[data-k=scope]')) => {
    const items: MenuItem<DiffScope>[] = [
      ...SCOPES.map(x => {
        const c = v.counts[x.k], none = x.k === 'turn' && !turn;
        return { label: x.label, icon: <Icon name={x.icon} />, on: v.scope === x.k, dis: none, hint: none ? 'None yet' : '', right: c ? <Nums add={c.add} del={c.del} small /> : undefined, data: x.k };
      }),
      { label: 'Commits', icon: <Icon name="branch" />, on: v.scope === 'commits', right: <Icon name="chev" />, data: 'commits' as DiffScope, dis: !v.commits.length, hint: v.commits.length ? '' : 'None yet' },
    ];
    // Commits is a flyout beside the scope menu (both stay open while you tick commits): picking or hovering it
    let fly: (() => void) | null = null, menuEl: HTMLElement | null = null;
    const openFly = () => {
      if (fly || !v.commits.length) return;
      const row = [...(menuEl?.querySelectorAll<HTMLElement>('.mi') || [])].find(x => x.textContent?.trim().startsWith('Commits'));
      if (!row) return;
      const r = row.getBoundingClientRect(), w = 340, left = r.right + 8 + w > innerWidth ? r.left - w - 8 : r.right + 8;
      row.setAttribute('aria-expanded', 'true');
      fly = openLayer(c => <CommitsMenu v={v} anchor={new DOMRect(left, r.top - 12, 0, 0)} close={c} onBack={c} />, () => { fly = null; row.setAttribute('aria-expanded', 'false'); });
    };
    const closeScope = openMenu<DiffScope>({ anchor, place: 'bottom-start', width: 270, items, keep: it => it.data === 'commits',
      onPick: it => { if (it.data === 'commits') openFly(); else { fly?.(); closeScope(); setScope(it.data!); } },
      onClose: () => fly?.() });
    requestAnimationFrame(() => {
      menuEl = [...document.querySelectorAll<HTMLElement>('.menu')].pop() || null;
      menuEl?.addEventListener('mouseover', ev => { const m = (ev.target as HTMLElement).closest('.mi'); if (m?.textContent?.trim().startsWith('Commits')) openFly(); });
    });
  };
  const setScope = (s: DiffScope) => { if (v.scope === s) return; v.scope = s; if (s !== 'commits') v.range = null; v.cur = 0; v.anchor = null; update(); };
  const pickBranch = async (anchor = anchorOf('[data-k=branch]')) => {
    if (!repo) return;
    let list: Awaited<ReturnType<typeof api.git.branches>> = [];
    try { list = await api.git.branches(ctx.machine, repo.root); } catch (e) { toast(errText(e)); return; }
    openMenu<{ name: string; create?: boolean }>({
      anchor, place: 'bottom-start', width: 280, search: { placeholder: 'Switch branch or name a new one' }, empty: 'No branches',
      items: q => [
        ...list.map(b => ({ label: b.name, icon: <Icon name="branch" />, on: b.current, right: <span className="age">{b.when.replace(/ ago$/, '')}</span>, data: { name: b.name } })),
        ...(q.trim() && !list.some(b => b.name === q.trim()) ? [{ label: `Create branch “${q.trim()}”`, display: <>Create branch <b>{q.trim()}</b></>, icon: <Icon name="plus" />, data: { name: q.trim(), create: true } }] : []),
      ],
      onPick: it => { if (it.data && !(list.find(b => b.current)?.name === it.data.name)) void run(async () => { await api.git.switch(ctx.machine, repo.root, it.data!.name, it.data!.create); toast(`On ${it.data!.name}`, { icon: 'branch' }); }); },
    });
  };
  const trunk = isTrunk(repo);
  const total = v.counts.uncommitted;
  const anyStaged = (v.counts.staged?.files || 0) > 0;
  const commitWhat = anyStaged ? `${v.counts.staged!.files} staged file${v.counts.staged!.files === 1 ? '' : 's'}` : `All ${total?.files || 0} changed file${total?.files === 1 ? '' : 's'}`;
  const th = thread(t.thread);
  const slug = (th?.title || 'changes').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'changes';
  const commitLabel = trunk ? 'Create branch & commit' : 'Commit';
  const commit = (action: CommitAction) => {
    if (!repo) return;
    if (action !== 'branch' && !total?.files) { toast('Nothing to commit'); return; }
    const titles: Record<CommitAction, string> = trunk
      ? { commit: 'Create branch & commit', push: 'Create branch, commit & push', pr: 'Create branch, commit & open PR', branch: 'Create branch' }
      : { commit: 'Commit', push: 'Commit & push', pr: 'Commit & open PR', branch: 'Create branch' };
    openCommit({ machine: ctx.machine, root: repo.root, newBranch: trunk || action === 'branch', action, what: commitWhat, message: th?.title || '', branch: slug, title: titles[action], done: refresh });
  };
  const commitMenu = (anchor = anchorOf('.splitbtn')) => {
    const items: MenuItem<CommitAction>[] = (trunk
      ? [['Create branch, commit & push', 'push', 'upload'], ['Create branch, commit & open PR', 'pr', 'globe'], ['Create branch', 'branch', 'branch']]
      : [['Commit & push', 'push', 'upload'], ['Commit & open PR', 'pr', 'globe'], ['Create branch', 'branch', 'branch']]
    ).map(([label, data, icon]) => ({ label, data: data as CommitAction, icon: <Icon name={icon} />, dis: data !== 'branch' && !total?.files }));
    openMenu<CommitAction>({ anchor, place: 'bottom-end', width: 250, items, onPick: it => commit(it.data!) });
  };

  // ---------- keys ----------
  // mod-l in V-LINE: the picked diff lines become a page selection, which the quote command takes (linked to the file)
  useEffect(() => registerHooks(t.id, { addr: () => { if (v.vmode === 'V') selectPainted(body.current, '.diff.flat .dl.vsel .c'); return false; } }));
  const searchTree = () => { if (!side.show) side.set(true); requestAnimationFrame(() => tq.current?.focus(true)); };
  const yank = () => {
    const [a, b] = [Math.min(v.anchor ?? v.cur, v.cur), Math.max(v.anchor ?? v.cur, v.cur)];
    const text = rows.slice(a, b + 1).map(r => (r.k === 'line' ? (r.l.k === ' ' ? ' ' : r.l.k) + r.l.text : r.k === 'file' ? r.f.path : '')).filter(Boolean).join('\n');
    yankReg(text, true);
    toast(`Copied ${b - a + 1} line${b === a ? '' : 's'}`);
    v.anchor = null; v.vmode = 'n'; update();
  };
  const press = (r: Row | undefined) => {
    if (!r) return;
    if (r.k === 'file') toggle(r.f);
    else if (r.k === 'gap') openGap(r);
    else if (r.k === 'line') openAt(r);
  };
  const go = (i: number) => { v.cur = Math.max(0, Math.min(rows.length - 1, i)); v.col = -1; update(); };
  // the search reads each row as its text: a file header is its path, a line its code
  const rowText = (r: Row) => (r.k === 'line' ? r.l.text : r.k === 'file' ? (r.f.old ? `${r.f.old} → ${r.f.path}` : r.f.path) : r.k === 'gap' ? `${r.n} unmodified lines` : r.text);
  v.reader = {
    items: () => rows.map(rowText),
    at: () => ({ i: v.cur, o: v.col }),
    go: h => { v.cur = h.i; v.col = h.o; update(); },
    paint: q => { v.find = q; update(); },
    anchor: () => body.current?.getBoundingClientRect() ?? null,
    num: h => { const r = rows[h.i]; return r?.k === 'line' ? (r.l.k === '-' ? r.l.a : r.l.b) ?? null : null; },
  };
  const nextFile = (d: number) => { let i = v.cur + d; while (rows[i] && rows[i].k !== 'file') i += d; if (rows[i]) go(i); else if (d < 0) go(0); };
  const { own } = useSurface(t.id, focused, {
    mode: (): Mode => (v.vmode === 'V' ? 'V-LINE' : v.vmode === 'v' ? 'VISUAL' : 'NORMAL'),
    key: k => {
      // a mouse selection: y copies it, esc lets it go; any other key lets it go and does what it does
      if (v.vmode === 'v') {
        const txt = getSelection()?.toString() || '';
        dropSel();
        if (k === 'esc') return true;
        if (k === 'y') { yankReg(txt); toast('Copied'); return true; }
      }
      if (nativeTarget() && (k === 'enter' || k === 'space')) return false;
      if (v.g) {
        v.g = false;
        if (k === 'g') { const ex = v.count.explicit, n = v.count.take(); go(ex ? n - 1 : 0); return true; }
        v.count.clear();
        if (k === 's') { pickScope(); return true; }
        if (k === 'b') { void pickBranch(); return true; }
        if (k === 'f') { const r = rows[v.cur]; if (r) openFile({ machine: ctx.machine, dir: repo?.root || ctx.dir }, r.f.path, { line: r.k === 'line' ? r.l.b ?? r.l.a : 1, from: t, newTab: true }); return true; }
        return true;
      }
      const r = rows[v.cur];
      if (v.count.feed(k)) return true;
      if (k === 'g') { v.g = true; return true; }   // keeps the count for 5gg
      const explicit = v.count.explicit, n = v.count.take();
      if (v.search.key(k, n)) return true;
      if (splitKey(k)) { if (r?.k === 'line') openAt(r, true); return true; }   // shift-enter or O: the file in a new split
      switch (k) {
        case 'j': case 'down': go(v.cur + n); return true;
        case 'k': case 'up': go(v.cur - n); return true;
        case 'G': go(explicit ? n - 1 : rows.length - 1); return true;
        case 'end': go(rows.length - 1); return true;
        case 'home': go(0); return true;
        case 'ctrl-d': case 'pagedown': go(v.cur + halfPage(body.current) * n); return true;
        case 'ctrl-u': case 'pageup': go(v.cur - halfPage(body.current) * n); return true;
        case '}': case ']': for (let i = 0; i < n; i++) nextFile(1); return true;
        case '{': case '[': for (let i = 0; i < n; i++) nextFile(-1); return true;
        case 'enter': case 'o': press(r); return true;
        case 'l': case 'right': if (r?.k === 'file') toggle(r.f, true); else if (r?.k === 'gap') openGap(r); return true;
        case 'h': case 'left': if (r) toggle(r.f, false); return true;
        case 's': case 'space': if (r && working(v.scope)) void stage([r.f.path], r.f.staged !== 'yes'); return true;
        case 'S': if (working(v.scope)) stageAll(); return true;
        case 'x': if (r && working(v.scope)) void revert(r.f); return true;
        case 'u': if (v.lastUndo) void unrevert(v.lastUndo.undo); else toast('Nothing to undo'); return true;
        case 'f': searchTree(); return true;
        case 't': side.toggle(); return true;
        case 'c': commit('commit'); return true;
        case 'C': commitMenu(); return true;
        case 'V': if (v.vmode === 'V') { v.vmode = 'n'; v.anchor = null; } else { v.vmode = 'V'; v.anchor = v.cur; } update(); return true;
        case 'y': if (v.vmode === 'V') yank(); return true;
        case 'esc': if (v.vmode === 'V') { v.vmode = 'n'; v.anchor = null; update(); return true; } return v.search.clear();
      }
      return false;   // the app's NORMAL layer gets the rest (: H L | \ ?); the dispatcher drops what nobody takes
    },
  });

  // the mouse in a diff (VIM-MODEL rule 10): a click puts the character cursor there, a double click or a drag
  // selects (VISUAL), a triple click the line (V-LINE), each with Add to Chat. Enter (or g f) opens the file.
  const mouse = useRef(false);
  // the selection as rows and columns: a render repaints the line's spans, and the page selection is put back from these
  const msel = useRef<{ a: [number, number]; b: [number, number]; back: boolean } | null>(null);
  const downCol = useRef(0);
  const dropSel = () => { mouse.current = false; if (v.vmode !== 'n') { v.vmode = 'n'; v.anchor = null; getSelection()?.removeAllRanges(); update(); } };
  const tsel = useToolSel(t, dropSel);
  const lineDown = (e: React.MouseEvent, i: number) => {
    if (e.detail > 1) return;
    const cr = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
    const at = (e.target as Element).closest('.n') ? { col: 0 } : cr && colAt(cr.startContainer, cr.startOffset);
    const r = rows[i], len = r?.k === 'line' ? r.l.text.length : 0;
    v.cur = i; v.col = downCol.current = at ? Math.min(at.col, Math.max(0, len - 1)) : 0; update();
  };
  const mouseUp = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const d = e.detail, row = (e.target as Element).closest<HTMLElement>('.dl[data-i]');
    setTimeout(() => {
      if (d >= 3 && row) { mouse.current = true; msel.current = null; v.vmode = 'V'; v.anchor = v.cur = +row.dataset.i!; v.col = downCol.current; update(); return; }
      const g = getSelection(), root = body.current;
      if (!g || g.isCollapsed || !root || !root.contains(g.anchorNode)) return;
      if (!g.toString().trim()) { g.removeAllRanges(); return; }   // a double click on blank space selects nothing
      const x = selEnds(root), ri = (q: { row: HTMLElement }) => +(q.row.dataset.i ?? -1);
      msel.current = x && ri(x.a) >= 0 && ri(x.b) >= 0 ? { a: [ri(x.a), x.a.col], b: [ri(x.b), x.b.col], back: x.back } : null;
      const f = g.focusNode && colAt(g.focusNode, g.focusOffset), fi = f && +(f.row.dataset.i || -1);
      if (f && fi != null && fi >= 0) { v.cur = fi; const back = g.anchorNode && (g.focusNode!.compareDocumentPosition(g.anchorNode) & Node.DOCUMENT_POSITION_FOLLOWING); v.col = Math.max(0, back ? f.col : f.col - 1); }
      mouse.current = true; v.vmode = 'v'; v.anchor = null; update();
    }, 0);
  };
  useLayoutEffect(() => {
    if (!mouse.current) return;
    if (v.vmode === 'n') { mouse.current = false; tsel.show(null); return; }
    if (v.vmode === 'V') selectPainted(body.current, '.diff.flat .dl.vsel .c');
    const m = msel.current, root = body.current;
    if (v.vmode === 'v' && m && root) {
      const ca = root.querySelector(`.dl[data-i="${m.a[0]}"] .c`), cb = root.querySelector(`.dl[data-i="${m.b[0]}"] .c`);
      if (ca && cb) { const [an, ao] = nodeAt(ca, m.a[1]), [bn, bo] = nodeAt(cb, m.b[1]); if (m.back) getSelection()?.setBaseAndExtent(bn, bo, an, ao); else getSelection()?.setBaseAndExtent(an, ao, bn, bo); }
    }
    tsel.show(getSelection()?.toString() ?? null);
  });

  // keep the cursor row in sight
  useLayoutEffect(() => {
    const el = body.current?.querySelector('.rowcur, .curl');
    if (el && focused) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [v.cur, focused, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- render ----------
  const counts = v.counts[v.scope] || (v.files ? { files: files.length, add: files.reduce((a, f) => a + f.add, 0), del: files.reduce((a, f) => a + f.del, 0) } : undefined);
  const scopeLabel = v.scope === 'commits' ? rangeLabel(v) : SCOPES.find(x => x.k === v.scope)!.label;
  const sel = v.vmode === 'V' && v.anchor != null ? [Math.min(v.anchor, v.cur), Math.max(v.anchor, v.cur)] : null;
  const findRe = searchRe(v.find);
  /** The search's matches in a diff line; the one under the cursor is `now`. */
  const hitsIn = (text: string, i: number): Paint[] | undefined => {
    const out: Paint[] = findRe ? findAll([text], v.find).map(h => ({ from: h.o, to: h.o + Math.max(1, h.len), cls: i === v.cur && h.o === v.col ? 'hit now' : 'hit' })) : [];
    // the character cursor, where a click (or a search) put it
    if (i === v.cur && focused && v.col >= 0 && v.vmode !== 'v') out.push({ from: v.col, to: v.col + 1, cls: 'vc' });
    return out.length ? out : undefined;
  };
  const q = v.tq.trim().toLowerCase();
  const shown = files.filter(f => !q || f.path.toLowerCase().includes(q));
  const dirs = [...new Set(shown.map(f => (f.path.includes('/') ? f.path.replace(/\/[^/]*$/, '') : '')))].sort((a, b) => Number(a === '') - Number(b === '') || a.localeCompare(b));
  const allOn = files.length > 0 && files.every(f => f.staged === 'yes'), someOn = files.some(f => f.staged && f.staged !== 'no');

  if (repo === undefined) return <div className="changes"><div className="r-empty"><Spinner label="Reading the repository" /></div></div>;
  if (repo === null) return (
    <div className="changes"><div className="r-empty"><Icon name="diff" size="xl" /><span>{re.error || 'Not a git repository'}</span><span className="dim path">{ctx.dir}</span></div></div>
  );

  let fileI = -1;
  return (
    <div className="changes" ref={side.ref} onMouseDown={e => { if (!(e.target as HTMLElement).closest('.tq')) own(); }}>
      <header className="tool-h">
        <Chip data-k="scope" icon={scopeIcon(v.scope)} label={<>{scopeLabel}{counts && <Nums add={counts.add} del={counts.del} />}</>} caret
          title={`What to compare · ${kb('g s')}`} onClick={e => pickScope(e.currentTarget.getBoundingClientRect())} />
        <Chip data-k="branch" icon="branch" label={repo.branch || (repo.head ? repo.head.slice(0, 7) : 'No commits')} caret title={`Branch · ${kb('g b')}`}
          onClick={e => void pickBranch(e.currentTarget.getBoundingClientRect())} />
        {v.loading && v.files && <Spinner label="Refreshing" />}
        <span className="sp" />
        <SplitButton label={commitLabel} keys="c" disabled={!total?.files} menuDisabled={false} reason="Nothing to commit: no file has changes. Create branch is still in the menu." onClick={() => commit('commit')} onMenu={r => commitMenu(r)} menuLabel="More commit actions" />
        <IconButton icon="panelR" small on={side.show} label="Changed files" keys="t" aria-pressed={side.show} onClick={side.toggle} />
      </header>
      <div className={cx('cbody', side.show && 'tree')}>
        <div className="tool-b" data-read ref={body} onMouseUp={mouseUp} role="region" aria-label="Diff">
          {v.err ? <div className="r-empty"><Icon name="alert" size="xl" /><span>{v.err}</span></div>
            : !v.files ? <div className="r-empty"><Spinner label="Loading changes" /></div>
            : !files.length ? <div className="r-empty"><Icon name="diff" size="xl" /><span>{v.scope === 'staged' ? 'Nothing staged yet' : v.scope === 'turn' && !turn ? 'No agent turn yet' : 'No changes'}</span></div>
            : files.map(f => {
              const start = fileRow(f.path), open = isOpen(f), rs: { r: Row; i: number }[] = [];
              for (let i = start + 1; i < rows.length && rows[i].k !== 'file'; i++) rs.push({ r: rows[i], i });
              fileI++;
              return (
                <details key={f.path} className={cx('cfile', v.flash === f.path && 'flash')} open={open} data-p={f.path}>
                  <summary className={cx(v.cur === start && focused && 'rowcur', sel && start >= sel[0] && start <= sel[1] && 'vsel')}
                    onClick={e => { e.preventDefault(); v.cur = start; toggle(f); }}>
                    <Icon name="chev" className="ch" /><LangBadge path={f.path} />
                    <span className="f">{f.old ? <>{f.old} <span className="dim">→</span> {f.path}</> : f.path}</span>
                    <Nums add={f.add} del={f.del} />
                    {f.status === 'A' && <span className="tag">New</span>}{f.status === 'D' && <span className="tag del">Deleted</span>}
                    {!open && f.hunks.reduce((a, h) => a + h.lines.length, 0) >= BIG && <span className="tag dim">Large diff</span>}
                    <span className="sp" />
                    {working(v.scope) && <IconButton icon="retry" small label="Revert file" keys="x" onMouseDown={e => e.preventDefault()} onClick={e => { e.stopPropagation(); void revert(f); }} />}
                    {working(v.scope) && <Checkbox on={staged(f)} label={`Stage ${f.path}`} onChange={on => void stage([f.path], on)} />}
                  </summary>
                  {open && <div className="diff flat" data-src={`diff:${f.path}`}>
                    {rs.map(({ r, i }) => r.k === 'gap'
                      ? <button key={i} type="button" className={cx('dgap', v.cur === i && focused && 'rowcur')} title={`Show ${r.n} unmodified lines`}
                          onMouseDown={e => e.preventDefault()} onClick={() => { v.cur = i; openGap(r); }}>
                          {v.gaps.has(r.key) ? <Spinner label="Loading" /> : <Icon name="down" size="sm" />}<span>{r.n} unmodified line{r.n === 1 ? '' : 's'}</span>
                        </button>
                      : r.k === 'note' ? <div key={i} className={cx('dl note', v.cur === i && focused && 'curl')}><span className="n" /><span className="c dim">{r.text}</span></div>
                      : r.k === 'line' ? <div key={i} data-i={i} className={cx('dl', r.l.k === '+' ? 'add' : r.l.k === '-' ? 'del' : '', v.cur === i && focused && 'curl', sel && i >= sel[0] && i <= sel[1] && 'vsel')}
                          onMouseDown={e => lineDown(e, i)}>
                          <span className="n">{r.l.k === '-' ? r.l.a : r.l.b}</span><span className="c"><CodeLine toks={r.toks} unit={0} paint={hitsIn(r.l.text, i)} /></span>
                        </div>
                      : null)}
                  </div>}
                </details>
              );
            })}
        </div>
        {side.show && (<>
          <ResizeHandle axis="x" label="Resize file tree" onPointerDown={resizeTree} onDoubleClick={() => resetEdge(TREE_EDGE)} />
          <aside className="ctree" aria-label="Changed files">
            <label className="tq"><Icon name="search" size="sm" />
              <VimField ref={tq} tabId={t.id} value={v.tq} onChange={x => { v.tq = x.replace(/\n/g, ''); update(); }} placeholder="Search files" className="tq-f"
                onEnter={() => { const first = shown[0]; own(); (document.activeElement as HTMLElement | null)?.blur(); if (first) jump(first.path); }}
                onLeave={() => { own(); (document.activeElement as HTMLElement | null)?.blur(); }} />
            </label>
            {working(v.scope) && files.length > 0 && (
              <div className="tf all"><Checkbox on={allOn ? true : someOn ? 'mix' : false} label="Stage all" onChange={() => stageAll()} /><span className="t">{files.length} file{files.length === 1 ? '' : 's'} changed</span></div>
            )}
            {!working(v.scope) && files.length > 0 && <div className="tf all"><span className="t">{files.length} file{files.length === 1 ? '' : 's'} changed</span></div>}
            {dirs.map(d => (
              <div key={d || '.'} role="group" aria-label={d || 'root'}>
                {d && <div className="td"><Icon name="down" size="sm" /><span>{d}</span></div>}
                {shown.filter(f => (f.path.includes('/') ? f.path.replace(/\/[^/]*$/, '') : '') === d).map(f => (
                  <div key={f.path} className={cx('tf', d && 'in', rowFile()?.path === f.path && 'on')}>
                    {working(v.scope) && <Checkbox on={staged(f)} label={`Stage ${f.path}`} onChange={on => void stage([f.path], on)} />}
                    <button type="button" className="tfn" title={f.path} onMouseDown={e => e.preventDefault()} onClick={() => { own(); jump(f.path); }}><LangBadge path={f.path} /><span className="t">{baseName(f.path)}</span></button>
                    <Nums add={f.add} del={f.del} small />
                    <span className={cx('fst', f.status.toLowerCase())} title={({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' } as Record<string, string>)[f.status]} />
                  </div>
                ))}
              </div>
            ))}
            {q && !shown.length && <div className="tf none">No matching files</div>}
          </aside>
        </>)}
      </div>
      {tsel.bar}
    </div>
  );
  void fileI;
}

/** "a1b2c3d" for one commit, "oldest^..newest" for a run, "All commits" for all. */
function rangeLabel(v: View) {
  const r = v.range, c = v.commits;
  if (!r || !c[r[0]]) return 'Commits';
  if (r[0] === 0 && r[1] === c.length - 1 && c.length > 1) return 'All commits';
  return r[0] === r[1] ? c[r[0]].short : `${c[r[1]].short}^..${c[r[0]].short}`;
}

/** The commits list: tick commits to diff an unbroken run of them (history is a line, so a pick is a range).
 *  Nothing ticked + tick one -> that commit; tick outside the run -> it grows to reach it; untick an end -> it
 *  shrinks; untick one in the middle -> it and everything older go; untick the last -> back to the old scope. */
function CommitsMenu({ v, anchor, close, onBack }: { v: View; anchor: DOMRect | null; close: () => void; onBack: () => void }) {
  useApp();
  const n = v.commits.length, r = v.range, all = !!r && r[0] === 0 && r[1] === n - 1;
  const box = (st: boolean | 'mix') => <span className={cx('cb', st === 'mix' ? 'mix' : st && 'on')}>{st === true && <Icon name="check" />}</span>;
  // the list only changes with the picked run (a new array each render would re-register the menu's keys forever)
  const items = useMemo((): MenuItem<number>[] => [
    { label: 'All commits', icon: box(all ? true : r ? 'mix' : false), data: -1 },
    ...v.commits.map((c, j) => ({ label: `${c.short} ${c.subject}`, display: <><span className="hash">{c.short}</span> {c.subject}</>, icon: box(!!r && j >= r[0] && j <= r[1]), right: <span className="age">{c.when.replace(/ ago$/, '')}</span>, data: j })),
    // the git range the ticks amount to, and how many commits that is
    ...(r ? [{ label: '', head: true, block: <div className="fly-r">{rangeLabel(v)}<span>{r[1] - r[0] + 1} commit{r[1] === r[0] ? '' : 's'}</span></div> }] : []),
  ], [r?.[0], r?.[1], v.commits]); // eslint-disable-line react-hooks/exhaustive-deps
  const tick = (c: number) => {
    let x = v.range;
    if (c < 0) x = all ? null : [0, n - 1];
    else if (!x) x = [c, c];
    else if (c < x[0] || c > x[1]) x = [Math.min(x[0], c), Math.max(x[1], c)];
    else if (x[0] === x[1]) x = null;
    else if (c === x[0]) x = [c + 1, x[1]];
    else x = [x[0], c - 1];
    if (x && v.scope !== 'commits') v.before = v.scope;
    v.range = x; v.scope = x ? 'commits' : v.before === 'commits' ? 'uncommitted' : v.before; v.cur = 0;
    update();
  };
  // a flyout: clicks in it are not clicks outside the scope menu beside it
  return <div onMouseDown={e => e.stopPropagation()}><Menu<number> anchor={anchor} place="bottom-start" width={340} keep items={items} search={{ placeholder: 'Filter commits' }} className="commits-m fly"
    onPick={it => tick(it.data!)} onClose={close} keys={k => { if (k === 'h' || k === 'backspace') { onBack(); return true; } return false; }} empty="No matching commits" /></div>;
}

void animate; void MOTION;
