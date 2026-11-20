import { describe, expect, it } from 'vitest';
import { which } from '../../shell';
import { fakeHost, until } from '../test/fakes';
import { CodexDriver, CodexServers, launchAppServer, type Launch } from './driver';
import { codexHistory, turnEvents } from './history';
import { itemEvents } from './items';
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

describe('Codex history', () => {
  it('maps the app-server turns through the same items as the live driver, with the live ids', () => {
    const { events, turnOf } = turnEvents(turnsFixture as never);
    expect(events.map(e => e.t)).toEqual(['user', 'thinking', 'tool', 'edit', 'text', 'worked', 'user', 'interrupted', 'worked', 'error']);
    // a message Skein sent keeps the id it was shown under (its client id); one typed elsewhere has the item id
    expect(events[0]).toMatchObject({ id: 'c1', text: 'list files' });
    expect(events[6]).toMatchObject({ id: 'u2' });
    expect(events[2]).toMatchObject({ t: 'tool', name: 'Shell', out: 'a\nb', status: 'done' });
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

  it('starts a thread, links its id, and runs a turn', async () => {
    const { srv, h, d } = setup();
    await d.send({ text: 'hello', model: 'GPT-6.2 Sol', effort: 'High', perm: 'Auto' });
    expect(h.thread('t1').sessionId).toBe('cx-1');
    expect(srv.got.map(g => g.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(srv.got[2].params).toMatchObject({ model: 'gpt-6.2-sol', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(srv.got[3].params).toMatchObject({ threadId: 'cx-1', effort: 'high', input: [{ type: 'text', text: 'hello' }] });
    const clientId = srv.got[3].params.clientUserMessageId;
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
