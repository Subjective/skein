// How a tab names itself: icon, title, status.
import type { Harness } from '@shared/types';
import type { Tab } from '../state/layout';
import { machine, S, thread } from '../state/store';
import { hostOf } from '../views/tools/address';

export const harnessName = (h: Harness) => (h === 'claude' ? 'Claude Code' : 'Codex');
/** A project's name in the sidebar: a name the user gave it, ~ for the home folder, else the folder's name. */
export const projectName = (m: string, d: string) => (S.settings as unknown as { names?: Record<string, string> }).names?.[m + ':' + d] || (d === S.machines.find(x => x.id === m)?.home ? '~' : base(d)) || d;
/** A path as people read it: the machine's home folder shown as ~ (the stored path stays absolute). */
export function tildify(m: string | undefined, d: string): string {
  const home = S.machines.find(x => x.id === (m || 'local'))?.home?.replace(/[\\/]+$/, '');
  if (!home || !d.startsWith(home)) return d;
  const rest = d.slice(home.length);
  return rest === '' ? '~' : /^[\\/]/.test(rest) ? '~' + rest : d;
}
const base = (p = '') => p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || p;

export function tabMeta(t: Tab): { icon: string; title: string; ssh?: boolean } {
  const th = thread(t.thread);
  const m = machine(th?.machine || t.machine);
  const ssh = !!m?.ssh;
  switch (t.kind) {
    case 'thread': return { icon: th?.harness || 'chat', title: th?.title || 'Thread', ssh };
    case 'shell': return { icon: 'terminal', title: ssh ? (m?.name || 'shell') : S.info.platform === 'mac' ? 'zsh' : S.info.platform === 'win' ? 'PowerShell' : 'bash', ssh };
    case 'changes': return { icon: 'diff', title: 'Changes' };
    case 'files': return { icon: 'folder', title: 'Files' };
    case 'file': return { icon: 'file', title: base(t.path) };
    case 'sub': return { icon: 'agent', title: subName(t) };
    case 'vimrc': return { icon: 'sliders', title: 'vimrc' };
    case 'browser': return { icon: 'globe', title: t.title || hostOf(t.url || '') || 'Browser', ssh };
    default: return { icon: 'compose', title: 'New thread' };
  }
}
export { base };

/** A subagent tab's name, from its thread's chat log. */
let subNames: (t: Tab) => string = () => 'Subagent';
export const setSubNames = (f: (t: Tab) => string) => { subNames = f; };
const subName = (t: Tab) => subNames(t);
