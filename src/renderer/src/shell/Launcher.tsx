// What a new tab shows: one composer (the model picks the harness), where it runs, and the other tab kinds.
// enter starts the thread with the prompt; an empty enter just opens the harness.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Harness, ThreadMeta } from '@shared/types';
import { api } from '../api';
import * as A from '../state/actions';
import { mkTab, type Tab } from '../state/layout';
import { machine, S, toast, update, useApp, ws } from '../state/store';
import { addHostMenu, knownDirs, linkDot, openFolderPicker, openMenu, sshAddr } from './overlays';
import { showAuth } from './AuthDialog';
import { harnessName, tildify } from './meta';
import { Chip, Dot, Icon } from '../ui/primitives';
import { Composer, type ComposerHandle } from '../views/chat/Composer';
import { forgetField } from '../ui/VimField';
import { forgetCodeField } from '../ui/editor/CodeField';
import { blank, outgoing, setUltra, ultraOf, type Draft } from '../views/chat/state';
import { defaultModel } from '../views/chat/options';

export const harnessOf = (t: Tab): Harness => (t.model?.startsWith('codex') ? 'codex' : t.model?.startsWith('claude') ? 'claude' : (S.settings as unknown as { lastHarness?: Harness }).lastHarness || 'claude');
/** The tab's model id: what was picked, else the harness's first (the shared list, @shared/models, which chat uses too). */
// any model the harness lists (live lists are longer than the bundled one); none set: the harness's default
const modelOf = (t: Tab) => { const h = harnessOf(t), id = t.model?.split(':')[1] || ''; return id || defaultModel(h, t.machine).id; };

export function Launcher({ t, focused }: { t: Tab; focused: boolean }) {
  const s = useApp();
  const [draft, setDraft] = useState<Draft>(blank);
  const comp = useRef<ComposerHandle>(null);
  useEffect(() => { launcherFocus.set(t.id, () => comp.current?.focus(true)); return () => { launcherFocus.delete(t.id); }; }, [t.id]);
  // back from a popup or dialog (the model picker, a menu, a confirm): the keys go back to the composer, in the mode
  // it had, as in a thread (rule 15)
  const was = useRef(focused);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const back = focused && !was.current, left = !focused && was.current; was.current = focused;
    // the keys went elsewhere (the sidebar, another pane): the composer lets go, so its cursor is not drawn beside theirs
    if (left && root.current?.contains(document.activeElement) && document.activeElement?.closest('.comp')) (document.activeElement as HTMLElement).blur();
    // take the keys unless something else in this tab has them (a card, a picker). Focus left in another tab counts as
    // nothing: a file's editor keeps it while its tab hides, and the keys would then reach no field (i did nothing).
    const el = document.activeElement;
    if (back && (!el || el.closest('.comp') || !root.current?.contains(el))) comp.current?.focus(A.steppedInsert());   // stepping tabs keeps the mode
  });
  const m = machine(t.machine) || s.machines[0];
  const h = harnessOf(t);
  const missing = m && !m.has.includes(h);
  // the folder: the tab's, else the workspace's project when it is on this machine (as the mockup's new tab)
  const w = ws(), dir = t.dir || (w.machine === (t.machine || m?.id) ? w.dir : '') || '~';

  const start = async () => {
    if (!m) return;
    if (m.ssh && m.link !== 'up') { toast(`${m.name} is not connected`, { icon: 'host' }); void api.machines.connect(m.id); return; }
    if (missing) { toast(`${harnessName(h)} is not installed on ${m.name}`, { icon: 'alert' }); return; }
    const prompt = outgoing(draft), images = draft.images;
    const view = s.settings.defaultView;
    const model = t.model?.split(':')[1] || undefined;
    const ultra = ultraOf(t.id);
    if (!t.dir) t.dir = dir;
    forgetField(t.id); forgetCodeField(t.id);   // a brand-new thread's composer opens in INSERT, whatever the launcher's mode was
    const th = await A.startThread(t, h, view);
    setDraft(blank());
    if (ultra) setUltra(th.id, true);
    if (prompt) void api.threads.update(th.id, { title: prompt.replace(/\s+/g, ' ').slice(0, 60) });
    if (view === 'chat') {
      if (prompt || images.length) void api.chat.send(th.id, { text: prompt, images, model, effort: t.effort, perm: t.perm, ...(h === 'claude' ? { ultra } : {}) }).catch(e => toast(`Couldn't start: ${(e as Error).message}`, { icon: 'alert' }, 6000));
    } else {
      // the first prompt rides on the command line, so the TUI starts working on it straight away; images go to the
      // machine's inbox first and their paths into the prompt (G14)
      const paths: string[] = [];
      for (const [i, src] of images.entries()) {
        try { const b = await (await fetch(src)).arrayBuffer(); paths.push(await api.images.toInbox(th.machine, new Uint8Array(b), `paste-${i + 1}-${Date.now().toString(36)}.png`)); }
        catch (e) { toast(`Couldn't copy an image to ${m.name}: ${(e as Error).message}`, { icon: 'alert' }, 6000); }
      }
      const text = [...paths.map(p => (/\s/.test(p) ? `"${p}"` : p)), prompt].filter(Boolean).join(' ');
      pendingArgs.set(th.id, [...(model ? ['--model', model] : []), ...(text ? [text] : [])]);
    }
    update(x => { x.tick++; });
  };

  // the composer's pickers report here until the thread starts; a new harness resets the permission (as the mockup)
  const onSettings = (p: { harness?: Harness; model?: string; effort?: string; perm?: string }) => {
    update(x => {
      const hh = p.harness || harnessOf(t);
      if (p.model !== undefined || p.harness) t.model = `${hh}:${p.model ?? modelOf(t)}`;
      if (p.effort) t.effort = p.effort;
      if (p.harness) t.perm = undefined;
      if (p.perm) t.perm = p.perm;
      x.tick++;
    });
    A.save();
  };
  const stand: ThreadMeta = { id: t.id, harness: h, machine: m?.id || 'local', dir, title: '', model: modelOf(t), effort: t.effort, perm: t.perm, createdAt: 0, updatedAt: 0, status: 'idle' };

  // the machine and folder menus open above their chips, as every composer menu does (mockup pickMachine, pickDir)
  const pickMachine = (el: HTMLElement) => openMenu<string>({
    anchor: el.getBoundingClientRect(), place: 'top-start', width: 280,
    items: [...s.machines.map(x => ({ label: x.name, icon: <Icon name={x.ssh ? 'host' : 'laptop'} />, hint: sshAddr(x), right: linkDot(x) ?? undefined, on: x.id === m?.id, data: x.id })),
      { label: 'Add SSH host', icon: <Icon name="plus" />, hint: '~/.ssh/config', data: '' }],
    onPick: it => {
      if (!it.data) { void addHostMenu(); return; }
      const nm = machine(it.data); if (!nm) return;
      // the folder stays when that machine knows it, else its most recent folder
      const known = knownDirs(nm.id);
      update(() => { t.machine = nm.id; t.dir = known.includes(dir) ? dir : known[0] || '~'; });
      // G6: picking a machine without this harness switches to one it has, and says so
      if (nm.has.length && !nm.has.includes(harnessOf(t))) {
        const other = nm.has[0], md = defaultModel(other, nm.id);
        update(() => { t.model = `${other}:${md.id}`; t.perm = undefined; });
        toast(<span>{nm.name} has only {harnessName(other)}. Switched to <b>{md.label}</b></span>, { icon: other });
      }
      A.save();
      if (nm.ssh && nm.link === 'auth' && showAuth(nm.id)) return;
      if (nm.ssh && nm.link !== 'up') void api.machines.connect(nm.id);
    },
  });
  const pickDir = (el: HTMLElement) => openFolderPicker(t.machine || m?.id || 'local', el.getBoundingClientRect(), d => { update(() => { t.dir = d; }); A.save(); },
    { place: 'top-start', width: 360, current: dir, recent: true });
  const open = (kind: 'shell' | 'changes' | 'files' | 'browser') => update(x => { Object.assign(t, mkTab(kind, { machine: t.machine, dir: t.dir }), { id: t.id }); x.tick++; });

  return (
    <div className="newp" ref={root}><div className="col">
      <Composer ref={comp} tabId={t.id} thread={stand} draft={draft} onDraft={setDraft} placeholder="Ask anything" autoFocus={focused}
        startMode={t.startNormal ? 'NORMAL' : 'INSERT'} onSend={() => void start()} fresh={{ onSettings }} />
      <div className="under pick">
        <Chip icon={m?.ssh ? 'host' : 'laptop'} label={<>{m?.name}{m?.ssh && m.link !== 'up' && <> <Dot color={m.link === 'down' ? 'red' : 'amber'} /></>}</>} caret onClick={e => pickMachine(e.currentTarget)} title="Machine" />
        <Chip className="path" icon="folder" label={tildify(t.machine, dir)} caret onClick={e => pickDir(e.currentTarget)} title="Directory" />
        <span className="sp" />
        <Chip icon="branch" lbl="lbl" on={!!t.worktree} label={t.worktree ? 'new worktree' : 'main'} title="Start in a new git worktree" onClick={() => { update(x => { t.worktree = !t.worktree; x.tick++; }); A.save(); }} />
      </div>
      {missing && <div className="link-note"><Icon name="alert" /><span>{harnessName(h)} is not installed on {m?.name}.</span></div>}
      <div className="cards">
        {([['shell', 'terminal', 'Shell'], ['changes', 'diff', 'Changes'], ['files', 'file', 'Files'], ['browser', 'globe', 'Browser']] as const).map(([k, i, n]) => <button key={k} className="card" onClick={() => open(k)}><Icon name={i} /><span>{n}</span></button>)}
      </div>
    </div></div>
  );
}

/** Extra command-line arguments for a thread's first launch (model, first prompt). Read once. */
export const pendingArgs = new Map<string, string[]>();
/** Each new tab's way back into its composer in INSERT (`:tabnew` on a new tab, as the mockup's tabNew). */
export const launcherFocus = new Map<string, () => void>();
