import { describe, expect, it } from 'vitest';
import { which } from '../../shell';
import { fakeHost, until } from '../test/fakes';
import { CodexDriver, CodexServers, launchAppServer, type Launch } from './driver';
import { parseCodexRollout, patchFiles } from './history';
import { camelItem, itemEvents } from './items';
import { Rpc } from './rpc';

const J = (o: object) => JSON.stringify(o);

describe('Codex rollouts', () => {
  it('reads modern rollouts through the same item mapping as the live driver', () => {
    const text = [
      J({ type: 'session_meta', payload: { id: 'th1', cwd: '/p' } }),
      J({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } }),
      J({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn1', item: { type: 'UserMessage', id: 'i1', client_id: 'c1', content: [{ type: 'text', text: 'list files', text_elements: [] }] } } }),
      J({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn1', item: { type: 'CommandExecution', id: 'i2', command: 'ls', cwd: '/p', status: 'Completed', aggregated_output: 'a\nb', exit_code: 0, duration_ms: 40, command_actions: [], source: 'agent' } } }),
      J({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn1', item: { type: 'FileChange', id: 'i3', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y' }] } } }),
      J({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn1', item: { type: 'AgentMessage', id: 'i4', text: 'Two files.' } } }),
      J({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn1', duration_ms: 4200 } }),
      J({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn2' } }),
    ].join('\n');
    const { events, turnOf } = parseCodexRollout(text);
    expect(events.map(e => e.t)).toEqual(['user', 'tool', 'edit', 'text', 'worked', 'interrupted']);
    expect(events[0]).toMatchObject({ id: 'i1', text: 'list files' });
    expect(events[1]).toMatchObject({ t: 'tool', name: 'Shell', arg: 'ls', out: 'a\nb', status: 'done' });
    expect(events[2]).toMatchObject({ t: 'edit', path: 'a.ts', add: 1, del: 1 });
    expect(turnOf.get('i1')).toBe('turn1');
  });

  // The shapes codex 0.171 writes (the core's items, not the app-server's): a message's text in content, reasoning
  // as summary_text, a command as argv with a secs / nanos duration, file changes keyed by path.
  it('reads the core item shapes current rollouts store', () => {
    const item = (turn: string, it: object) => J({ type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: it } });
    const text = [
      item('t1', { type: 'UserMessage', id: 'u1', client_id: 'c1', content: [{ type: 'text', text: 'hello codex', text_elements: [] }] }),
      item('t1', { type: 'Reasoning', id: 'rs_1', summary_text: ['Thinking about it.'], raw_content: [] }),
      item('t1', { type: 'AgentMessage', id: 'msg_1', content: [{ type: 'Text', text: 'Hello ' }, { type: 'Text', text: 'there.' }] }),
      item('t1', { type: 'CommandExecution', id: 'x1', command: ['/bin/bash', '-lc', 'touch a && echo made'], cwd: 'file:///p', status: 'completed', aggregated_output: 'made\n', exit_code: 0, duration: { secs: 1, nanos: 500_000_000 } }),
      item('t1', { type: 'FileChange', id: 'f1', changes: { '/p/my_file.txt': { type: 'add', content: 'one\ntwo\n' }, '/p/old_name.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y', move_path: null } }, status: 'completed' }),
      item('t1', { type: 'Plan', id: 'p1', text: '1. do it' }),
      item('t1', { type: 'SomethingNew', id: 'n1', weird: { nested: 1 } }),
      item('t1', { type: 'AgentMessage', id: 'msg_2' }),
    ].join('\n');
    const { events } = parseCodexRollout(text);
    expect(events.map(e => e.t)).toEqual(['user', 'thinking', 'text', 'tool', 'edit', 'edit', 'text']);
    expect(events[1]).toMatchObject({ text: 'Thinking about it.' });
    expect(events[2]).toMatchObject({ id: 'msg_1', text: 'Hello there.' });
    expect(events[3]).toMatchObject({ arg: 'touch a && echo made', out: 'made\n', status: 'done', meta: '1.5s' });
    expect(events[4]).toMatchObject({ id: 'f1:0', path: '/p/my_file.txt', add: 2, del: 0, diff: '+one\n+two' });
    expect(events[5]).toMatchObject({ id: 'f1:1', path: '/p/old_name.ts', add: 1, del: 1 });
  });

  it('skips an item it cannot read instead of throwing', () => {
    const text = [
      J({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't', item: { type: 'FileChange', id: 'f', changes: 'garbage' } } }),
      J({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't', item: { type: 'AgentMessage', id: 'm', content: [{ type: 'Text', text: 'still here' }] } } }),
    ].join('\n');
    expect(() => parseCodexRollout(text)).not.toThrow();
    expect(parseCodexRollout(text).events).toMatchObject([{ t: 'text', text: 'still here' }]);
  });

  it('reads older rollouts from messages and tool calls', () => {
    const text = [
      J({ type: 'session_meta', payload: { id: 'th1', cwd: '/p' } }),
      J({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }),
      J({ type: 'event_msg', payload: { type: 'user_message', message: 'fix it' } }),
      J({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'thinking' } }),
      J({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: J({ command: ['bash', '-lc', 'npm test'] }) } }),
      J({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: J({ output: 'ok', metadata: {} }) } }),
      J({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n+z\n*** End Patch' } }),
      J({ type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }),
    ].join('\n');
    const { events } = parseCodexRollout(text);
    expect(events.map(e => e.t)).toEqual(['user', 'thinking', 'tool', 'edit', 'text']);
    expect(events[2]).toMatchObject({ arg: 'npm test', out: 'ok', status: 'done' });
    expect(events[3]).toMatchObject({ path: 'a.ts', add: 2, del: 1 });
  });

  it('splits apply_patch bodies per file', () => {
    expect(patchFiles('*** Begin Patch\n*** Add File: n.ts\n+a\n*** Delete File: o.ts\n*** End Patch').map(f => f.path)).toEqual(['n.ts', 'o.ts']);
  });

  it('maps live items, skipping injected context', () => {
    expect(itemEvents(camelItem({ type: 'UserMessage', id: 'x', content: [{ type: 'text', text: '<environment_context>…' }] }))).toEqual([]);
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
    const srv = fakeServer(method => (method === 'thread/fork' ? { thread: { id: 'cx-fork' } } : method === 'turn/start' ? { turn: { id: 'turn-9' } } : {}));
    const h = fakeHost([{ id: 'p', harness: 'codex', sessionId: 'cx-parent' }, { id: 's', harness: 'codex', parent: { id: 'p' }, side: true }]);
    const d = new CodexDriver('s', h.host, new CodexServers(srv.launch));
    await d.send({ text: 'side' });
    expect(srv.got.find(g => g.method === 'thread/fork')?.params).toMatchObject({ threadId: 'cx-parent' });
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
