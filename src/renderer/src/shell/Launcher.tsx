// What a new tab shows: one composer (the model picks the harness), where it runs, and the other tab kinds.
// enter starts the thread with the prompt; an empty enter just opens the harness.
import { useRef, useState } from 'react';
import type { Harness, ThreadMeta } from '@shared/types';
import { MODELS } from '@shared/models';
import { api } from '../api';
import * as A from '../state/actions';
import { mkTab, type Tab } from '../state/layout';
import { machine, S, toast, update, useApp, ws } from '../state/store';
import { openMenu } from './overlays';
import { harnessName, tildify } from './meta';
import { Chip, Dot, Icon } from '../ui/primitives';
import { Composer, type ComposerHandle } from '../views/chat/Composer';
import { blank, outgoing, setUltra, ultraOf, type Draft } from '../views/chat/state';

export const harnessOf = (t: Tab): Harness => (t.model?.startsWith('codex') ? 'codex' : t.model?.startsWith('claude') ? 'claude' : (S.settings as unknown as { lastHarness?: Harness }).lastHarness || 'claude');
/** The tab's model id: what was picked, else the harness's first (the shared list, @shared/models, which chat uses too). */
const modelOf = (t: Tab) => { const h = harnessOf(t), id = t.model?.split(':')[1] || ''; return MODELS[h].some(m => m.id === id) ? id : MODELS[h][0].id; };

export function Launcher({ t, focused }: { t: Tab; focused: boolean }) {
  const s = useApp();
  const [draft, setDraft] = useState<Draft>(blank);
  const comp = useRef<ComposerHandle>(null);
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
    const th = await A.startThread(t, h, view);
    setDraft(blank());
    if (ultra) setUltra(th.id, true);
    if (prompt) void api.threads.update(th.id, { title: prompt.replace(/\s+/g, ' ').slice(0, 60) });
    if (view === 'chat') {
      if (prompt || images.length) void api.chat.send(th.id, { text: prompt, images, model, effort: t.effort, perm: t.perm }).catch(e => toast(`Couldn't start: ${(e as Error).message}`, { icon: 'alert' }, 6000));
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

  const pickMachine = (el: HTMLElement) => openMenu<string>({
    anchor: el.getBoundingClientRect(), place: 'bottom-start', width: 260,
    items: s.machines.map(x => ({ label: x.name, icon: <Icon name={x.ssh ? 'host' : 'laptop'} />, right: x.ssh ? <Dot color={x.link === 'up' ? 'green' : x.link === 'down' ? 'red' : 'amber'} /> : undefined, on: x.id === m?.id, data: x.id })),
    onPick: it => {
      const nm = machine(it.data);
      update(() => { t.machine = it.data; t.dir = nm?.home ? '~' : '~'; });
      if (nm?.ssh && nm.link !== 'up') void api.machines.connect(nm.id);
      // G6: picking a machine without this harness switches to one it has, and says so
      if (nm && nm.has.length && !nm.has.includes(harnessOf(t))) { const other = nm.has[0]; update(() => { t.model = `${other}:`; t.perm = undefined; }); toast(`${nm.name} has ${harnessName(other)} only, so the thread will use it`); }
    },
  });
  const pickDir = (el: HTMLElement) => dirMenu({ machine: t.machine, dir }, el, d => { update(() => { t.dir = d; }); A.save(); });
  const open = (kind: 'shell' | 'changes' | 'files' | 'browser') => update(x => { Object.assign(t, mkTab(kind, { machine: t.machine, dir: t.dir }), { id: t.id }); x.tick++; });

  return (
    <div className="newp"><div className="col">
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

/** Folder picker on a machine, starting at `at.dir`: type a path to list it; tab (or l) goes in, h goes up,
 *  enter picks. A new thread's folder and moving a thread both use it. */
export function dirMenu(at: { machine?: string; dir?: string }, el: HTMLElement, pick: (dir: string) => void, o: { placeholder?: string } = {}) {
  const t = at;
  let cwd = t.dir || '~';
  let entries: { name: string; dir: boolean }[] = [];
  const close = { fn: () => {} };
  const load = async (d: string) => { try { entries = (await api.fs.list(t.machine || 'local', d)).filter(e => e.dir && !e.hidden); } catch { entries = []; } };
  const show = async () => {
    await load(cwd);
    close.fn();
    close.fn = openMenu<string>({
      anchor: el.getBoundingClientRect(), place: 'bottom-start', width: 380, search: { placeholder: o.placeholder || 'Folder', value: '' }, keep: false,
      items: [{ label: cwd, icon: <Icon name="check" />, hint: 'Use this folder', data: '.' }, { label: '..', icon: <Icon name="folder" />, data: '..' }, ...entries.map(e => ({ label: e.name, icon: <Icon name="folder" />, data: e.name }))],
      onPick: it => {
        if (it.data === '.') { pick(cwd); return; }
        cwd = it.data === '..' ? (cwd.replace(/[\\/][^\\/]+[\\/]?$/, '') || '/') : `${cwd.replace(/[\\/]$/, '')}/${it.data}`;
        void show();
      },
      keys: (k, it) => {
        if ((k === 'l' || k === 'tab') && it?.data && it.data !== '.') { cwd = it.data === '..' ? (cwd.replace(/[\\/][^\\/]+[\\/]?$/, '') || '/') : `${cwd.replace(/[\\/]$/, '')}/${it.data}`; void show(); return true; }
        if (k === 'h') { cwd = cwd.replace(/[\\/][^\\/]+[\\/]?$/, '') || '/'; void show(); return true; }
        return false;
      },
    });
  };
  void show();
}
