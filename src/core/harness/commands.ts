// What a harness offers in the composer's / menu, asked in the thread's folder (project commands and skills
// depend on it):
//   Claude Code: the initialize response's `commands` (the SDK's SlashCommand: name, description, argumentHint,
//     builtin), from the same no-prompt query the model list uses, run with cwd = the folder. Built-in rows are
//     the commands, except those the same query's reloadSkills names (Claude Code's own skills: /simplify,
//     /code-review); those and the rest (user, project, plugin and MCP commands and skills) go under Skills.
//     Rows Claude Code marks "(removed)" are left out.
//   Codex: `skills/list` for the folder (picked as `$name`, which the driver sends as a skill input). The
//     app-server lists no commands, so its built-in commands are shared/commands.ts's.
// Cached like the pickers' options, keyed by machine, harness and folder.
import { bundledCommands, CODEX_COMMANDS, type HarnessCommand, type HarnessCommands } from '../../shared/commands';
import type { Harness, Machine } from '../../shared/types';
import type { QueryFn } from './claude/driver';
import type { CodexServers } from './codex/driver';
import type { Rpc } from './codex/rpc';
import { claudeInit, Kept, withTimeout } from './options';

/** The SDK's SlashCommand, as much of it as we read. */
export interface ClaudeCommandInfo { name: string; description?: string; argumentHint?: string; builtin?: boolean; aliases?: string[] }

const byName = (a: HarnessCommand, b: HarnessCommand) => a.name.localeCompare(b.name);

export function claudeCommands(list: ClaudeCommandInfo[], skillNames: string[] = []): HarnessCommands {
  const isSkill = new Set(skillNames);
  const seen = new Set<string>(), commands: HarnessCommand[] = [], skills: HarnessCommand[] = [];
  for (const x of list) {
    // internal entry points (`__remote-workflow`) are not for people; a name shadowed by a built-in runs the built-in
    if (!x.name || x.name.startsWith('_') || seen.has(x.name) || /^\(removed\)/i.test(x.description ?? '')) continue;
    seen.add(x.name);
    const row: HarnessCommand = {
      cmd: '/' + x.name, name: x.name, ...(x.description ? { hint: x.description } : {}),
      ...(x.argumentHint ? { args: x.argumentHint } : {}), source: x.builtin ? 'built-in' : 'custom',
    };
    (x.builtin && !isSkill.has(x.name) ? commands : skills).push(row);
  }
  return { commands: commands.sort(byName), skills: skills.sort(byName), source: 'harness' };
}

/** Codex's SkillMetadata (protocol/v2/SkillMetadata.ts), as much of it as we read. */
export interface CodexSkill { name: string; description?: string; shortDescription?: string; interface?: { shortDescription?: string }; path?: string; scope?: string; enabled?: boolean }

export function codexCommands(skills: CodexSkill[]): HarnessCommands {
  const rows = skills.filter(s => s.enabled !== false && s.name).map((s): HarnessCommand => {
    const hint = s.interface?.shortDescription || s.shortDescription || s.description;
    return { cmd: '$' + s.name, name: s.name, ...(hint ? { hint } : {}), ...(s.scope ? { source: s.scope } : {}) };
  });
  return { commands: CODEX_COMMANDS, skills: rows.sort(byName), source: 'harness' };
}

/** A folder as the machine knows it: ~ expanded (Codex takes absolute cwds). */
export const absDir = (m: Machine, dir: string, home: string) =>
  dir === '~' ? (m.home || home) : dir.startsWith('~/') || dir.startsWith('~\\') ? (m.home || home) + dir.slice(1) : dir;

export async function codexSkills(rpc: Rpc, cwd: string): Promise<CodexSkill[]> {
  const r = await withTimeout(rpc.request<{ data: { cwd: string; skills: CodexSkill[] }[] }>('skills/list', { cwds: [cwd] }), 'Codex');
  return (r.data ?? []).flatMap(e => e.skills ?? []);
}

/** The / menu source createHarnesses uses. */
export function harnessCommands(query: () => Promise<QueryFn>, servers: CodexServers, home: string) {
  const kept = new Kept<HarnessCommands>((k, why) => bundledCommands(k.split(':')[1] as Harness, why));
  return {
    get(m: Machine, h: Harness, dir: string): Promise<HarnessCommands> {
      return kept.get(`${m.id}:${h}:${dir}`, async () => {
        if (h === 'claude') {
          const init = await claudeInit(m, await query(), dir, true);
          if (!init.commands?.length) throw new Error('Claude Code listed no commands');
          return claudeCommands(init.commands as ClaudeCommandInfo[], init.skills);
        }
        return codexCommands(await codexSkills(await servers.get(m), absDir(m, dir, home)));
      });
    },
    drop: (machine?: string) => kept.drop(machine),
  };
}
