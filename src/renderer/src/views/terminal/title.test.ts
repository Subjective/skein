import { describe, expect, it } from 'vitest';
import { titleRunning } from './title';

describe('terminal title', () => {
  it('reads Claude Code\'s idle ✳ as idle and its spinner as running', () => {
    expect(titleRunning('✳ Claude Code')).toBe(false);
    expect(titleRunning('✳ Two-word greeting')).toBe(false);
    expect(titleRunning('◐ Claude Code')).toBe(true);
    expect(titleRunning('◑ Two-word greeting')).toBe(true);
    expect(titleRunning('⠋ Working')).toBe(true);
  });
  it('a plain title is idle', () => {
    expect(titleRunning('bash')).toBe(false);
    expect(titleRunning('Fix the restore race')).toBe(false);
  });
});
