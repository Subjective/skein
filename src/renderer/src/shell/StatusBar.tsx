// The status bar: the mode pill (whatever has the keys), the workspace, where the focused tab runs,
// and the leader's keys while it is armed.
import { kb } from '../input/platform';
import { tildify } from './meta';
import * as A from '../state/actions';
import { machine, thread, useApp, ws } from '../state/store';
import { cx, Icon } from '../ui/primitives';
import { currentMode } from './keyboard';
import { run } from './commands';

const LEADER: [string, string][] = [['v', 'split →'], ['s', 'split ↓'], ['%', 'shell →'], ['"', 'shell ↓'], ['c', 'new tab'], ['q', 'close tab'], ['t', 'chat ⇄ term'], ['z', 'zoom'], ['w', 'workspaces'], ['hjkl', 'focus'], ['HJKL', 'move'], ['<>', 'resize'], ['[', 'scrollback']];

export function StatusBar() {
  const s = useApp();
  const t = A.currentTab(), th = thread(t.thread);
  const m = machine(th?.machine || t.machine || ws().machine);
  const dir = th?.dir || t.dir || ws().dir;
  const mode = currentMode();
  return (
    <div id="status">
      {s.settings.vim && <span className={cx('vim', mode === 'INSERT' && 'ins', mode === 'TERMINAL' && 'trm', mode.startsWith('V') && 'vis')} role="status" aria-live="polite" aria-label={`Mode ${mode}`}>{mode}</span>}
      <button className="wsb" title={`Workspaces · ${kb('ctrl-tab')} goes to the last one`} onClick={() => run('workspaces')}>{ws().name}</button>
      {s.leader
        ? <span className="lead">{LEADER.map(([k, l]) => <span key={k}><kbd>{k}</kbd>{l}</span>)}</span>
        : <span className="loc"><Icon name={m?.ssh ? 'host' : 'laptop'} /><span>{m?.name}</span><span className="dim">{dir && tildify(m?.id, dir)}</span>{th?.branch && <><Icon name="branch" /><span className="dim">{th.branch}</span></>}</span>}
      {s.seq && <kbd className="seq">{s.seq}</kbd>}
      <span className="sp" />
    </div>
  );
}
