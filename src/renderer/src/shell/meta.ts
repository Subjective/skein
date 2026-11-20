// How a tab names itself: icon, title, status.
import type { Harness } from '@shared/types';
import type { Tab } from '../state/layout';
import { machine, S, thread } from '../state/store';

export const harnessName = (h: Harness) => (h === 'claude' ? 'Claude Code' : 'Codex');
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
    case 'vimrc': return { icon: 'sliders', title: 'vimrc' };
    case 'browser': return { icon: 'globe', title: 'Browser' };
    default: return { icon: 'compose', title: 'New thread' };
  }
}
export { base };
