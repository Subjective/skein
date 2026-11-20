// What the harnesses answer in the dev backend, shaped as core/harness/options.ts turns their answers into rows.
// Claude: the list Claude Code 2.1.329 (Agent SDK 0.3.329) gave for a first-party account. Codex: model/list
// shaped rows (efforts and default effort per model).
import { CODEX_COMMANDS, type HarnessCommand, type HarnessCommands } from '@shared/commands';
import { EFFORTS, PERMS, type HarnessOptions, type ModelDef } from '@shared/models';
import type { Harness } from '@shared/types';

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
const c = (id: string, label: string, hint: string, x: Partial<ModelDef> = {}): ModelDef =>
  ({ id, label, hint, efforts: ALL, ultra: true, ...x });

const CLAUDE: ModelDef[] = [
  c('default', 'Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks', { isDefault: true, resolved: 'claude-opus-5-5' }),
  c('opus', 'Opus 5.5', 'For complex work and everyday tasks', { resolved: 'claude-opus-5-5' }),
  c('fable', 'Fable 5.2', 'For your toughest challenges', { resolved: 'claude-fable-5-2' }),
  c('sonnet', 'Sonnet 5.5', 'Most efficient for simpler tasks', { resolved: 'claude-sonnet-5-5' }),
  c('haiku', 'Haiku 5.5', 'Fastest for quick answers', { resolved: 'claude-haiku-5-5' }),
  c('claude-fable-5-1', 'Fable 5.1', 'Most capable for your hardest and longest-running tasks'),
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'Fastest for quick answers', efforts: [] },
  c('claude-sonnet-5', 'Sonnet 5', 'Efficient for routine tasks'),
  c('claude-opus-5', 'Opus 5', 'Best for everyday, complex tasks'),
  c('claude-fable-5', 'Fable 5', 'Most capable for your hardest and longest-running tasks'),
  c('claude-opus-4-8', 'Opus 4.8', 'Best for everyday, complex tasks'),
  c('claude-opus-4-7', 'Opus 4.7', 'Best for everyday, complex tasks'),
  c('claude-opus-4-6', 'Opus 4.6', 'Best for everyday, complex tasks'),
  c('claude-sonnet-4-6', 'Sonnet 4.6', 'Efficient for routine tasks'),
];

const CODEX: ModelDef[] = [
  { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', hint: 'Frontier agentic coding model', efforts: ['low', 'medium', 'high', 'xhigh'], effort: 'medium', isDefault: true },
  { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', hint: 'Faster and cheaper for everyday tasks', efforts: ['low', 'medium', 'high'], effort: 'medium' },
];

export const fakeOptions = (h: Harness): HarnessOptions =>
  ({ models: h === 'claude' ? CLAUDE : CODEX, perms: PERMS[h], efforts: EFFORTS, source: 'harness' });

// The / menu. Claude: part of Claude Code 2.1.329's built-in list, and custom skills (a project skill in skein).
// Codex: its built-in commands and skills/list rows (picked as $name).
const b = (name: string, hint: string, args?: string): HarnessCommand => ({ cmd: '/' + name, name, hint, source: 'built-in', ...(args ? { args } : {}) });
const CLAUDE_CMDS: HarnessCommand[] = [
  b('clear', 'Start a new session with empty context', '[name]'), b('code-review', 'Review the current diff, or a PR number/branch/path target, for correctness bugs'),
  b('compact', 'Free up context by summarizing the conversation so far', '<optional custom summarization instructions>'),
  b('config', 'Set a setting by key', 'key=value'), b('context', 'Show current context usage'), b('effort', "Set the model's effort level"),
  b('init', 'Initialize a new CLAUDE.md file with codebase documentation'), b('mcp', 'Manage MCP servers'), b('model', 'Set the AI model for Claude Code', '<model>'),
  b('security-review', 'Complete a security review of the pending changes on the current branch'), b('simplify', 'Review the changed code for reuse, simplification, efficiency'),
  b('usage', "Show session cost, plan usage, and what's contributing to your limits"),
];
const custom = (name: string, hint: string): HarnessCommand => ({ cmd: '/' + name, name, hint, source: 'custom' });

export const fakeCommands = (h: Harness, dir: string): HarnessCommands => h === 'claude'
  ? { commands: CLAUDE_CMDS, skills: [custom('changelog', 'Write the changelog entry for this branch'), ...(/skein/.test(dir) ? [custom('mockup-parity', 'Check a change against the mockup')] : [])], source: 'harness' }
  : { commands: CODEX_COMMANDS, skills: [{ cmd: '$pdf', name: 'pdf', hint: 'Read and make PDF files', source: 'system' }, { cmd: '$release-notes', name: 'release-notes', hint: 'Draft release notes from merged PRs', source: 'repo' }], source: 'harness' };
