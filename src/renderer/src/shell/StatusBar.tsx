// The status bar: the mode pill (whatever has the keys), the workspace, where the focused tab runs,
// and the leader's keys while it is armed. A thread's machine and folder open the move menu (leader m); the branch
// opens the branch picker (leader g). The branch is the folder's live one, read again when the tab or the
// thread's state changes and when the window comes back (no polling here; Changes polls while it shows).
import { kb } from '../input/platform';
import { tildify } from './meta';
import * as A from '../state/actions';
import { machine, thread, useApp, ws } from '../state/store';
import { cx, Icon } from '../ui/primitives';
import { branchOf, useRepoLook } from '../views/tools/repo';
import { openBranches } from './branches';
import { moveHere } from './move';
import { currentMode } from './keyboard';
import { run } from './commands';
import { wsWaiting } from './switcher';

const LEADER: [string, string][] = [['v', 'split →'], ['s', 'split ↓'], ['%', 'shell →'], ['"', 'shell ↓'], ['c', 'new tab'], ['q', 'close tab'], ['t', 'chat ⇄ term'], ['z', 'zoom'], ['w', 'workspaces'], ['g', 'branch'], ['m', 'move'], ['hjkl', 'focus'], ['HJKL', 'move'], ['<>', 'resize'], ['x', 'swap'], ['esc', 'normal']];

export function StatusBar() {
  const s = useApp();
  const t = A.currentTab(), th = thread(t.thread);
  const m = machine(th?.machine || t.machine || ws().machine);
  const dir = th?.dir || t.dir || ws().dir;
  const mode = currentMode();
  // the live branch; the thread's recorded one until the first look answers; none outside a repository
  const branch = branchOf(useRepoLook(m?.id, dir, th?.status), th?.branch);
  const movable = !!th && !th.side && !th.archived;
  const where = <><Icon name={m?.ssh ? 'host' : 'laptop'} /><span className="mn">{m?.name}</span><span className="dim">{dir && tildify(m?.id, dir)}</span></>;
  return (
    <div id="status">
      {s.settings.vim && <span className={cx('vim', mode === 'INSERT' && 'ins', mode === 'TERMINAL' && 'trm', mode.startsWith('V') && 'vis')} role="status" aria-live="polite" aria-label={`Mode ${mode}`}>{mode}</span>}
      <button className="wsb" title={`Workspaces · ${kb('ctrl-tab')} goes to the last one`} onClick={() => run('workspace')}>{ws().name}{s.workspaces.some(x => x.id !== s.wid && wsWaiting(x)) && <i className="wdot" />}</button>
      {s.leader
        ? <span className="lead">{LEADER.map(([k, l]) => <span key={k}><kbd>{k}</kbd>{l}</span>)}</span>
        : <span className="loc">
          {movable
            ? <button type="button" className="sb sb-loc" title={`Move this thread · ${kb(s.settings.leader)} m`} onClick={() => moveHere()}>{where}</button>
            : <span className="sb-loc">{where}</span>}
          {branch && m && dir && <button type="button" className="sb sb-branch" title={`Switch or create a branch · ${kb(s.settings.leader)} g`}
            onClick={e => void openBranches({ machine: m.id, dir, anchor: e.currentTarget.getBoundingClientRect(), place: 'top-start' })}><Icon name="branch" /><span className="dim">{branch}</span></button>}
        </span>}
      {s.seq && <kbd className="seq">{s.seq}</kbd>}
      <span className="sp" />
    </div>
  );
}
