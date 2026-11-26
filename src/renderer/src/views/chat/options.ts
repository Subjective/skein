// What the composer's pickers offer per harness: what the harness itself lists on the thread's machine
// (api.harness.options, asked once per machine and harness and kept here), and shared/models.ts's lists
// until it answers or when it can't be asked. The backend takes ids or labels; we store ids.
import { useEffect, useState } from 'react';
import type { Density, Harness } from '@shared/types';
import { bundledOptions, EFFORTS, PERMS, effortId, findModel, modelId as sharedModelId, permId, type HarnessOptions, type ModelDef } from '@shared/models';
import { bundledCommands, CORE, type HarnessCommand, type HarnessCommands } from '@shared/commands';
import { api } from '../../api';
import { bump } from './state';

export interface Opt { id: string; label: string; hint?: string; icon?: string; warn?: boolean; hide?: boolean }

/** How much of an agent's steps a turn shows, least first (zm and zr step through them). */
export const DENSITY: Density[] = ['compact', 'balanced', 'detailed'];
export const DENSITY_NAME: Record<Density, string> = { compact: 'Compact', balanced: 'Balanced', detailed: 'Detailed' };

const RENEW = 10 * 60_000;
const kept = new Map<string, { at: number; o: HarnessOptions }>();
const asking = new Set<string>();
/** The last answer from the harness on any machine: labels for threads whose machine hasn't answered yet. */
const latest: Partial<Record<Harness, HarnessOptions>> = {};
/** One object per harness, so a picker's memo sees the same lists until the answer comes. */
const BUNDLED: Record<Harness, HarnessOptions> = { claude: bundledOptions('claude'), codex: bundledOptions('codex'), agy: bundledOptions('agy') };

/** What the harness offers on the machine. Asks it the first time (and again after a while); the change
 *  arrives as a chat bump (useChat re-renders). */
export function harnessOptions(h: Harness, machine = 'local'): HarnessOptions {
  const k = machine + ':' + h, c = kept.get(k);
  if ((!c || Date.now() - c.at > (c.o.source === 'harness' ? RENEW : 30_000)) && !asking.has(k)) {
    asking.add(k);
    api.harness.options(machine, h)
      .then(o => { kept.set(k, { at: Date.now(), o }); if (o.source === 'harness') latest[h] = o; bump(); }, () => {})
      .finally(() => asking.delete(k));
  }
  // a machine that couldn't be asked (down, no harness) shows what another machine's harness said, if any
  return (c?.o.source === 'harness' ? c.o : latest[h] ?? c?.o) ?? BUNDLED[h];
}
const known = (h: Harness, machine?: string) => (machine ? harnessOptions(h, machine) : latest[h] ?? BUNDLED[h]);

/** A model id from an id or a label, in what the harness lists. Unknown values pass through. */
export const modelId = (h: Harness, v?: string, machine?: string) => sharedModelId(h, v, known(h, machine).models);
/** The harness's default model (what runs when a thread sets none). */
export const defaultModel = (h: Harness, machine?: string): ModelDef => { const ms = known(h, machine).models; return ms.find(m => m.isDefault) ?? ms[0]; };
/** The model definition (efforts, ultra) for a stored model value. A model no list has gets the default's
 *  efforts and keeps its own id. */
export const modelDef = (h: Harness, v?: string, machine?: string): ModelDef => {
  if (!v) return defaultModel(h, machine);
  const o = known(h, machine);
  return findModel(h, v, o.models) ?? findModel(h, v) ?? { ...defaultModel(h, machine), id: modelId(h, v, machine) ?? v, label: v, isDefault: false };
};
/** Effort levels the model takes. */
export const efforts = (h: Harness, model?: string, machine?: string): Opt[] => {
  const es = modelDef(h, model, machine).efforts, names = known(h, machine).efforts;
  return es.map(e => names.find(x => x.id === e) ?? { id: e, label: e });
};
/** A chip's name for the model: the Default row shows the model it runs now ('Opus 5.5'), as the row under it does. */
export const modelLabel = (h: Harness, v?: string, machine?: string) => {
  const d = modelDef(h, v, machine);
  if (!d.isDefault || !d.resolved) return d.label;
  return known(h, machine).models.find(m => !m.isDefault && (m.resolved ?? m.id) === d.resolved)?.label ?? d.label;
};
export const effortLabel = (v?: string) => { const id = effortId(v); return EFFORTS.find(e => e.id === id)?.label ?? (id ? id[0].toUpperCase() + id.slice(1) : 'Medium'); };
/** The mode a thread with none set runs in: Claude Code's default mode; Codex's Default preset; Antigravity's Default. */
const unsetPerm = (h: Harness) => (h === 'codex' ? 'auto' : 'default');
export const permLabel = (h: Harness, v?: string) => PERMS[h].find(p => p.id === (permId(h, v) ?? unsetPerm(h)))?.label ?? v ?? '';
/** The current permission id (the harness's default when the thread sets none). */
export const permOf = (h: Harness, v?: string) => permId(h, v) ?? unsetPerm(h);
export { effortId, permId };

/** The permission menu: the modes the harness offers on the machine (Claude: the SDK's permission modes, Auto mode
 *  where a model has it; Codex: its approval presets that managed policy allows), less the ones its own picker
 *  hides, unless the thread is in one or policy leaves nothing else. */
export const permChoices = (h: Harness, machine?: string, cur?: string): Opt[] => {
  const all = known(h, machine).perms, shown = all.filter(p => !p.hide || p.id === cur);
  return shown.some(p => !p.hide) ? shown : all;
};
/** The current mode's row (for the chip's icon and tone). */
export const permRow = (h: Harness, v?: string) => PERMS[h].find(p => p.id === permOf(h, v));

// ---- / commands: what the harness lists in the thread's folder (api.harness.commands, kept per machine,
// harness and folder like the pickers' options); shared/commands.ts's lists until it answers or when it can't
// be asked. Ours act at once; the rest go through as text. ----
export interface Slash { cmd: string; hint: string; display: string; icon: string }
const ICONS: Record<string, string> = { clear: 'compose', new: 'plus', compact: 'layers', model: 'agent', effort: 'sliders', plan: 'tree', resume: 'clock',
  review: 'check', 'code-review': 'check', 'security-review': 'lock', init: 'file', mcp: 'plug', permissions: 'shield', approvals: 'shield',
  status: 'host', usage: 'host', context: 'brain', diff: 'diff', mention: 'clip', rename: 'pencil', loop: 'retry', 'reload-plugins': 'retry',
  'reload-skills': 'retry', debug: 'alert', doctor: 'alert', config: 'wrench', color: 'sun', side: 'chat', sidechats: 'chat', subagents: 'agent', 'list-agents': 'agent' };
const displayOf = (name: string) => ({ mcp: 'MCP', side: 'Side chat', sidechats: 'Side chats' } as Record<string, string>)[name] || (name[0].toUpperCase() + name.slice(1)).replace(/-/g, ' ');
const slash = ([cmd, hint]: [string, string]): Slash => {
  const name = cmd.slice(1);
  return { cmd, hint, display: displayOf(name), icon: ICONS[name] || 'bolt' };
};
/** A harness's description cut to its first clause, so a row reads like Codex's ('Start a new session with empty
 *  context; loops carry over…' -> 'Start a new session with empty context'). */
export const shortHint = (s = '') => s.split(/;\s|\.\s|\s[—–-]\s|\s\(/)[0].replace(/[.:,]$/, '').trim();
const fromHarness = (c: HarnessCommand, hint = shortHint(c.hint)): Slash => ({ cmd: c.cmd, hint, display: displayOf(c.name), icon: ICONS[c.name] || 'bolt' });

/** The / menu's sections: the everyday commands (CORE, in its order), the harness's skills, and its other built-ins. */
export interface SlashLists { commands: Slash[]; skills: Slash[]; more: Slash[]; source: HarnessCommands['source'] }
const asSlash = new WeakMap<HarnessCommands, SlashLists>();
const slashOf = (h: Harness, c: HarnessCommands): SlashLists => {
  let r = asSlash.get(c);
  if (!r) {
    const all = [...c.commands, ...c.skills], core = CORE[h], isCore = (x: HarnessCommand) => core.some(k => k.name === x.name);
    r = {
      commands: core.flatMap(k => { const x = all.find(y => y.name === k.name); return x ? [fromHarness(x, k.hint)] : []; }),
      skills: c.skills.filter(x => !isCore(x)).map(x => fromHarness(x)),
      more: c.commands.filter(x => !isCore(x)).map(x => fromHarness(x)),
      source: c.source,
    };
    asSlash.set(c, r);
  }
  return r;
};
const BUNDLED_CMDS: Record<Harness, HarnessCommands> = { claude: bundledCommands('claude'), codex: bundledCommands('codex'), agy: bundledCommands('agy') };
const keptCmds = new Map<string, { at: number; c: HarnessCommands }>();
const askingCmds = new Map<string, Promise<void>>();

/** Ask the harness for its commands in the folder unless a fresh answer is kept. Resolves once it is. */
function askCommands(h: Harness, machine: string, dir: string): Promise<void> {
  const k = `${machine}:${h}:${dir}`, c = keptCmds.get(k);
  if (c && Date.now() - c.at <= (c.c.source === 'harness' ? RENEW : 30_000)) return Promise.resolve();
  let p = askingCmds.get(k);
  if (!p) {
    p = api.harness.commands(machine, h, dir)
      .then(r => { keptCmds.set(k, { at: Date.now(), c: r }); }, () => {})
      .finally(() => askingCmds.delete(k));
    askingCmds.set(k, p);
  }
  return p;
}

/** The harness's commands and skills in a folder on a machine (the bundled lists until it answers). */
export function harnessCommands(h: Harness, machine = 'local', dir = '~'): SlashLists {
  void askCommands(h, machine, dir);
  return slashOf(h, keptCmds.get(`${machine}:${h}:${dir}`)?.c ?? BUNDLED_CMDS[h]);
}
/** The same, re-rendering the caller when the harness answers (the composer, which doesn't follow chat bumps). */
export function useHarnessCommands(h: Harness, machine = 'local', dir = '~'): SlashLists {
  const [, redraw] = useState(0);
  useEffect(() => {
    let live = true;
    void askCommands(h, machine, dir).then(() => { if (live) redraw(n => n + 1); });
    return () => { live = false; };
  }, [h, machine, dir]);
  return slashOf(h, keptCmds.get(`${machine}:${h}:${dir}`)?.c ?? BUNDLED_CMDS[h]);
}
/** A typed /word matches a row by its name: '/rel' finds a Codex skill's '$release-notes' too. */
export const slashHit = (c: Slash, q: string) => c.cmd.slice(1).startsWith(q.replace(/^[/$]/, ''));

/** A thread's own (not side chats or subagents): after the harness's commands. */
export const THREAD_SLASH: Slash[] = ([['/side', 'New side chat about the quote or the last reply'], ['/sidechats', 'Open or start a side chat'], ['/subagents', "List this thread's subagents"]] as [string, string][]).map(slash);
/** Commands Skein acts on itself instead of sending them, where the harness only answers them in its terminal UI
 *  (or not at all): the composer's pickers, and the view's actions (a new thread, Changes, the thread search,
 *  side chats). The harness answers the rest: Claude Code's /compact, /context, /usage, /init, its skills; the
 *  drivers turn Codex's /compact, /review, /init and both harnesses' /status (and Claude's /mcp) into calls. */
const PICKERS = ['/model', '/effort', '/permissions', '/approvals', '/plan', '/mention'];
const VIEWS = ['/clear', '/new', '/diff', '/resume', ...THREAD_SLASH.map(x => x.cmd)];
/** The ones that take what follows them: '/model opus', '/effort high', '/plan <what to plan>'. */
export const SLASH_ARGS = ['/model', '/effort', '/plan'];
export interface SlashWhere { bare?: boolean; side?: boolean; fresh?: boolean }
/** Whether the command is one of ours where the composer is: a subagent's has no pickers or actions; a launcher has
 *  no thread to act on yet; a side chat has no side chats of its own. Claude Code's Plan mode is Claude's. */
export function isOurs(cmd: string, h: Harness, o: SlashWhere): boolean {
  if (o.bare) return false;
  if (cmd === '/plan') return h === 'claude';
  if (PICKERS.includes(cmd)) return true;
  if (!VIEWS.includes(cmd) || o.fresh) return false;
  return !(o.side && THREAD_SLASH.some(x => x.cmd === cmd));
}
/** A row the / menu leaves out there: ours where they can't act. */
export const slashHidden = (cmd: string, h: Harness, o: SlashWhere) =>
  (PICKERS.includes(cmd) || VIEWS.includes(cmd)) && !isOurs(cmd, h, o);

export const INSTALL: Record<Harness, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex',
  // Google's installer (Windows: irm https://antigravity.google/cli/install.ps1 | iex)
  agy: navigator.userAgent.includes('Windows') ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
};
