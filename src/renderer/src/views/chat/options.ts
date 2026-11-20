// What the composer's pickers offer per harness. Models come from the launcher's list, so a new thread
// and a running one offer the same choices. Values are what the harness takes; labels are what we show.
import type { Harness } from '@shared/types';
import { MODELS } from '../../shell/Launcher';

export interface Opt { id: string; label: string }

export const models = (h: Harness): Opt[] => MODELS[h];
export const EFFORTS: Record<Harness, Opt[]> = {
  claude: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'max', label: 'Max' }],
  codex: [{ id: 'minimal', label: 'Minimal' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }],
};
export const PERMS: Record<Harness, Opt[]> = {
  claude: [{ id: 'default', label: 'Ask before edits' }, { id: 'acceptEdits', label: 'Accept edits' }, { id: 'plan', label: 'Plan mode' }, { id: 'bypassPermissions', label: 'Full access' }],
  codex: [{ id: 'read-only', label: 'Read only' }, { id: 'auto', label: 'Auto' }, { id: 'full-access', label: 'Full access' }],
};
const find = (list: Opt[], v?: string) => list.find(o => o.id === v || o.label.toLowerCase() === v?.toLowerCase());
export const modelLabel = (h: Harness, v?: string) => find(models(h), v)?.label ?? (v || 'Default');
export const effortLabel = (h: Harness, v?: string) => find(EFFORTS[h], v)?.label ?? (v || 'Medium');
export const permLabel = (h: Harness, v?: string) => find(PERMS[h], v)?.label ?? (v || PERMS[h][0].label);

/** / commands. Ours open a picker or a popup; the harness's go through as text. */
export const OURS: [string, string][] = [['/model', 'Model and effort'], ['/side', 'Side chat about the last reply'], ['/sidechats', 'Side chats of this thread'], ['/subagents', 'Subagents of this thread']];
export const HARNESS_SLASH: Record<Harness, [string, string][]> = {
  claude: [['/clear', 'Start a fresh conversation'], ['/compact', 'Summarise to free up context'], ['/review', 'Review the current diff'], ['/init', 'Create CLAUDE.md'], ['/cost', 'Usage this thread'], ['/memory', 'Edit memory files'], ['/status', 'Thread and account status']],
  codex: [['/compact', 'Summarise to free up context'], ['/review', 'Review the current diff'], ['/diff', 'Show the working diff'], ['/init', 'Create AGENTS.md'], ['/status', 'Thread and account status']],
};

export const INSTALL: Record<Harness, string> = { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex' };
