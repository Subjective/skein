import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '../shared/types';
import { carriedPrompts, ownEvents } from './side';

const u = (id: string): ThreadEvent => ({ t: 'user', id, text: id });
const r = (id: string): ThreadEvent => ({ t: 'text', id, text: id });
// the parent: Hi, HHey, Hey there, each answered
const parent = [u('u1'), r('r1'), u('u2'), r('r2'), u('u3'), r('r3')];

describe('side chat history', () => {
  it('counts the messages a fork carries over, up to the reply it branched at', () => {
    expect(carriedPrompts(parent, 'r1')).toBe(1);
    expect(carriedPrompts(parent, 'r3')).toBe(3);
    expect(carriedPrompts(parent)).toBe(3);            // no fork point: the whole thread
    expect(carriedPrompts(parent, 'gone')).toBe(3);    // a fork point the parent no longer has
    expect(carriedPrompts([], 'r1')).toBe(0);
  });

  it("keeps only the side chat's own turns, as both harnesses record a fork (the parent's turns first)", () => {
    const side = [u('u1'), r('r1'), u('u2'), r('r2'), u('s1'), { t: 'tool', id: 't', name: 'Read', arg: 'a', status: 'done' } as ThreadEvent, r('s1r'), u('s2'), r('s2r')];
    expect(ownEvents(side, 2).map(e => e.id)).toEqual(['s1', 't', 's1r', 's2', 's2r']);
    expect(ownEvents(side.slice(0, 4), 2)).toEqual([]);   // forked, nothing asked in it yet
    expect(ownEvents(side, 0)).toBe(side);
  });
});
