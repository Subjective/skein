import { describe, expect, it } from 'vitest';
import { loadError } from './netErrors';

describe('loadError', () => {
  it('puts known net errors in words', () => {
    expect(loadError('net::ERR_CONNECTION_REFUSED')).toBe('nothing is listening there');
    expect(loadError('ERR_UNSAFE_PORT')).toBe('that port is blocked');
  });
  it('keeps the name of an unknown one', () => expect(loadError('net::ERR_BLOCKED_BY_CLIENT')).toBe('ERR_BLOCKED_BY_CLIENT'));
  it('never says nothing', () => expect(loadError('')).toBe('it failed'));
});
