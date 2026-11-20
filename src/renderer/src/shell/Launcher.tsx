// What a new tab shows: one composer (the model picks the harness), where it runs, and the other tab kinds.
// enter starts the thread with the prompt; an empty enter just opens the harness.
import { useRef, useState } from 'react';
import type { Harness } from '@shared/types';
import { MODELS as SHARED_MODELS } from '@shared/models';
import { api } from '../api';
import * as A from '../state/actions';
import { mkTab, type Tab } from '../state/layout';
import { machine, S, toast, update, useApp } from '../state/store';
import { openMenu } from './overlays';
import { harnessName } from './meta';
import { Chip, Dot, Icon, SendButton } from '../ui/primitives';
import { VimField, type VimFieldHandle } from '../ui/VimField';

/** Models per harness. CLI aliases, so they keep working as versions change. */
// The model menu: the harness's own default first, then the shared list (@shared/models), which chat uses too.
export const MODELS: Record<Harness, { id: string; label: string }[]> = {
  claude: [{ id: '', label: 'Default' }, ...SHARED_MODELS.claude],
  codex: [{ id: '', label: 'Default' }, ...SHARED_MODELS.codex],
};
export const harnessOf = (t: Tab): Harness => (t.model?.startsWith('codex') ? 'codex' : t.model?.startsWith('claude') ? 'claude' : (S.settings as unknown as { lastHarness?: Harness }).lastHarness || 'claude');
const modelLabel = (t: Tab) => { const h = harnessOf(t), id = t.model?.split(':')[1] || ''; return `${harnessName(h)}${id ? ' · ' + (MODELS[h].find(m => m.id === id)?.label || id) : ''}`; };

export function Launcher({ t, focused }: { t: Tab; focused: boolean }) {
  const s = useApp();
  const [draft, setDraft] = useState('');
  const field = useRef<VimFieldHandle>(null);
  const m = machine(t.machine) || s.machines[0];
  const h = harnessOf(t);
  const missing = m && !m.has.includes(h);

  const start = async () => {
    if (!m) return;
    if (m.ssh && m.link !== 'up') { toast(`${m.name} is not connected`, { icon: 'host' }); void api.machines.connect(m.id); return; }
    if (missing) { toast(`${harnessName(h)} is not installed on ${m.name}`, { icon: 'alert' }); return; }
    const prompt = draft.trim();
    const view = s.settings.defaultView;
    const model = t.model?.split(':')[1] || undefined;
    const th = await A.startThread(t, h, view);
    if (prompt) void api.threads.update(th.id, { title: prompt.replace(/\s+/g, ' ').slice(0, 60) });
    if (view === 'chat') {
      if (prompt) void api.chat.send(th.id, { text: prompt, model }).catch(e => toast(`Couldn't start: ${(e as Error).message}`, { icon: 'alert' }, 6000));
    } else {
      // the first prompt rides on the command line, so the TUI starts working on it straight away
      pendingArgs.set(th.id, [...(model ? ['--model', model] : []), ...(prompt ? [prompt] : [])]);
    }
    update(x => { x.tick++; });
  };

  const pickModel = (el: HTMLElement) => openMenu<string>({
    anchor: el.getBoundingClientRect(), place: 'bottom-start', width: 260, search: { placeholder: 'Search models' },
    items: (['claude', 'codex'] as Harness[]).flatMap(hh => [
      { head: true, label: harnessName(hh), icon: <Icon name={hh} /> },
      ...MODELS[hh].map(x => ({ label: x.label, hint: m && !m.has.includes(hh) ? `Not installed on ${m.name}` : undefined, dis: !!m && !m.has.includes(hh), on: harnessOf(t) === hh && (t.model?.split(':')[1] || '') === x.id, data: `${hh}:${x.id}` })),
    ]),
    onPick: it => update(() => { t.model = it.data; }),
  });
  const pickMachine = (el: HTMLElement) => openMenu<string>({
    anchor: el.getBoundingClientRect(), place: 'bottom-start', width: 260,
    items: s.machines.map(x => ({ label: x.name, icon: <Icon name={x.ssh ? 'host' : 'laptop'} />, right: x.ssh ? <Dot color={x.link === 'up' ? 'green' : x.link === 'down' ? 'red' : 'amber'} /> : undefined, on: x.id === m?.id, data: x.id })),
    onPick: it => {
      const nm = machine(it.data);
      update(() => { t.machine = it.data; t.dir = nm?.home ? '~' : '~'; });
      if (nm?.ssh && nm.link !== 'up') void api.machines.connect(nm.id);
      // G6: picking a machine without this harness switches to one it has, and says so
      if (nm && nm.has.length && !nm.has.includes(harnessOf(t))) { const other = nm.has[0]; update(() => { t.model = `${other}:`; }); toast(`${nm.name} has ${harnessName(other)} only, so the thread will use it`); }
    },
  });
  const pickDir = (el: HTMLElement) => dirMenu(t, el, d => { update(() => { t.dir = d; }); A.save(); });
  const open = (kind: 'shell' | 'changes' | 'files') => update(x => { Object.assign(t, mkTab(kind, { machine: t.machine, dir: t.dir }), { id: t.id }); x.tick++; });

  return (
    <div className="newp"><div className="col">
      <div className="comp">
        <div className="taw"><VimField ref={field} tabId={t.id} value={draft} onChange={setDraft} placeholder="Ask anything" autoFocus={focused} startMode={t.startNormal ? 'NORMAL' : 'INSERT'} onEnter={() => void start()} /></div>
        <div className="cf">
          <span className="sp" />
          <Chip icon={h} label={modelLabel(t)} caret onClick={e => pickModel(e.currentTarget)} title="Model" />
          <SendButton label="Start" disabled={!!missing} onClick={() => void start()} />
        </div>
      </div>
      <div className="under pick">
        <Chip icon={m?.ssh ? 'host' : 'laptop'} label={<>{m?.name}{m?.ssh && m.link !== 'up' && <> <Dot color={m.link === 'down' ? 'red' : 'amber'} /></>}</>} caret onClick={e => pickMachine(e.currentTarget)} title="Machine" />
        <Chip className="path" icon="folder" label={t.dir || '~'} caret onClick={e => pickDir(e.currentTarget)} title="Folder" />
        <span className="sp" />
      </div>
      {missing && <div className="link-note"><Icon name="alert" /><span>{harnessName(h)} is not installed on {m?.name}.</span></div>}
      <div className="cards">
        {([['shell', 'terminal', 'Shell'], ['changes', 'diff', 'Changes'], ['files', 'file', 'Files']] as const).map(([k, i, n]) => <button key={k} className="card" onClick={() => open(k)}><Icon name={i} /><span>{n}</span></button>)}
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
