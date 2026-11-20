// When a thread can move (HANDOFF "Moving a thread"). Shared so the confirm dialog says why before main refuses.
import type { Harness, Machine, ThreadMeta } from './types';

const NAME: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Why the thread can't move to `dir` on `to`, in plain words, or null when it can. */
export function moveBlocked(t: ThreadMeta, to: Machine, dir: string): string | null {
  if (t.status === 'running') return 'It is working. It can move once its turn ends.';
  if (t.status === 'wait') return 'It is waiting on you. Answer it, then move it.';
  if (t.machine === to.id && t.dir === dir) return 'It is already there.';
  if (to.ssh && to.link !== 'up') return `${to.name} isn’t connected.`;
  if (!to.has.includes(t.harness)) return `${NAME[t.harness]} isn’t installed on ${to.name}.`;
  return null;
}
