// The branch picker: the status bar's branch, Changes' branch chip, `:branch` and leader g open the same menu.
// Type to filter, or to name a new branch (the last row creates it). Git runs on the folder's machine, so it
// works the same over SSH. The current branch carries a dot when the working tree has uncommitted changes
// (from the repository state the status bar already keeps; no extra git call).
import { api } from '../api';
import { toast } from '../state/store';
import { Icon } from '../ui/primitives';
import { refreshNow, repoEntry } from '../views/tools/repo';
import { here, openMenu } from './overlays';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const rectOf = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;

export interface BranchPick { machine: string; dir: string; anchor: DOMRect | null; place?: 'top-start' | 'bottom-start'; done?: () => void }

export async function openBranches(o: BranchPick) {
  const e = repoEntry(o.machine, o.dir);
  const root = e.repo?.root ?? (await api.git.repo(o.machine, o.dir).catch(() => null))?.root;
  if (!root) { toast('Not a git repository'); return; }
  let list: Awaited<ReturnType<typeof api.git.branches>> = [];
  try { list = await api.git.branches(o.machine, root); } catch (err) { toast(errText(err), { icon: 'alert' }); return; }
  const dirty = Object.keys(e.repo?.changed || {}).length;
  const current = list.find(b => b.current)?.name;
  openMenu<{ name: string; create?: boolean }>({
    anchor: o.anchor, place: o.place || 'bottom-start', width: 280, className: 'branches', search: { placeholder: 'Switch branch or name a new one' }, empty: 'No branches',
    items: q => [
      ...list.map(b => ({
        label: b.name, icon: <Icon name="branch" />, on: b.current, data: { name: b.name },
        right: <>{b.current && dirty > 0 && <i className="bdot" title={`${dirty} uncommitted change${dirty === 1 ? '' : 's'}`} aria-label="Uncommitted changes" />}<span className="age">{b.when.replace(/ ago$/, '')}</span></>,
      })),
      ...(q.trim() && !list.some(b => b.name === q.trim()) ? [{ label: `Create branch “${q.trim()}”`, display: <>Create branch <b>{q.trim()}</b></>, icon: <Icon name="plus" />, data: { name: q.trim(), create: true } }] : []),
    ],
    onPick: it => { if (it.data && it.data.name !== current) void switchTo(o, root, it.data.name, it.data.create); },
  });
}

async function switchTo(o: BranchPick, root: string, name: string, create?: boolean) {
  try {
    await api.git.switch(o.machine, root, name, create);
    toast(create ? `Created ${name}` : `On ${name}`, { icon: 'branch' });
  } catch (err) { toast(errText(err), { icon: 'alert' }); }
  await refreshNow(o.machine, o.dir);
  o.done?.();
}

/** `:branch` with no name, leader g: the picker for the focused tab's folder, from the status bar's branch. */
export function openBranchesHere() {
  const c = here();
  // a frame first: from the leader, the bar is still drawing the leader's keys in place of the branch
  requestAnimationFrame(() => void openBranches({ ...c, anchor: rectOf('#status .sb-branch') || rectOf('#status .sb-loc') || rectOf('#status'), place: 'top-start' }));
}

/** `:branch name`: switch to it, or create it when there is none by that name. */
export async function branchHere(name: string) {
  const c = here();
  const root = (await api.git.repo(c.machine, c.dir).catch(() => null))?.root;
  if (!root) { toast('Not a git repository'); return; }
  const list = await api.git.branches(c.machine, root).catch(() => []);
  if (list.find(b => b.current)?.name === name) { toast(`Already on ${name}`, { icon: 'branch' }); return; }
  await switchTo({ ...c, anchor: null }, root, name, !list.some(b => b.name === name));
}
