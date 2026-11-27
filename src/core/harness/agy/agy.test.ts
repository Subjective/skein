import { describe, expect, it } from 'vitest';
import type { Machine } from '../../../shared/types';
import { Rpc } from '../codex/rpc';
import { fakeHost, until } from '../test/fakes';
import { AgyServers, agyHome, type Opened, type Update } from './acp';
import { AgyDriver, imageBlock } from './driver';
import { AgyFold, callEvents, commandOutput, replay } from './fold';
import { agyHistory, agySessions } from './history';
import { agyCommands, agyOptions } from './options';

// Shapes copied from agy 1.5.18 (`agy acp`, 2026-11-26), trimmed.
const CWD = '/tmp/agy-probe/repo';
const writeCall = { toolCallId: 'call_1', name: 'write_file', args: { Content: 'hi', Path: `${CWD}/hello.txt` }, kind: 'edit', title: 'File ../../../../tmp/agy-probe/repo/hello.txt', locations: [{ path: `${CWD}/hello.txt` }], rawInput: { Content: 'hi', Path: `${CWD}/hello.txt` } };
const runCall = { toolCallId: 'call_2', name: 'run_command', args: { CommandLine: 'git status --short', WaitMsBeforeAsync: 5000, toolSummary: 'Git status check' }, kind: 'execute', title: 'git status --short', rawInput: { CommandLine: 'git status --short', WaitMsBeforeAsync: 5000, toolSummary: 'Git status check' } };
const runOutput = { output: 'Created At: 2026-11-25T23:30:06-08:00\nCompleted At: 2026-11-25T23:30:06-08:00\nCommand exited with code 0.\n\nCommand output:\n?? hello.txt\r\n', exit_code: 0 };
const opened = (model = 'gemini-4-neon'): Opened => ({
  models: { currentModelId: model + '-high', availableModels: [
    ...['high', 'xhigh', 'medium', 'low'].map(e => ({ modelId: `gemini-4-neon-${e}`, name: `Gemini 4 Neon (${e})` })),
    ...['medium', 'high', 'low'].map(e => ({ modelId: `gemini-4-carbon-${e}`, name: `Gemini 4 Carbon (${e})` })),
    { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' }, { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ] },
  modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default', description: 'Ask before edits and commands.' }, { id: 'accept-edits', name: 'Accept edits' }, { id: 'auto', name: 'Auto' }, { id: 'plan', name: 'Plan' }] },
  configOptions: [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }, { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' }, { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }] },
    { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [] },
  ],
});

/** A replayed session (session/load), as agy sends it. */
const loadReplay: Update[] = [
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Reply with exactly: hello from agy.' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from agy.' } },
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Create a file hello.txt' } },
  { sessionUpdate: 'tool_call', ...writeCall, status: 'completed', rawOutput: {}, content: [{ type: 'diff', path: `${CWD}/hello.txt`, newText: 'hi' }] } as Update,
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I have created hello.txt' } },
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Run git status' } },
  { sessionUpdate: 'tool_call', ...runCall, status: 'completed', rawOutput: runOutput } as Update,
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The output is ' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '`?? hello.txt`' } },
];

describe('Antigravity steps', () => {
  it('shows a write as an edit with its diff, relative to the thread folder', () => {
    const [e] = callEvents({ ...writeCall, status: 'completed', content: [{ type: 'diff', path: `/private${CWD}/hello.txt`, newText: 'hi' }] } as never, CWD);
    expect(e).toMatchObject({ t: 'edit', id: 'call_1', path: 'hello.txt', add: 1, del: 0, status: 'done' });
    // before agy sends the diff (waiting for approval): the edit, running
    expect(callEvents({ ...writeCall, status: 'pending' } as never, CWD)[0]).toMatchObject({ t: 'edit', path: 'hello.txt', status: 'running' });
  });
  it('shows a command with its output, not agy’s header', () => {
    expect(commandOutput({ ...runCall, rawOutput: runOutput } as never)).toEqual({ out: '?? hello.txt', code: 0 });
    const [e] = callEvents({ ...runCall, status: 'completed', rawOutput: { output: 'Command exited with code 2.\n\nCommand output:\nnope\n', exit_code: 2 } } as never, CWD);
    expect(e).toMatchObject({ t: 'tool', name: 'Shell', kind: 'command', arg: 'git status --short', out: 'nope', meta: 'exit 2', status: 'failed' });
  });
  it('shows reads and other tools by what they do', () => {
    expect(callEvents({ toolCallId: 'r', name: 'read_file', kind: 'read', status: 'completed', rawInput: { Path: `${CWD}/src/a.ts` } } as never, CWD)[0]).toMatchObject({ name: 'Read', arg: 'src/a.ts', kind: 'read' });
    expect(callEvents({ toolCallId: 'b', name: 'browser_subagent', kind: 'other', status: 'in_progress', title: 'Run browser_subagent', rawInput: { Task: 'open the docs' } } as never, CWD)[0]).toMatchObject({ name: 'Browser subagent', arg: 'open the docs', kind: 'other', status: 'running' });
  });
  it('turns agy’s update_steps into the turn’s to-do list, one list per turn', () => {
    const out: { id: string; t: string }[] = [];
    const fold = new AgyFold(e => out.push(e), () => 'x');
    const steps = (s: string) => ({ sessionUpdate: 'tool_call', toolCallId: 'call_s' + s, name: 'update_steps', kind: 'other', status: 'in_progress', rawInput: { steps: [{ status: s, title: 'Read' }] } }) as Update;
    fold.update(steps('in_progress')); fold.update(steps('completed'));
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(out[1].id);
    expect(out[1]).toMatchObject({ t: 'todo', items: [{ text: 'Read', done: true }] });
  });
});

describe('Antigravity subagents', () => {
  // agy 1.5.18: invoke_subagent completes as soon as the subagent starts; it reports back later in the same turn
  const spawn = (status: string) => ({ sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update', toolCallId: 'call_sa', name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent', status,
    rawInput: { Prompt: 'List the top-level folders of the repo and report back in one sentence.', Role: 'Top-Level Folder Lister', TypeName: 'research' } }) as Update;
  it('shows a spawn as a subagent row that runs until the turn ends, with its prompt as the first message', () => {
    const out: { id: string; t: string }[] = [];
    const fold = new AgyFold(e => out.push(e), () => 'x');
    fold.update(spawn('in_progress')); fold.update(spawn('completed'));
    expect(out.every(e => e.t === 'sub')).toBe(true);
    expect(out.at(-1)).toMatchObject({ t: 'sub', id: 'call_sa', name: 'research', task: 'Top-Level Folder Lister', status: 'running',
      events: [{ t: 'user', id: 'p-call_sa', text: 'List the top-level folders of the repo and report back in one sentence.' }] });
    fold.end();
    expect(out.at(-1)).toMatchObject({ t: 'sub', id: 'call_sa', status: 'done' });
  });
  it('puts the calls agy forwards from a subagent (needing approval) under its row, tied to its session', () => {
    const out: { id: string; t: string }[] = [];
    const fold = new AgyFold(e => out.push(e), () => 'x');
    const child = '14b805b6-f79f-492d-a5ec-f2f71e56cc78';
    fold.update(spawn('in_progress')); fold.update(spawn('completed'));
    fold.update({ sessionUpdate: 'tool_call', ...runCall, toolCallId: `${child}:call_2`, status: 'pending' } as Update);
    fold.update({ sessionUpdate: 'tool_call_update', ...runCall, toolCallId: `${child}:call_2`, status: 'completed', rawOutput: runOutput } as Update);
    expect(out.every(e => e.t === 'sub')).toBe(true);
    expect(out.at(-1)).toMatchObject({ agent: child, status: 'running', events: [{ t: 'user' }, { t: 'tool', id: 'call_2', name: 'Shell', out: '?? hello.txt', status: 'done' }] });
    // one still waiting when the turn is stopped fails with it
    fold.update({ sessionUpdate: 'tool_call', ...runCall, toolCallId: `${child}:call_3`, status: 'pending' } as Update);
    fold.abandon();
    expect(out.at(-1)).toMatchObject({ status: 'failed', events: [{ t: 'user' }, { status: 'done' }, { id: 'call_3', status: 'failed' }] });
  });
  it('fails a subagent the turn was stopped under, and replays one as done', () => {
    const out: { t: string; status?: string }[] = [];
    const fold = new AgyFold(e => out.push(e), () => 'x');
    fold.update(spawn('completed')); fold.abandon(); fold.end();
    expect(out.filter(e => e.t !== 'sub')).toEqual([]);
    expect(out.at(-1)).toMatchObject({ t: 'sub', status: 'failed' });
    const evs = replay([{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Summarize the repo' } }, spawn('completed'), { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }], CWD);
    expect(evs.map(e => e.t)).toEqual(['user', 'sub', 'text']);
    expect(evs[1]).toMatchObject({ status: 'done' });
  });
});

describe('Antigravity history', () => {
  it('folds a replayed session into turns: your messages, replies and steps', () => {
    const evs = replay(loadReplay, CWD);
    expect(evs.map(e => e.t)).toEqual(['user', 'text', 'user', 'edit', 'text', 'user', 'tool', 'text']);
    expect(evs[7]).toMatchObject({ t: 'text', text: 'The output is `?? hello.txt`' });
    expect(evs[6]).toMatchObject({ id: 'call_2', out: '?? hello.txt' });
    expect(evs.some(e => 'streaming' in e)).toBe(false);
  });
});

describe('Antigravity options', () => {
  it('lists model families with the thinking levels each offers, and agy’s modes', () => {
    const o = agyOptions(opened());
    expect(o.models.map(m => [m.id, m.efforts.join(',')])).toEqual([
      ['gemini-4-neon', 'low,medium,high,xhigh'], ['gemini-4-carbon', 'low,medium,high'], ['gemini-pro-orchestrator', ''], ['gpt-oss-120b-medium', ''],
    ]);
    expect(o.models[0]).toMatchObject({ isDefault: true, effort: 'high' });
    expect(o.perms.map(p => p.id)).toEqual(['default', 'accept-edits', 'auto', 'plan']);
    expect(o.perms[1]).toMatchObject({ icon: 'pencil' });
  });
  it('lists its commands first, then its skills', () => {
    const c = agyCommands([{ name: 'plan', description: 'Plan carefully' }, { name: 'antigravity-guide', description: 'A guide' }]);
    expect(c.commands.map(x => x.cmd)).toEqual(['/plan']);
    expect(c.skills.map(x => x.cmd)).toEqual(['/antigravity-guide']);
  });
});

describe('Antigravity images', () => {
  it('sends a data URL as an image block', () => {
    expect(imageBlock('data:image/png;base64,AAAA')).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
  });
});

// ---- a fake `agy acp`, answering as the real one did ----

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
class FakeAgy {
  sent: Msg[] = [];
  sessions = new Map<string, { model: string; mode: string }>();
  rpc!: Rpc;
  private n = 0;
  private waiting = new Map<string | number, (r: unknown) => void>();
  private cancel: (() => void) | null = null;

  launch = () => {
    this.rpc = new Rpc(line => this.receive(JSON.parse(line)), () => this.rpc.ended(0, 'killed'), { tag: 'agy', strict: true });
    return this.rpc;
  };
  private send(m: Msg) { queueMicrotask(() => this.rpc.feed(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')); }
  private update(sessionId: string, update: object) { this.send({ method: 'session/update', params: { sessionId, update } }); }
  private ask(params: Record<string, unknown>) { const id = String(++this.n); this.send({ id, method: 'session/request_permission', params }); return new Promise(r => this.waiting.set(id, r)); }

  private async receive(m: Msg) {
    this.sent.push(m);
    if (m.id != null && !m.method) { this.waiting.get(m.id)?.(m.result); return; }
    const p = m.params ?? {}, sid = p.sessionId as string;
    const reply = (result: unknown) => this.send({ id: m.id, result });
    switch (m.method) {
      case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
      case 'session/new': { const id = 'ses-' + (this.sessions.size + 1); this.sessions.set(id, { model: 'gemini-4-neon', mode: 'default' }); return reply({ sessionId: id, ...opened() }); }
      case 'session/resume': case 'session/load':
        if (!this.sessions.has(sid)) return this.send({ id: m.id, error: { code: -32002, message: `Session not found: ${sid}` } });
        // agy resets a loaded session to its default model
        this.sessions.get(sid)!.model = 'gemini-4-neon';
        if (m.method === 'session/load') for (const u of loadReplay) this.update(sid, u);
        return reply(opened());
      case 'session/set_config_option': if (p.configId === 'model') this.sessions.get(sid)!.model = p.value as string; return reply({ configOptions: opened(this.sessions.get(sid)!.model).configOptions });
      case 'session/set_mode': this.sessions.get(sid)!.mode = p.modeId as string; return reply({});
      case 'session/close': return reply({});
      case 'session/list': return reply({ sessions: [
        { sessionId: 'ses-1', cwd: CWD, title: 'Hello', updatedAt: '2026-11-26T07:30:15Z' },
        { sessionId: 'old', cwd: agyHome(LOCAL), title: 'Placed nowhere', updatedAt: '2026-05-19T23:55:45Z' },
      ] });
      case 'session/cancel': this.cancel?.(); return;
      case 'session/prompt': {
        const text = ((p.prompt as { text?: string }[]).find(b => b.text)?.text) ?? '';
        if (text === 'write') {
          this.update(sid, { sessionUpdate: 'tool_call', ...writeCall, status: 'in_progress' });
          const r = await this.ask({ sessionId: sid, toolCall: { ...writeCall, status: 'pending', content: [{ type: 'diff', path: `${CWD}/hello.txt`, newText: 'hi' }] }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] }) as { outcome: { outcome: string; optionId?: string } };
          this.update(sid, { sessionUpdate: 'tool_call_update', ...writeCall, status: r.outcome.optionId === 'allow' ? 'completed' : 'failed', content: [{ type: 'diff', path: `${CWD}/hello.txt`, newText: 'hi' }] });
        }
        if (text === 'slow') return void (this.cancel = () => { this.cancel = null; reply({ stopReason: 'cancelled' }); });
        this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } });
        this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from agy.' } });
        this.update(sid, { sessionUpdate: 'usage_update', used: 9482, size: 1048576 });
        this.update(sid, { sessionUpdate: 'session_info_update', title: 'Say hello' });
        this.update(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'plan', description: 'Plan carefully' }] });
        return setTimeout(() => reply({ stopReason: 'end_turn' }), 5);
      }
      default: return this.send({ id: m.id, error: { code: -32601, message: 'unknown ' + m.method } });
    }
  }
  calls(method: string) { return this.sent.filter(m => m.method === method); }
}

const LOCAL: Machine = { id: 'local', name: 'This computer', link: 'up', has: ['agy'] };

function setup(t: Record<string, unknown> = {}) {
  const fake = new FakeAgy();
  const servers = new AgyServers(fake.launch);
  const h = fakeHost([{ id: 't1', harness: 'agy', dir: process.cwd(), ...t }], { has: ['agy'] });
  return { fake, servers, h, d: new AgyDriver('t1', h.host, servers) };
}

describe('Antigravity driver', () => {
  it('opens a session, streams a reply, and keeps what agy says of the thread', async () => {
    const { fake, servers, h, d } = setup();
    expect(await d.prepare()).toBe(true);
    expect(h.thread('t1').sessionId).toBe('ses-1');
    // a thread with no model runs agy's default, recorded so the picker shows it
    expect(h.thread('t1')).toMatchObject({ model: 'gemini-4-neon', effort: 'high' });
    expect(fake.sent[0]).toMatchObject({ jsonrpc: '2.0', method: 'initialize' });
    await d.send({ text: 'hi' });
    await until(() => h.thread('t1').status === 'idle' && h.view().some(e => e.t === 'text'));
    const v = h.view();
    expect(v.map(e => e.t)).toEqual(['user', 'text']);
    expect(v[1]).toMatchObject({ text: 'hello from agy.' });
    expect('streaming' in v[1] && v[1].streaming).toBeFalsy();
    expect(h.thread('t1')).toMatchObject({ title: 'Say hello', ctxTokens: { used: 9482, max: 1048576 } });
    expect(servers.offered.get('local')?.commands?.map(c => c.name)).toEqual(['plan']);
  });

  it('asks before an edit and answers with the option you pick', async () => {
    const { h, d, fake } = setup();
    await d.send({ text: 'write' });
    await until(() => h.view().some(e => e.t === 'approval'));
    const ap = h.view().find(e => e.t === 'approval')!;
    expect(ap).toMatchObject({ request: { kind: 'edit', title: 'Edit hello.txt?', options: [{ id: 'allow', label: 'Allow', primary: true }, { id: 'deny', label: 'Deny' }] } });
    expect(h.thread('t1').status).toBe('wait');
    await d.answer('call_1', 'allow');
    await until(() => h.thread('t1').status === 'idle');
    expect(fake.sent.find(m => m.id === '1' && !m.method)).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    // outside the thread's folder: the whole path
    expect(h.view().find(e => e.t === 'edit')).toMatchObject({ path: `${CWD}/hello.txt`, status: 'done' });
    expect(h.view().find(e => e.id === 'ap-call_1')).toMatchObject({ t: 'notice', text: `Allowed: ${CWD}/hello.txt` });
  });

  it('stops a turn with session/cancel and pauses what waits', async () => {
    const { h, d, fake } = setup();
    await d.send({ text: 'slow' });
    await until(() => fake.calls('session/prompt').length === 1);
    await d.send({ text: 'next', queue: true });
    expect(h.thread('t1').queue?.map(q => q.text)).toEqual(['next']);
    await d.interrupt();
    await until(() => h.thread('t1').status === 'idle');
    expect(fake.calls('session/cancel')).toHaveLength(1);
    expect(h.view().some(e => e.t === 'interrupted')).toBe(true);
    expect(h.thread('t1').queuePaused).toBe(true);
    // resuming the queue sends what waited
    await d.resumeQueue();
    await until(() => fake.calls('session/prompt').length === 2);
  });

  it('resumes a thread’s session and puts its own model and mode back, as agy resets them', async () => {
    const { h, d, fake } = setup({ model: 'gemini-4-carbon', effort: 'low', perm: 'auto' });
    fake.sessions.set('ses-9', { model: 'gemini-4-carbon', mode: 'auto' });
    h.host.update('t1', { sessionId: 'ses-9' });
    await d.send({ text: 'hi' });
    await until(() => h.thread('t1').status === 'idle');
    expect(fake.calls('session/resume')).toHaveLength(1);
    expect(fake.calls('session/set_config_option').map(m => [m.params!.configId, m.params!.value])).toEqual([['model', 'gemini-4-carbon'], ['thought_level', 'low']]);
    expect(fake.calls('session/set_mode')[0].params).toMatchObject({ modeId: 'auto' });
    // the next turn changes nothing
    await d.send({ text: 'again' });
    await until(() => fake.calls('session/prompt').length === 2 && h.thread('t1').status === 'idle');
    expect(fake.calls('session/set_config_option')).toHaveLength(2);
  });

  it('says so when agy no longer has the conversation', async () => {
    const { h, d } = setup({ sessionId: 'gone' });
    await d.send({ text: 'hi' });
    expect(h.view().find(e => e.t === 'error')).toMatchObject({ text: 'Antigravity no longer has this conversation.' });
  });

  it('can’t rewind: editing an earlier message is refused', async () => {
    const { d } = setup();
    await expect(d.send({ text: 'x', rewind: 'u1' })).rejects.toThrow(/rewind/);
  });
});

describe('Antigravity history and discovery', () => {
  it('reads a session through session/load and closes it after', async () => {
    const fake = new FakeAgy(), readers = new AgyServers(fake.launch);
    fake.sessions.set('ses-1', { model: 'gemini-4-neon', mode: 'default' });
    const evs = await agyHistory(readers, LOCAL, 'ses-1', CWD);
    expect(evs.map(e => e.t)).toEqual(['user', 'text', 'user', 'edit', 'text', 'user', 'tool', 'text']);
    expect(fake.calls('session/close')).toHaveLength(1);
    expect(await agyHistory(readers, LOCAL, 'missing', CWD)).toEqual([]);
  });

  it('lists sessions, leaving out the ones agy can’t place', async () => {
    const fake = new FakeAgy(), readers = new AgyServers(fake.launch);
    const found = await agySessions(readers, LOCAL, 50);
    expect(found).toEqual([{ harness: 'agy', sessionId: 'ses-1', dir: CWD, title: 'Hello', updatedAt: Date.parse('2026-11-26T07:30:15Z'), createdAt: Date.parse('2026-11-26T07:30:15Z') }]);
  });
});
