import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@shared/types';
import { mergeSnapshot } from './state';

describe('mergeSnapshot', () => {
  it('a Codex first prompt shows once: the rollout line and the live prompt are one message', () => {
    // the history load starts as the thread opens; the prompt is pushed (client id) before the rollout comes back (u-0)
    const snap: ThreadEvent[] = [{ t: 'user', id: 'u-0', text: 'Fix the build' }];
    const pushed: ThreadEvent[] = [{ t: 'user', id: 'c1d2', text: 'Fix the build', at: 1 }];
    expect(mergeSnapshot(snap, pushed)).toEqual(pushed);
  });
  it('keeps an earlier message with the same words, and anything not pushed', () => {
    const snap: ThreadEvent[] = [{ t: 'user', id: 'u-0', text: 'go on' }, { t: 'text', id: 'a-1', text: 'Done.' }, { t: 'user', id: 'u-2', text: 'go on' }];
    const pushed: ThreadEvent[] = [{ t: 'user', id: 'c9', text: 'go on' }];
    expect(mergeSnapshot(snap, pushed).map(e => e.id)).toEqual(['u-0', 'a-1', 'c9']);
  });
  it('same ids: the push wins (Claude names the transcript line with the id it sent)', () => {
    const snap: ThreadEvent[] = [{ t: 'user', id: 'x', text: 'hi' }, { t: 'text', id: 'y', text: 'Hel' }];
    const pushed: ThreadEvent[] = [{ t: 'text', id: 'y', text: 'Hello' }];
    expect(mergeSnapshot(snap, pushed).map(e => e.id)).toEqual(['x', 'y']);
  });
});
