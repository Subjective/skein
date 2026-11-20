import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness, Machine, ThreadMeta } from '../shared/types';
import { claudeSlug, machineIO, moveBlocked, moveSession, type MoveIO } from './move';

const local: Machine = { id: 'local', name: 'This PC', link: 'up', has: ['claude', 'codex'] };
const box: Machine = { id: 'box', name: 'box', link: 'up', has: ['claude', 'codex'], ssh: { host: 'box' }, home: '/home/me' };
const down: Machine = { ...box, id: 'down', name: 'down', link: 'down' };
const codexOnly: Machine = { ...box, id: 'cx', name: 'cx', has: ['codex'] };

const thread = (harness: Harness, x: Partial<ThreadMeta> = {}): ThreadMeta =>
  ({ id: 't1', harness, sessionId: 'abc-123', machine: 'local', dir: '/w/app', title: 'x', createdAt: 0, updatedAt: 0, status: 'idle', ...x });

/** Machines as a map of path -> text per machine id, with folders implied by their files. */
function fakeIO(fs: Record<string, Record<string, string>>, roots: Record<string, Partial<Record<Harness, string>>> = {}) {
  const calls: string[] = [];
  const has = (m: Machine, p: string) => Object.keys(fs[m.id] || {}).some(f => f === p || f.startsWith(p + '/'));
  const io: MoveIO = {
    root: async (m, h) => roots[m.id]?.[h] ?? `${m.home ?? '/home/local'}/.${h}`,
    find: async (m, h, id) => Object.keys(fs[m.id] || {}).find(f => (h === 'claude' ? new RegExp(`/projects/[^/]+/${id}\\.jsonl$`) : new RegExp(`/sessions/\\d+/\\d+/\\d+/rollout-[^/]*${id}\\.jsonl$`)).test(f)) ?? null,
    isDir: async (m, p) => Object.keys(fs[m.id] || {}).some(f => f.startsWith(p + '/')) || (fs[m.id]?.[p + '/'] !== undefined),
    copy: async (m, a, b, folder) => {
      calls.push(`copy ${m.id} ${a} -> ${b}${folder ? ' (folder)' : ''}`);
      for (const [f, text] of Object.entries(fs[m.id])) if (f === a || (folder && f.startsWith(a + '/'))) fs[m.id][b + f.slice(a.length)] = text;
    },
    send: async (from, a, to, b, folder) => {
      calls.push(`send ${from.id}:${a} -> ${to.id}:${b}${folder ? ' (folder)' : ''}`);
      fs[to.id] ||= {};
      for (const [f, text] of Object.entries(fs[from.id])) if (f === a || (folder && f.startsWith(a + '/'))) fs[to.id][b + f.slice(a.length)] = text;
    },
  };
  return { io, calls, fs, has };
}

describe('claudeSlug', () => {
  it('turns slashes and dots into dashes', () => {
    expect(claudeSlug('/home/me/projects/skein')).toBe('-home-me-projects-skein');
    expect(claudeSlug('/home/me/my.app')).toBe('-home-me-my-app');
    expect(claudeSlug('/Users/me/.config/x')).toBe('-Users-me--config-x');
  });
  it('handles Windows paths', () => {
    expect(claudeSlug('C:\\Users\\me\\proj')).toBe('C--Users-me-proj');
  });
});

describe('moveBlocked', () => {
  it('refuses a running thread and one waiting on you', () => {
    expect(moveBlocked(thread('claude', { status: 'running' }), local, '/w/other')).toMatch(/turn ends/);
    expect(moveBlocked(thread('codex', { status: 'wait' }), local, '/w/other')).toMatch(/waiting on you/);
  });
  it('refuses an offline machine, a missing CLI and the same place', () => {
    expect(moveBlocked(thread('claude'), down, '/x')).toMatch(/isn’t connected/);
    expect(moveBlocked(thread('claude'), codexOnly, '/x')).toMatch(/Claude Code isn’t installed on cx/);
    expect(moveBlocked(thread('claude'), local, '/w/app')).toMatch(/already there/);
  });
  it('allows an idle or unread thread', () => {
    expect(moveBlocked(thread('claude', { status: 'unread' }), box, '/home/me/app')).toBeNull();
    expect(moveBlocked(thread('codex'), local, '/w/other')).toBeNull();
  });
});

describe('moveSession: Claude Code', () => {
  const src = '/home/local/.claude/projects/-w-app/abc-123.jsonl';
  it('same machine: copies the transcript (and its folder) into the new project and keeps the original', async () => {
    const f = fakeIO({ local: { [src]: '{"a":1}\n', '/home/local/.claude/projects/-w-app/abc-123/subagents/s.jsonl': 'sub', '/w/next.v2/x': '' } });
    const r = await moveSession(thread('claude'), local, local, '/w/next.v2', f.io);
    // a local destination uses this computer's separators (backslashes on Windows)
    const dst = join('/home/local/.claude/projects/-w-next-v2/abc-123.jsonl'), dir = join('/home/local/.claude/projects/-w-next-v2/abc-123');
    expect(f.calls).toEqual([`copy local ${src} -> ${dst}`, `copy local /home/local/.claude/projects/-w-app/abc-123 -> ${dir} (folder)`]);
    expect(f.fs.local[dst]).toBe('{"a":1}\n');
    expect(f.fs.local[src]).toBe('{"a":1}\n');
    expect(f.fs.local[dir + '/subagents/s.jsonl']).toBe('sub');
    expect(r.copied).toHaveLength(2);
  });
  it('other machine: sends the transcript into the project of the folder there', async () => {
    const f = fakeIO({ local: { [src]: 'T' }, box: { '/home/me/app/README': '' } });
    await moveSession(thread('claude'), local, box, '/home/me/app', f.io);
    expect(f.calls).toEqual([`send local:${src} -> box:/home/me/.claude/projects/-home-me-app/abc-123.jsonl`]);
    expect(f.fs.box['/home/me/.claude/projects/-home-me-app/abc-123.jsonl']).toBe('T');
  });
  it('uses the target machine’s config folder', async () => {
    const f = fakeIO({ local: { [src]: 'T' }, box: { '/srv/app/x': '' } }, { box: { claude: '/opt/claude' } });
    await moveSession(thread('claude'), local, box, '/srv/app', f.io);
    expect(f.calls[0]).toBe(`send local:${src} -> box:/opt/claude/projects/-srv-app/abc-123.jsonl`);
  });
  it('copies nothing when there is no transcript yet', async () => {
    const f = fakeIO({ local: { '/w/b/x': '' } });
    const r = await moveSession(thread('claude'), local, local, '/w/b', f.io);
    expect(f.calls).toEqual([]);
    expect(r.patch).toEqual({});
  });
  it('fails when the folder is not there', async () => {
    const f = fakeIO({ local: { [src]: 'T' }, box: {} });
    await expect(moveSession(thread('claude'), local, box, '/home/me/nope', f.io)).rejects.toThrow(/doesn’t exist on box/);
    expect(f.calls).toEqual([]);
  });
});

describe('moveSession: Codex', () => {
  const src = '/home/local/.codex/sessions/2026/11/20/rollout-2026-11-20T10-00-00-abc-123.jsonl';
  it('same machine: copies nothing (resumed by id with the new cwd)', async () => {
    const f = fakeIO({ local: { [src]: 'R', '/w/other/x': '' } });
    const r = await moveSession(thread('codex'), local, local, '/w/other', f.io);
    expect(f.calls).toEqual([]);
    expect(r.copied).toEqual([]);
  });
  it('other machine: sends the rollout to the same date folder there', async () => {
    const f = fakeIO({ local: { [src]: 'R' }, box: { '/home/me/app/x': '' } });
    await moveSession(thread('codex'), local, box, '/home/me/app', f.io);
    const dst = '/home/me/.codex/sessions/2026/11/20/rollout-2026-11-20T10-00-00-abc-123.jsonl';
    expect(f.calls).toEqual([`send local:${src} -> box:${dst}`]);
    expect(f.fs.box[dst]).toBe('R');
    expect(f.fs.local[src]).toBe('R');
  });
  it('other machine with no rollout yet: the thread starts afresh there', async () => {
    const f = fakeIO({ local: {}, box: { '/home/me/app/x': '' } });
    const r = await moveSession(thread('codex'), local, box, '/home/me/app', f.io);
    expect(r.patch).toHaveProperty('sessionId', undefined);
  });
});

describe('machineIO on this computer', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  it('finds and copies a Claude transcript under CLAUDE_CONFIG_DIR', async () => {
    const d = mkdtempSync(join(tmpdir(), 'skein-move-'));
    process.env.CLAUDE_CONFIG_DIR = join(d, 'claude');
    const from = join(d, 'w', 'a'), to = join(d, 'w', 'b.c');
    mkdirSync(from, { recursive: true }); mkdirSync(to, { recursive: true });
    const proj = join(d, 'claude', 'projects', claudeSlug(from));
    mkdirSync(join(proj, 'abc-123', 'subagents'), { recursive: true });
    writeFileSync(join(proj, 'abc-123.jsonl'), 'line\n');
    writeFileSync(join(proj, 'abc-123', 'subagents', 's.jsonl'), 'sub\n');
    const r = await moveSession(thread('claude', { dir: from }), local, local, to, machineIO);
    const dst = join(d, 'claude', 'projects', claudeSlug(to));
    expect(readFileSync(join(dst, 'abc-123.jsonl'), 'utf8')).toBe('line\n');
    expect(readFileSync(join(dst, 'abc-123', 'subagents', 's.jsonl'), 'utf8')).toBe('sub\n');
    expect(existsSync(join(proj, 'abc-123.jsonl'))).toBe(true);
    expect(r.copied).toHaveLength(2);
  });
});
