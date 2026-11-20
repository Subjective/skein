import { describe, expect, it } from 'vitest';
import { discoveredId } from './threads';

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
