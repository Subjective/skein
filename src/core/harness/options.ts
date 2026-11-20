// What each harness offers on a machine: its models (with effort levels) and its permission modes, asked
// from the harness itself so the pickers list what it really runs.
//   Claude Code: the Agent SDK's initialize response (Query.initializationResult().models, the same list as
//     supportedModels()), from a query that sends no prompt, so no turn runs and no transcript is written.
//     SSH machines run the remote `claude` the same way the driver does (sshSpawner). Permission modes are
//     the SDK's PermissionMode values (checked against the type below); Auto mode only when a model has it.
//   Codex: the machine's app-server (`model/list`, every page; `configRequirements/read` narrows the
//     approval presets to what managed policy allows).
// Answers are cached per machine and harness; a failed query falls back to shared/models.ts and is retried
// sooner.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Options, PermissionMode, Query, SDKControlInitializeResponse, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { bundledOptions, EFFORTS, PERMS, type Choice, type HarnessOptions, type ModelDef } from '../../shared/models';
import type { Harness, Machine } from '../../shared/types';
import { log } from '../log';
import { localExecutable, sshSpawner, type QueryFn } from './claude/driver';
import type { CodexServers } from './codex/driver';
import type { Rpc } from './codex/rpc';

// Every PermissionMode the installed SDK defines must have a row in PERMS.claude (and nothing else may):
// a new SDK mode breaks the typecheck here until it is added there.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;
const _modesMatch: Exact<(typeof CLAUDE_MODES)[number], PermissionMode> = true; void _modesMatch;

const OK_TTL = 10 * 60_000, FAIL_TTL = 30_000, TIMEOUT = 25_000;

/** The SDK's ModelInfo, as much of it as we read. */
export interface ClaudeModelInfo {
  value: string; displayName: string; description?: string; resolvedModel?: string;
  supportsEffort?: boolean; supportedEffortLevels?: string[]; supportsAdaptiveThinking?: boolean; supportsAutoMode?: boolean;
}

/** Claude's models as picker rows. 'default' is Claude Code's own default (it resolves per account). */
export function claudeOptions(models: ClaudeModelInfo[]): HarnessOptions {
  const rows: ModelDef[] = models.map(m => ({
    id: m.value, label: m.displayName, ...(m.description ? { hint: m.description } : {}),
    efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []).slice() : [],
    // Ultracode needs a model that supports it; the SDK's ModelInfo has no flag for that (0.3.329), so: models with
    // effort levels and adaptive thinking (every current model, none of the older ones).
    ...(m.supportsEffort && m.supportsAdaptiveThinking ? { ultra: true } : {}),
    ...(m.value === 'default' ? { isDefault: true } : {}),
    ...(m.resolvedModel && m.resolvedModel !== m.value ? { resolved: m.resolvedModel } : {}),
  }));
  const auto = models.some(m => m.supportsAutoMode);
  return { models: rows, perms: PERMS.claude.filter(p => p.id !== 'auto' || auto), efforts: EFFORTS, source: 'harness' };
}

/** Codex's Model, as much of it as we read (protocol/v2/Model.ts). */
export interface CodexModel {
  id: string; model: string; displayName: string; description?: string; hidden?: boolean; isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[]; defaultReasoningEffort?: string;
}
/** What managed policy allows (protocol/v2/ConfigRequirements.ts), as much as we read. */
export interface CodexRequirements { allowedApprovalPolicies?: unknown[] | null; allowedApprovalsReviewers?: string[] | null; allowedSandboxModes?: string[] | null }

/** The approval preset each Codex permission choice sets (driver.ts codexPerm uses the same pairs). */
const CODEX_PRESET: Record<string, { approval: string; sandbox: string; reviewer: string }> = {
  auto: { approval: 'on-request', sandbox: 'workspace-write', reviewer: 'user' },
  'auto-review': { approval: 'on-request', sandbox: 'workspace-write', reviewer: 'auto_review' },
  'full-access': { approval: 'never', sandbox: 'danger-full-access', reviewer: 'user' },
  'read-only': { approval: 'on-request', sandbox: 'read-only', reviewer: 'user' },
};

export function codexOptions(models: CodexModel[], req?: CodexRequirements | null): HarnessOptions {
  const known = new Set(EFFORTS.map(e => e.id));
  const efforts: Choice[] = [...EFFORTS];
  const rows: ModelDef[] = models.filter(m => !m.hidden).map(m => {
    const es = (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort);
    for (const e of es) if (!known.has(e)) { known.add(e); efforts.push({ id: e, label: e[0].toUpperCase() + e.slice(1) }); }
    // lowest first, as EFFORTS orders them (ultra above max is the top stop); a name we don't know keeps its place last
    const rank = (e: string) => { const i = EFFORTS.findIndex(x => x.id === e); return i < 0 ? EFFORTS.length : i; };
    es.sort((a, b) => rank(a) - rank(b));
    return {
      id: m.model || m.id, label: m.displayName || m.model || m.id, ...(m.description ? { hint: m.description } : {}),
      efforts: es, ...(m.defaultReasoningEffort ? { effort: m.defaultReasoningEffort } : {}), ...(m.isDefault ? { isDefault: true } : {}),
    };
  });
  rows.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
  const okApproval = (a: string) => !req?.allowedApprovalPolicies || req.allowedApprovalPolicies.includes(a);
  const okSandbox = (s: string) => !req?.allowedSandboxModes || req.allowedSandboxModes.includes(s);
  const okReviewer = (r: string) => !req?.allowedApprovalsReviewers || req.allowedApprovalsReviewers.includes(r);
  const perms = PERMS.codex.filter(p => { const x = CODEX_PRESET[p.id]; return !x || (okApproval(x.approval) && okSandbox(x.sandbox) && okReviewer(x.reviewer)); });
  return { models: rows, perms: perms.length ? perms : PERMS.codex, efforts, source: 'harness' };
}

/** A prompt that never comes: the query initializes and answers control requests, and no turn runs. */
const silence = (stop: Promise<void>): AsyncIterable<SDKUserMessage> => ({
  [Symbol.asyncIterator]: () => ({ next: () => stop.then(() => ({ value: undefined as never, done: true })) }),
});

/** Claude Code's initialize response for a folder on the machine (its models, commands and skills). */
export async function claudeInit(m: Machine, query: QueryFn, dir?: string): Promise<SDKControlInitializeResponse> {
  let end!: () => void;
  const stopped = new Promise<void>(r => (end = r));
  let stderr = '';
  const where = dir ?? (m.ssh ? m.home || '~' : homedir());
  const opts: Options = {
    cwd: m.ssh ? undefined : expandLocal(where),
    // the same settings the driver reads, so availableModels / modelPicker narrow the list as they do in a chat,
    // and the folder's project commands and skills are listed
    settingSources: ['user', 'project', 'local'],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    stderr: d => { stderr = (stderr + d).slice(-2000); },
  };
  if (m.ssh) opts.spawnClaudeCodeProcess = sshSpawner(m, where, d => { stderr = (stderr + d).slice(-2000); });
  else { const exe = localExecutable(); if (exe) opts.pathToClaudeCodeExecutable = exe; }
  let q: Query | null = null;
  try {
    q = query({ prompt: silence(stopped), options: opts });
    return await withTimeout(q.initializationResult(), 'Claude Code');
  } catch (e) {
    throw new Error(((e as Error).message || String(e)) + (stderr.trim() ? ` (${stderr.trim().split('\n').pop()})` : ''));
  } finally {
    end();
    try { q?.close(); } catch { /* already gone */ }
  }
}

export async function askClaude(m: Machine, query: QueryFn): Promise<HarnessOptions> {
  const init = await claudeInit(m, query);
  const models = (init.models ?? []) as ClaudeModelInfo[];
  if (!models.length) throw new Error('Claude Code listed no models');
  return claudeOptions(models);
}

const expandLocal = (dir: string) => (dir === '~' ? homedir() : dir.startsWith('~/') || dir.startsWith('~\\') ? join(homedir(), dir.slice(2)) : dir);

export async function askCodex(rpc: Rpc): Promise<HarnessOptions> {
  const models: CodexModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r: { data: CodexModel[]; nextCursor: string | null } = await withTimeout(rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) }), 'Codex');
    models.push(...(r.data ?? []));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  if (!models.length) throw new Error('Codex listed no models');
  const req = await withTimeout(rpc.request<{ requirements: CodexRequirements | null }>('configRequirements/read', {}), 'Codex')
    .then(r => r.requirements).catch(() => null);
  return codexOptions(models, req);
}

export function withTimeout<T>(p: Promise<T>, who: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${who} did not answer in ${TIMEOUT / 1000} s`)), TIMEOUT); })])
    .finally(() => clearTimeout(t));
}

/** Answers kept by key for a while: ten minutes, or 30 s for a failure, which gives `fallback(why)` meanwhile. */
export class Kept<T> {
  private kept = new Map<string, { at: number; ttl: number; v: Promise<T> }>();
  constructor(private fallback: (key: string, why: string) => T, private now = () => Date.now()) {}

  get(k: string, ask: () => Promise<T>): Promise<T> {
    const c = this.kept.get(k);
    if (c && this.now() - c.at < c.ttl) return c.v;
    const entry = { at: this.now(), ttl: OK_TTL, v: null as unknown as Promise<T> };
    entry.v = ask().catch(e => {
      const why = (e as Error).message || String(e);
      log('harness', 'ask', k, why);
      entry.ttl = FAIL_TTL;
      return this.fallback(k, why);
    });
    this.kept.set(k, entry);
    return entry.v;
  }

  /** Forget a machine's answers (keys start with its id). */
  drop(machine?: string) { for (const k of [...this.kept.keys()]) if (!machine || k.startsWith(machine + ':')) this.kept.delete(k); }
}

/** Per machine and harness: the answer, or the fallback with the reason. */
export class OptionsCache {
  private kept: Kept<HarnessOptions>;
  constructor(private ask: (m: Machine, h: Harness) => Promise<HarnessOptions>, now = () => Date.now()) {
    this.kept = new Kept((k, why) => bundledOptions(k.split(':')[1] as Harness, why), now);
  }
  get(m: Machine, h: Harness): Promise<HarnessOptions> { return this.kept.get(`${m.id}:${h}`, () => this.ask(m, h)); }
  drop(machine?: string) { this.kept.drop(machine); }
}

/** The options source createHarnesses uses: Claude through the SDK, Codex through the machine's app-server. */
export function harnessOptions(query: () => Promise<QueryFn>, servers: CodexServers) {
  return new OptionsCache(async (m, h) => {
    if (h === 'claude') return askClaude(m, await query());
    return askCodex(await servers.get(m));
  });
}
