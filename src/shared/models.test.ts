import { describe, expect, it } from 'vitest';
import { effortId, modelId, modelLabel, permId } from './models';

describe('model catalog', () => {
  it('accepts labels or ids', () => {
    expect(modelId('claude', 'Opus 5.5')).toBe('opus');
    expect(modelId('claude', 'opus')).toBe('opus');
    expect(modelId('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(modelId('codex', 'GPT-6.2 Sol')).toBe('gpt-6.2-sol');
    expect(effortId('Ultra')).toBe('xhigh');
    expect(effortId('High')).toBe('high');
    expect(permId('claude', 'Accept edits')).toBe('acceptEdits');
    expect(permId('claude', 'plan')).toBe('plan');
    expect(permId('codex', 'Full access')).toBe('full');
    expect(permId('codex', 'nonsense')).toBeUndefined();
    expect(modelLabel('codex', 'gpt-6.2-astra')).toBe('GPT-6.2 Astra');
  });
});
