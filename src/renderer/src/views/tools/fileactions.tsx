// The open file's ⋯ menu: Cursor's, trimmed to what Skein does (Josh, 2026-11-21). The same actions are ex commands
// (:reveal, :copypath, :copyurl, :diffview, :numbers, :wrap, :discard) and a File group in ctrl-k, so every one is
// reachable without the mouse. Line numbers and word wrap are settings (every file); the diff view is per tab.
import { useMemo } from 'react';
import { api } from '../../api';
import { yank } from '../../input/register';
import * as A from '../../state/actions';
import type { Tab } from '../../state/layout';
import { machine, openLayer, S, toast, update, useApp } from '../../state/store';
import { Menu, type MenuItem } from '../../ui/Menu';
import { cx } from '../../ui/primitives';
import { baseName } from './highlight';
import { ctxOf, join } from './repo';

export type FileAction = 'discard' | 'reveal' | 'copypath' | 'copyurl' | 'diffview' | 'numbers' | 'wrap';
export const FILE_ACTIONS: FileAction[] = ['discard', 'reveal', 'copypath', 'copyurl', 'diffview', 'numbers', 'wrap'];

/** What an open file view tells the menu (FileView registers it while mounted). */
export interface FileLive {
  dirty(): boolean;
  discard(): void;
  /** The file differs from its last commit, so a diff view has something to show. */
  canDiff(): boolean;
  diff(): boolean;
  setDiff(on: boolean): void;
  /** The repository root and the file's path in it, when the file is in one. */
  repo(): { root: string; rel: string } | null;
}
const live = new Map<string, FileLive>();
export const registerFile = (tabId: string, f: FileLive) => { live.set(tabId, f); return () => { if (live.get(tabId) === f) live.delete(tabId); }; };

export const numbersOn = () => S.settings.fileNumbers !== false;
export const wrapOn = () => !!S.settings.fileWrap;
const setSetting = async (patch: Partial<typeof S.settings>) => { const v = await api.app.setSettings(patch); update(s => { s.settings = v; }); };

const revealLabel = () => (S.info.platform === 'mac' ? 'Reveal in Finder' : S.info.platform === 'win' ? 'Reveal in File Explorer' : 'Show in folder');
const sw = (on: boolean) => <span className={cx('sw', on && 'on')} aria-hidden="true" />;
const sep = (): MenuItem<FileAction> => ({ head: true, label: '', block: <i className="msep" /> });
const isToggle = (a?: FileAction) => a === 'diffview' || a === 'numbers' || a === 'wrap';

/** The menu's rows for a file tab, in Cursor's order. Discard shows only with unsaved edits. */
export function fileItems(t: Tab): MenuItem<FileAction>[] {
  const f = live.get(t.id), remote = !!machine(ctxOf(t).machine)?.ssh, inRepo = !!f?.repo(), canDiff = !!f?.canDiff();
  return [
    ...(f?.dirty() ? [{ label: 'Discard changes', data: 'discard' as const }, sep()] : []),
    { label: revealLabel(), dis: remote, hint: remote ? 'Not on this computer' : undefined, data: 'reveal' },
    { label: 'Copy relative path', data: 'copypath' },
    { label: 'Copy remote URL', dis: !inRepo, hint: inRepo ? undefined : 'Not in a repository', data: 'copyurl' },
    sep(),
    { label: 'Diff view', dis: !canDiff, hint: canDiff ? undefined : 'No changes', right: sw(canDiff && !!f?.diff()), data: 'diffview' },
    sep(),
    { label: 'Line numbers', right: sw(numbersOn()), data: 'numbers' },
    { label: 'Word wrap', right: sw(wrapOn()), data: 'wrap' },
  ];
}

/** Run an action on a file tab. false when the tab is not an open file (the command then says so). */
export function fileAction(a: FileAction, t: Tab = A.currentTab()): boolean {
  const f = live.get(t.id);
  if (t.kind !== 'file' || !f) return false;
  const ctx = ctxOf(t), path = t.path || '';
  switch (a) {
    case 'discard': {
      if (!f.dirty()) { toast('No unsaved changes'); break; }
      f.discard(); toast(<>Discarded changes to <b>{baseName(path)}</b></>, { icon: 'retry' });
      break;
    }
    case 'reveal':
      if (machine(ctx.machine)?.ssh) { toast(`${baseName(path)} is on ${machine(ctx.machine)?.name}, not this computer`, { icon: 'host' }); break; }
      void api.app.reveal(join(ctx.dir, path)).catch(e => toast(`Couldn't reveal it: ${e instanceof Error ? e.message : e}`, { icon: 'alert' }));
      break;
    case 'copypath': yank(path); toast(<>Copied <b>{path}</b></>, { icon: 'copy' }); break;
    case 'copyurl': {
      const r = f.repo();
      if (!r) { toast('This file is not in a repository'); break; }
      void api.git.webUrl(ctx.machine, r.root, r.rel).then(
        u => { if (!u) { toast('No web address for this repository\'s remote'); return; } yank(u); toast('Copied the remote URL', { icon: 'copy' }); },
        e => toast(`Couldn't read the remote: ${e instanceof Error ? e.message : e}`, { icon: 'alert' }));
      break;
    }
    case 'diffview': if (!f.canDiff()) toast('No changes since the last commit'); else f.setDiff(!f.diff()); break;
    case 'numbers': void setSetting({ fileNumbers: !numbersOn() }); break;
    case 'wrap': void setSetting({ fileWrap: !wrapOn() }); break;
  }
  return true;
}

/** The ⋯ menu, under its button. It redraws as its toggles change; they keep it open. */
export function openFileMenu(t: Tab, anchor: DOMRect | null) {
  const Live = ({ close }: { close: () => void }) => {
    useApp();
    // a new list only when a row changes: the menu re-registers its keys for every new list
    const f = live.get(t.id), sig = [f?.dirty(), f?.canDiff(), f?.diff(), numbersOn(), wrapOn()].join();
    const items = useMemo(() => fileItems(t), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
    return <Menu<FileAction> anchor={anchor} place="bottom-end" width={250} className="file-menu" items={items} onClose={close}
      keep={it => isToggle(it.data)} onPick={it => { if (it.data) fileAction(it.data, t); }} />;
  };
  openLayer(close => <Live close={close} />);
}
