// Overlays opened by commands: palette, : line, pane search, workspaces, keyboard sheet, settings.
// All are the shared Menu or Dialog, so they look and key the same.
import { useEffect, useState } from 'react';
import { COMMANDS, Keymap } from '../input/keymap';
import { kb } from '../input/platform';
import type { Surface } from '../input/dispatcher';
import { api } from '../api';
import * as A from '../state/actions';
import { allTabs } from '../state/layout';
import { machine, openLayer, S, thread, toast, update, useApp, ws } from '../state/store';
import { fuzzyTop } from '../ui/fuzzy';
import { Menu, type MenuItem, type MenuProps } from '../ui/Menu';
import { Dialog, useDialogSurface } from '../ui/Dialog';
import { cx, Icon, IconButton, Switch } from '../ui/primitives';
import { harnessName, tabMeta } from './meta';
import { run } from './commands';

/** Open any menu as an overlay. */
export function openMenu<D>(p: Omit<MenuProps<D>, 'onClose'> & { onClose?: () => void }) {
  const close = openLayer(c => <Menu<D> {...p} onClose={c} />, p.onClose);
  return close;
}

const ago = (t: number) => { const m = (Date.now() - t) / 60000; return m < 1 ? 'now' : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/** Where the focused tab works: its thread's folder, or the tab's or workspace's. */
function here(): { machine: string; dir: string } {
  const t = A.currentTab(), th = t.thread ? thread(t.thread) : undefined, w = ws();
  return th ? { machine: th.machine, dir: th.dir } : { machine: t.machine || w.machine, dir: t.dir || w.dir };
}

const found = new Map<string, { at: number; list: string[] }>();
async function openFiles() {
  const { machine: m, dir } = here(), key = m + '\0' + dir;
  let hit = found.get(key);
  if (!hit || Date.now() - hit.at > 30_000) {
    try { hit = { at: Date.now(), list: await api.fs.find(m, dir) }; found.set(key, hit); }
    catch (e) { return toast(`Couldn't list files in ${dir}: ${(e as Error).message}`, { icon: 'alert' }, 5000); }
  }
  const list = hit.list;
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  openMenu<string>({
    modal: true, className: 'pal files', ranked: true, empty: list.length ? 'No matching files' : 'No files here',
    search: { placeholder: `Search files in ${dir}` },
    items: q => fuzzyTop(q, list, 60).map(p => ({ label: base(p), hint: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', icon: <Icon name="file" />, data: p })),
    onPick: it => { if (it.data) A.openFile(m, dir, it.data); },
  });
}

export function openPalette(mode: 'all' | 'file' = 'all') {
  if (mode === 'file') { void openFiles(); return; }
  const items = (q: string): MenuItem<() => void>[] => {
    const th = [...S.threads].filter(t => !t.archived && !t.side).sort((a, b) => b.updatedAt - a.updatedAt);
    const out: MenuItem<() => void>[] = [{ head: true, label: 'Threads' }];
    for (const t of th.slice(0, q ? 200 : 8)) out.push({ label: t.title, hint: `${machine(t.machine)?.name ?? t.machine} · ${t.dir}`, icon: <Icon name={t.harness} />, right: <span className="age">{ago(t.updatedAt)}</span>, data: () => A.openThread(t.id) });
    out.push({ head: true, label: 'Actions' });
    const acts: [string, string, string][] = [['New thread', 'compose', 'tabnew'], ['Workspaces', 'layers', 'workspaces'], ['Settings', 'sliders', 'settings'], ['Keyboard shortcuts', 'keyboard', 'keys'], ['Split right', 'splitR', 'vsplit'], ['Split down', 'splitD', 'split'], ['Shell', 'terminal', 'vshell'], ['Browser', 'globe', 'browser']];
    const km = keymap();
    for (const [label, icon, cmd] of acts) { const b = km.keysFor(cmd)[0]; out.push({ label, icon: <Icon name={icon} />, kbd: b ? kb(b.layer === 'leader' ? 'ldr ' + b.keys : b.keys) : undefined, data: () => run(cmd) }); }
    return out;
  };
  openMenu<() => void>({ modal: true, className: 'pal', search: { placeholder: 'Search threads and actions' }, items, onPick: it => it.data?.(), empty: 'No matches' });
}

export function openCmdline() {
  const names = Object.keys(COMMANDS);
  openMenu<string>({
    modal: true, className: 'pal', search: { prefix: ':' },
    // exact name first, then names it starts, then names that contain it (so `:w` enter runs w)
    items: q => {
      const w = q.trim().split(' ')[0], rank = (n: string) => (n === w ? 0 : n.startsWith(w) ? 1 : 2);
      return names.filter(n => !w || n.startsWith(w) || n.includes(w)).sort((a, b) => (w ? rank(a) - rank(b) : 0)).map(n => ({ label: n, hint: COMMANDS[n], data: n }));
    },
    onPick: (it, q) => run(it.data || q),
  });
}

export function openPaneSearch() {
  const w = ws();
  const items: MenuItem<() => void>[] = allTabs(w).map(({ tab, pane }) => {
    const m = tabMeta(tab);
    return { label: m.title, icon: <Icon name={m.icon} />, hint: pane ? '' : 'popup', on: tab.id === A.currentTab().id, data: () => (pane ? A.activate(pane.id, tab.id) : update(() => { w.pf = tab.id; })) };
  });
  openMenu<() => void>({ modal: true, className: 'pal', search: { placeholder: 'Search tabs in this workspace' }, items, onPick: it => it.data?.() });
}

export function openWorkspaces() {
  const items = (q: string): MenuItem<string>[] => [
    ...[...S.workspaces].sort((a, b) => b.usedAt - a.usedAt).map(w => ({ label: w.name, hint: `${machine(w.machine)?.name ?? ''} ${w.dir}`, on: w.id === S.wid, data: w.id, icon: <Icon name="layers" /> })),
    ...(q.trim() && !S.workspaces.some(w => w.name === q.trim()) ? [{ label: `Create “${q.trim()}”`, icon: <Icon name="plus" />, data: 'new:' + q.trim() }] : []),
  ];
  openMenu<string>({
    modal: true, className: 'wsw', search: { placeholder: 'Switch or create a workspace' }, items, normal: S.workspaces.length > 1,
    onPick: it => { if (it.data?.startsWith('new:')) A.newWorkspace(it.data.slice(4), ws().machine, ws().dir); else if (it.data) A.switchWorkspace(it.data); },
    keys: (k, it) => {
      if (k === 'd' && it?.data && S.workspaces.length > 1) { update(s => { s.workspaces = s.workspaces.filter(w => w.id !== it.data); if (s.wid === it.data) s.wid = s.workspaces[0].id; }); A.save(); return true; }
      return false;
    },
  });
}

let km: Keymap | null = null, kmSrc = '';
export function keymap(): Keymap {
  const src = S.settings.vimrc + '|' + S.info.platform;
  if (!km || kmSrc !== src) { km = Keymap.build(S.settings.vimrc, S.info.platform === 'mac' ? 'mac' : 'win'); kmSrc = src; }
  return km;
}

// ---------- keyboard sheet ----------
const SHEET: [string, string[]][] = [
  ['Anywhere', ['palette', 'files', 'panesearch', 'cmdline', 'keys', 'sidebar']],
  ['Tabs', ['tabnew', 'tabclose', 'tabnext', 'tabprev', 'view', 'popout']],
  ['Panes', ['vsplit', 'split', 'vshell', 'shell', 'zoom', 'only', 'swap', 'focus h', 'focus l', 'resize -', 'resize +']],
  ['Terminals and workspaces', ['scrollback', 'workspaces', 'wsnext', 'back', 'forward']],
];
/** Reader keys are Vim's own, not keymap commands, so the sheet lists them as they are. */
const READER: [string, string[]][] = [
  ['Move, with a count', ['h j k l', 'w b', '3j']], ['Top, bottom', ['gg', 'G']], ['Search, backwards', ['/', '?']],
  ['Next, previous match', ['n', 'N']], ['Select, lines', ['v', 'V']], ['Copy', ['y']],
];
export function openKeys() {
  openLayer(close => <KeysSheet close={close} />);
}
function KeysSheet({ close }: { close: () => void }) {
  const k = keymap();
  useDialogSurface({ onEsc: close });
  const fmt = (c: string) => k.keysFor(c).slice(0, 2).map(b => kb(b.layer === 'leader' ? `ldr ${b.keys}` : b.keys).replace('ldr', kb(S.settings.leader)));
  return (
    <Dialog onClose={close} className="keys" label="Keyboard shortcuts">
      <div className="kcols">
        {SHEET.map(([h, cmds]) => (
          <section key={h}><h4>{h}</h4>
            {cmds.map(c => <div key={c}><span>{COMMANDS[c]}</span><span className="kk">{fmt(c).map(x => <kbd key={x}>{x}</kbd>)}</span></div>)}
          </section>
        ))}
        <section><h4>Reading a thread, file, diff or scrollback</h4>
          {READER.map(([l, ks]) => <div key={l}><span>{l}</span><span className="kk">{ks.map(x => <kbd key={x}>{x}</kbd>)}</span></div>)}
        </section>
      </div>
      <p className="dim">Plain keys act in NORMAL only. {kb(S.settings.leader)} is the leader. Bindings come from your vimrc (Settings, Vim).</p>
    </Dialog>
  );
}

// ---------- settings ----------
interface Row { label: string; desc?: string; seg?: [string, string][]; get?: () => string; set?: (v: string) => void; sw?: () => boolean; toggle?: () => void; btn?: string; run?: () => void; extra?: React.ReactNode }

export function openSettings(section?: string) { openLayer(close => <Settings close={close} section={section} />); }
const setSetting = async (patch: Partial<typeof S.settings>) => { const s = await api.app.setSettings(patch); update(st => { st.settings = s; }); };

// Keys (VIM-MODEL section 4, Settings): two lists side by side. The section list has the keys first: j / k move
// over sections (the page follows), l / enter / tab go into the section's rows. In the rows, j / k move,
// h / l lower and raise a row's value (a choice, a switch), enter presses it, and esc, shift-tab, or h on a row
// with no value go back to the section list. esc there closes. H / L (tabs elsewhere) do nothing in this dialog.
function Settings({ close, section }: { close: () => void; section?: string }) {
  const s = useApp();
  const [sec, setSec] = useState(() => Math.max(0, ['General', 'Vim', 'Notifications', 'Machines'].indexOf(section || '')));
  const [row, setRow] = useState(0);
  const [col, setCol] = useState<'nav' | 'rows'>('nav');
  const sections: [string, string, Row[]][] = [
    ['General', 'sliders', [
      { label: 'Theme', seg: [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], get: () => s.settings.theme, set: v => setSetting({ theme: v as never }) },
      { label: 'Threads open as', desc: 'You can switch any tab between the two', seg: [['chat', 'Chat'], ['term', 'Terminal']], get: () => s.settings.defaultView, set: v => setSetting({ defaultView: v as never }) },
      { label: 'Sidebar', seg: [['grouped', 'By machine'], ['recent', 'Most recent']], get: () => s.settings.sideView, set: v => setSetting({ sideView: v as never }) },
    ]],
    ['Vim', 'keyboard', [
      { label: 'Vim keys', desc: 'Modal editing in composers, menus and read-only text', sw: () => s.settings.vim, toggle: () => setSetting({ vim: !s.settings.vim }) },
      { label: 'vimrc', desc: 'Insert maps and key bindings', btn: 'Edit', run: () => { close(); const p = A.focusedPane(); update(() => A.addTab(p, { id: 'vimrc-' + Date.now(), kind: 'vimrc' })); } },
      { label: 'Leader', desc: s.info.platform === 'mac' ? 'macOS may take ⌃Space for input sources' : 'Pane and tab commands, also inside terminals', seg: [['ctrl-space', kb('ctrl-space')], ['ctrl-\\', kb('ctrl-\\')]], get: () => s.settings.leader, set: v => setSetting({ leader: v as never }) },
    ]],
    ['Notifications', 'bell', [
      { label: 'Notify me', desc: 'When Skein is in the background or the thread is out of sight', seg: [['waiting', 'Waiting on me'], ['replies', 'Every reply'], ['off', 'Never']], get: () => s.settings.notify, set: v => setSetting({ notify: v as never }) },
    ]],
    ['Machines', 'host', [
      ...s.machines.map(m => ({
        label: m.name, desc: m.ssh ? `${m.ssh.user ? m.ssh.user + '@' : ''}${m.ssh.host}${m.note && m.link !== 'up' ? ' · ' + m.note : ''}` : m.os,
        extra: <span className="s-meta">{(['claude', 'codex'] as const).map(h => <span key={h} className={cx('has', !m.has.includes(h) && 'no')} title={`${harnessName(h)} ${m.has.includes(h) ? 'installed' : 'not found'}`}><Icon name={h} /></span>)}</span>,
        btn: m.ssh ? (m.link === 'up' ? 'Refresh' : 'Connect') : undefined, run: () => void api.machines.connect(m.id),
      })),
      { label: 'Add SSH host', desc: 'From ~/.ssh/config', btn: 'Add', run: () => addHostMenu() },
    ]],
  ];
  const rows = sections[sec][2];
  const r = rows[Math.min(row, rows.length - 1)];
  const step = (x: Row, d: number) => { if (!x.seg || !x.get || !x.set) return; const i = x.seg.findIndex(o => o[0] === x.get!()); x.set(x.seg[(i + d + x.seg.length) % x.seg.length][0]); };
  const press = (x: Row) => { if (x.seg) step(x, 1); else if (x.toggle) x.toggle(); else x.run?.(); };
  const goSec = (i: number) => { setSec(Math.max(0, Math.min(sections.length - 1, i))); setRow(0); };
  useDialogSurface({
    onEsc: () => (col === 'rows' ? setCol('nav') : close()),
    key: k => {
      if (k === 'q') { close(); return true; }
      if (col === 'nav') {
        if (k === 'j' || k === 'down') { goSec(sec + 1); return true; }
        if (k === 'k' || k === 'up') { goSec(sec - 1); return true; }
        if (k === 'G') { goSec(sections.length - 1); return true; }
        if (k === 'g') { goSec(0); return true; }
        if (k === 'l' || k === 'right' || k === 'enter' || k === 'tab' || k === 'space') { setCol('rows'); setRow(0); return true; }
        return k.length === 1 || k === 'shift-tab';
      }
      if (k === 'j' || k === 'down') { setRow(Math.min(rows.length - 1, row + 1)); return true; }
      if (k === 'k' || k === 'up') { setRow(Math.max(0, row - 1)); return true; }
      if (k === 'G') { setRow(rows.length - 1); return true; }
      if (k === 'g') { setRow(0); return true; }
      if (k === 'shift-tab') { setCol('nav'); return true; }
      if (k === 'l' || k === 'right') { if (r?.seg) step(r, 1); else if (r?.sw && !r.sw()) r.toggle?.(); return true; }
      if (k === 'h' || k === 'left') { if (r?.seg) step(r, -1); else if (r?.sw?.()) r.toggle?.(); else setCol('nav'); return true; }
      if (k === 'enter' || k === 'space') { if (r) press(r); return true; }
      return k.length === 1 || k === 'tab';
    },
  }, [sec, row, col, rows.length, s.settings]);
  return (
    <Dialog onClose={close} className="settings" label="Settings">
      <nav className={cx('settings-nav', s.settings.vim && col === 'nav' && 'kf')}><h4>Settings</h4>
        {sections.map(([n, i], k) => <button key={n} className={cx(k === sec && 'on')} aria-current={k === sec || undefined} onClick={() => { setSec(k); setRow(0); setCol('nav'); }}><Icon name={i} /><span>{n}</span></button>)}
      </nav>
      <section className="s-body">
        <header><h3>{sections[sec][0]}</h3><IconButton icon="x" label="Close" small onClick={close} /></header>
        {rows.map((x, i) => (
          <div key={x.label} className={cx('s-row', s.settings.vim && col === 'rows' && i === row && 'cur')} onMouseEnter={() => { setRow(i); setCol('rows'); }}>
            <div className="s-txt"><b>{x.label}</b>{x.desc && <span>{x.desc}</span>}</div>
            {x.extra}
            {x.seg ? <div className="seg txt">{x.seg.map(([v, n]) => <button key={v} className={cx(x.get?.() === v && 'on')} onClick={() => x.set?.(v)}>{n}</button>)}</div>
              : x.sw ? <Switch on={x.sw()} onChange={() => x.toggle?.()} label={x.label} />
              : x.btn ? <button className="btn sm" onClick={() => x.run?.()}>{x.btn}</button> : null}
          </div>
        ))}
      </section>
    </Dialog>
  );
}

async function addHostMenu() {
  const hosts = await api.machines.sshHosts();
  openMenu<string>({
    modal: true, className: 'pal', search: { placeholder: 'Host from ~/.ssh/config, or user@host' },
    items: q => [...hosts.map(h => ({ label: h, icon: <Icon name="host" />, data: h })), ...(q.trim() && !hosts.includes(q.trim()) ? [{ label: `Add ${q.trim()}`, icon: <Icon name="plus" />, data: q.trim() }] : [])],
    empty: 'No hosts in ~/.ssh/config. Type user@host',
    onPick: async it => {
      const raw = it.data!; const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(raw);
      if (!m) return;
      const added = await api.machines.add(m[2], { host: m[2], user: m[1], port: m[3] ? +m[3] : undefined });
      update(s => { s.machines = [...s.machines.filter(x => x.id !== added.id), added]; });
      void api.machines.connect(added.id);
    },
  });
}

export type { Surface };
export function useOverlayEffect() { useEffect(() => {}, []); }
