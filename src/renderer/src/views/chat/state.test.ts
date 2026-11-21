import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@shared/types';
import { mergeSnapshot, outgoing, QI, syncQuotes, TK, tokenOf, withIcons } from './state';

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

describe('quote chips', () => {
  const q = { id: 'q1', text: 'Most of the time is spent in the profile', src: 'ev:t:e' };
  it('a chip leads with the space its chat icon is drawn over, then the clipped words in quotes', () => {
    expect(tokenOf(q)).toBe(`${TK}${QI}“Most of the time is spent in the profile”${TK}`);
    expect(tokenOf({ ...q, text: 'x'.repeat(60) })).toBe(`${TK}${QI}“${'x'.repeat(39)}…”${TK}`);
  });
  it('sends the whole quote, without the icon space or the marks', () => {
    const d = { text: `${tokenOf(q)} why?`, images: [], quotes: [q] };
    expect(outgoing(d)).toBe('“Most of the time is spent in the profile” why?');
  });
  it('a draft saved before the icon still matches its quote and sends it', () => {
    const old = `see ${TK}“Most of the time is spent in the profile”${TK} here`;
    const text = withIcons(old);
    expect(text).toBe(`see ${tokenOf(q)} here`);
    expect(syncQuotes({ text, images: [], quotes: [q] })).toEqual([q]);
    expect(withIcons(text)).toBe(text);
  });
  it('undoing a deleted chip brings its quote back', () => {
    const text = `${tokenOf(q)} why?`;
    expect(syncQuotes({ text: ' why?', images: [], quotes: [q] })).toEqual([]);
    expect(syncQuotes({ text, images: [], quotes: [] })).toEqual([q]);
  });
});
