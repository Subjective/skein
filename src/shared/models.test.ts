import { describe, expect, it } from 'vitest';
import { bundledOptions, effortId, findModel, modelId, modelLabel, PERMS, permId, snapEffort } from './models';

describe('model catalog', () => {
  it('accepts labels or ids', () => {
    expect(modelId('claude', 'Opus 5.5')).toBe('opus');
    expect(modelId('claude', 'opus')).toBe('opus');
    expect(modelId('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(modelId('codex', 'GPT-6.2 Sol')).toBe('gpt-6.2-sol');
    expect(effortId('Ultra')).toBe('ultra');   // Codex's effort above max, not xhigh
    expect(effortId('X-High')).toBe('xhigh');
    expect(effortId('Extra high')).toBe('xhigh');
    expect(effortId('High')).toBe('high');
    expect(effortId('minimal')).toBe('minimal');
    expect(permId('claude', 'Accept edits')).toBe('acceptEdits');
    expect(permId('claude', 'plan')).toBe('plan');
    expect(permId('codex', 'nonsense')).toBeUndefined();
    expect(modelLabel('codex', 'gpt-6.2-astra')).toBe('GPT-6.2 Astra');
  });

  it('keeps older names working', () => {
    // labels and ids stored before the lists followed the harnesses
    expect(permId('claude', 'Ask before edits')).toBe('default');
    expect(permId('claude', 'Full access')).toBe('bypassPermissions');
    expect(permId('codex', 'full')).toBe('full-access');
    expect(permId('codex', 'Full access')).toBe('full-access');
    expect(permId('codex', 'Auto')).toBe('auto');
    expect(permId('codex', 'Default')).toBe('auto');
  });

  it('looks a model up in a live list first, then the bundled one', () => {
    const live = [{ id: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['low'] }];
    expect(modelId('claude', 'Opus 4.8', live)).toBe('claude-opus-4-8');
    expect(modelLabel('claude', 'claude-opus-4-8', live)).toBe('Opus 4.8');
    expect(modelId('claude', 'Sonnet 5.5', live)).toBe('sonnet');
    // a pinned full id shows as the alias that resolves to it (not as the Default row)
    expect(findModel('claude', 'claude-opus-5-5')?.id).toBe('opus');
    expect(modelLabel('claude', 'claude-opus-5-5')).toBe('Opus 5.5');
  });

  it('offers every Claude permission mode, bypass included', () => {
    expect(PERMS.claude.map(p => p.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
    expect(PERMS.codex.map(p => p.label)).toEqual(['Ask for approval', 'Approve for me', 'Full Access', 'Read Only']);
    expect(permId('codex', 'Approve for me')).toBe('auto-review');
    // the fallback claims no ultra effort it doesn't know a model has
    expect(bundledOptions('codex').models.some(m => m.efforts.includes('ultra'))).toBe(false);
    const b = bundledOptions('codex', 'no codex');
    expect(b).toMatchObject({ source: 'bundled', error: 'no codex' });
  });
});

describe('snapEffort', () => {
  const codex = { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], effort: 'medium' };
  const claude = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
  it('keeps a level the model has', () => { expect(snapEffort('high', claude)).toBe('high'); });
  it('goes to the nearest level the model has', () => {
    expect(snapEffort('ultra', claude)).toBe('max');
    expect(snapEffort('max', { efforts: ['low', 'medium', 'high'] })).toBe('high');
    expect(snapEffort('minimal', codex)).toBe('low');
  });
  it('takes the lower level on a tie', () => { expect(snapEffort('medium', { efforts: ['low', 'high'] })).toBe('low'); });
  it('takes the default for an unknown level, and nothing for a model without efforts', () => {
    expect(snapEffort('turbo', codex)).toBe('medium');
    expect(snapEffort('high', { efforts: [] })).toBe('');
  });
});
