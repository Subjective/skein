import { describe, expect, it } from 'vitest';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import type { Machine } from '../../shared/types';
import type { QueryFn } from './claude/driver';
import { askClaude, askCodex, claudeOptions, codexOptions, OptionsCache, type ClaudeModelInfo, type CodexModel } from './options';
import type { Rpc } from './codex/rpc';

const local: Machine = { id: 'local', name: 'here', os: 'Linux', link: 'up', has: ['claude', 'codex'] };
const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];

// as Claude Code 2.1.329 lists them (trimmed)
const CLAUDE: ClaudeModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ALL, supportsAdaptiveThinking: true, supportsAutoMode: true, supportsFastMode: true },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', supportsEffort: true, supportedEffortLevels: ALL, supportsAdaptiveThinking: true, supportsAutoMode: true },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
];

// protocol/v2/Model.ts shaped
const CODEX: CodexModel[] = [
  { id: 'b', model: 'gpt-b', displayName: 'GPT B', description: 'Fast', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'low', isDefault: false },
  { id: 'a', model: 'gpt-a', displayName: 'GPT A', description: 'Smart', supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra-deep' }], defaultReasoningEffort: 'high', isDefault: true },
  { id: 'h', model: 'gpt-hidden', displayName: 'Hidden', hidden: true },
];

describe('harness options', () => {
  it('turns Claude Code\'s model list into picker rows', () => {
    const o = claudeOptions(CLAUDE);
    expect(o.source).toBe('harness');
    expect(o.models.map(m => m.id)).toEqual(['default', 'opus', 'claude-haiku-4-5-20251001']);
    expect(o.models[0]).toMatchObject({ label: 'Default (recommended)', isDefault: true, efforts: ALL, ultra: true, resolved: 'claude-opus-5-5' });
    expect(o.models[2]).toMatchObject({ label: 'Haiku 4.5', efforts: [] });
    expect(o.models[2].ultra).toBeUndefined();
    // fast mode where Claude Code says the model has it
    expect(o.models[0].speeds).toEqual([{ id: 'fast', label: 'Fast mode' }]);
    expect(o.models[1].speeds).toBeUndefined();
    expect(o.perms.map(p => p.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
    // no model with auto mode: Auto mode isn't offered
    expect(claudeOptions([CLAUDE[2]]).perms.map(p => p.id)).not.toContain('auto');
  });

  it('turns Codex model/list into picker rows, default first, hidden left out', () => {
    const o = codexOptions(CODEX);
    expect(o.models.map(m => m.id)).toEqual(['gpt-a', 'gpt-b']);
    expect(o.models[0]).toMatchObject({ label: 'GPT A', hint: 'Smart', efforts: ['minimal', 'high', 'ultra-deep'], effort: 'high', isDefault: true });
    expect(o.efforts.find(e => e.id === 'ultra-deep')?.label).toBe('Ultra-deep');
    expect(o.perms.map(p => p.id)).toEqual(['read-only', 'auto', 'auto-review', 'full-access']);
    expect(o.models[0].speeds).toBeUndefined();
  });

  it('lists a Codex model\'s faster service tiers, in its words, with its default tier', () => {
    const tiers = [{ id: 'default', name: 'Standard' }, { id: 'priority', name: 'Fast', description: '2x speed, increased usage' }];
    const [a, b] = codexOptions([{ ...CODEX[1], serviceTiers: tiers, defaultServiceTier: 'priority' }, { ...CODEX[0], serviceTiers: tiers, defaultServiceTier: null }]).models;
    expect(a).toMatchObject({ speeds: [{ id: 'priority', label: 'Fast', hint: '2x speed, increased usage' }], speed: 'priority' });
    expect(b.speeds).toHaveLength(1);
    expect(b.speed).toBeUndefined();
  });

  it('puts Codex\'s ultra effort at the top of the track, above max, whatever order model/list gives', () => {
    const o = codexOptions([{ id: 'u', model: 'gpt-u', displayName: 'U', isDefault: true, defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }, { reasoningEffort: 'low' }, { reasoningEffort: 'max' }, { reasoningEffort: 'high' }] }]);
    expect(o.models[0].efforts).toEqual(['low', 'high', 'max', 'ultra']);
    expect(o.efforts.find(e => e.id === 'ultra')?.label).toBe('Ultra');
    expect(o.efforts.filter(e => e.id === 'ultra')).toHaveLength(1);
  });

  it('leaves out Codex presets that managed policy forbids', () => {
    expect(codexOptions(CODEX, { allowedApprovalPolicies: ['on-request'], allowedSandboxModes: null }).perms.map(p => p.id)).toEqual(['read-only', 'auto', 'auto-review']);
    expect(codexOptions(CODEX, { allowedApprovalsReviewers: ['user'] }).perms.map(p => p.id)).toEqual(['read-only', 'auto', 'full-access']);
    expect(codexOptions(CODEX, { allowedApprovalPolicies: null, allowedSandboxModes: ['read-only'] }).perms.map(p => p.id)).toEqual(['read-only']);
  });

  it('asks Codex for every page of models', async () => {
    const calls: [string, unknown][] = [];
    const rpc = { request: async (method: string, p: { cursor?: string }) => {
      calls.push([method, p]);
      if (method === 'model/list') return p.cursor ? { data: [CODEX[1]], nextCursor: null } : { data: [CODEX[0]], nextCursor: 'c1' };
      return { requirements: { allowedApprovalPolicies: ['on-request', 'never'], allowedSandboxModes: ['workspace-write', 'danger-full-access'] } };
    } } as unknown as Rpc;
    const o = await askCodex(rpc);
    expect(o.models.map(m => m.id)).toEqual(['gpt-a', 'gpt-b']);
    expect(o.perms.map(p => p.id)).toEqual(['auto', 'auto-review', 'full-access']);
    expect(calls.map(c => c[0])).toEqual(['model/list', 'model/list', 'configRequirements/read']);
  });

  it('asks Claude without sending a prompt and closes the query', async () => {
    let closed = false, sent = false, got: Options | undefined;
    const q: QueryFn = ({ prompt, options }) => {
      got = options;
      void (async () => { for await (const _ of prompt) sent = true; })();
      return { initializationResult: async () => ({ models: CLAUDE }), close: () => { closed = true; } } as unknown as Query;
    };
    const o = await askClaude(local, q);
    expect(o.models).toHaveLength(3);
    expect(closed).toBe(true);
    expect(sent).toBe(false);
    expect(got?.settingSources).toEqual(['user', 'project', 'local']);
  });

  it('falls back to the bundled lists when the harness can\'t be asked, and asks again sooner', async () => {
    let t = 0, n = 0;
    const cache = new OptionsCache(async () => { n++; throw new Error('codex: not found'); }, () => t);
    const o = await cache.get(local, 'codex');
    expect(o).toMatchObject({ source: 'bundled', error: 'codex: not found' });
    expect(o.models.length).toBeGreaterThan(0);
    await cache.get(local, 'codex'); expect(n).toBe(1);
    t = 31_000; await cache.get(local, 'codex'); expect(n).toBe(2);
  });

  it('keeps an answer per machine and harness for ten minutes', async () => {
    let t = 0, n = 0;
    const cache = new OptionsCache(async (_m, h) => { n++; return h === 'claude' ? claudeOptions(CLAUDE) : codexOptions(CODEX); }, () => t);
    await cache.get(local, 'claude'); await cache.get(local, 'claude'); await cache.get(local, 'codex');
    expect(n).toBe(2);
    t = 5 * 60_000; await cache.get(local, 'claude'); expect(n).toBe(2);
    t = 11 * 60_000; await cache.get(local, 'claude'); expect(n).toBe(3);
    cache.drop('local'); await cache.get(local, 'codex'); expect(n).toBe(4);
  });
});
