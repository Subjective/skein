// Sample transcripts and a pretend agent for the chat view in a plain browser (`pnpm dev:web`).
// Mirrors the mockup's data (mockups/data.js) so every chat state can be looked at and tested:
// a running turn with subagents, approvals (1 of 3), a terminal-driven mirror, errors, side chats.
import type { ChatSend, NewThread, SkeinEvent } from '@shared/api';
import type { Queued, ThreadEvent, ThreadMeta } from '@shared/types';

const shot = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" font-family="system-ui,sans-serif">
<rect width="640" height="360" fill="#1b1b1b"/><rect width="150" height="360" fill="#151515"/>
<rect x="190" y="44" width="300" height="10" rx="5" fill="#444"/><rect x="190" y="68" width="390" height="10" rx="5" fill="#333"/>
<rect x="182" y="238" width="426" height="84" rx="18" fill="#2c2c2c"/><rect x="202" y="287" width="62" height="24" rx="12" fill="#3d3d3d"/>
<text x="233" y="303" font-size="11" fill="#ddd" text-anchor="middle">Paste</text><circle cx="582" cy="296" r="14" fill="#ececec"/></svg>`);

const restoreDiff = `@@ -41,6 +41,7 @@
 export async function restore(id: string) {
-  const last = store.lastActive(id)
-  await lock.acquire(id)
+  await lock.acquire(id)
+  await store.flushed(id)
+  const last = store.lastActive(id)
   try {
     return await hydrate(id, last)`;

let n = 0;
const id = () => 'e' + ++n;
const user = (text: string, images?: string[]): ThreadEvent => ({ t: 'user', id: id(), text, images });
const text = (s: string): ThreadEvent => ({ t: 'text', id: id(), text: s });
const tool = (name: string, arg: string, x: { out?: string; meta?: string; status?: 'running' | 'done' | 'failed' } = {}): ThreadEvent => ({ t: 'tool', id: id(), name, arg, status: 'done', ...x });

export const histories: Record<string, ThreadEvent[]> = {
  t1: [
    user('Sessions sometimes restore with a stale `lastActive`. Find the race and fix it.'),
    { t: 'thinking', id: id(), text: 'The restore path and the store write can interleave. Check the order of the lock and the read.' },
    text('The restore path reads `lastActive` before the store has flushed, so a restore that lands mid-write sees the old value.'),
    tool('Read', 'sessions/restore.ts', { meta: '84 lines' }),
    tool('Grep', 'lastActive', { meta: '6 matches' }),
    text('The fix is to take the restore lock and wait for the flush **before** reading, not after.'),
    { t: 'edit', id: id(), path: 'sessions/restore.ts', add: 3, del: 2, diff: restoreDiff, status: 'done' },
    { t: 'todo', id: id(), items: [{ text: 'Reproduce the race', done: true }, { text: 'Take the lock before the read', done: true }, { text: 'Add a regression test', done: false }, { text: 'Run the full suite', done: false }] },
    { t: 'worked', id: id(), ms: 130_000 },
    user('Add a regression test too.'),
    tool('Bash', 'pnpm test sessions', { out: ' PASS  sessions/store.test.ts\n PASS  sessions/lock.test.ts\n\nTests: 21 passed, 21 total' }),
    { t: 'sub', id: 'g1', name: 'Explore', task: 'Find every caller of lastActive', status: 'done', dur: '38s', events: [
      tool('Grep', 'lastActive', { meta: '6 matches' }), tool('Read', 'sessions/store.ts', { meta: '140 lines' }),
      text('Three callers: `restore()`, `touch()` and the export job. Only `restore()` reads before the flush.')] },
    { t: 'sub', id: 'g3', name: 'Review', task: 'Check lock ordering in restore.ts', status: 'done', dur: '1m 04s', events: [
      tool('Read', 'sessions/restore.ts', { meta: '84 lines' }), text('The lock is taken before the flush wait and released in `finally`. No ordering problem.')] },
    // takes follow-ups, as a Codex sub-agent does (Claude Code's take none: their popups say so)
    { t: 'sub', id: 'g2', name: 'Test runner', task: 'Run the sessions suite and report failures', status: 'running', dur: '42s', followUps: true, events: [
      tool('Bash', 'pnpm test sessions', { out: ' PASS  sessions/store.test.ts\n PASS  sessions/lock.test.ts' })] },
  ],
  t2: [
    user('Why does the paste button look misaligned here?', [shot]),
    text('The button sits in a flex row with no `align-items`, so it stretches to the row height and its label drops 3px below the baseline of the text beside it.'),
    tool('Read', 'ui/composer.css', { meta: '212 lines' }),
    { t: 'edit', id: id(), path: 'ui/composer.css', add: 2, del: 1, status: 'done', diff: '@@ -88,5 +88,6 @@\n .composer-foot {\n   display: flex;\n-  gap: 4px;\n+  gap: 6px;\n+  align-items: center;\n }' },
    text('I would like to rebuild and take a new screenshot to confirm.'),
    { t: 'approval', id: 'a1', request: { requestId: 'r1', kind: 'command', title: 'Run this command?', body: 'pnpm build && pnpm shot composer', detail: 'Rebuild the UI and capture the composer', options: [{ id: 'allow', label: 'Allow', primary: true }, { id: 'always', label: 'Always allow' }, { id: 'deny', label: 'Deny' }] } },
    { t: 'approval', id: 'a2', request: { requestId: 'r2', kind: 'command', title: 'Run this command?', body: 'pnpm test ui/composer', detail: 'Check the composer tests still pass', from: 'Test runner', options: [{ id: 'allow', label: 'Allow', primary: true }, { id: 'always', label: 'Always allow' }, { id: 'deny', label: 'Deny' }] } },
    { t: 'approval', id: 'a3', request: { requestId: 'r3', kind: 'command', title: 'Run this command?', body: 'git stash list', detail: 'See if older composer work was stashed', from: 'Explore', options: [{ id: 'allow', label: 'Allow', primary: true }, { id: 'always', label: 'Always allow' }, { id: 'deny', label: 'Deny' }] } },
  ],
  t3: [
    user('Add a timestamp to each message in the Markdown export.'),
    { t: 'edit', id: id(), path: 'export/markdown.ts', add: 9, del: 2, status: 'done' },
    text('Each exported message now starts with its local time in `HH:mm` and the date appears once per day.'),
  ],
  t4: [
    user('My PowerShell profile takes two seconds to load. Trim it.'),
    text('Most of the time is `oh-my-posh` initialising on every shell. Caching its init script brings startup to about 300 ms.'),
  ],
  t5: [
    user('Split `worker.py` into a consumer and a retry policy. Keep behaviour identical.'),
    tool('Read', 'queue/worker.py', { meta: '412 lines' }),
    text('The retry logic is tangled into `handle()`. I will lift it into `RetryPolicy` first, then move the consume loop.'),
    { t: 'edit', id: id(), path: 'queue/retry.py', add: 58, del: 0, status: 'done' },
  ],
  t6: [
    user('The orders-by-account query got slow last week. Profile it.'),
    tool('Bash', 'psql -f bench/explain_orders.sql', { out: 'Seq Scan on orders  (cost=0.00..48211.40 rows=1203 width=96)\n  Filter: (account_id = 4471)\nExecution Time: 1840.221 ms' }),
    text('It is a sequential scan. The index on `(account_id, created_at)` was dropped in migration `0042`. Put it back:\n\n```sql\nCREATE INDEX orders_account_created\n  ON orders (account_id, created_at);\n```\n\nThen run the plan again.'),
    { t: 'notice', id: id(), text: 'Context compacted to continue' },
    text('With the index back, p95 drops from 1.8 s to about 40 ms. The migration is ready to review.'),
    user('Is it safe to build during business hours?'),
    text('Yes, with `CONCURRENTLY` it does not lock writes ([docs](https://www.postgresql.org/docs/current/sql-createindex.html)):\n\n- build it on a **replica** first\n- then on the primary\n\n1. check the plan\n2. drop the old one'),
  ],
  t7: [
    user('Convert the INI loader configs to TOML and keep the old keys working.'),
    { t: 'edit', id: id(), path: 'loaders/config.py', add: 41, del: 17, status: 'done' },
    text('All 14 loader configs are converted. Old INI keys still load through a shim that logs a deprecation warning once per key.'),
  ],
  t8: [
    user('CI fails on install. Regenerate the lockfile.'),
    tool('Bash', 'pnpm install --lockfile-only', { out: 'ERR_PNPM_FETCH_503  registry unavailable', status: 'failed' }),
    { t: 'error', id: id(), kind: 'rate', text: 'Rate limit reached. Resets at 3:40 PM' },
  ],
  // a long thread: more messages of yours than the timeline rail has room for
  s2: Array.from({ length: 70 }, (_, i) => [user(`Backlog item ${i + 1}: what is left?`), text(`Item ${i + 1} needs one more test, then it can close.`)]).flat(),
  // a side chat of t1, branched at its first reply
  s1: [user('Why not a mutex here instead of a lock file?'),
    text('A mutex only covers one process. Restore runs in both the server and the CLI, so the lock file is the cross-process option. `sessions/lock.ts` already takes it; a mutex would only add a second, weaker layer.')],
};

/** Side chats and other extra threads the sample starts with. */
export const extraThreads = (T: (id: string, h: 'claude' | 'codex', m: string, dir: string, title: string, age: number, x?: Partial<ThreadMeta>) => ThreadMeta) => [
  T('s1', 'claude', 'local', '~/projects/skein', 'Why not a mutex here?', 3, { side: true, parent: { id: 't1', at: histories.t1[2].id } }),
  T('s2', 'claude', 'local', '~/projects/dotfiles', 'Walk through the backlog', 8000),
];

/** The pretend agent: streams a short reply, asks nothing, and answers approvals. */
export function fakeChat(emit: (e: SkeinEvent) => void, threads: ThreadMeta[]) {
  const ev = (thread: string) => (histories[thread] ||= []);
  const status = (th: string, s: ThreadMeta['status']) => { const t = threads.find(x => x.id === th); if (t) { t.status = s; t.updatedAt = Date.now(); emit({ type: 'thread', thread: { ...t } }); } };
  const push = (thread: string, event: ThreadEvent, replace = false) => {
    const list = ev(thread), i = list.findIndex(x => x.id === event.id);
    if (i >= 0) list[i] = event; else list.push(event);
    emit({ type: 'chat', thread, event, replace });
  };
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const later = (thread: string, ms: number, f: () => void) => { const t = setTimeout(f, ms); timers.set(thread, [...(timers.get(thread) || []), t]); };
  const reply = (thread: string, words: string) => {
    status(thread, 'running');
    const rid = id(), parts = words.split(' ');
    later(thread, 500, () => push(thread, tool('Read', 'README.md', { meta: '120 lines' })));
    parts.forEach((_, i) => later(thread, 900 + i * 40, () => push(thread, { t: 'text', id: rid, text: parts.slice(0, i + 1).join(' '), streaming: i < parts.length - 1 }, true)));
    later(thread, 950 + parts.length * 40, () => { push(thread, { t: 'worked', id: id(), ms: 2_000 }); status(thread, 'idle'); next(thread); });
  };
  // the queue (ThreadMeta.queue): each waits for the turn before it to end, then starts a turn of its own
  const th = (thread: string) => threads.find(x => x.id === thread)!;
  const setQueue = (thread: string, q: Queued[], paused = th(thread).queuePaused) => {
    const t = th(thread); t.queue = q; t.queuePaused = q.length ? paused : false; emit({ type: 'thread', thread: { ...t } });
  };
  const turn = (thread: string, m: { text: string; images?: string[] }) => {
    push(thread, user(m.text, m.images));
    reply(thread, 'This is the browser preview, so no agent is attached. In the app the reply streams in here, and the same turn shows in the thread\'s terminal view.');
  };
  const next = (thread: string) => {
    const t = th(thread), [head, ...rest] = t.queue ?? [];
    if (!head || t.queuePaused || t.status === 'running') return;
    setQueue(thread, rest); turn(thread, head);
  };
  let qn = 0;
  const queue = {
    steer: async (thread: string, qid: string) => {
      const t = th(thread), m = t.queue?.find(x => x.id === qid); if (!m) return;
      setQueue(thread, t.queue!.filter(x => x !== m));
      if (t.status === 'running') push(thread, user(m.text, m.images)); else turn(thread, m);
    },
    remove: async (thread: string, qid: string) => setQueue(thread, (th(thread).queue ?? []).filter(x => x.id !== qid)),
    edit: async (thread: string, qid: string, text: string) => setQueue(thread, (th(thread).queue ?? []).map(x => x.id === qid ? { ...x, text } : x)),
    order: async (thread: string, ids: string[]) => { const q = th(thread).queue ?? []; setQueue(thread, ids.map(i => q.find(x => x.id === i)!).filter(Boolean)); },
    resume: async (thread: string) => { setQueue(thread, th(thread).queue ?? [], false); next(thread); },
  };
  return {
    history: async (thread: string) => [...ev(thread)],
    send: async (thread: string, m: ChatSend) => {
      if (m.rewind) { const list = ev(thread), i = list.findIndex(x => x.id === m.rewind); if (i >= 0) list.splice(i); }
      if (m.sub) {
        const s = ev(thread).find(x => x.t === 'sub' && x.id === m.sub);
        if (s && s.t === 'sub') { s.events = [...(s.events || []), user(m.text, m.images)]; s.status = 'running'; push(thread, { ...s }, true);
          later(thread, 900, () => { s.events = [...(s.events || []), text('Done. Nothing else failed.')]; s.status = 'done'; push(thread, { ...s }, true); }); }
        return;
      }
      if (m.queue && th(thread)?.status === 'running') { setQueue(thread, [...(th(thread).queue ?? []), { id: 'q' + ++qn, text: m.text, ...(m.images?.length ? { images: m.images } : {}) }]); return; }
      if (m.retry) { const list = ev(thread); const e = list[list.length - 1]; if (e?.t === 'error') { list.pop(); emit({ type: 'chat', thread, event: { t: 'notice', id: e.id, text: 'Retrying' }, replace: true }); } }
      else if (m.resume) push(thread, { t: 'notice', id: id(), text: 'Continued' });
      else push(thread, user(m.text, m.images));
      if (th(thread).queuePaused) setQueue(thread, th(thread).queue ?? [], false);   // a turn you start resumes the queue
      reply(thread, 'This is the browser preview, so no agent is attached. In the app the reply streams in here, and the same turn shows in the thread\'s terminal view.');
    },
    interrupt: async (thread: string) => {
      for (const t of timers.get(thread) || []) clearTimeout(t);
      timers.delete(thread);
      const list = ev(thread), last = list[list.length - 1];
      if (last?.t === 'text' && last.streaming) push(thread, { ...last, streaming: false }, true);
      push(thread, { t: 'interrupted', id: id() });
      status(thread, 'idle');
      if (th(thread).queue?.length) setQueue(thread, th(thread).queue!, true);
    },
    answer: async (thread: string, requestId: string, optionId: string) => {
      const list = ev(thread), a = list.find(x => x.t === 'approval' && x.request.requestId === requestId);
      if (!a || a.t !== 'approval') return;
      const ok = optionId !== 'deny';
      push(thread, { t: 'tool', id: a.id, name: 'Bash', arg: a.request.body, status: ok ? 'done' : 'failed', meta: ok ? a.request.from : 'denied', out: ok && !a.request.from ? '✓ built in 3.4s\n✓ wrote shots/composer.png' : undefined }, true);
      if (!list.some(x => x.t === 'approval')) status(thread, 'idle');
    },
    queue,
    fork: (spec: NewThread, t: ThreadMeta) => {
      const src = spec.parent && ev(spec.parent.id);
      if (src && !t.side) { const i = src.findIndex(x => x.id === spec.parent!.at); histories[t.id] = src.slice(0, i + 1).map(x => ({ ...x })); }
    },
  };
}
