// What the composer's pickers offer per harness, from the shared catalog (src/shared/models.ts), so the
// launcher, the chat and the backend agree. The backend takes ids or labels; we store ids.
import type { Harness } from '@shared/types';
import { EFFORTS as ALL_EFFORTS, MODELS, PERMS as ALL_PERMS, effortId, modelId, permId } from '@shared/models';

export interface Opt { id: string; label: string; hint?: string }

export const models = (h: Harness): Opt[] => MODELS[h];
/** Effort levels the model takes (all of the harness's when the model is unknown). */
export const efforts = (h: Harness, model?: string): Opt[] => {
  const m = MODELS[h].find(x => x.id === modelId(h, model)) || MODELS[h][0];
  return ALL_EFFORTS.filter(e => m.efforts.includes(e.id));
};
export const PERMS = ALL_PERMS;
export const modelLabel = (h: Harness, v?: string) => MODELS[h].find(m => m.id === modelId(h, v))?.label ?? v ?? MODELS[h][0].label;
export const effortLabel = (v?: string) => ALL_EFFORTS.find(e => e.id === effortId(v))?.label ?? 'Medium';
export const permLabel = (h: Harness, v?: string) => ALL_PERMS[h].find(p => p.id === permId(h, v))?.label ?? ALL_PERMS[h][0].label;
export { effortId, modelId, permId };

/** / commands. Ours open a picker or a popup; the harness's go through as text. */
export const OURS: [string, string][] = [['/model', 'Model and effort'], ['/side', 'Side chat about the last reply'], ['/sidechats', 'Side chats of this thread'], ['/subagents', 'Subagents of this thread']];
export const HARNESS_SLASH: Record<Harness, [string, string][]> = {
  claude: [['/clear', 'Start a fresh conversation'], ['/compact', 'Summarise to free up context'], ['/review', 'Review the current diff'], ['/init', 'Create CLAUDE.md'], ['/cost', 'Usage this thread'], ['/memory', 'Edit memory files'], ['/status', 'Thread and account status']],
  codex: [['/compact', 'Summarise to free up context'], ['/review', 'Review the current diff'], ['/diff', 'Show the working diff'], ['/init', 'Create AGENTS.md'], ['/status', 'Thread and account status']],
};

export const INSTALL: Record<Harness, string> = { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex' };
