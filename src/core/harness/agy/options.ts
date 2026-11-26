// What Antigravity offers, from what its sessions say: agy lists its models and modes in the answer to session/new
// (and load, resume), and its / commands in an available_commands_update. ACP has no call that lists them without
// a session, so the pickers show the newest answer on the machine (AgyServers.offered), and shared/models.ts's lists
// (what agy 1.5.18 offered on an AI Pro plan) until a thread there has opened one.
import { type HarnessCommand, type HarnessCommands } from '../../../shared/commands';
import { EFFORTS, PERMS, type Choice, type HarnessOptions, type ModelDef } from '../../../shared/models';
import type { AvailableCommand, Opened } from './acp';

const RANK = (id: string) => EFFORTS.findIndex(e => e.id === id);

/** agy's models as picker rows: a model family (configOptions `model`) with the thinking levels it offers (the
 *  availableModels ids `<family>-<level>`), and agy's modes as the permission menu. */
export function agyOptions(o: Opened): HarnessOptions {
  const fam = o.configOptions?.find(c => c.id === 'model' || c.category === 'model');
  const ids = o.models?.availableModels.map(x => x.modelId) ?? [];
  const cur = fam?.currentValue;
  const models: ModelDef[] = (fam?.options ?? []).map(f => {
    const efforts = ids.filter(id => id.startsWith(f.value + '-')).map(id => id.slice(f.value.length + 1)).filter(e => RANK(e) >= 0).sort((a, b) => RANK(a) - RANK(b));
    return {
      id: f.value, label: f.name, ...(f.description ? { hint: f.description } : {}), efforts,
      ...(efforts.length ? { effort: efforts.includes('high') ? 'high' : efforts[efforts.length - 1] } : {}),
      ...(f.value === cur ? { isDefault: true } : {}),
    };
  });
  const icons = new Map(PERMS.agy.map(p => [p.id, p]));
  const perms: Choice[] = (o.modes?.availableModes ?? []).map(m => ({ ...icons.get(m.id), id: m.id, label: m.name, ...(m.description ? { hint: m.description } : {}) }));
  if (!models.length) throw new Error('Antigravity listed no models');
  return { models, perms: perms.length ? perms : PERMS.agy, efforts: EFFORTS, source: 'harness' };
}

/** agy's / menu. agy sends its commands and skills as one list: its own commands (as agy 1.5.18 has them) come first,
 *  the rest (its guides, the user's skills) under Skills. */
const BUILT_IN = new Set(['goal', 'compact', 'schedule', 'browser', 'plan', 'grill-me', 'teamwork', 'learn', 'boost', 'swarm']);
export function agyCommands(list: AvailableCommand[]): HarnessCommands {
  const row = (c: AvailableCommand): HarnessCommand => ({ cmd: '/' + c.name, name: c.name, ...(c.description ? { hint: c.description } : {}), ...(c.input?.hint ? { args: c.input.hint } : {}), source: BUILT_IN.has(c.name) ? 'built-in' : 'custom' });
  const by = (a: HarnessCommand, b: HarnessCommand) => a.name.localeCompare(b.name);
  return { commands: list.filter(c => BUILT_IN.has(c.name)).map(row).sort(by), skills: list.filter(c => !BUILT_IN.has(c.name)).map(row).sort(by), source: 'harness' };
}
