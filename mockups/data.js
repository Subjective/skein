/* Mock data. Every session is a list of events; the terminal view and the chat view
   both render from this same list, which is what keeps the two modes in sync. */
(function () {
  const uri = svg => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);

  // Stand-in images (a UI screenshot and a benchmark plot) so image handling can be shown.
  const shot = uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" font-family="Segoe UI,system-ui,sans-serif">
    <rect width="640" height="360" fill="#1b1b1b"/><rect width="150" height="360" fill="#151515"/>
    ${[40, 68, 96, 124, 152].map((y, i) => `<rect x="18" y="${y}" width="${[96, 78, 110, 64, 88][i]}" height="9" rx="4.500" fill="#3a3a3a"/>`).join('')}
    <rect x="190" y="44" width="300" height="10" rx="5" fill="#444"/><rect x="190" y="68" width="390" height="10" rx="5" fill="#333"/>
    <rect x="190" y="92" width="340" height="10" rx="5" fill="#333"/><rect x="190" y="116" width="220" height="10" rx="5" fill="#333"/>
    <rect x="182" y="238" width="426" height="84" rx="18" fill="#2c2c2c"/>
    <rect x="202" y="258" width="150" height="10" rx="5" fill="#555"/>
    <rect x="202" y="287" width="62" height="24" rx="12" fill="#3d3d3d"/><text x="233" y="303" font-size="11" fill="#ddd" text-anchor="middle">Paste</text>
    <circle cx="582" cy="296" r="14" fill="#ececec"/>
    <path d="M196 284h74M196 314h74" stroke="#f0616d" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="278" y="290" font-size="10" fill="#f0616d">3px low</text></svg>`);

  const chart = uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" font-family="Segoe UI,system-ui,sans-serif" font-size="11">
    <rect width="640" height="320" fill="#ffffff"/>
    <text x="24" y="30" font-size="13" fill="#1a1a1a" font-weight="600">orders_by_account · p95 latency (ms)</text>
    ${[80, 140, 200, 260].map((y, i) => `<path d="M56 ${y}H616" stroke="#ececec"/><text x="48" y="${y + 4}" fill="#8a8a8a" text-anchor="end">${[1800, 1200, 600, 0][i]}</text>`).join('')}
    <polyline fill="none" stroke="#b5b5b5" stroke-width="2" points="56,96 126,90 196,84 266,88 336,80 406,82 476,78 546,84 616,80"/>
    <polyline fill="none" stroke="#10a37f" stroke-width="2" points="56,255 126,256 196,255 266,256 336,256 406,255 476,256 546,256 616,256"/>
    <text x="610" y="70" fill="#8a8a8a" text-anchor="end">seq scan</text><text x="610" y="246" fill="#10a37f" text-anchor="end">with index</text>
    ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d, i) => `<text x="${56 + i * 140}" y="286" fill="#8a8a8a" text-anchor="middle">${d}</text>`).join('')}</svg>`);

  const machines = [
    window.OS === 'mac' ? { id: 'local', name: 'This Mac', os: 'macOS', addr: 'local', up: true, lat: null, has: ['claude', 'codex'] }
      : { id: 'local', name: 'This PC', os: 'Windows', addr: 'local', up: true, lat: null, has: ['claude', 'codex'] },
    { id: 'linux', name: 'linux', os: 'Linux', addr: 'joshyin@linux-dev', up: true, lat: 38, ssh: true, has: ['claude', 'codex'] },
    { id: 'build', name: 'build-07', os: 'Linux', addr: 'ci@build-07', up: false, lat: null, ssh: true, has: ['codex'] },
  ];

  const MSEED = JSON.stringify(machines);   // scenes change link states; reset puts them back

  const dirs = {
    local: ['~/projects/skein', '~/projects/dotfiles', '~/projects/notes', '~/scripts'],
    linux: ['~/repo/trade-ticker', '~/repo/etl-config', '~/repo/metrics', '~/repo/skein', '~/scratch'],
    build: ['~/ci', '~/ci/runners'],
  };

  // Effort stops and extra toggles are data per model (placeholder values, easy to correct).
  const E3 = ['Low', 'Medium', 'High'];
  const models = {
    claude: [{ n: 'Opus 5.5', e: [...E3, 'Max'], ultra: true }, { n: 'Sonnet 5.5', e: [...E3, 'Max'], ultra: true }, { n: 'Haiku 5.5', e: E3 }, { n: 'Fable 5.2', e: [...E3, 'Max'], ultra: true }],
    codex: [{ n: 'GPT-6.2 Sol', e: [...E3, 'Ultra'] }, { n: 'GPT-6.2 Astra', e: E3 }],
  };
  const perms = {
    claude: ['Ask before edits', 'Accept edits', 'Plan mode'],
    codex: ['Read only', 'Auto', 'Full access'],
  };

  const slash = {
    claude: [['/clear', 'Start a fresh conversation'], ['/compact', 'Summarise to free up context'], ['/model', 'Switch model'],
      ['/plan', 'Plan before editing'], ['/resume', 'Resume a past thread'], ['/review', 'Review the current diff'],
      ['/init', 'Create CLAUDE.md'], ['/mcp', 'Manage MCP servers'], ['/permissions', 'Edit tool permissions'], ['/status', 'Thread and account status']],
    codex: [['/new', 'Start a new thread'], ['/compact', 'Summarise to free up context'], ['/model', 'Switch model and effort'],
      ['/approvals', 'Choose what needs approval'], ['/review', 'Review the current diff'], ['/diff', 'Show the working diff'],
      ['/mention', 'Attach a file'], ['/init', 'Create AGENTS.md'], ['/status', 'Thread and account status']],
  };

  // Skills the harness exposes; listed in the slash menu after its built-in commands.
  const skills = {
    claude: [['/code-review', 'Review the current diff for bugs'], ['/simplify', 'Clean up the changed code'], ['/security-review', 'Security review of pending changes']],
    codex: [['/code-review', 'Review the current diff for bugs'], ['/simplify', 'Clean up the changed code']],
  };

  const files = ['PLAN.md', 'sessions/restore.ts', 'sessions/store.ts', 'sessions/lock.ts', 'sessions/restore.test.ts', 'ui/composer.css', 'ui/composer.tsx', 'package.json', 'README.md'];

  // File contents for the file inspector. Anything not listed shows a short stub.
  const docs = {
    'PLAN.md': `# Image paste over SSH

Paste an image from the local clipboard into a thread that runs on a remote machine.

## Steps

1. Intercept paste in the app and save the bitmap to a temp PNG.
2. Copy it to \`~/.skein/inbox\` on the host over the existing SSH connection.
3. Insert the remote path at the prompt, so the harness attaches it as an image.
4. Show the thumbnail in the composer and inline in the terminal.

## Fallback

If the copy fails, keep the image local and tell the user. Never send a path that does not exist on the host.

## Open questions

- Should the inbox be cleaned when the thread closes, or after seven days?
- Is one SSH control connection per host enough for large images?`,
    'sessions/restore.ts': `import { store } from './store'
import { lock } from './lock'

export async function restore(id: string) {
  await lock.acquire(id)
  await store.flushed(id)
  const last = store.lastActive(id)
  try {
    return await hydrate(id, last)
  } finally {
    lock.release(id)
  }
}

async function hydrate(id: string, last: number) {
  const snap = await store.read(id)
  return { ...snap, lastActive: Math.max(snap.lastActive, last) }
}`,
  };
  const newTest = `import { restore } from './restore'
import { store } from './store'

test('restore waits for a pending flush', async () => {
  const id = 'thread-1'
  const write = store.touch(id, 42)
  const restored = restore(id)
  await write
  expect((await restored).lastActive).toBe(42)
})`.split('\n').map((s, i) => ['+', i + 1, s]);
  const commits = [['a41c9e2', 'Take the restore lock before the read', '2m'], ['7f03b1d', 'Add a flush barrier to the store', '1h'], ['c2e88a0', 'Thread store: batch writes', '1d']];

  const restoreDiff = [
    [' ', 41, 'export async function restore(id: string) {'],
    ['-', 42, '  const last = store.lastActive(id)'],
    ['-', 43, '  await lock.acquire(id)'],
    ['+', 42, '  await lock.acquire(id)'],
    ['+', 43, '  await store.flushed(id)'],
    ['+', 44, '  const last = store.lastActive(id)'],
    [' ', 45, '  try {'],
    [' ', 46, '    return await hydrate(id, last)'],
  ];

  const seed = [
    { id: 's1', harness: 'claude', title: 'Fix session-restore race', machine: 'local', dir: '~/projects/skein', branch: 'fix/restore-race',
      status: 'running', age: 0, model: 'Opus 5.5', effort: 'Medium', perm: 'Accept edits', ctx: 38, events: [
        { t: 'user', text: 'Sessions sometimes restore with a stale `lastActive`. Find the race and fix it.' },
        { t: 'text', text: 'The restore path reads `lastActive` before the store has flushed, so a restore that lands mid-write sees the old value.' },
        { t: 'tool', name: 'Read', arg: 'sessions/restore.ts', meta: '84 lines' },
        { t: 'tool', name: 'Grep', arg: 'lastActive', meta: '6 matches' },
        { t: 'text', text: 'The fix is to take the restore lock and wait for the flush **before** reading, not after.' },
        { t: 'tool', name: 'Edit', arg: 'sessions/restore.ts', add: 3, del: 2, diff: restoreDiff },
        { t: 'todo', age: 1, items: [['done', 'Reproduce the race'], ['done', 'Take the lock before the read'], ['now', 'Add a regression test'], ['todo', 'Run the full suite']] },
        { t: 'user', text: 'Add a regression test too.' },
        { t: 'tool', name: 'Bash', arg: 'pnpm test sessions', out: ' PASS  sessions/store.test.ts\n PASS  sessions/lock.test.ts\n\nTests: 21 passed, 21 total' },
        { t: 'live', text: 'Writing the regression test', dur: '42s' },
      ] },
    { id: 's3', harness: 'claude', title: 'Paste button misaligned', machine: 'local', dir: '~/projects/skein', branch: 'main',
      status: 'wait', age: 4, pinned: true, model: 'Sonnet 5.5', effort: 'Medium', perm: 'Ask before edits', ctx: 12, events: [
        { t: 'user', text: 'Why does the paste button look misaligned here?', images: [shot] },
        { t: 'text', text: 'The button sits in a flex row with no `align-items`, so it stretches to the row height and its label drops 3px below the baseline of the text beside it.' },
        { t: 'tool', name: 'Read', arg: 'ui/composer.css', meta: '212 lines' },
        { t: 'tool', name: 'Edit', arg: 'ui/composer.css', add: 2, del: 1, diff: [
          [' ', 88, '.composer-foot {'], [' ', 89, '  display: flex;'], ['-', 90, '  gap: 4px;'], ['+', 90, '  gap: 6px;'], ['+', 91, '  align-items: center;'], [' ', 92, '}']] },
        { t: 'text', text: 'I would like to rebuild and take a new screenshot to confirm.' },
        { t: 'approval', cmd: 'pnpm build && pnpm shot composer', why: 'Rebuild the UI and capture the composer' },
      ] },
    { id: 's9', harness: 'claude', title: 'Plan image paste over SSH', machine: 'local', dir: '~/projects/skein', branch: 'main',
      status: 'wait', age: 2, model: 'Opus 5.5', effort: 'High', perm: 'Plan mode', ctx: 9, events: [
        { t: 'user', text: 'Plan how to paste images into threads that run on a remote machine. Do not write code yet.' },
        { t: 'tool', name: 'Read', arg: 'ui/composer.tsx', meta: '318 lines' },
        { t: 'text', text: 'I wrote the plan to `PLAN.md`. Comment on anything you want changed, or approve it and I will start.' },
        { t: 'plan', file: 'PLAN.md' },
      ] },
    { id: 's2', harness: 'codex', title: 'Profile slow orders query', machine: 'linux', dir: '~/repo/trade-ticker', branch: 'perf/orders-index',
      status: 'idle', age: 14, model: 'GPT-6.2 Sol', effort: 'High', perm: 'Auto', ctx: 21, events: [
        { t: 'user', text: 'The orders-by-account query got slow last week. Profile it.' },
        { t: 'worked', dur: '1m 21s' },
        { t: 'tool', name: 'Bash', arg: 'psql -f bench/explain_orders.sql', out: 'Seq Scan on orders  (cost=0.00..48211.40 rows=1203 width=96)\n  Filter: (account_id = 4471)\nExecution Time: 1840.221 ms' },
        { t: 'text', text: 'It is a sequential scan. The index on `(account_id, created_at)` was dropped in migration `0042`.' },
        { t: 'tool', name: 'Edit', arg: 'migrations/0043_restore_index.sql', add: 2, del: 0, diff: [
          ['+', 1, 'CREATE INDEX CONCURRENTLY orders_account_created_idx'], ['+', 2, '  ON orders (account_id, created_at DESC);']] },
        { t: 'tool', name: 'Bash', arg: 'python bench/orders.py --plot', meta: 'wrote bench/p95.png' },
        { t: 'image', img: chart, cap: 'bench/p95.png' },
        { t: 'text', text: 'With the index back, p95 drops from 1.8 s to about 40 ms. The migration is ready to review.' },
      ] },
    { id: 's4', harness: 'codex', title: 'Refactor queue worker', machine: 'linux', dir: '~/repo/trade-ticker', branch: 'refactor/worker',
      status: 'running', age: 1, model: 'GPT-6.2 Sol', effort: 'Medium', perm: 'Auto', ctx: 54, events: [
        { t: 'user', text: 'Split `worker.py` into a consumer and a retry policy. Keep behaviour identical.' },
        { t: 'tool', name: 'Read', arg: 'queue/worker.py', meta: '412 lines' },
        { t: 'text', text: 'The retry logic is tangled into `handle()`. I will lift it into `RetryPolicy` first, then move the consume loop.' },
        { t: 'tool', name: 'Edit', arg: 'queue/retry.py', add: 58, del: 0 },
        { t: 'live', text: 'Moving the consume loop', dur: '1m 08s' },
      ] },
    { id: 's5', harness: 'claude', title: 'Migrate ETL config to YAML', machine: 'linux', dir: '~/repo/etl-config', branch: 'main',
      status: 'unread', age: 180, model: 'Opus 5.5', effort: 'High', perm: 'Accept edits', ctx: 66, events: [
        { t: 'user', text: 'Convert the INI loader configs to YAML and keep the old keys working.' },
        { t: 'tool', name: 'Edit', arg: 'loaders/config.py', add: 41, del: 17 },
        { t: 'text', text: 'All 14 loader configs are converted. Old INI keys still load through a shim that logs a deprecation warning once per key.' },
      ] },
    { id: 's8', harness: 'codex', title: 'Add timestamps to chat export', machine: 'local', dir: '~/projects/skein', branch: 'main',
      status: 'idle', age: 1500, model: 'GPT-6.2 Astra', effort: 'Medium', perm: 'Auto', ctx: 9, events: [
        { t: 'user', text: 'Add a timestamp to each message in the Markdown export.' },
        { t: 'tool', name: 'Edit', arg: 'export/markdown.ts', add: 9, del: 2 },
        { t: 'text', text: 'Each exported message now starts with its local time in `HH:mm` and the date appears once per day.' },
      ] },
    { id: 's7', harness: 'claude', title: 'Tidy PowerShell profile', machine: 'local', dir: '~/projects/dotfiles', branch: 'main',
      status: 'idle', age: 5800, model: 'Haiku 5.5', effort: 'Low', perm: 'Ask before edits', ctx: 5, events: [
        { t: 'user', text: 'My PowerShell profile takes two seconds to load. Trim it.' },
        { t: 'text', text: 'Most of the time is `oh-my-posh` initialising on every shell. Caching its init script brings startup to about 300 ms.' },
      ] },
    { id: 's6', harness: 'codex', title: 'Bump lockfile to fix CI', machine: 'build', dir: '~/ci', branch: 'main',
      status: 'error', age: 2900, model: 'GPT-6.2 Astra', effort: 'Low', perm: 'Auto', ctx: 3, events: [
        { t: 'user', text: 'CI fails on install. Regenerate the lockfile.' },
        { t: 'tool', name: 'Bash', arg: 'pnpm install --lockfile-only', out: 'ERR_PNPM_FETCH_503  registry unavailable' },
      ] },
  ];

  // Side chats: forks of a thread at one message (`at` is the event index they branch from).
  seed[0].sides = [
    { id: 'c1', title: 'Why not a mutex here?', at: 4, events: [
      { t: 'user', text: 'Why not a mutex here instead of a lock file?' },
      { t: 'text', text: 'A mutex only covers one process. Restore runs in both the server and the CLI, so the lock file is the cross-process option. `sessions/lock.ts` already takes it; a mutex would only add a second, weaker layer.' }] },
    { id: 'c2', title: 'Rollback if the lock sticks', at: 1, events: [
      { t: 'user', text: 'If we ship this, what is the rollback if the lock file gets stuck?' },
      { t: 'text', text: 'Delete the lock file and restart. Restore falls back to the last flushed value, so nothing is lost.' }] },
  ];

  // Subagents a thread has started. Each has its own transcript; they are read-only.
  seed[0].subs = [
    { id: 'g1', name: 'Explore', task: 'Find every caller of lastActive', status: 'done', dur: '38s', events: [
      { t: 'tool', name: 'Grep', arg: 'lastActive', meta: '6 matches' }, { t: 'tool', name: 'Read', arg: 'sessions/store.ts', meta: '140 lines' },
      { t: 'text', text: 'Three callers: `restore()`, `touch()` and the export job. Only `restore()` reads before the flush.' }] },
    { id: 'g3', name: 'Review', task: 'Check lock ordering in restore.ts', status: 'done', dur: '1m 04s', events: [
      { t: 'tool', name: 'Read', arg: 'sessions/restore.ts', meta: '84 lines' },
      { t: 'text', text: 'The lock is taken before the flush wait and released in `finally`. No ordering problem.' }] },
    { id: 'g2', name: 'Test runner', task: 'Run the sessions suite and report failures', status: 'running', dur: '42s', events: [
      { t: 'tool', name: 'Bash', arg: 'pnpm test sessions', out: ' PASS  sessions/store.test.ts\n PASS  sessions/lock.test.ts' },
      { t: 'live', text: 'Running restore.test.ts', dur: '12s' }] },
  ];
  seed[0].events.splice(9, 0, { t: 'agents', ids: ['g1', 'g3', 'g2'] });   // just before the live status line

  // More uncommitted work in the restore thread's checkout, so the Changes tab has a tree to show.
  // A diff row ['~', from, lines] is a run of unchanged lines: folded until you open it.
  const ctx = (from, arr) => ['~', from, arr];
  const extraChanges = {
    s1: [
      { path: 'sessions/store.ts', add: 6, del: 1, diff: [
        ctx(1, ["import { db } from '../db'", "import { emitter } from './events'", '', 'type Row = { id: string; lastActive: number }', '', 'const pending = new Map<string, Promise<void>>()', '', 'export const store = {', '  lastActive(id: string) {', '    return db.get<Row>(id)?.lastActive ?? 0', '  },', '']),
        [' ', 13, '  touch(id: string, at: number) {'],
        ['-', 14, '    db.put({ id, lastActive: at })'],
        ['+', 14, '    const write = db.put({ id, lastActive: at })'],
        ['+', 15, '    pending.set(id, write)'],
        ['+', 16, '    return write.finally(() => pending.delete(id))'],
        [' ', 17, '  },'],
        ['+', 18, '  flushed(id: string) {'],
        ['+', 19, '    return pending.get(id) ?? Promise.resolve()'],
        ['+', 20, '  },'],
        [' ', 21, '}'] ] },
      { path: 'sessions/lock.ts', add: 2, del: 2, diff: [
        ctx(1, ["const held = new Map<string, Promise<void>>()", '', 'export const lock = {']),
        ['-', 4, '  async acquire(id: string) {'],
        ['-', 5, '    while (held.has(id)) await held.get(id)'],
        ['+', 4, '  async acquire(id: string, timeout = 5_000) {'],
        ['+', 5, '    while (held.has(id)) await Promise.race([held.get(id), sleep(timeout)])'],
        [' ', 6, '    let release!: () => void'],
        ctx(7, ['    held.set(id, new Promise<void>(r => (release = r)))', '    return () => { held.delete(id); release() }', '  },', '}']) ] },
      { path: 'ui/restore-banner.tsx', add: 8, del: 0, isNew: true, diff: [
        ['+', 1, "import { useRestore } from '../sessions/useRestore'"],
        ['+', 2, ''],
        ['+', 3, 'export function RestoreBanner({ id }: { id: string }) {'],
        ['+', 4, '  const state = useRestore(id)'],
        ['+', 5, "  if (state !== 'waiting') return null"],
        ['+', 6, '  return <div className="banner">Restoring after the last write</div>'],
        ['+', 7, '}'],
        ['+', 8, ''] ] },
      { path: 'package.json', add: 1, del: 1, diff: [
        ctx(1, ['{', '  "name": "skein",', '  "version": "0.4.0",', '  "scripts": {', '    "dev": "electron .",', '    "build": "tsc -b && electron-builder",']),
        ['-', 7, '    "test": "vitest run"'],
        ['+', 7, '    "test": "vitest run --sequence.concurrent=false"'],
        [' ', 8, '  },'],
        ctx(9, ['  "dependencies": {', '    "node-pty": "^1.1.0",', '    "xterm": "^5.5.0"', '  }', '}']) ] },
    ],
  };

  window.D = {
    img: { shot, chart }, machines, dirs, models, perms, slash, skills, files, docs, newTest, commits, extraChanges, sessions: [],
    reset() { this.sessions = JSON.parse(JSON.stringify(seed)); machines.forEach((m, i) => { for (const k of Object.keys(m)) delete m[k]; Object.assign(m, JSON.parse(MSEED)[i]); }); },
    modelDef: n => [...models.claude, ...models.codex].find(m => m.n === n),
    harnessOf: n => (models.codex.some(m => m.n === n) ? 'codex' : 'claude'),
  };
  window.D.reset();
})();
