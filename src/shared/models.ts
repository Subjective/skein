// What each harness can run: models, effort levels and permission modes, with the labels the UI shows.
// The live lists come from the harness itself (core/harness/options.ts: Claude's initialize response,
// Codex's model/list); the lists here are the fallback when that query fails, and the source of the
// permission modes (Claude: the Agent SDK's PermissionMode; Codex: its built-in approval presets).
// The chat backend accepts either a label ('Opus 5.5', 'Accept edits') or an id ('opus', 'acceptEdits'),
// so pickers can pass whatever they show. No Node or DOM imports.
import type { Harness } from './types';

export interface ModelDef {
  /** Passed to the harness (`--model`, thread/start `model`). */
  id: string;
  label: string;
  /** The harness's own description of the model. */
  hint?: string;
  /** Effort ids this model accepts, lowest first. Empty: the model takes no effort setting. */
  efforts: string[];
  /** The effort the harness uses when none is set (Codex says; Claude: the model's own default). */
  effort?: string;
  /** Offers the Ultracode switch in the model picker. */
  ultra?: boolean;
  /** The harness's default model. */
  isDefault?: boolean;
  /** The full model id an alias resolves to (Claude 'opus' -> 'claude-opus-5-5'), so a thread pinned to that
   *  id shows the alias's name and check. */
  resolved?: string;
}

export interface Choice { id: string; label: string; hint?: string; /** Other names that mean this choice (older labels and ids). */ aka?: string[] }

/** What a harness offers on a machine. `source` says whether the harness answered or this file's fallback is shown. */
export interface HarnessOptions {
  models: ModelDef[];
  perms: Choice[];
  efforts: Choice[];
  source: 'harness' | 'bundled';
  /** Why the harness could not be asked (source 'bundled'). */
  error?: string;
}

const E = (...ids: string[]) => ids;
const CLAUDE_EFFORTS = E('low', 'medium', 'high', 'xhigh', 'max');

/** The fallback model lists. Claude: what Claude Code 2.1.329 (Agent SDK 0.3.329) lists first for a
 *  first-party account. Codex: the mockup's models (not checked against a live Codex). */
export const MODELS: Record<Harness, ModelDef[]> = {
  claude: [
    { id: 'default', label: 'Default (recommended)', hint: 'Opus 5.5 · Best for everyday, complex tasks', efforts: CLAUDE_EFFORTS, ultra: true, isDefault: true },
    { id: 'opus', label: 'Opus 5.5', hint: 'For complex work and everyday tasks', efforts: CLAUDE_EFFORTS, ultra: true, resolved: 'claude-opus-5-5' },
    { id: 'fable', label: 'Fable 5.2', hint: 'For your toughest challenges', efforts: CLAUDE_EFFORTS, ultra: true, resolved: 'claude-fable-5-2' },
    { id: 'sonnet', label: 'Sonnet 5.5', hint: 'Most efficient for simpler tasks', efforts: CLAUDE_EFFORTS, ultra: true, resolved: 'claude-sonnet-5-5' },
    { id: 'haiku', label: 'Haiku 5.5', hint: 'Fastest for quick answers', efforts: CLAUDE_EFFORTS, ultra: true, resolved: 'claude-haiku-5-5' },
  ],
  codex: [
    { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', efforts: E('low', 'medium', 'high', 'xhigh'), effort: 'medium', isDefault: true },
    { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', efforts: E('low', 'medium', 'high'), effort: 'medium' },
  ],
};

/** Every effort level either harness names, lowest first (Codex ReasoningEffort, Claude EffortLevel). A track
 *  lists a model's efforts in this order. */
export const EFFORTS: Choice[] = [
  { id: 'none', label: 'None' }, { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'X-High', aka: ['Extra high'] }, { id: 'max', label: 'Max' },
  // Codex: a reasoning effort above max (ReasoningEffort is a free string; a model lists it when it has it)
  { id: 'ultra', label: 'Ultra' },
];

/** Permission modes. Claude: every value of the Agent SDK's PermissionMode (core/harness/options.ts checks
 *  the list against the type), in Claude Code's shift-tab order, with the SDK's descriptions. Codex: its
 *  built-in approval presets (codex `/approvals`: id, name and description), which set the approval
 *  policy and sandbox (core/harness/codex/driver.ts codexPerm). */
export const PERMS: Record<Harness, Choice[]> = {
  claude: [
    { id: 'default', label: 'Default', hint: 'Asks before edits and commands', aka: ['Ask before edits', 'Ask permissions'] },
    { id: 'acceptEdits', label: 'Accept edits', hint: 'Edits files without asking; asks before commands' },
    { id: 'plan', label: 'Plan mode', hint: 'Reads and plans; changes nothing until you approve' },
    { id: 'auto', label: 'Auto mode', hint: 'A classifier approves or denies each request' },
    { id: 'dontAsk', label: "Don't ask", hint: 'Never asks; denies anything not allowed beforehand' },
    { id: 'bypassPermissions', label: 'Bypass permissions', hint: 'Never asks; runs everything', aka: ['Full access', 'bypass'] },
  ],
  codex: [
    { id: 'read-only', label: 'Read Only', hint: 'Codex can read files in the current workspace. Approval is required to edit files or access the internet.' },
    { id: 'auto', label: 'Default', hint: 'Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.', aka: ['Auto', 'Agent'] },
    { id: 'full-access', label: 'Full Access', hint: 'Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.', aka: ['full'] },
  ],
};

/** The fallback options for a harness (also what the renderer shows until the harness answers). */
export const bundledOptions = (h: Harness, error?: string): HarnessOptions =>
  ({ models: MODELS[h], perms: PERMS[h], efforts: EFFORTS, source: 'bundled', ...(error ? { error } : {}) });

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');
const pick = (list: { id: string; label: string; aka?: string[] }[], v?: string) => {
  if (!v) return undefined;
  const k = key(v);
  return list.find(x => key(x.id) === k || key(x.label) === k || x.aka?.some(a => key(a) === k))?.id;
};

/** A model id for the harness, from an id or a label in `list` (default: the fallback list). Unknown values
 *  pass through, so a model newer than any list still works. */
export const modelId = (h: Harness, v?: string, list: ModelDef[] = MODELS[h]) =>
  (v ? pick(list, v) ?? pick(MODELS[h], v) ?? v : undefined);
export const effortId = (v?: string) => (v ? pick(EFFORTS, v) ?? v.toLowerCase() : undefined);
export const permId = (h: Harness, v?: string) => pick(PERMS[h], v);
/** The row for a stored model value: by id or label, else a pinned full id by what an alias resolves to. */
export const findModel = (h: Harness, v?: string, list: ModelDef[] = MODELS[h]) => {
  if (!v) return undefined;
  const id = modelId(h, v, list);
  return list.find(m => m.id === id) ?? list.find(m => m.resolved === id && m.id !== 'default');
};
export const modelLabel = (h: Harness, id?: string, list: ModelDef[] = MODELS[h]) =>
  findModel(h, id, list)?.label ?? findModel(h, id)?.label ?? id;
