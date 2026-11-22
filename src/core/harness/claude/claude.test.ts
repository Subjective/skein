import { describe, expect, it } from 'vitest';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { fakeHost, tick, until } from '../test/fakes';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine, ThreadEvent } from '../../../shared/types';
import { approvalFor, ClaudeDriver, type QueryFn } from './driver';
import { userText } from './fold';
import { claudeSubHistory, currentChain, parseClaudeTranscript } from './history';

const J = (o: object) => JSON.stringify(o);
const asst = (uuid: string, parent: string, msgId: string, block: object, ts = '2026-11-20T10:00:05Z') =>
  J({ type: 'assistant', uuid, parentUuid: parent, timestamp: ts, message: { id: msgId, role: 'assistant', content: [block] } });
const user = (uuid: string, parent: string | null, content: unknown, extra: object = {}, ts = '2026-11-20T10:00:00Z') =>
  J({ type: 'user', uuid, parentUuid: parent, timestamp: ts, message: { role: 'user', content }, ...extra });

const transcript = [
  J({ type: 'summary', summary: 'Fix tests' }),
  user('u1', null, 'Fix the failing test'),
  asst('a1', 'u1', 'm1', { type: 'thinking', thinking: 'Look at the test first.' }),
  asst('a2', 'a1', 'm1', { type: 'text', text: 'Running the tests.' }),
  asst('a3', 'a2', 'm1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }),
  user('r1', 'a3', [{ type: 'tool_result', tool_use_id: 'tu1', content: '1 failing', is_error: false }]),
  asst('a4', 'r1', 'm2', { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' } }),
  user('r2', 'a4', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }]),
  asst('a5', 'r2', 'm3', { type: 'text', text: 'Fixed.' }, '2026-11-20T10:00:09Z'),
  // An abandoned branch: an older reply that was edited away.
  user('old', 'a5', 'first try', {}, '2026-11-20T10:01:00Z'),
  asst('oldr', 'old', 'm4', { type: 'text', text: 'old answer' }),
  // The current branch: the user edited "first try" into "second try".
  user('u2', 'a5', '<command-name>/compact</command-name><command-args>keep tests</command-args>', {}, '2026-11-20T10:02:00Z'),
  J({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: 'u2' }),
  user('meta', 'c1', 'injected', { isMeta: true }),
  user('u3', 'meta', [{ type: 'text', text: 'Now add a test' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }], {}, '2026-11-20T10:03:00Z'),
  user('int', 'u3', [{ type: 'text', text: '[Request interrupted by user]' }]),
  J({ type: 'last-prompt', leafUuid: 'int' }),
].join('\n');

describe('Claude history', () => {
  it('follows the current branch, not the file order', () => {
    const ids = currentChain(transcript.split('\n').map(l => JSON.parse(l))).map(e => e.uuid);
    expect(ids).toContain('u2');
    expect(ids).not.toContain('old');
    expect(ids).not.toContain('oldr');
  });

  it('folds messages into events with stable ids', () => {
    const { events, fold } = parseClaudeTranscript(transcript);
    expect(events.map(e => e.t)).toEqual(['user', 'thinking', 'text', 'tool', 'edit', 'text', 'worked', 'user', 'notice', 'user', 'interrupted']);
    expect(events[0]).toMatchObject({ t: 'user', id: 'u1', text: 'Fix the failing test' });
    expect(events[1]).toMatchObject({ id: 'm1:0', text: 'Look at the test first.' });
    expect(events[2]).toMatchObject({ id: 'm1:1', text: 'Running the tests.' });
    expect(events[3]).toMatchObject({ t: 'tool', id: 'tu1', name: 'Bash', kind: 'command', arg: 'npm test', out: '1 failing', status: 'done' });
    expect(events[4]).toMatchObject({ t: 'edit', id: 'tu2', path: '/p/a.ts', add: 2, del: 1, status: 'done' });
    expect(events[6]).toMatchObject({ t: 'worked', ms: 9000 });
    expect(events[7]).toMatchObject({ t: 'user', text: '/compact keep tests' });
    expect(events[9]).toMatchObject({ t: 'user', id: 'u3', text: 'Now add a test', images: ['data:image/png;base64,AAA'] });
    // Fork points and rewind points.
    expect(fold.uuidOf.get('m1:1')).toBe('a2');
    expect(fold.uuidOf.get('tu1')).toBe('r1');
    expect(fold.before.get('u3')).toBe('meta');
    expect(fold.before.get('u1')).toBe(null);
  });

  it('hides harness-injected user text', () => {
    expect(userText('<system-reminder>x</system-reminder>')).toBeNull();
    expect(userText('<local-command-stdout>hi</local-command-stdout>')).toBeNull();
    expect(userText('hello <system-reminder>x</system-reminder>')).toBe('hello');
  });
});

describe('approval cards', () => {
  it('describes commands, edits, plans and questions', () => {
    expect(approvalFor('Bash', { command: 'rm -rf build' }, 'r1')).toMatchObject({ kind: 'command', body: 'rm -rf build', options: [{ id: 'allow', primary: true }, { id: 'deny' }] });
    expect(approvalFor('Bash', { command: 'x' }, 'r1', { suggestions: [{}] }).options.map(o => o.id)).toEqual(['allow', 'always', 'deny']);
    expect(approvalFor('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' }, 'r2')).toMatchObject({ kind: 'edit', title: 'Edit b.ts?' });
    expect(approvalFor('ExitPlanMode', { plan: '1. do it' }, 'r3')).toMatchObject({ kind: 'plan', body: '1. do it' });
    const q = approvalFor('AskUserQuestion', { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }, 'r4');
    expect(q.options.map(o => o.label)).toEqual(['Postgres', 'SQLite', 'Skip']);
  });
});

/** A scripted stand-in for the Agent SDK: each user message runs `turn`, which yields SDK messages. */
function fakeSdk(turn: (msg: SDKUserMessage, opts: Options, n: number) => AsyncGenerator<SDKMessage>) {
  const calls: Options[] = [], flags: Record<string, unknown>[] = [];
  let interrupted = false;
  const query: QueryFn = ({ prompt, options }) => {
    calls.push(options!);
    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'init', session_id: options!.sessionId ?? options!.resume ?? 'sess', uuid: 'init' } as never;
      let n = 0;
      for await (const m of prompt) { interrupted = false; yield* turn(m, options!, n++); }
    }
    const gen = run() as unknown as Query;
    Object.assign(gen, {
      interrupt: async () => { interrupted = true; },
      setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async (f: Record<string, unknown>) => { flags.push(f); },
      getContextUsage: async () => ({ totalTokens: 24_000, maxTokens: 180_000, rawMaxTokens: 200_000, percentage: 12, isAutoCompactEnabled: true, autoCompactThreshold: 167_000 }),
      close: () => {},
    });
    return gen;
  };
  return { query, calls, flags, get interrupted() { return interrupted; } };
}

const result = (ms = 1500): SDKMessage => ({ type: 'result', subtype: 'success', duration_ms: ms, is_error: false, result: 'ok' } as never);

describe('Claude driver', () => {
  it('sends Ultracode: at start as a session setting, then with the effort, since an effort alone turns it off', async () => {
    const sdk = fakeSdk(async function* () { yield result(); });
    const h = fakeHost([{ id: 't1', sessionId: '11111111-1111-1111-1111-111111111111' }]);
    const d = new ClaudeDriver('t1', h.host, async () => sdk.query);
    await d.send({ text: 'one', effort: 'Ultra', ultra: true });   // Codex's ultra effort is not Claude's: left out
    await until(() => h.thread('t1').status === 'idle');
    expect(sdk.calls[0].settings).toEqual({ ultracode: true });
    expect(sdk.calls[0].effort).toBeUndefined();
    await d.send({ text: 'two', effort: 'high', ultra: true });
    await until(() => sdk.flags.length === 1);
    expect(sdk.flags[0]).toEqual({ effortLevel: 'high', ultracode: true });
    await d.send({ text: 'three', ultra: false });
    await until(() => sdk.flags.length === 2);
    expect(sdk.flags[1]).toEqual({ ultracode: false });
    await d.send({ text: 'four' });   // no ultra key: what the driver has stays, nothing to send
    await tick(30);
    expect(sdk.flags).toHaveLength(2);
    await d.release();
  });

  it('runs a turn: user echo, streaming text, final text, worked, idle', async () => {
    const sdk = fakeSdk(async function* () {
      yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null } as never;
      yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, parent_tool_use_id: null } as never;
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }, parent_tool_use_id: null } as never;
      await tick(80);
      yield { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] }, parent_tool_use_id: null } as never;
      yield result();
    });
    const h = fakeHost([{ id: 't1', sessionId: '11111111-1111-1111-1111-111111111111' }]);
    const d = new ClaudeDriver('t1', h.host, async () => sdk.query);
    await d.send({ text: 'Say hello', model: 'Sonnet 5.5', perm: 'Accept edits' });
    await until(() => h.thread('t1').status === 'idle' && h.statuses.includes('running'));
    const v = h.view();
    expect(v[0]).toMatchObject({ t: 'user', text: 'Say hello' });
    expect(v[1]).toMatchObject({ t: 'text', id: 'm1:0', text: 'Hello' });
    expect(v.find(e => e.t === 'worked')).toMatchObject({ ms: 1500 });
    expect(h.events.some(x => x.e.t === 'text' && x.e.streaming && x.e.text === 'Hel')).toBe(true);
    expect(sdk.calls[0]).toMatchObject({ model: 'sonnet', permissionMode: 'acceptEdits', sessionId: '11111111-1111-1111-1111-111111111111', includePartialMessages: true });
    expect(h.thread('t1').title).toBe('Say hello');
    // after the turn, Claude Code's own context count: used of the full window, and where it auto-compacts
    await until(() => h.thread('t1').ctxTokens != null);
    expect(h.thread('t1')).toMatchObject({ ctx: 12, ctxTokens: { used: 24_000, max: 200_000, compactAt: 167_000 } });
    await d.release();
  });

  it('keeps a queue: each waits for the turn before it, can be edited, reordered, steered, and a stop pauses it', async () => {
    const got: string[] = [];
    let open: (() => void)[] = [];
    const sdk = fakeSdk(async function* (m) {
      const c = (m.message as { content: { type: string; text?: string }[] }).content;
      got.push(c.find(x => x.type === 'text')?.text ?? '');
      await new Promise<void>(r => open.push(r));   // the turn runs until the test lets it end
      yield sdk.interrupted ? ({ type: 'result', subtype: 'error_during_execution', duration_ms: 10, is_error: true, errors: ['interrupted'] } as never) : result(10);
    });
    const end = async () => { await until(() => open.length > 0); const f = open; open = []; f.forEach(r => r()); };
    const h = fakeHost([{ id: 't1', sessionId: '33333333-3333-3333-3333-333333333333' }]);
    const d = new ClaudeDriver('t1', h.host, async () => sdk.query);
    const texts = () => h.thread('t1').queue?.map(x => x.text);
    await d.send({ text: 'one' });
    await until(() => h.thread('t1').status === 'running');
    await d.send({ text: 'two', queue: true });
    await d.send({ text: 'three', queue: true });
    await d.send({ text: 'four', queue: true });
    expect(texts()).toEqual(['two', 'three', 'four']);
    expect(h.view().filter(e => e.t === 'user')).toHaveLength(1);   // queued ones show when they start
    const [two, three, four] = h.thread('t1').queue!.map(x => x.id);
    await d.editQueued(three, 'three, edited');
    await d.orderQueue([three, two, four]);
    expect(texts()).toEqual(['three, edited', 'two', 'four']);
    await d.dropQueued(four);
    // the turn ends: the head starts as a turn of its own
    await end();
    await until(() => got.length === 2);
    expect(got).toEqual(['one', 'three, edited']);
    expect(texts()).toEqual(['two']);
    // a stop pauses the queue; resume starts the next
    await d.interrupt();
    await end();
    await until(() => h.thread('t1').queuePaused === true);
    expect(got).toHaveLength(2);
    await d.resumeQueue();
    await until(() => got.length === 3);
    expect(got[2]).toBe('two');
    expect(h.thread('t1')).toMatchObject({ queue: [], queuePaused: false });
    // steer: sent now, not queued
    await d.send({ text: 'five', queue: true });
    await d.steerQueued(h.thread('t1').queue![0].id);
    expect(texts()).toEqual([]);
    expect(h.view().filter(e => e.t === 'user').at(-1)).toMatchObject({ text: 'five' });
    await end(); await end();
    await until(() => got.length === 4 && h.thread('t1').status === 'idle');
    await d.release();
  });

  it('turns a permission prompt into an approval card and answers it', async () => {
    let decision: unknown;
    const sdk = fakeSdk(async function* (_m, opts) {
      decision = await opts.canUseTool!('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'tu9', suggestions: [] } as never);
      yield result(200);
    });
    const h = fakeHost([{ id: 't1', sessionId: '22222222-2222-2222-2222-222222222222' }]);
    const d = new ClaudeDriver('t1', h.host, async () => sdk.query);
    await d.send({ text: 'test it' });
    await until(() => h.view().some(e => e.t === 'approval'));
    expect(h.thread('t1').status).toBe('wait');
    const card = h.view().find(e => e.t === 'approval')!;
    expect(card).toMatchObject({ id: 'ap-tu9', request: { kind: 'command', body: 'npm test' } });
    await d.answer('tu9', 'allow');
    await until(() => h.thread('t1').status === 'idle');
    expect(decision).toMatchObject({ behavior: 'allow' });
    expect(h.view().find(e => e.id === 'ap-tu9')).toMatchObject({ t: 'notice', text: 'Allowed: npm test' });
    await d.release();
  });

  it('reports a crash with the error kind and restarts on the next send', async () => {
    let starts = 0;
    const query: QueryFn = p => {
      starts++;
      const first = starts === 1;
      async function* run(): AsyncGenerator<SDKMessage> {
        for await (const _m of p.prompt) {
          if (first) throw new Error('Claude Code process exited with code 1: Invalid API key · Please run /login');
          yield result();
        }
      }
      return Object.assign(run(), { interrupt: async () => {}, close: () => {}, setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {}, getContextUsage: async () => ({ totalTokens: 0, rawMaxTokens: 200_000, isAutoCompactEnabled: false }) }) as unknown as Query;
    };
    const h = fakeHost([{ id: 't1', sessionId: '33333333-3333-3333-3333-333333333333' }]);
    const d = new ClaudeDriver('t1', h.host, async () => query);
    await d.send({ text: 'hi' });
    await until(() => h.view().some(e => e.t === 'error'));
    expect(h.view().find(e => e.t === 'error')).toMatchObject({ kind: 'auth' });
    expect(h.thread('t1').status).toBe('error');
    await d.send({ text: 'again' });
    await until(() => h.thread('t1').status === 'idle');
    expect(starts).toBe(2);
    await d.release();
  });

  it('forks a side chat from the parent session at the chosen event', async () => {
    const sdk = fakeSdk(async function* () { yield result(); });
    const h = fakeHost([
      { id: 'p', sessionId: 'parent-session' },
      { id: 's', sessionId: '44444444-4444-4444-4444-444444444444', parent: { id: 'p', at: 'm1:1' }, side: true },
    ]);
    // No transcript exists for either id on this machine, so the fork falls back to a fresh session with its id.
    const d = new ClaudeDriver('s', h.host, async () => sdk.query);
    await d.send({ text: 'side question' });
    await until(() => h.thread('s').status === 'idle');
    expect(sdk.calls[0].sessionId).toBe('44444444-4444-4444-4444-444444444444');
    expect(sdk.calls[0].resume).toBeUndefined();
    await d.release();
  });

  it('release waits for the running turn to end', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(r => (finish = r));
    const sdk = fakeSdk(async function* () { await gate; yield result(); });
    const h = fakeHost([{ id: 't1', sessionId: '55555555-5555-5555-5555-555555555555' }]);
    const d = new ClaudeDriver('t1', h.host, async () => sdk.query);
    await d.send({ text: 'long job' });
    let released = false;
    const r = d.release().then(() => { released = true; });
    await tick(30);
    expect(released).toBe(false);
    finish();
    await r;
    expect(released).toBe(true);
  });
});

// Shapes from a real run (Claude Code 2026-11): the Agent tool launches the subagent in the background, its own
// transcript is <session>/subagents/agent-<agentId>.jsonl (a sidechain) beside a .meta.json naming the tool call,
// and a <task-notification> message in the session says when it ended.
describe('Claude subagents', () => {
  const agentCall = { type: 'tool_use', id: 'tuA', name: 'Agent', input: { description: 'Count files', subagent_type: 'general-purpose', prompt: 'Run ls /etc and report the names.' } };
  const launched = { isAsync: true, status: 'async_launched', agentId: 'a08', description: 'Count files' };
  const note = '<task-notification>\n<task-id>a08</task-id>\n<tool-use-id>tuA</tool-use-id>\n<status>completed</status>\n<summary>Agent "Count files" finished</summary>\n<usage><subagent_tokens>21890</subagent_tokens><tool_uses>1</tool_uses><duration_ms>1426</duration_ms></usage>\n</task-notification>';
  const session = [
    user('u1', null, 'Count the files with a subagent'),
    asst('a1', 'u1', 'm1', agentCall),
    user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 'tuA', content: 'Async agent launched successfully.' }], { toolUseResult: launched }),
    asst('a2', 'r1', 'm2', { type: 'text', text: 'It is running.' }),
    user('n1', 'a2', note, { origin: { kind: 'task-notification' } }),
    asst('a3', 'n1', 'm3', { type: 'text', text: 'Done.' }),
  ].join('\n');
  const side = (o: string) => ({ ...JSON.parse(o), isSidechain: true, agentId: 'a08' });
  const subTranscript = [
    side(user('s1', null, 'Run ls /etc and report the names.')),
    side(asst('s2', 's1', 'sm1', { type: 'tool_use', id: 'tuB', name: 'Bash', input: { command: 'ls /etc | head -3' } })),
    side(user('s3', 's2', [{ type: 'tool_result', tool_use_id: 'tuB', content: 'X11', is_error: false }])),
    side(asst('s4', 's3', 'sm2', { type: 'text', text: 'It printed X11.' })),
  ];

  it('history: a background subagent runs until its task notification, which the transcript does not show', () => {
    const { events } = parseClaudeTranscript(session);
    const sub = events.find(e => e.t === 'sub');
    expect(sub).toMatchObject({ id: 'tuA', name: 'general-purpose', task: 'Count files', status: 'done', dur: '1s', agent: 'a08' });
    expect(events.filter(e => e.t === 'user').map(e => (e as { text: string }).text)).toEqual(['Count the files with a subagent']);
    const running = parseClaudeTranscript(session.split('\n').slice(0, 4).join('\n')).events.find(e => e.t === 'sub');
    expect(running).toMatchObject({ status: 'running', agent: 'a08' });
  });

  it("history: a subagent's own transcript folds into its turns, its prompt under the id the live stream gives it", () => {
    const { events } = parseClaudeTranscript(subTranscript, 'tuA');
    expect(events.map(e => [e.t, e.id])).toEqual([['user', 'p-tuA'], ['tool', 'tuB'], ['text', 'sm2:0']]);
    expect(events[1]).toMatchObject({ name: 'Bash', out: 'X11', status: 'done' });
  });

  it('reads the transcript by agentId, or finds it through the .meta.json that names the tool call', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skein-sub-'));
    const dir = join(home, '.claude', 'projects', '-p', 'sess', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-a08.jsonl'), subTranscript.map(o => JSON.stringify(o)).join('\n'));
    writeFileSync(join(dir, 'agent-a08.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'tuA' }));
    writeFileSync(join(dir, 'agent-zz.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tuOther' }));
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CFG: process.env.CLAUDE_CONFIG_DIR };
    process.env.HOME = process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const local = { id: 'local', name: 'This computer' } as Machine;
      expect((await claudeSubHistory(local, 'sess', 'tuA', 'a08')).map(e => e.id)).toEqual(['p-tuA', 'tuB', 'sm2:0']);
      expect((await claudeSubHistory(local, 'sess', 'tuA')).map(e => e.id)).toEqual(['p-tuA', 'tuB', 'sm2:0']);
      expect(await claudeSubHistory(local, 'sess', 'tuNone')).toEqual([]);
    } finally {
      for (const [k, v] of [['HOME', was.HOME], ['USERPROFILE', was.USERPROFILE], ['CLAUDE_CONFIG_DIR', was.CFG]] as const) if (v == null) delete process.env[k]; else process.env[k] = v;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('live: subagent messages (parent_tool_use_id) stream into its event; the task notification ends it', async () => {
    const msgs = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [agentCall] }, parent_tool_use_id: null },
      { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuA', content: 'launched' }] }, tool_use_result: launched, parent_tool_use_id: null },
      { type: 'assistant', uuid: 's2', message: { id: 'sm1', content: [{ type: 'tool_use', id: 'tuB', name: 'Bash', input: { command: 'ls' } }] }, parent_tool_use_id: 'tuA', agent_id: 'a08' },
      { type: 'user', uuid: 's3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuB', content: 'X11' }] }, parent_tool_use_id: 'tuA', agent_id: 'a08' },
      { type: 'assistant', uuid: 's4', message: { id: 'sm2', content: [{ type: 'text', text: 'It printed X11.' }] }, parent_tool_use_id: 'tuA', agent_id: 'a08' },
      { type: 'system', subtype: 'task_notification', task_id: 'a08', tool_use_id: 'tuA', status: 'completed', output_file: '', summary: '', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 65_000 } },
      { type: 'result', subtype: 'success', duration_ms: 10, is_error: false },
    ];
    let opts: Options | undefined;
    const q: QueryFn = (({ options }: { options: Options }) => { opts = options; return (async function* () { for (const m of msgs) yield m as unknown as SDKMessage; })() as unknown as Query; }) as unknown as QueryFn;
    const h = fakeHost([{ id: 't1', harness: 'claude', sessionId: 's', dir: process.cwd() }]);
    const d = new ClaudeDriver('t1', h.host, async () => q);
    await d.send({ text: 'Count the files with a subagent' });
    await until(() => h.view().some(e => e.t === 'sub' && e.status === 'done'));
    expect(opts?.forwardSubagentText).toBe(true);
    const sub = h.view().find(e => e.t === 'sub') as Extract<ThreadEvent, { t: 'sub' }>;
    expect(sub).toMatchObject({ agent: 'a08', dur: '1m 5s' });
    // the same ids history gives, so the popup merges the two without doubles
    expect(sub.events?.map(e => [e.t, e.id])).toEqual([['user', 'p-tuA'], ['tool', 'tuB'], ['text', 'sm2:0']]);
    await expect(d.send({ text: 'hi', sub: 'tuA' })).rejects.toThrow(/Follow-ups aren't available/);
  });
});
