// What each harness can run: models, effort levels and permission modes, with the labels the UI shows.
// The chat backend accepts either a label ('Opus 5.5', 'Accept edits') or an id ('opus', 'acceptEdits'),
// so pickers can pass whatever they show. No Node or DOM imports.
import type { Harness } from './types';

export interface ModelDef {
  /** Passed to the harness (`--model`, thread/start `model`). */
  id: string;
  label: string;
  /** Effort ids this model accepts, lowest first. */
  efforts: string[];
  /** Offers the Ultracode switch in the model picker. */
  ultra?: boolean;
}

export interface Choice { id: string; label: string; hint?: string }

const E = (...ids: string[]) => ids;

export const MODELS: Record<Harness, ModelDef[]> = {
  claude: [
    { id: 'opus', label: 'Opus 5.5', efforts: E('low', 'medium', 'high', 'max'), ultra: true },
    { id: 'sonnet', label: 'Sonnet 5.5', efforts: E('low', 'medium', 'high', 'max'), ultra: true },
    { id: 'haiku', label: 'Haiku 5.5', efforts: E('low', 'medium', 'high') },
    { id: 'claude-fable-5-2', label: 'Fable 5.2', efforts: E('low', 'medium', 'high', 'max'), ultra: true },
  ],
  codex: [
    { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', efforts: E('low', 'medium', 'high', 'xhigh') },
    { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', efforts: E('low', 'medium', 'high') },
  ],
};

export const EFFORTS: Choice[] = [
  { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Ultra' }, { id: 'max', label: 'Max' },
];

export const PERMS: Record<Harness, Choice[]> = {
  claude: [
    { id: 'default', label: 'Ask before edits', hint: 'Asks before each edit and command' },
    { id: 'acceptEdits', label: 'Accept edits', hint: 'Edits without asking; asks before commands' },
    { id: 'plan', label: 'Plan mode', hint: 'Reads and plans; changes nothing until you approve' },
    { id: 'bypassPermissions', label: 'Full access', hint: 'Never asks' },
  ],
  codex: [
    { id: 'read-only', label: 'Read only', hint: 'Reads files; asks before any change' },
    { id: 'auto', label: 'Auto', hint: 'Edits and runs in the folder; asks to go outside it' },
    { id: 'full', label: 'Full access', hint: 'Never asks; no sandbox' },
  ],
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');
const pick = (list: { id: string; label: string }[], v?: string) => {
  if (!v) return undefined;
  const k = key(v);
  return list.find(x => key(x.id) === k || key(x.label) === k)?.id;
};

/** A model id for the harness. Unknown values pass through, so a model newer than this list still works. */
export const modelId = (h: Harness, v?: string) => (v ? pick(MODELS[h], v) ?? v : undefined);
export const effortId = (v?: string) => (v ? pick(EFFORTS, v) ?? v.toLowerCase() : undefined);
export const permId = (h: Harness, v?: string) => pick(PERMS[h], v);
export const modelLabel = (h: Harness, id?: string) => MODELS[h].find(m => m.id === id)?.label ?? id;
