// An in-memory git repository for the browser stand-in (fakeApi), so Changes, Files and the open file have
// something real to show and change under `pnpm dev:web` and in the UI tests. Folder: ~/projects/skein.
import type { Branch, Commit, FileDiff, RepoState, RevertUndo, ScopeCounts, ScopeSpec, SkeinApi } from '@shared/api';
import type { DirEntry } from '@shared/types';
import { diffLines, toHunks } from '../views/tools/linediff';

type Tree = Map<string, string>;
export const ROOT = '~/projects/skein';

const T = (o: Record<string, string>): Tree => new Map(Object.entries(o));
const store = `// Sessions persist to disk and restore on launch.
import { readFile, writeFile } from 'node:fs/promises';
import type { Session } from './types';

export interface Store {
  path: string;
  sessions: Session[];
}

const VERSION = 2;

export async function load(path: string): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (raw.version !== VERSION) return { path, sessions: [] };
    return { path, sessions: raw.sessions };
  } catch {
    return { path, sessions: [] };
  }
}

export async function save(s: Store) {
  const body = JSON.stringify({ version: VERSION, sessions: s.sessions }, null, 2);
  await writeFile(s.path, body);
}

export function find(s: Store, id: string) {
  return s.sessions.find(x => x.id === id);
}

export function remove(s: Store, id: string) {
  s.sessions = s.sessions.filter(x => x.id !== id);
}

export function count(s: Store) {
  return s.sessions.length;
}
`;
const c1 = T({
  'README.md': '# Skein\n\nThreads for Claude Code and Codex.\n\n## Build\n\n1. Install pnpm\n2. Run `pnpm dev`\n',
  'package.json': '{\n  "name": "skein",\n  "version": "0.1.0",\n  "private": true\n}\n',
  'sessions/store.ts': store,
  'sessions/types.ts': 'export interface Session {\n  id: string;\n  title: string;\n}\n',
  'ui/theme.css': ':root {\n  --bg: #212121;\n  --fg: #ececec;\n}\n\nbody {\n  margin: 0;\n}\n',
  'docs/notes.txt': 'Notes\n',
});
const c2 = new Map(c1); c2.set('sessions/types.ts', 'export interface Session {\n  id: string;\n  title: string;\n  updatedAt: number;\n}\n');
const c3 = new Map(c2); c3.set('README.md', c1.get('README.md')! + '\n## Test\n\nRun `pnpm test`.\n');

interface CommitRec { hash: string; subject: string; when: string; tree: Tree; parent: number }
const hex = (n: number) => (n * 2654435761 >>> 0).toString(16).padStart(8, '0');
const commits: CommitRec[] = [
  { hash: hex(3) + 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', subject: 'Document the test command', when: '2 hours ago', tree: c3, parent: 1 },
  { hash: hex(2) + 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', subject: 'Track when a session last changed', when: '1 day ago', tree: c2, parent: 2 },
  { hash: hex(1) + 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', subject: 'First version of session restore', when: '3 days ago', tree: c1, parent: -1 },
];
let branch = 'fix/restore-race';
const branches: Record<string, number> = { main: 0, 'fix/restore-race': 0 };
let head = (): CommitRec => commits[branches[branch] ?? 0];

// working tree and index
const work: Tree = new Map(c3);
work.set('sessions/store.ts', store
  .replace("const VERSION = 2;", "const VERSION = 3;")
  .replace("    if (raw.version !== VERSION) return { path, sessions: [] };", "    if (raw.version !== VERSION) return migrate(path, raw);")
  .replace("export function count(s: Store) {\n  return s.sessions.length;\n}\n", "export function count(s: Store) {\n  return s.sessions.length;\n}\n\nfunction migrate(path: string, raw: { sessions?: Session[] }): Store {\n  return { path, sessions: raw.sessions ?? [] };\n}\n"));
work.set('sessions/restore.test.ts', "import { expect, test } from 'vitest';\nimport { load } from './store';\n\ntest('restores an empty store', async () => {\n  const s = await load('/nope.json');\n  expect(s.sessions).toEqual([]);\n});\n");
work.set('ui/theme.css', ':root {\n  --bg: #1e1e1e;\n  --fg: #ececec;\n  --accent: #4aa3ff;\n}\n\nbody {\n  margin: 0;\n}\n');
work.delete('docs/notes.txt');
const index: Tree = new Map(c3);
index.set('ui/theme.css', work.get('ui/theme.css')!);
const ignored = ['node_modules', 'dist', '.git'];

// trees by id, so snapshots and scopes are plain lookups
const trees = new Map<string, Tree>();
let treeN = 0;
const treeId = (t: Tree) => { const id = 'tree' + (++treeN).toString(16).padStart(6, '0'); trees.set(id, new Map(t)); return id; };
const resolveTree = (rev: string): Tree => {
  if (rev === 'worktree') return work;
  if (rev === 'index') return index;
  if (trees.has(rev)) return trees.get(rev)!;
  if (rev === 'HEAD') return head().tree;
  const c = commits.find(x => x.hash.startsWith(rev.replace(/\^$/, '')));
  if (!c) throw new Error(`bad revision ${rev}`);
  if (rev.endsWith('^')) return c.parent >= 0 ? commits[c.parent].tree : new Map();
  return c.tree;
};

function diffTrees(a: Tree, b: Tree, only?: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (only && p !== only) continue;
    const x = a.get(p), y = b.get(p);
    if (x === y) continue;
    const hunks = toHunks(diffLines(x == null ? [] : x.replace(/\n$/, '').split('\n'), y == null ? [] : y.replace(/\n$/, '').split('\n')));
    const add = hunks.reduce((n, h) => n + h.lines.filter(l => l.k === '+').length, 0), del = hunks.reduce((n, h) => n + h.lines.filter(l => l.k === '-').length, 0);
    out.push({ path: p, status: x == null ? 'A' : y == null ? 'D' : 'M', add, del, hunks });
  }
  return out;
}
const sides = (s: ScopeSpec): [Tree, Tree] => {
  switch (s.scope) {
    case 'staged': return [head().tree, index];
    case 'unstaged': return [index, work];
    case 'turn': if (!s.base) throw new Error('No agent turn yet'); return [resolveTree(s.base), s.head ? resolveTree(s.head) : work];
    case 'commits': return [resolveTree(s.base! + '^'), resolveTree(s.head!)];
    default: return [head().tree, work];
  }
};
const delay = <T,>(v: T, ms = 40) => new Promise<T>(r => setTimeout(() => r(v), ms));
const inRepo = (dir: string) => dir === ROOT || dir.startsWith(ROOT + '/');
const rel = (p: string) => p.slice(ROOT.length + 1);
const undos = new Map<string, { path: string; work?: string; index?: string }[]>();
let gen = 0;
const touch = () => { gen++; };

export const fakeGit: SkeinApi['git'] = {
  repo: async (_m, dir) => delay(inRepo(dir) ? ({ root: ROOT, prefix: dir === ROOT ? '' : rel(dir), branch, head: head().hash, ahead: 1, behind: 0, upstream: `origin/${branch}`, trunk: 'main', key: String(gen), changed: Object.fromEntries(diffTrees(head().tree, work).map(f => [f.path, f.status])) } as RepoState) : null),
  changes: async (_m, _r, s) => { const [a, b] = sides(s); const fs = diffTrees(a, b, s.path); if (s.scope !== 'commits' && s.scope !== 'turn') for (const f of fs) { const st = head().tree.get(f.path) !== index.get(f.path), un = index.get(f.path) !== work.get(f.path); f.staged = st ? (un ? 'part' : 'yes') : 'no'; } return delay(fs); },
  counts: async (_m, _r, specs) => delay(specs.map((s): ScopeCounts => { try { const fs = diffTrees(...sides(s)); return { files: fs.length, add: fs.reduce((n, f) => n + f.add, 0), del: fs.reduce((n, f) => n + f.del, 0) }; } catch { return { files: 0, add: 0, del: 0 }; } })),
  show: async (_m, _r, p, rev) => { const t = resolveTree(rev).get(p); if (t == null) throw new Error(`${p} is not in ${rev}`); return delay(t); },
  commits: async (_m, _r, n) => delay(commits.slice(branches[branch] ?? 0, (branches[branch] ?? 0) + n).map((c): Commit => ({ hash: c.hash, short: c.hash.slice(0, 7), subject: c.subject, when: c.when, author: 'You' }))),
  branches: async () => delay(Object.keys(branches).map((name): Branch => ({ name, current: name === branch, when: name === branch ? '2 hours ago' : '3 days ago' }))),
  switch: async (_m, _r, b, create) => { if (create) { if (branches[b] != null) throw new Error(`a branch named '${b}' already exists`); branches[b] = branches[branch]; } else if (branches[b] == null) throw new Error(`invalid reference: ${b}`); branch = b; touch(); },
  push: async () => { await delay(0, 200); return { pr: `https://github.com/example/skein/compare/${branch}?expand=1` }; },
  snapshot: async () => treeId(work),
  files: async () => delay([...work.keys()].sort()),
  webUrl: async (_m, _r, p) => `https://github.com/example/skein/blob/${branch}/${p}`,
  stage: async (_m, _d, ps, on) => { for (const p of ps) { const src = on ? work : head().tree; if (src.has(p)) index.set(p, src.get(p)!); else index.delete(p); } touch(); },
  revert: async (_m, _d, ps): Promise<RevertUndo> => {
    const id = 'u' + Date.now();
    undos.set(id, ps.map(p => ({ path: p, work: work.get(p), index: index.get(p) })));
    for (const p of ps) { const h = head().tree.get(p); if (h == null) { work.delete(p); index.delete(p); } else { work.set(p, h); index.set(p, h); } }
    touch(); return { id, paths: ps };
  },
  unrevert: async (_m, _d, u) => { for (const x of undos.get(u.id) || []) { if (x.work == null) work.delete(x.path); else work.set(x.path, x.work); if (x.index == null) index.delete(x.path); else index.set(x.path, x.index); } undos.delete(u.id); touch(); },
  commit: async (_m, _d, message, o = {}) => {
    if (o.branch) await fakeGit.switch('local', ROOT, o.branch, true);
    const staged = diffTrees(head().tree, index).length > 0;
    if (!staged && o.all) for (const [p, t] of work) index.set(p, t);
    if (!staged && o.all) for (const p of [...index.keys()]) if (!work.has(p)) index.delete(p);
    if (!diffTrees(head().tree, index).length) throw new Error('nothing to commit, working tree clean');
    commits.unshift({ hash: hex(commits.length + 1) + 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', subject: message.split('\n')[0], when: 'just now', tree: new Map(index), parent: branches[branch] });
    for (const b of Object.keys(branches)) if (b !== branch) branches[b]++;
    branches[branch] = 0; touch();
  },
  log: async (_m, _d, n) => (await fakeGit.commits('local', ROOT, n)).map(c => ({ hash: c.short, subject: c.subject, when: c.when })),
  status: async () => ({ isRepo: true, branch, files: [] }),
  diff: async () => '',
};

/** fs over the fake project; anything outside it is left to the caller. */
export const fakeFs = {
  owns: (p: string) => inRepo(p),
  files: async () => [...work.keys()].sort(),
  list: async (dir: string): Promise<DirEntry[]> => {
    dir = dir.replace(/[\/]+$/, '');
    const r = dir === ROOT ? '' : rel(dir) + '/';
    const kids = new Map<string, boolean>();
    for (const p of work.keys()) if (p.startsWith(r)) { const rest = p.slice(r.length); kids.set(rest.split('/')[0], rest.includes('/')); }
    if (!r) for (const d of ignored) kids.set(d, true);
    return delay([...kids].map(([name, d]) => ({ name, dir: d, hidden: name.startsWith('.') })).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1)));
  },
  read: async (p: string) => { const t = work.get(rel(p)); if (t == null) throw new Error(`ENOENT: no such file, open '${p}'`); return delay(t); },
  write: async (p: string, text: string) => { work.set(rel(p), text); touch(); await delay(0, 30); },
};
/** Mark a change from outside (an agent edited a file), for tests. */
export const fakeEdit = (p: string, text: string) => { work.set(p, text); touch(); };
