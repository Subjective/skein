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

/** The permission menu: the mockup's modes per harness. Claude's bypass mode stays readable on a thread
 *  that already has it, but is not offered. */
export const permChoices = (h: Harness): Opt[] => ALL_PERMS[h].filter(p => !(h === 'claude' && p.id === 'bypassPermissions'));

/** The model definition (efforts, ultra) for a stored model value. */
export const modelDef = (h: Harness, v?: string) => MODELS[h].find(m => m.id === modelId(h, v)) || MODELS[h][0];

// ---- / commands (the mockup's lists, data.js slash + skills). Ours act at once; the rest go through as text. ----
export interface Slash { cmd: string; hint: string; display: string; icon: string }
const ICONS: Record<string, string> = { clear: 'compose', new: 'plus', compact: 'layers', model: 'agent', plan: 'tree', resume: 'clock',
  review: 'check', init: 'file', mcp: 'clip', permissions: 'shield', approvals: 'shield', status: 'host',
  diff: 'diff', mention: 'clip', sidechats: 'chat', subagents: 'agent' };
const slash = ([cmd, hint]: [string, string]): Slash => {
  const name = cmd.slice(1);
  const display = ({ mcp: 'MCP', sidechats: 'Side chats' } as Record<string, string>)[name] || (name[0].toUpperCase() + name.slice(1)).replace(/-/g, ' ');
  return { cmd, hint, display, icon: ICONS[name] || 'bolt' };
};
export const HARNESS_SLASH: Record<Harness, Slash[]> = {
  claude: ([['/clear', 'Start a fresh conversation'], ['/compact', 'Summarise to free up context'], ['/model', 'Switch model'],
    ['/plan', 'Plan before editing'], ['/resume', 'Resume a past thread'], ['/review', 'Review the current diff'],
    ['/init', 'Create CLAUDE.md'], ['/mcp', 'Manage MCP servers'], ['/permissions', 'Edit tool permissions'], ['/status', 'Thread and account status']] as [string, string][]).map(slash),
  codex: ([['/new', 'Start a new thread'], ['/compact', 'Summarise to free up context'], ['/model', 'Switch model and effort'],
    ['/approvals', 'Choose what needs approval'], ['/review', 'Review the current diff'], ['/diff', 'Show the working diff'],
    ['/mention', 'Attach a file'], ['/init', 'Create AGENTS.md'], ['/status', 'Thread and account status']] as [string, string][]).map(slash),
};
/** A thread's own (not side chats or subagents): after the harness's commands. */
export const THREAD_SLASH: Slash[] = ([['/sidechats', 'Open or start a side chat'], ['/subagents', "List this thread's subagents"]] as [string, string][]).map(slash);
/** Skills the harness exposes, under a Skills heading. */
export const SKILLS: Record<Harness, Slash[]> = {
  claude: ([['/code-review', 'Review the current diff for bugs'], ['/simplify', 'Clean up the changed code'], ['/security-review', 'Security review of pending changes']] as [string, string][]).map(slash),
  codex: ([['/code-review', 'Review the current diff for bugs'], ['/simplify', 'Clean up the changed code']] as [string, string][]).map(slash),
};
/** Commands the app acts on itself (open a picker) instead of sending them. */
export const OURS = ['/model', '/sidechats', '/subagents'];

export const INSTALL: Record<Harness, string> = { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex' };
