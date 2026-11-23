import { describe, expect, it } from 'vitest';
import { dur } from './duration';

describe('dur', () => {
  it('reads without zero padding', () => {
    expect(dur(4_200)).toBe('4s');
    expect(dur(59_400)).toBe('59s');
    expect(dur(59_600)).toBe('1m 0s');
    expect(dur(66_000)).toBe('1m 6s');
    expect(dur(125_000)).toBe('2m 5s');
    expect(dur(3_725_000)).toBe('1h 2m');
  });
});
