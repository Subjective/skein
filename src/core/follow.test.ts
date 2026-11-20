import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine, ThreadEvent, ThreadMeta } from '../shared/types';
import { claudeTurnState, codexTurnState, endsTurn, Follower, Follows, sessionOfFile, type FollowHost, type TurnState } from './follow';
import { spawn } from 'node:child_process';
import { LineSplitter, LocalTail, RemoteTail } from './tail';

const J = (o: object) => JSON.stringify(o);
const user = (uuid: string, parent: string | null, content: unknown, ts = new Date().toISOString()) =>
  J({ type: 'user', uuid, parentUuid: parent, timestamp: ts, message: { role: 'user', content } });
const asst = (uuid: string, parent: string, msgId: string, block: object, stop: string | null = null, ts = new Date().toISOString()) =>
  J({ type: 'assistant', uuid, parentUuid: parent, timestamp: ts, message: { id: msgId, role: 'assistant', content: [block], stop_reason: stop } });
const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

describe('LineSplitter', () => {
  it('holds a partial last line until its newline comes', () => {
    const s = new LineSplitter();
    expect(s.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(s.pending).toBe(4);
    expect(s.push(Buffer.from(':2}\r\n\n'))).toEqual(['{"b":2}']);
    expect(s.pending).toBe(0);
  });
  it('keeps a multi-byte character cut between two reads whole', () => {
    const s = new LineSplitter(), b = Buffer.from('"héllo ✓"\n');
    const cut = b.indexOf(0xe2) + 1;   // inside the three bytes of ✓
    expect(s.push(b.subarray(0, cut))).toEqual([]);
    expect(s.push(b.subarray(cut))).toEqual(['"héllo ✓"']);
  });
});

describe('LocalTail', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skein-tail-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads appends from the offset, partial lines included once whole; truncation and replacement start over', async () => {
    const f = join(dir, 'x.jsonl');
    writeFileSync(f, 'old1\nold2\n');
    const got: string[] = []; let resets = 0;
    const t = new LocalTail(f, 10, { lines: ls => got.push(...ls), reset: () => { resets++; } }, { poll: 20 });
    try {
      appendFileSync(f, 'new1\nnew');
      await until(() => got.length === 1);
      appendFileSync(f, '2\n');
      await until(() => got.length === 2);
      expect(got).toEqual(['new1', 'new2']);
      // truncated: everything after comes from the top
      truncateSync(f, 0); appendFileSync(f, 'a\n');
      await until(() => got.includes('a'));
      expect(resets).toBe(1);
      // replaced by another file (rotation), even a longer one
      const g = join(dir, 'y.jsonl'); writeFileSync(g, 'r1\nr2\nr3\nr4\nr5\n'); renameSync(g, f);
      await until(() => got.includes('r5'));
      expect(resets).toBe(2);
      expect(got.slice(-5)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    } finally { t.stop(); }
  });
});

describe('RemoteTail', () => {
  it('runs tail -c +N -F from the offset and restarts from where it got to when the link drops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skein-rtail-')), f = join(dir, 'x.jsonl');
    writeFileSync(f, 'old\n');
    const got: string[] = [], procs: ReturnType<typeof spawn>[] = [];
    // the ssh hop is replaced by running the same command here
    const fake = ((_m: Machine, cmd: string[]) => { const p = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(p); return p; }) as never;
    const t = new RemoteTail({ id: 'r' } as unknown as Machine, f, 4, { lines: ls => got.push(...ls), reset: () => {} }, { spawn: fake, retryMs: 20 });
    try {
      appendFileSync(f, 'a\nb');
      await until(() => got.length === 1);
      procs[0].kill();                       // the link drops mid-line
      appendFileSync(f, 'c\nd\n');
      await until(() => got.includes('d'));
      expect(got).toEqual(['a', 'bc', 'd']);
      expect(procs.length).toBe(2);
    } finally { t.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('turn state', () => {
  const p = (s: string) => s.split('\n').map(l => JSON.parse(l));
  it('Claude: a prompt or a tool call is running; end_turn, an interrupt or a local command is idle', () => {
    expect(claudeTurnState(p(user('u', null, 'hi')))).toBe('running');
    expect(claudeTurnState(p([user('u', null, 'hi'), asst('a', 'u', 'm', { type: 'tool_use', id: 't', name: 'Bash', input: {} }, 'tool_use')].join('\n')))).toBe('running');
    expect(claudeTurnState(p([user('u', null, 'hi'), asst('a', 'u', 'm', { type: 'text', text: 'ok' }, 'end_turn'), J({ type: 'last-prompt' })].join('\n')))).toBe('idle');
    expect(claudeTurnState(p(user('i', null, [{ type: 'text', text: '[Request interrupted by user]' }])))).toBe('idle');
    expect(claudeTurnState(p(user('c', null, '<local-command-stdout>Set model</local-command-stdout>')))).toBe('idle');
    expect(claudeTurnState(p(J({ type: 'system', subtype: 'turn_duration', durationMs: 10 })))).toBe('idle');
  });
  it('Codex: task_started until task_complete or turn_aborted', () => {
    const ev = (type: string) => ({ type: 'event_msg', payload: { type } });
    expect(codexTurnState([ev('task_started'), { type: 'response_item', payload: {} }])).toBe('running');
    expect(codexTurnState([ev('task_started'), ev('task_complete')])).toBe('idle');
    expect(codexTurnState([ev('task_started'), ev('turn_aborted')])).toBe('idle');
    expect(endsTurn('codex', [ev('task_complete')])).toBe(true);
  });
  it('names the session of a transcript file', () => {
    expect(sessionOfFile('/h/.claude/projects/-p/0b5e2a8c-1111-2222-3333-444455556666.jsonl')).toEqual({ harness: 'claude', id: '0b5e2a8c-1111-2222-3333-444455556666' });
    expect(sessionOfFile('C:\\h\\.codex\\sessions\\2026\\11\\20\\rollout-2026-11-20T10-00-00-0b5e2a8c-1111-2222-3333-444455556666.jsonl')).toEqual({ harness: 'codex', id: '0b5e2a8c-1111-2222-3333-444455556666' });
    expect(sessionOfFile('notes.txt')).toBeNull();
  });
});

// A follower over a real file in a throwaway CLAUDE_CONFIG_DIR / CODEX_HOME, with a host that records what it is told.
describe('Follower', () => {
  let root: string; const env = { ...process.env };
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'skein-follow-')); process.env.CLAUDE_CONFIG_DIR = join(root, 'claude'); process.env.CODEX_HOME = join(root, 'codex'); });
  afterEach(() => { process.env = { ...env }; rmSync(root, { recursive: true, force: true }); });

  const local = { id: 'local', name: 'This computer', link: 'up' } as unknown as Machine;
  function host(t: ThreadMeta) {
    const h = {
      owner: null as 'driver' | 'pty' | null,
      pushed: [] as { e: ThreadEvent; replace: boolean }[],
      acts: [] as { state: TurnState; ended: boolean }[],
      api: null as unknown as FollowHost & { bySession(id: string): ThreadMeta | undefined },
    };
    h.api = {
      machine: () => local, thread: id => (id === t.id ? t : undefined), bySession: sid => (sid === t.sessionId ? t : undefined),
      owner: () => h.owner, event: (_t, e, replace) => h.pushed.push({ e, replace }), activity: (_t, a) => h.acts.push(a),
    };
    return h;
  }
  const claudeThread = (sid: string): ThreadMeta => ({ id: 't1', harness: 'claude', sessionId: sid, machine: 'local', dir: '/p', title: 'x', createdAt: 0, updatedAt: 0, status: 'idle' });

  it('loads the baseline, then pushes only what is new or changed, without repeating history', async () => {
    const sid = '11111111-2222-3333-4444-555555555555', file = join(root, 'claude', 'projects', '-p', `${sid}.jsonl`);
    mkdirSync(join(root, 'claude', 'projects', '-p'), { recursive: true });
    // the last line is still being written: it is not part of the baseline
    writeFileSync(file, [user('u1', null, 'list files'), asst('a1', 'u1', 'm1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }, 'tool_use')].join('\n') + '\n' + '{"type":"user","uu');
    const t = claudeThread(sid), h = host(t);
    const f = new Follower(t.id, h.api, { throttle: 10, tail: (p, off, sink) => new LocalTail(p, off, sink, { poll: 20, watch: false }) });
    const base = await f.load();
    expect(base!.map(e => e.id)).toEqual(['u1', 'tu1']);
    expect(base![1]).toMatchObject({ t: 'tool', status: 'running' });
    f.start();
    try {
      // the cut line is rewritten whole by the test (a writer that flushed half a line, then the rest)
      const cut = '{"type":"user","uu';
      const rest = user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a\nb' }]).slice(cut.length);
      appendFileSync(file, rest + '\n');
      await until(() => h.pushed.some(p => p.e.id === 'tu1'));
      expect(h.pushed.find(p => p.e.id === 'tu1')).toMatchObject({ replace: true, e: { status: 'done', out: 'a\nb' } });
      expect(h.acts.at(-1)).toEqual({ state: 'running', ended: false });
      appendFileSync(file, asst('a2', 'r1', 'm2', { type: 'text', text: 'Two files.' }, 'end_turn') + '\n');
      await until(() => h.pushed.some(p => p.e.id === 'm2:0'));
      expect(h.pushed.find(p => p.e.id === 'm2:0')).toMatchObject({ replace: false, e: { t: 'text', text: 'Two files.' } });
      expect(h.acts.at(-1)).toEqual({ state: 'idle', ended: true });
      // nothing from the baseline came again unchanged, and nothing came twice
      expect(h.pushed.filter(p => p.e.id === 'u1')).toHaveLength(0);
      const ids = h.pushed.map(p => p.e.id + JSON.stringify(p.e));
      expect(new Set(ids).size).toBe(ids.length);

      // Skein's own driver writes: no pushes (it sends its own), no activity, but the baseline keeps up
      h.owner = 'driver'; const n = h.pushed.length, na = h.acts.length;
      appendFileSync(file, user('u2', 'a2', 'again') + '\n' + asst('a3', 'u2', 'm3', { type: 'text', text: 'Mine.' }, 'end_turn') + '\n');
      await new Promise(r => setTimeout(r, 150));
      expect(h.pushed.length).toBe(n); expect(h.acts.length).toBe(na);
      // then someone else again: only their new entries arrive
      h.owner = null;
      appendFileSync(file, user('u3', 'a3', 'from the other terminal') + '\n');
      await until(() => h.pushed.some(p => p.e.id === 'u3'));
      expect(h.pushed.slice(n).map(p => p.e.id)).toEqual(['u3']);
      expect(h.acts.at(-1)).toEqual({ state: 'running', ended: false });
    } finally { f.stop(); }
  });

  it('a Skein terminal writing (the chat mirror) pushes events but reports no outside activity', async () => {
    const sid = '21111111-2222-3333-4444-555555555555', file = join(root, 'claude', 'projects', '-p', `${sid}.jsonl`);
    mkdirSync(join(root, 'claude', 'projects', '-p'), { recursive: true });
    writeFileSync(file, user('u1', null, 'hi') + '\n');
    const t = claudeThread(sid), h = host(t); h.owner = 'pty';
    const f = new Follower(t.id, h.api, { throttle: 10, tail: (p, off, sink) => new LocalTail(p, off, sink, { poll: 20, watch: false }) });
    await f.load(); f.start();
    try {
      appendFileSync(file, asst('a1', 'u1', 'm1', { type: 'text', text: 'hello' }, 'end_turn') + '\n');
      await until(() => h.pushed.length === 1);
      expect(h.acts).toEqual([]);
    } finally { f.stop(); }
  });

  it('follows a Codex rollout (fixture) the same way', async () => {
    const sid = '0b5e2a8c-1111-2222-3333-444455556666', dir = join(root, 'codex', 'sessions', '2026', '11', '20');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-11-20T10-00-00-${sid}.jsonl`);
    const ev = (payload: object) => J({ type: 'event_msg', payload });
    writeFileSync(file, [J({ type: 'session_meta', payload: { id: sid, cwd: '/p' } }), ev({ type: 'task_started', turn_id: 'turn1' }),
      ev({ type: 'item_completed', turn_id: 'turn1', item: { type: 'UserMessage', id: 'i1', content: [{ type: 'text', text: 'list files', text_elements: [] }] } })].join('\n') + '\n');
    const t: ThreadMeta = { ...claudeThread(sid), harness: 'codex' }, h = host(t);
    const f = new Follower(t.id, h.api, { throttle: 10, tail: (p, off, sink) => new LocalTail(p, off, sink, { poll: 20, watch: false }) });
    expect((await f.load())!.map(e => e.id)).toEqual(['i1']);
    f.start();
    try {
      appendFileSync(file, [ev({ type: 'item_completed', turn_id: 'turn1', item: { type: 'AgentMessage', id: 'i2', content: [{ type: 'Text', text: 'Two files.' }] } }), ev({ type: 'task_complete', turn_id: 'turn1', duration_ms: 2500 })].join('\n') + '\n');
      await until(() => h.acts.some(a => a.state === 'idle'));
      expect(h.pushed.map(p => p.e.id)).toEqual(['i2', 'w-turn1']);
      expect(h.pushed[0].e).toMatchObject({ t: 'text', text: 'Two files.' });
      expect(h.acts.at(-1)).toEqual({ state: 'idle', ended: true });
    } finally { f.stop(); }
  });

  it('wakes on a directory watch for a transcript written outside Skein', async () => {
    const sid = '31111111-2222-3333-4444-555555555555', pdir = join(root, 'claude', 'projects', '-p');
    mkdirSync(pdir, { recursive: true });
    const t = claudeThread(sid), h = host(t);
    const fs = new Follows(h.api, { throttle: 10 });
    try {
      await new Promise(r => setTimeout(r, 100));   // watchers are set up
      writeFileSync(join(pdir, `${sid}.jsonl`), user('u1', null, 'started in another terminal') + '\n');
      await until(() => h.acts.length > 0);
      expect(h.acts[0]).toEqual({ state: 'running', ended: false });
      appendFileSync(join(pdir, `${sid}.jsonl`), asst('a1', 'u1', 'm1', { type: 'text', text: 'done' }, 'end_turn') + '\n');
      await until(() => h.acts.some(a => a.state === 'idle'));
      expect(h.pushed.map(p => p.e.id)).toContain('m1:0');
    } finally { fs.dispose(); }
  });
});
