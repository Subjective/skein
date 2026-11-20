// The project's files as a tree: the Files tab's body, and the side tree of an open file.
// In a repository the tree comes from `git ls-files` (tracked and new files; ignored ones are left out, and
// ignored folders at the top show dimmed), with M / A / D / R marks for uncommitted work. Outside a repository
// folders are listed as they open. Typing in the search box flattens the tree to matching paths.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DirEntry } from '@shared/types';
import { api } from '../../api';
import { update } from '../../state/store';
import { cx, Icon, Spinner } from '../../ui/primitives';
import { GitMark, LangBadge } from './code';
import { baseName } from './highlight';
import { join, type Ctx, type RepoEntry } from './repo';

export interface Node { name: string; rel: string; dir: boolean; ign?: boolean }
export interface TreeState { open: Set<string>; cur: string | null; q: string }

/** What a tree can list: built from git's file list, or read folder by folder. */
export interface Lister {
  ready: boolean;
  error?: string;
  kids(rel: string): Node[] | undefined;
  load(rel: string): void;
  /** every file path known (all of them in a repository), for search */
  all(): string[];
  mark(rel: string): string | undefined;
  /** marks roll up: a folder with changed files inside shows a dot */
  dirty(rel: string): boolean;
}

interface Cache { gen: number; root: string; files: string[] | null; kids: Map<string, Node[]>; ign: Node[]; loading: Set<string>; error?: string }
const caches = new Map<string, Cache>();

/** A lister for `ctx.dir`. In a repository paths stay relative to `ctx.dir`, which may be below the root. */
export function useLister(ctx: Ctx, re: RepoEntry): Lister {
  const repo = re.repo;
  const key = ctx.machine + '\u0000' + ctx.dir;
  let c = caches.get(key);
  if (!c || (repo && c.gen !== re.gen && c.root === repo.root) || (repo?.root || '') !== c.root) {
    const prev = c;
    c = { gen: re.gen, root: repo?.root || '', files: prev && prev.root === (repo?.root || '') ? prev.files : null, kids: new Map(), ign: prev?.ign || [], loading: new Set() };
    caches.set(key, c);
  }
  const cache = c;
  // the root's path inside the repository, so git's root-relative paths map onto this folder
  const sub = repo ? repo.prefix : '';

  useEffect(() => {
    if (!repo || cache.loading.has('*')) return;
    cache.loading.add('*');
    void Promise.all([api.git.files(ctx.machine, repo.root), api.fs.list(ctx.machine, ctx.dir).catch(() => [] as DirEntry[])]).then(([fs, top]) => {
      cache.files = fs.filter(p => !sub || p.startsWith(sub + '/')).map(p => (sub ? p.slice(sub.length + 1) : p));
      const tracked = new Set(cache.files.map(p => p.split('/')[0]));
      cache.ign = top.filter(e => e.dir && e.name !== '.git' && !tracked.has(e.name)).map(e => ({ name: e.name, rel: e.name, dir: true, ign: true }));
      cache.kids = new Map(); cache.error = undefined; update();
    }, e => { cache.error = String(e instanceof Error ? e.message : e); update(); }).finally(() => cache.loading.delete('*'));
  }, [repo?.root, re.gen, ctx.dir]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromFiles = (rel: string): Node[] => {
    const hit = cache.kids.get(rel); if (hit) return hit;
    const pre = rel ? rel + '/' : '', seen = new Map<string, Node>();
    for (const p of cache.files!) {
      if (!p.startsWith(pre)) continue;
      const rest = p.slice(pre.length), i = rest.indexOf('/'), name = i < 0 ? rest : rest.slice(0, i);
      if (!seen.has(name)) seen.set(name, { name, rel: pre + name, dir: i >= 0 });
    }
    const out = [...seen.values(), ...(rel ? [] : cache.ign)].sort(order);
    cache.kids.set(rel, out);
    return out;
  };
  const listed = (rel: string) => cache.kids.get(rel);
  const isIgn = (rel: string) => cache.ign.some(n => rel === n.rel || rel.startsWith(n.rel + '/'));
  const load = (rel: string) => {
    if (cache.kids.has(rel) || cache.loading.has(rel) || (repo && cache.files && !isIgn(rel))) return;
    const ign = !!repo; // only ignored folders are listed from disk inside a repository
    cache.loading.add(rel);
    void api.fs.list(ctx.machine, join(ctx.dir, rel)).then(es => {
      cache.kids.set(rel, es.map(e => ({ name: e.name, rel: rel ? rel + '/' + e.name : e.name, dir: e.dir, ign: ign || e.name === '.git' })).sort(order)); update();
    }, e => { cache.error = String(e instanceof Error ? e.message : e); update(); }).finally(() => cache.loading.delete(rel));
  };
  const changed = repo?.changed || {};
  const toRoot = (rel: string) => (sub ? sub + '/' + rel : rel);
  return {
    ready: repo ? !!cache.files : true,
    error: cache.error,
    kids: rel => {
      if (repo && cache.files) {
        if (!isIgn(rel)) return fromFiles(rel);
      }
      if (repo && !cache.files) return undefined;
      const k = listed(rel); if (!k) load(rel); return k;
    },
    load,
    all: () => cache.files || [...cache.kids.values()].flat().filter(n => !n.dir).map(n => n.rel),
    mark: rel => changed[toRoot(rel)],
    dirty: rel => { const p = toRoot(rel) + '/'; return Object.keys(changed).some(x => x.startsWith(p)); },
  };
}
const order = (a: Node, b: Node) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1);

/** Rows a tree shows: open folders unfolded, or the search hits. */
export function visible(l: Lister, st: TreeState): (Node & { depth: number })[] {
  const q = st.q.trim().toLowerCase();
  if (q) {
    const hits = l.all().filter(p => p.toLowerCase().includes(q));
    // file names that match rank first, then shorter paths
    hits.sort((a, b) => Number(!baseName(a).toLowerCase().includes(q)) - Number(!baseName(b).toLowerCase().includes(q)) || a.length - b.length);
    return hits.slice(0, 300).map(p => ({ name: baseName(p), rel: p, dir: false, depth: 0 }));
  }
  const out: (Node & { depth: number })[] = [];
  const walk = (rel: string, depth: number) => {
    for (const n of l.kids(rel) || []) { out.push({ ...n, depth }); if (n.dir && st.open.has(n.rel)) walk(n.rel, depth + 1); }
  };
  walk('', 0);
  return out;
}

export function ProjectTree({ l, st, onOpen, active, cursor, className, label }: {
  l: Lister; st: TreeState; onOpen: (n: Node) => void; active?: string; cursor?: boolean; className?: string; label: string;
}) {
  const rows = visible(l, st);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (cursor) ref.current?.querySelector('.rowcur')?.scrollIntoView({ block: 'nearest' }); }, [st.cur, cursor]);
  useLayoutEffect(() => { if (active && !cursor) ref.current?.querySelector('.pr.on')?.scrollIntoView({ block: 'nearest' }); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  if (l.error && !rows.length) return <div className="ptree"><div className="none">{l.error}</div></div>;
  if (!l.ready) return <div className="ptree"><div className="none"><Spinner label="Listing files" /></div></div>;
  return (
    <div className={cx('ptree', className)} role="tree" aria-label={label} ref={ref}>
      {rows.map(n => {
        const open = st.open.has(n.rel), loading = n.dir && open && !l.kids(n.rel);
        const m = n.dir ? undefined : l.mark(n.rel);
        return (
          <button key={n.rel} type="button" role="treeitem" aria-expanded={n.dir ? open : undefined} aria-selected={n.rel === st.cur}
            className={cx('pr', n.dir && 'dir', n.ign && 'ign', n.rel === active && 'on', cursor && n.rel === st.cur && 'rowcur')}
            style={{ paddingLeft: 6 + n.depth * 14 }} title={n.rel}
            onMouseDown={e => e.preventDefault()} onClick={() => { st.cur = n.rel; onOpen(n); }}>
            {n.dir ? <><Icon name="chev" className={cx('tw', open && 'open')} /><Icon name={open ? 'folderOpen' : 'folder'} /></> : <LangBadge path={n.rel} />}
            <span className="t">{n.name}</span>
            {st.q && n.rel.includes('/') && <span className="dim">{n.rel.replace(/\/[^/]*$/, '')}</span>}
            {loading && <Spinner label="Listing" />}
            {m ? <GitMark s={m} /> : n.dir && !n.ign && l.dirty(n.rel) ? <span className="gst m dotm" title="Changes inside">•</span> : null}
          </button>
        );
      })}
      {!rows.length && <div className="none">{st.q ? 'No matching files' : 'Empty folder'}</div>}
    </div>
  );
}

/** Folder open / close, loading its entries when it opens. */
export function toggleDir(l: Lister, st: TreeState, rel: string, open?: boolean) {
  const want = open ?? !st.open.has(rel);
  if (want) { st.open.add(rel); l.load(rel); } else st.open.delete(rel);
  update();
}
