import { describe, expect, it } from 'vitest';
import { Threads, discoveredId } from './threads';

describe('discovered thread ids', () => {
  it('differ for Codex sessions started in the same minute (UUIDv7 share their head)', () => {
    const a = discoveredId('01a1fa47-44ca-7160-b761-1c6aefdeea12', () => false);
    const b = discoveredId('01a1fa47-4871-7433-9901-be84151bcee6', () => false);
    expect(a).toBe('t-1c6aefdeea12');
    expect(b).not.toBe(a);
  });

  it('never reuses an id that is taken', () => {
    expect(discoveredId('01a1fa47-44ca-7160-b761-1c6aefdeea12', id => id === 't-1c6aefdeea12')).toMatch(/^t-[0-9a-f]{8}$/);
  });
});

describe('forks', () => {
  const fake = { rows: () => [], put: () => {} } as unknown as import('./store').Store;
  it('are side chats only when asked: Fork into a new thread is a thread of its own', () => {
    const threads = new Threads(fake);
    const spec = { harness: 'codex', machine: 'local', dir: '/tmp', view: 'chat', parent: { id: 't1', at: 'r1' } } as const;
    expect(threads.create(spec).side).toBe(false);
    expect(threads.create({ ...spec, side: true }).side).toBe(true);
  });
});

describe('discovery titles', () => {
  const fake = { rows: () => [], put: () => {} } as unknown as import('./store').Store;
  const f = (title?: string) => ({ harness: 'claude' as const, sessionId: 's1', dir: '/w', title, updatedAt: 1, createdAt: 1 });
  it('take the harness title once it has one, but never over a name you gave', () => {
    const threads = new Threads(fake);
    const [t] = threads.discover('local', [f()]);
    expect(t.title).toBe('Untitled');
    threads.discover('local', [f('Fix the restore race')]);   // the prompt landed after the first look
    expect(threads.get(t.id).title).toBe('Fix the restore race');
    threads.discover('local', [f('Restore race fix')]);       // Claude Code generated its title
    expect(threads.get(t.id).title).toBe('Restore race fix');
    threads.update(t.id, { title: 'Mine', named: true });
    threads.discover('local', [f('Something else')]);
    expect(threads.get(t.id).title).toBe('Mine');
  });
});
