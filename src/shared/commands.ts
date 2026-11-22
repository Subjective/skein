// What a harness offers in the composer's / menu: its commands and its skills, asked from the harness in the
// thread's folder (core/harness/commands.ts: Claude Code's initialize `commands`; Codex's `skills/list`).
// The lists here are the fallback when the harness can't be asked. No Node or DOM imports.
import type { Harness } from './types';

export interface HarnessCommand {
  /** What is typed and sent: '/compact' (a command, a Claude skill) or '$name' (a Codex skill). */
  cmd: string;
  /** The name without its sigil. */
  name: string;
  hint?: string;
  /** What it takes after the name ('<file>'), when the harness says. */
  args?: string;
  /** Where it comes from, when the harness says: 'built-in', 'custom' (Claude: user, project, plugin or MCP),
   *  or a Codex skill's scope ('user', 'repo', 'system', 'admin'). */
  source?: string;
}

export interface HarnessCommands {
  /** Listed first: the harness's own commands. */
  commands: HarnessCommand[];
  /** Under the Skills heading. */
  skills: HarnessCommand[];
  source: 'harness' | 'bundled';
  error?: string;
}

const c = (cmd: string, hint: string, source = 'built-in'): HarnessCommand => ({ cmd, name: cmd.slice(1), hint, source });

/** Codex's built-in slash commands (its TUI's list). The app-server does not list commands, so Codex always
 *  shows these, with its skills from `skills/list`. */
export const CODEX_COMMANDS: HarnessCommand[] = [
  c('/new', 'Start a new thread'), c('/compact', 'Summarise to free up context'), c('/model', 'Switch model and effort'),
  c('/approvals', 'Choose what needs approval'), c('/review', 'Review the current diff'), c('/diff', 'Show the working diff'),
  c('/mention', 'Attach a file'), c('/init', 'Create AGENTS.md'), c('/status', 'Thread and account status'),
];

/** The commands the / menu lists first, in this order, with short hints of ours (as Codex's list above): the ones the
 *  harness lists, wherever it puts them (Claude Code counts /init and /code-review as skills). The harness's other
 *  built-ins follow under More. */
export const CORE: Record<Harness, { name: string; hint: string }[]> = {
  claude: [
    { name: 'clear', hint: 'Start a new conversation' }, { name: 'compact', hint: 'Summarise to free up context' },
    { name: 'model', hint: 'Switch model and effort' }, { name: 'effort', hint: 'Set the effort level' }, { name: 'plan', hint: 'Plan before editing' },
    { name: 'resume', hint: 'Resume a past thread' }, { name: 'code-review', hint: 'Review the current diff' },
    { name: 'context', hint: 'Show context usage' }, { name: 'usage', hint: 'Cost and plan limits' }, { name: 'permissions', hint: 'Edit tool permissions' },
    { name: 'mcp', hint: 'Manage MCP servers' }, { name: 'init', hint: 'Create CLAUDE.md' }, { name: 'status', hint: 'Thread and account status' },
  ],
  codex: CODEX_COMMANDS.map(x => ({ name: x.name, hint: x.hint ?? '' })),
};

/** The fallback lists, for when the harness can't be asked. */
export const COMMANDS: Record<Harness, { commands: HarnessCommand[]; skills: HarnessCommand[] }> = {
  claude: {
    commands: [
      c('/clear', 'Start a fresh conversation'), c('/compact', 'Summarise to free up context'), c('/model', 'Switch model'),
      c('/plan', 'Plan before editing'), c('/resume', 'Resume a past thread'),
      c('/init', 'Create CLAUDE.md'), c('/mcp', 'Manage MCP servers'), c('/permissions', 'Edit tool permissions'), c('/status', 'Thread and account status'),
    ],
    skills: [c('/code-review', 'Review the current diff for bugs'), c('/simplify', 'Clean up the changed code'), c('/security-review', 'Security review of pending changes')],
  },
  codex: { commands: CODEX_COMMANDS, skills: [] },
};

export const bundledCommands = (h: Harness, error?: string): HarnessCommands =>
  ({ ...COMMANDS[h], source: 'bundled', ...(error ? { error } : {}) });
