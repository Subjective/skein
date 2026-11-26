import { describe, expect, it } from 'vitest';
import { which } from '../../shell';
import { fakeHost, until } from '../test/fakes';
import { CodexDriver, CodexServers, launchAppServer, type Launch } from './driver';
import { codexHistory, turnEvents } from './history';
import { commandStep, itemEvents, unwrap } from './items';
import { Rpc } from './rpc';

const J = (o: object) => JSON.stringify(o);

// Turns as thread/turns/list returns them (shapes copied from codex 0.171): history uses the live item mapping.
const turnsFixture = [
  { id: 'turn1', status: 'completed', error: null, durationMs: 4200, items: [
    { type: 'userMessage', id: 'u1', clientId: 'c1', content: [{ type: 'text', text: 'list files', text_elements: [] }] },
    { type: 'reasoning', id: 'rs_1', summary: ['Thinking about it.'], content: [] },
    { type: 'commandExecution', id: 'x1', command: "/bin/bash -lc 'ls'", cwd: '/p', status: 'completed', aggregatedOutput: 'a\nb', exitCode: 0, durationMs: 40, commandActions: [], source: 'agent' },
    { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/p/hello.txt', kind: { type: 'add' }, diff: 'hello from codex\n' }] },
    { type: 'agentMessage', id: 'msg_1', text: 'Two files.', phase: null },
  ] },
  { id: 'turn2', status: 'interrupted', error: null, durationMs: 2600, items: [{ type: 'userMessage', id: 'u2', clientId: null, content: [{ type: 'text', text: 'slow', text_elements: [] }] }] },
  { id: 'turn3', status: 'failed', durationMs: 10, error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }, items: [] },
];

describe('Codex commands as steps', () => {
  it('shows a tagged read, search or listing as that step, and anything else as the command without its shell', () => {
    const c = (command: string, commandActions: unknown[]) => commandStep({ command, commandActions } as never);
    expect(c("/bin/bash -lc 'sed -n 1,80p src/a.ts'", [{ type: 'read', command: 'sed', name: 'a.ts', path: '/p/src/a.ts' }])).toMatchObject({ name: 'Read', arg: '/p/src/a.ts', kind: 'read' });
    expect(c("/bin/bash -lc 'rg -n lastActive src'", [{ type: 'search', command: 'rg', query: 'lastActive', path: 'src' }])).toMatchObject({ name: 'Search', arg: 'lastActive  src', kind: 'search' });
    expect(c("/bin/bash -lc 'ls'", [{ type: 'listFiles', command: 'ls', path: null }])).toMatchObject({ name: 'List', arg: '.', kind: 'list' });
    // two actions in one command, or an unknown one: the command itself
    expect(c("/bin/bash -lc 'cat a && rg x'", [{ type: 'read', command: 'cat a', name: 'a', path: 'a' }, { type: 'search', command: 'rg x', query: 'x', path: null }])).toMatchObject({ name: 'Shell', arg: 'cat a && rg x', kind: 'command' });
  });
  it('unwraps the shell Codex runs a command in', () => {
    expect(unwrap("/bin/bash -lc 'pnpm test'")).toBe('pnpm test');
    expect(unwrap("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrap('/bin/zsh -lc "echo \\"hi\\""')).toBe('echo "hi"');
    expect(unwrap('pwsh -Command Get-ChildItem')).toBe('pwsh -Command Get-ChildItem');
  });
});

describe('Codex history', () => {
  it('maps the app-server turns through the same items as the live driver, with the live ids', () => {
    const { events, turnOf } = turnEvents(turnsFixture as never);
    expect(events.map(e => e.t)).toEqual(['user', 'thinking', 'tool', 'edit', 'text', 'worked', 'user', 'interrupted', 'worked', 'error']);
    // a message Skein sent keeps the id it was shown under (its client id); one typed elsewhere has the item id
    expect(events[0]).toMatchObject({ id: 'c1', text: 'list files' });
    expect(events[6]).toMatchObject({ id: 'u2' });
    expect(events[2]).toMatchObject({ t: 'tool', name: 'Shell', kind: 'command', arg: 'ls', out: 'a\nb', status: 'done' });
    expect(events[3]).toMatchObject({ t: 'edit', path: '/p/hello.txt', add: 1, del: 0, diff: '+hello from codex' });
    expect(events[9]).toMatchObject({ t: 'error', kind: 'rate' });
    expect(turnOf.get('c1')).toBe('turn1');
  });

  it('reads a whole thread, pages one thread/read cannot hydrate, and treats an unreadable thread as empty', async () => {
    const calls: Record<string, unknown>[] = [];
    const whole = { request: async (m: string, p: Record<string, unknown>) => (m === 'thread/read' && p.includeTurns ? { thread: { id: 'th1', turns: turnsFixture } } : {}) } as unknown as Rpc;
    expect((await codexHistory(whole, 'th1')).events).toHaveLength(10);
    // a paginated thread: thread/read refuses to hydrate it, so its turns are paged
    const rpc = { request: async (m: string, p: Record<string, unknown>) => {
      if (m === 'thread/read') throw new Error('paginated thread');
      calls.push(p); return p.cursor ? { data: turnsFixture.slice(1), nextCursor: null } : { data: turnsFixture.slice(0, 1), nextCursor: 'next' };
    } } as unknown as Rpc;
    const h = await codexHistory(rpc, 'th1');
    expect(calls.map(c => c.cursor)).toEqual([null, 'next']);
    expect(calls[0]).toMatchObject({ threadId: 'th1', sortDirection: 'asc', itemsView: 'full' });
    expect(h.events.map(e => e.id)).toContain('i-turn2');
    const broken = { request: async () => { throw new Error('thread not found'); } } as unknown as Rpc;
    expect((await codexHistory(broken, 'th1')).events).toEqual([]);
  });

  it('maps live items, skipping injected context', () => {
    expect(itemEvents({ type: 'userMessage', id: 'x', clientId: null, content: [{ type: 'text', text: '<environment_context>…', text_elements: [] }] } as never)).toEqual([]);
    expect(itemEvents({ type: 'commandExecution', id: 'c', command: 'false', status: 'completed', exitCode: 1, durationMs: 20 } as never)[0]).toMatchObject({ status: 'failed', meta: 'exit 1 · 20ms' });
  });
});

/** An in-memory app-server: answers requests with `reply`, lets the test push notifications and requests. */
function fakeServer(reply: (method: string, params: Record<string, unknown>) => unknown) {
  const got: { method: string; params: Record<string, unknown> }[] = [];
  const responses = new Map<number, unknown>();
  let rpc!: Rpc;
  let sid = 1000;
  const launch: Launch = async () => {
    rpc = new Rpc(line => {
      const m = JSON.parse(line);
      if (m.method) {
        got.push({ method: m.method, params: m.params ?? {} });
        if (m.id != null) queueMicrotask(() => rpc.feed(J({ id: m.id, result: reply(m.method, m.params ?? {}) ?? {} }) + '\n'));
      } else if (m.id != null) responses.set(m.id, m.result ?? m.error);
    }, () => rpc.ended(0, 'killed'));
    return { rpc };
  };
  return {
    launch, got, responses,
    notify: (method: string, params: object) => rpc.feed(J({ method, params }) + '\n'),
    request: (method: string, params: object) => { const id = ++sid; rpc.feed(J({ id, method, params }) + '\n'); return id; },
    crash: () => rpc.ended(1, 'segfault'),
  };
}

describe('Codex driver', () => {
  const setup = (thread: object = {}) => {
    const srv = fakeServer(method => {
      if (method === 'thread/start') return { thread: { id: 'cx-1' } };
      if (method === 'thread/fork') return { thread: { id: 'cx-fork' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    });
    const h = fakeHost([{ id: 't1', harness: 'codex', ...thread }]);
    const d = new CodexDriver('t1', h.host, new CodexServers(srv.launch));
    return { srv, h, d };
  };

  it('sends the ultra effort through as it is', async () => {
    const { srv, d } = setup();
    await d.send({ text: 'think hard', effort: 'Ultra' });
    expect(srv.got.find(g => g.method === 'turn/start')?.params).toMatchObject({ effort: 'ultra' });
  });

  it('sends the speed as the turn\'s service tier, and nothing when none was set', async () => {
    const { srv, d } = setup();
    await d.send({ text: 'one' });
    expect(srv.got.find(g => g.method === 'turn/start')?.params).not.toHaveProperty('serviceTier');
  });

  it('sends a set speed as the turn\'s service tier', async () => {
    const { srv, d } = setup();
    await d.send({ text: 'fast please', speed: 'priority' });
    expect(srv.got.find(g => g.method === 'turn/start')?.params).toMatchObject({ serviceTier: 'priority' });
  });

  it('starts a thread, links its id, and runs a turn', async () => {
    const { srv, h, d } = setup();
    await d.send({ text: 'hello', model: 'GPT-6.2 Sol', effort: 'High', perm: 'Auto' });
    expect(h.thread('t1').sessionId).toBe('cx-1');
    const got = srv.got.filter(g => g.method !== 'thread/queue/list');
    expect(got.map(g => g.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(got[2].params).toMatchObject({ model: 'gpt-6.2-sol', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(got[3].params).toMatchObject({ threadId: 'cx-1', effort: 'high', input: [{ type: 'text', text: 'hello' }] });
    const clientId = got[3].params.clientUserMessageId;
    expect(h.thread('t1').status).toBe('running');
    // The server echoes the user message (skipped: shown at send), streams, and completes.
    srv.notify('item/started', { threadId: 'cx-1', turnId: 'turn-1', item: { type: 'userMessage', id: 'u1', clientId, content: [] } });
    srv.notify('item/started', { threadId: 'cx-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: '' } });
    srv.notify('item/agentMessage/delta', { threadId: 'cx-1', turnId: 'turn-1', itemId: 'a1', delta: 'Hi' });
    srv.notify('item/completed', { threadId: 'cx-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'Hi there' } });
    srv.notify('turn/completed', { threadId: 'cx-1', turn: { id: 'turn-1', status: 'completed', error: null, durationMs: 2500 } });
    await until(() => h.thread('t1').status === 'idle');
    expect(h.view().map(e => e.t)).toEqual(['user', 'text', 'worked']);
    expect(h.view()[1]).toMatchObject({ id: 'a1', text: 'Hi there' });
  });

  it('answers a command approval and steers a running turn', async () => {
    const { srv, h, d } = setup({ sessionId: 'cx-1' });
    await d.send({ text: 'run tests' });
    expect(srv.got.map(g => g.method)).toContain('thread/resume');
    srv.notify('turn/started', { threadId: 'cx-1', turn: { id: 'turn-1' } });
    const rid = srv.request('item/commandExecution/requestApproval', { threadId: 'cx-1', turnId: 'turn-1', itemId: 'cmd1', command: 'npm test', reason: null });
    await until(() => h.view().some(e => e.t === 'approval'));
    expect(h.thread('t1').status).toBe('wait');
    await d.answer('cmd1', 'acceptForSession');
    await until(() => srv.responses.has(rid));
    expect(srv.responses.get(rid)).toEqual({ decision: 'acceptForSession' });
    expect(h.view().find(e => e.id === 'ap-cmd1')).toMatchObject({ t: 'notice', text: 'Always allowed: npm test' });
    await d.send({ text: 'also lint' });
    expect(srv.got.at(-1)).toMatchObject({ method: 'turn/steer', params: { expectedTurnId: 'turn-1' } });
  });

  it("queues on Codex's own queue, mirrors it, steers one in, and pauses after a stop", async () => {
    // a server keeping a queue the way the app-server does (thread/queue/*), announcing each change
    let q: { id: string; input: unknown[]; clientUserMessageId: string }[] = [], n = 0;
    const srv: ReturnType<typeof fakeServer> = fakeServer((method, p) => {
      const P = p as { input?: unknown[]; clientUserMessageId?: string; queuedSubmissionId?: string; queuedSubmissionIds?: string[] };
      const changed = () => queueMicrotask(() => srv.notify('thread/queue/changed', { threadId: 'cx-1' }));
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'thread/queue/list') return { data: q, nextCursor: null };
      if (method === 'thread/queue/add') { const s = { id: 'q' + ++n, input: P.input!, clientUserMessageId: P.clientUserMessageId! }; q.push(s); changed(); return { queuedSubmission: s }; }
      if (method === 'thread/queue/delete') { q = q.filter(x => x.id !== P.queuedSubmissionId); changed(); return { deleted: true }; }
      if (method === 'thread/queue/update') { q = q.map(x => (x.id === P.queuedSubmissionId ? { ...x, input: P.input! } : x)); changed(); return {}; }
      if (method === 'thread/queue/reorder') { q = P.queuedSubmissionIds!.map(i => q.find(x => x.id === i)!); changed(); return {}; }
      return {};
    });
    const h = fakeHost([{ id: 't1', harness: 'codex', sessionId: 'cx-1' }]);
    const d = new CodexDriver('t1', h.host, new CodexServers(srv.launch));
    await d.send({ text: 'first' });
    srv.notify('turn/started', { threadId: 'cx-1', turn: { id: 'turn-1' } });
    await d.send({ text: 'second', queue: true });
    await d.send({ text: 'third', queue: true });
    await until(() => h.thread('t1').queue?.length === 2);
    expect(h.thread('t1').queue!.map(x => x.text)).toEqual(['second', 'third']);
    expect(h.view().filter(e => e.t === 'user').map(e => (e as { text: string }).text)).toEqual(['first']);   // queued ones show when they start
    const [a, b] = h.thread('t1').queue!.map(x => x.id);
    await d.editQueued(b, 'third, edited');
    await d.orderQueue([b, a]);
    await until(() => h.thread('t1').queue![0].text === 'third, edited');
    // steer: into the running turn now, and out of the queue
    await d.steerQueued(a);
    expect(srv.got.find(g => g.method === 'turn/steer')?.params).toMatchObject({ expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'second' }] });
    await until(() => h.thread('t1').queue?.length === 1);
    expect(h.view().filter(e => e.t === 'user').map(e => (e as { text: string }).text)).toEqual(['first', 'second']);
    // a stop pauses it; resume starts the next
    srv.notify('turn/completed', { threadId: 'cx-1', turn: { id: 'turn-1', status: 'interrupted', error: null, durationMs: 10 } });
    await until(() => h.thread('t1').queuePaused === true);
    await d.resumeQueue();
    expect(srv.got.at(-1)).toMatchObject({ method: 'thread/queue/start', params: { threadId: 'cx-1' } });
    srv.notify('turn/started', { threadId: 'cx-1', turn: { id: 'turn-2' } });
    await until(() => h.thread('t1').queuePaused === false);
    await d.dropQueued(b);
    await until(() => h.thread('t1').queue?.length === 0);
  });

  it('continues a stopped turn: a turn with no input and a Continued note, live and in history', async () => {
    const { srv, h, d } = setup({ sessionId: 'cx-1' });
    await d.send({ text: '', resume: true });
    expect(srv.got.find(g => g.method === 'turn/start')?.params).toMatchObject({ threadId: 'cx-1', input: [] });
    expect(h.view().filter(e => e.t === 'user')).toHaveLength(0);
    expect(h.view().at(-1)).toMatchObject({ t: 'notice', id: 'c-turn-1', text: 'Continued' });
    const user = (id: string) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text: 'go', text_elements: [] }] });
    const turns = [
      { id: 'a', status: 'interrupted', error: null, durationMs: 10, items: [user('u1')] },
      { id: 'b', status: 'completed', error: null, durationMs: 10, items: [{ type: 'agentMessage', id: 'm1', text: 'ok' }] },
      { id: 'c', status: 'completed', error: null, durationMs: 10, items: [{ type: 'agentMessage', id: 'm2', text: 'ok' }] },   // not after a stop: no note
    ];
    expect(turnEvents(turns as never).events.filter(e => e.t === 'notice')).toEqual([{ t: 'notice', id: 'c-b', text: 'Continued' }]);
  });

  it('records the model and effort Codex resumed a thread with when the thread has none', async () => {
    const srv = fakeServer(method => (method === 'thread/resume' ? { thread: { id: 'cx-old' }, model: 'gpt-5.2', reasoningEffort: 'low' } : method === 'turn/start' ? { turn: { id: 'turn-1' } } : {}));
    const h = fakeHost([{ id: 'o', harness: 'codex', sessionId: 'cx-old' }, { id: 'p', harness: 'codex', sessionId: 'cx-pick', model: 'gpt-6.2-sol', effort: 'high' }]);
    const servers = new CodexServers(srv.launch);
    await new CodexDriver('o', h.host, servers).send({ text: 'follow up' });
    expect(h.thread('o')).toMatchObject({ model: 'gpt-5.2', effort: 'low' });
    // a thread whose model was picked keeps it
    await new CodexDriver('p', h.host, servers).send({ text: 'go' });
    expect(h.thread('p')).toMatchObject({ model: 'gpt-6.2-sol', effort: 'high' });
  });

  it('forks a side chat through the parent turn and reports failures by kind', async () => {
    const srv = fakeServer(method => (method === 'thread/fork' ? { thread: { id: 'cx-fork' } } : method === 'turn/start' ? { turn: { id: 'turn-9' } } : method === 'thread/read' ? { thread: { id: 'cx-parent', turns: turnsFixture } } : {}));
    const h = fakeHost([{ id: 'p', harness: 'codex', sessionId: 'cx-parent' }, { id: 's', harness: 'codex', parent: { id: 'p', at: 'msg_1' }, side: true }]);
    const d = new CodexDriver('s', h.host, new CodexServers(srv.launch));
    await d.send({ text: 'side' });
    // forked through the turn that holds the message it branched from, found in the parent's history
    expect(srv.got.find(g => g.method === 'thread/fork')?.params).toMatchObject({ threadId: 'cx-parent', lastTurnId: 'turn1' });
    expect(h.thread('s').sessionId).toBe('cx-fork');
    srv.notify('turn/completed', { threadId: 'cx-fork', turn: { id: 'turn-9', status: 'failed', durationMs: 10, error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
    await until(() => h.view().some(e => e.t === 'error'));
    expect(h.view().find(e => e.t === 'error')).toMatchObject({ kind: 'rate' });
    expect(h.thread('s').status).toBe('error');
  });

  it('shows a crash and starts a new server on the next send', async () => {
    const { srv, h, d } = setup({ sessionId: 'cx-1' });
    await d.send({ text: 'go' });
    srv.crash();
    await until(() => h.view().some(e => e.t === 'error'));
    expect(h.view().find(e => e.t === 'error')).toMatchObject({ kind: 'crash' });
    await d.send({ text: 'again' });
    expect(srv.got.filter(g => g.method === 'initialize').length).toBe(2);
  });
});

// The real CLI, when it is installed: the app-server starts, a thread is created, and a turn without an
// account fails with an 'auth' row rather than hanging.
describe.skipIf(!which('codex') || !process.env.SKEIN_REAL_CODEX)('real codex app-server', () => {
  it('starts, creates a thread, and reports a missing login as auth', async () => {
    const h = fakeHost([{ id: 't1', harness: 'codex', dir: process.cwd() }]);
    const servers = new CodexServers(launchAppServer);
    const d = new CodexDriver('t1', h.host, servers);
    await d.send({ text: 'hi' });
    expect(h.thread('t1').sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await d.attachArgs())?.args[0]).toBe('--remote');
    await until(() => h.view().some(e => e.t === 'error'), 60_000);
    expect(h.view().find(e => e.t === 'error')).toMatchObject({ kind: 'auth' });
    servers.dispose();
  }, 90_000);
});

// A sub-agent is a Codex thread of its own (collabAgentToolCall spawnAgent → receiverThreadIds).
describe('Codex sub-agents', () => {
  const spawn = (states: object = { 'cx-child': { status: 'running', message: null } }) => ({ type: 'collabAgentToolCall', id: 'sp1', tool: 'spawnAgent', status: 'completed', senderThreadId: 'cx-1', receiverThreadIds: ['cx-child'], prompt: 'Run the tests', model: 'gpt-5.2', reasoningEffort: null, agentsStates: states });
  const wait = { type: 'collabAgentToolCall', id: 'w1', tool: 'wait', status: 'completed', senderThreadId: 'cx-1', receiverThreadIds: ['cx-child'], prompt: null, model: null, reasoningEffort: null, agentsStates: { 'cx-child': { status: 'completed', message: 'ok' } } };

  it('history: the spawn is a sub event that takes follow-ups; a later wait reports how it ended', () => {
    const { events } = turnEvents([{ id: 'turn1', status: 'completed', error: null, durationMs: 10, items: [spawn(), wait] }] as never);
    expect(events).toEqual([{ t: 'sub', id: 'sp1', name: 'Agent (gpt-5.2)', task: 'Run the tests', status: 'done', agent: 'cx-child', followUps: true }]);
  });

  it("reads its turns from its own thread, streams them into its event, and sends follow-ups to that thread", async () => {
    const srv = fakeServer(method => (method === 'turn/start' ? { turn: { id: 'turn-x' } } : method === 'thread/read' ? { thread: { turns: [{ id: 'turn1', status: 'completed', error: null, durationMs: 10, items: [spawn()] }] } } : {}));
    const servers = new CodexServers(srv.launch);
    const h = fakeHost([{ id: 't1', harness: 'codex', sessionId: 'cx-1' }]);
    const d = new CodexDriver('t1', h.host, servers);
    await d.send({ text: 'spawn one' });
    srv.notify('item/completed', { threadId: 'cx-1', turnId: 'turn-x', item: spawn() });
    await until(() => h.view().some(e => e.t === 'sub'));
    // its own thread's items go to its event; its approvals come to this thread's chat, marked as its
    srv.notify('turn/started', { threadId: 'cx-child', turn: { id: 'ct1' } });
    srv.notify('item/completed', { threadId: 'cx-child', turnId: 'ct1', item: { type: 'agentMessage', id: 'cm1', text: 'Tests pass.' } });
    await until(() => !!(h.view().find(e => e.t === 'sub') as { events?: unknown[] }).events?.length);
    srv.request('item/commandExecution/requestApproval', { threadId: 'cx-child', turnId: 'ct1', itemId: 'cmd9', command: 'npm test', reason: null });
    await until(() => h.view().some(e => e.t === 'approval'));
    expect(h.view().find(e => e.t === 'approval')).toMatchObject({ request: { from: 'Agent (gpt-5.2)' } });
    // a follow-up while its turn runs steers it; after the turn, it starts a new one on the sub-agent's thread
    await d.send({ text: 'and lint?', sub: 'sp1' });
    expect(srv.got.at(-1)).toMatchObject({ method: 'turn/steer', params: { threadId: 'cx-child', expectedTurnId: 'ct1' } });
    srv.notify('turn/completed', { threadId: 'cx-child', turn: { id: 'ct1', status: 'completed', error: null, durationMs: 5 } });
    await until(() => (h.view().find(e => e.t === 'sub') as { status: string }).status === 'done');
    await d.send({ text: 'one more', sub: 'sp1' });
    expect(srv.got.filter(g => g.params?.threadId === 'cx-child').map(g => g.method)).toEqual(['thread/resume', 'turn/steer', 'turn/start']);
    const sub = h.view().find(e => e.t === 'sub') as { status: string; events: { t: string; text?: string }[] };
    expect(sub.status).toBe('running');
    expect(sub.events.map(e => e.text)).toEqual(['Tests pass.', 'and lint?', 'one more']);
  });

  it('a history-loaded sub-agent: its thread is found through the parent when the driver has not seen it', async () => {
    const srv = fakeServer(method => (method === 'thread/read' ? { thread: { turns: [{ id: 'turn1', status: 'completed', error: null, durationMs: 10, items: [spawn()] }] } } : method === 'turn/start' ? { turn: { id: 'tx' } } : {}));
    const h = fakeHost([{ id: 't1', harness: 'codex', sessionId: 'cx-1' }]);
    const d = new CodexDriver('t1', h.host, new CodexServers(srv.launch));
    await d.send({ text: 'hi', sub: 'sp1' });
    expect(srv.got.at(-1)).toMatchObject({ method: 'turn/start', params: { threadId: 'cx-child', input: [{ type: 'text', text: 'hi' }] } });
    await expect(d.send({ text: 'hi', sub: 'nope' })).rejects.toThrow(/Follow-ups aren't available/);
  });
});
