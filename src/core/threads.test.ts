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
