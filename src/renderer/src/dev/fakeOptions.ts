// What the harnesses answer in the dev backend, shaped as core/harness/options.ts turns their answers into rows.
// Claude: the list Claude Code 2.1.329 (Agent SDK 0.3.329) gave for a first-party account (fast mode: supportsFastMode). Codex: model/list
// shaped rows (efforts and default effort per model).
import { bundledCommands, CODEX_COMMANDS, type HarnessCommand, type HarnessCommands } from '@shared/commands';
import { CLAUDE_FAST, EFFORTS, MODELS, PERMS, type HarnessOptions, type ModelDef } from '@shared/models';
import type { Harness } from '@shared/types';

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
const c = (id: string, label: string, hint: string, x: Partial<ModelDef> = {}): ModelDef =>
  ({ id, label, hint, efforts: ALL, ultra: true, ...x });

const F = { speeds: [CLAUDE_FAST] };
const CLAUDE: ModelDef[] = [
  c('default', 'Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks', { isDefault: true, resolved: 'claude-opus-5-5', ...F }),
  c('opus', 'Opus 5.5', 'For complex work and everyday tasks', { resolved: 'claude-opus-5-5', ...F }),
  c('fable', 'Fable 5.2', 'For your toughest challenges', { resolved: 'claude-fable-5-2', ...F }),
  c('sonnet', 'Sonnet 5.5', 'Most efficient for simpler tasks', { resolved: 'claude-sonnet-5-5' }),
  c('haiku', 'Haiku 5.5', 'Fastest for quick answers', { resolved: 'claude-haiku-5-5' }),
  c('claude-fable-5-1', 'Fable 5.1', 'Most capable for your hardest and longest-running tasks'),
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'Fastest for quick answers', efforts: [] },
  c('claude-sonnet-5', 'Sonnet 5', 'Efficient for routine tasks'),
  c('claude-opus-5', 'Opus 5', 'Best for everyday, complex tasks', F),
  c('claude-fable-5', 'Fable 5', 'Most capable for your hardest and longest-running tasks'),
  c('claude-opus-4-8', 'Opus 4.8', 'Best for everyday, complex tasks', F),
  c('claude-opus-4-7', 'Opus 4.7', 'Best for everyday, complex tasks'),
  c('claude-opus-4-6', 'Opus 4.6', 'Best for everyday, complex tasks'),
  c('claude-sonnet-4-6', 'Sonnet 4.6', 'Efficient for routine tasks'),
];

const FAST = { speeds: [{ id: 'priority', label: 'Fast', hint: '2x speed, increased usage' }] };
const CODEX: ModelDef[] = [
  { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', hint: 'Frontier agentic coding model', efforts: ['low', 'medium', 'high', 'xhigh'], effort: 'medium', isDefault: true, ...FAST },
  { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', hint: 'Faster and cheaper for everyday tasks', efforts: ['low', 'medium', 'high'], effort: 'medium', ...FAST },
];

export const fakeOptions = (h: Harness): HarnessOptions =>
  ({ models: h === 'claude' ? CLAUDE : h === 'agy' ? MODELS.agy : CODEX, perms: PERMS[h], efforts: EFFORTS, source: 'harness' });

// The / menu. Claude: Claude Code 2.1.330's list, split as core/harness/commands.ts splits it (its skills, by
// reloadSkills, under Skills), and custom skills (a project skill in skein). Codex: its built-in commands and
// skills/list rows (picked as $name).
const b = (name: string, hint: string, args?: string): HarnessCommand => ({ cmd: '/' + name, name, hint, source: 'built-in', ...(args ? { args } : {}) });
const CLAUDE_CMDS: HarnessCommand[] = [
  b('advisor', 'Let Claude consult a stronger model at key moments', '[fable|opus|sonnet|off]'),
  b('autocompact', 'Set how full the context gets before auto-summarizing', '[auto|<tokens>]'),
  b('batch', 'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.', '<instruction>'),
  b('clear', 'Start a new session with empty context; loops carry over, and the old one stays in /resume', '[name]'),
  b('color', 'Set the prompt bar color for this session', '[red|blue|green|yellow|purple|orange|pink|cyan|default]'),
  b('compact', 'Free up context by summarizing the conversation so far', '<optional custom summarization instructions>'),
  b('config', 'Set a setting by key', 'key=value'),
  b('context', 'Show current context usage'),
  b('debug', 'Enable debug logging for this session and help diagnose issues', '[issue description]'),
  b('deep-research', 'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report. (dynamic workflow)'),
  b('design', 'Make a new Design artifact from a brief', '[what to design]'),
  b('design-sync', 'Sync a React design system to Claude Design. Bundles the real component code (from Storybook or a bare package) and uploads it. Use when the user runs…', '[<project hint, e.g. "Acme DS">]'),
  b('doctor', 'Health-check the user\'s Claude Code setup and fix issues: diagnose installation health — what the `claude doctor` terminal diagnostics cover — from local data…', '[prompt-audit [<path>]]'),
  b('effort', 'Set the model\'s effort level', '<low|medium|high|xhigh|max|auto|ultracode [on|off]>'),
  b('fast', 'Toggle fast mode (Opus 5.5)', '[on|off]'),
  b('focus', 'Toggle focus view: just your prompt, summary, and response', '[on|off]'),
  b('goal', 'Set a goal — keep working until the condition is met'),
  b('import', 'Import config from another AI coding agent'),
  b('insights', 'Generate a report analyzing your Claude Code sessions'),
  b('list-agents', 'List subagents, teammates, and other Claude sessions you can message'),
  b('mcp', 'Manage MCP servers', '[reconnect|enable|disable [<server>|all]]'),
  b('model', 'Set the AI model for Claude Code', '<model>'),
  b('output-style', 'List output styles or switch to one', '[style]'),
  b('recap', 'Generate a one-line session recap now'),
  b('reload-plugins', 'Activate pending plugin changes in the current session', '[--force]'),
  b('reload-skills', 'Pick up skills added or changed on disk during this session'),
  b('rename', 'Rename the current conversation', '[name]'),
  b('run-skill-generator', 'Author or improve the run-<unit> skill - a per-project skill that tells agents how to build, launch, and drive this project\'s app. Use when the user asks to set…'),
  b('skill-doctor', 'Show which loaded skills are unused and costing context'),
  b('slides', 'Make a new Slides deck artifact from a brief', '[what the deck is about]'),
  b('team-onboarding', 'Help teammates ramp on Claude Code with a guide from your usage'),
  b('usage', 'Show session cost, plan usage, and what\'s contributing to your limits'),
  b('verify', 'Verify that a code change actually does what it\'s supposed to by exercising it end-to-end and observing behavior — drive the affected flow, not just tests or…'),
  b('whiteboard', 'Make a new Whiteboard artifact from a brief', '[what the whiteboard is for]'),
];
const CLAUDE_SKILLS: HarnessCommand[] = [
  b('artifact-capabilities', 'Runtime capabilities a published Artifact page can be granted — behavior static HTML cannot provide on its own, such as the page reading live or connected data,…'),
  b('artifact-diagramming', 'Diagramming know-how for Artifacts - when a picture earns its place, how to draw one that shows the real mechanism, and the inline-SVG mechanics that keep it…'),
  b('claude-api', 'Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration.\nTRIGGER —…'),
  b('code-review', 'Review the current diff, or a PR number/branch/path target, for correctness bugs (plus broken CLAUDE.md rules and cleanups where the model\'s recipe covers them;…', '[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]'),
  b('dataviz', 'Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React artifact,…'),
  b('fewer-permission-prompts', 'Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission…'),
  b('init', 'Initialize a new CLAUDE.md file with codebase documentation'),
  b('loop', 'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.', '[interval] [prompt]'),
  b('plugin-authoring', 'Make a mod: a change to Claude\'s own interface or behaviour, such as a theme, a panel or pane that stays beside the chat and updates, a band, status line,…'),
  b('run', 'Launch and drive this project\'s app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real app…'),
  b('security-review', 'Complete a security review of the pending changes on the current branch'),
  b('simplify', 'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use…', '[<target>]'),
  b('update-config', 'Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after X")…'),
  b('workflow-authoring', 'Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow…'),
];
const custom = (name: string, hint: string): HarnessCommand => ({ cmd: '/' + name, name, hint, source: 'custom' });

export const fakeCommands = (h: Harness, dir: string): HarnessCommands => h === 'agy' ? bundledCommands('agy') : h === 'claude'
  ? { commands: CLAUDE_CMDS, skills: [...CLAUDE_SKILLS, custom('changelog', 'Write the changelog entry for this branch'), ...(/skein/.test(dir) ? [custom('mockup-parity', 'Check a change against the mockup')] : [])], source: 'harness' }
  : { commands: CODEX_COMMANDS, skills: [{ cmd: '$pdf', name: 'pdf', hint: 'Read and make PDF files', source: 'system' }, { cmd: '$release-notes', name: 'release-notes', hint: 'Draft release notes from merged PRs', source: 'repo' }], source: 'harness' };
