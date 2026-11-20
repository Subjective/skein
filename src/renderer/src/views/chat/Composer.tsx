// One composer for threads, side chats, subagents and the edit-a-message box.
// Text is a VimField; / anywhere a word starts opens the command menu, @ opens files; images come from
// the + button, paste or drop; quoted selections sit in the text as chips (painted by the layer behind).
// Below the text: attach, permissions, model and effort, context used, send / stop. j from the text's
// last line (NORMAL) moves onto that row: h / l pick, enter presses, k goes back up.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Harness, ThreadMeta } from '@shared/types';
import type { Mode, Surface } from '../../input/dispatcher';
import { registerTab } from '../../input/surfaces';
import { api } from '../../api';
import { update } from '../../state/store';
import { openMenu } from '../../shell/overlays';
import { Menu, type MenuItem } from '../../ui/Menu';
import { Chip, cx, Icon, IconButton, SendButton } from '../../ui/primitives';
import { VimField, type VimFieldHandle } from '../../ui/VimField';
import { effortId, effortLabel, efforts, HARNESS_SLASH, modelLabel, models, OURS, permLabel, PERMS } from './options';
import { saveDraft, syncQuotes, TOK, type Draft } from './state';

export interface ComposerHandle { focus(insert?: boolean): void; caret(): number; field(): VimFieldHandle | null }

export interface ComposerProps {
  tabId: string;
  /** Persist the draft's text under this key (tabs), or not at all (the edit box). */
  persist?: string;
  thread: ThreadMeta;
  draft: Draft;
  onDraft(d: Draft): void;
  placeholder?: string;
  running?: boolean;
  onSend(): void;
  onStop?(): void;
  /** Our own / commands: /model is handled here; the rest go to the view. */
  onCommand?(cmd: string, anchor: DOMRect): void;
  onLeave?(): void;
  onLeaveUp?(): void;
  /** Keys the view wants first in NORMAL (y / n for requests, gg into the reader). */
  onNormalKey?(k: string): boolean;
  showContext?: boolean;
  /** Hide the pickers (subagents run with their thread's settings). */
  bare?: boolean;
  autoFocus?: boolean;
  className?: string;
}

type Pop = { kind: 'slash' | 'at'; from: number; q: string } | null;

const wordAt = (text: string, pos: number): Pop => {
  const before = text.slice(0, pos);
  let m = /(^|\s)(\/[\w:-]*)$/.exec(before);
  if (m) return { kind: 'slash', from: pos - m[2].length, q: m[2] };
  m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (m) return { kind: 'at', from: pos - m[2].length - 1, q: m[2] };
  return null;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(p, handle) {
  const field = useRef<VimFieldHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const cf = useRef<HTMLDivElement>(null);
  const bk = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const props = useRef(p); props.current = p;
  const [pop, setPop] = useState<Pop>(null);
  const menu = useRef<Surface | undefined>(undefined);
  const h: Harness = p.thread.harness;

  useImperativeHandle(handle, () => ({ focus: i => field.current?.focus(i), caret: () => field.current?.state().pos ?? 0, field: () => field.current }));

  const set = (d: Partial<Draft>) => {
    const next = { ...props.current.draft, ...d };
    if (d.text !== undefined) next.quotes = syncQuotes(next);
    props.current.onDraft(next);
    if (props.current.persist && d.text !== undefined) saveDraft(props.current.persist, next.text);
  };

  // ---- / and @ ----
  const onChange = (text: string) => {
    set({ text });
    const pos = field.current?.el()?.selectionStart ?? text.length;
    setPop(wordAt(text, pos));
  };
  const [files, setFiles] = useState<{ dir: string; list: { name: string; dir: boolean }[] }>({ dir: '', list: [] });
  const atDir = pop?.kind === 'at' ? pop.q.replace(/[^/\\]*$/, '') : '';
  useEffect(() => {
    if (pop?.kind !== 'at') return;
    let live = true;
    const th = props.current.thread;
    void api.fs.list(th.machine, `${th.dir.replace(/[\\/]$/, '')}/${atDir}`).then(list => { if (live) setFiles({ dir: atDir, list: list.filter(e => !e.hidden) }); }).catch(() => live && setFiles({ dir: atDir, list: [] }));
    return () => { live = false; };
  }, [pop?.kind, atDir]);

  const items = useMemo((): MenuItem<string>[] => {
    if (!pop) return [];
    if (pop.kind === 'slash') {
      const q = pop.q.toLowerCase(), hit = (c: string) => c.startsWith(q);
      const ours = OURS.filter(([c]) => hit(c)), theirs = HARNESS_SLASH[h].filter(([c]) => hit(c));
      return [...ours.map(([c, d]) => ({ label: c, hint: d, data: c })), ...theirs.map(([c, d]) => ({ label: c, hint: d, data: c }))];
    }
    const base = pop.q.slice(atDir.length).toLowerCase();
    if (files.dir !== atDir) return [];
    return files.list.filter(e => e.name.toLowerCase().startsWith(base)).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 50)
      .map(e => ({ label: e.name + (e.dir ? '/' : ''), icon: <Icon name={e.dir ? 'folder' : 'file'} />, data: atDir + e.name + (e.dir ? '/' : '') }));
  }, [pop, files, atDir, h]);
  // a word like /usr/bin that matches no command opens nothing
  const open = !!pop && (items.length > 0 || (pop.kind === 'at' && files.dir !== atDir));

  const pick = (it: MenuItem<string>) => {
    const d = props.current.draft, f = pop; if (!f || !it.data) return;
    const pos = field.current?.state().pos ?? d.text.length;
    if (f.kind === 'slash' && OURS.some(([c]) => c === it.data)) {   // ours: take the word out, keep the rest, act
      const text = (d.text.slice(0, f.from) + d.text.slice(pos)).replace(/ {2,}/g, ' ');
      set({ text }); field.current?.set(text); setPop(null);
      const anchor = box.current!.getBoundingClientRect();
      if (it.data === '/model') pickModel(anchor); else props.current.onCommand?.(it.data, anchor);
      return;
    }
    const ins = f.kind === 'slash' ? it.data + ' ' : '@' + it.data + (it.data.endsWith('/') ? '' : ' ');
    const text = d.text.slice(0, f.from) + ins + d.text.slice(pos);
    set({ text }); field.current?.set(text);
    const at = f.from + ins.length;
    const el = field.current?.el(); if (el) el.setSelectionRange(at, at);
    setPop(it.data.endsWith('/') && f.kind === 'at' ? { kind: 'at', from: f.from, q: it.data } : null);
  };

  // ---- pickers ----
  const choose = (patch: Partial<ThreadMeta>) => { void api.threads.update(props.current.thread.id, patch); };
  const pickModel = (anchor: DOMRect) => {
    const th = props.current.thread, es = efforts(h, th.model);
    let effort = effortId(th.effort) ?? 'medium';
    const close = openMenu<{ model?: string; effort?: string }>({
      anchor, place: 'top-end', width: 260, className: 'composer-menu', normal: true,
      items: [
        ...models(h).map(m => ({ label: m.label, icon: <Icon name={h} />, on: modelLabel(h, th.model) === m.label, data: { model: m.id } })),
        { head: true, label: 'Effort' },
        ...es.map(e => ({ label: e.label, on: e.id === effort, data: { effort: e.id } })),
      ],
      keys: k => {   // h / l step the effort without leaving the model
        const i = es.findIndex(e => e.id === effort), d = k === 'h' || k === 'left' ? -1 : k === 'l' || k === 'right' ? 1 : 0;
        if (!d) return false;
        effort = es[Math.max(0, Math.min(es.length - 1, i + d))].id; choose({ effort }); close(); pickModel(anchor); return true;
      },
      onPick: it => { if (it.data) choose(it.data); },
    });
  };
  const pickPerm = (anchor: DOMRect) => openMenu<string>({
    anchor, place: 'top-start', width: 220, className: 'composer-menu', normal: true,
    items: PERMS[h].map(o => ({ label: o.label, hint: o.hint, icon: <Icon name="shield" />, on: permLabel(h, p.thread.perm) === o.label, data: o.id })),
    onPick: it => choose({ perm: it.data }),
  });

  // ---- images ----
  const addFiles = (fs: Iterable<File>) => {
    for (const f of fs) {
      if (!f.type.startsWith('image/')) continue;
      const r = new FileReader();
      r.onload = () => set({ images: [...props.current.draft.images, String(r.result)] });
      r.readAsDataURL(f);
    }
  };

  // ---- the row under the text (keyboard) ----
  const ctl = useRef<{ i: number; un?: () => void }>({ i: 0 });
  const buttons = () => [...(cf.current?.querySelectorAll<HTMLButtonElement>(':scope > button') ?? [])];
  const ctlMark = (i: number) => { const bs = buttons(); bs.forEach(b => b.classList.remove('kcur')); ctl.current.i = Math.max(0, Math.min(bs.length - 1, i)); bs[ctl.current.i]?.classList.add('kcur'); };
  const ctlEnd = (back?: 'normal' | 'insert') => {
    buttons().forEach(b => b.classList.remove('kcur')); ctl.current.un?.(); ctl.current.un = undefined;
    if (back) field.current?.focus(back === 'insert'); else { props.current.onLeave?.(); update(s => { s.tick++; }); }
  };
  const ctlSurface: Surface = {
    kind: 'list', mode: () => 'NORMAL',
    key: k => {
      const i = ctl.current.i;
      if (k === 'h' || k === 'left') ctlMark(i - 1);
      else if (k === 'l' || k === 'right') ctlMark(i + 1);
      else if (k === 'k' || k === 'up') ctlEnd('normal');
      else if (k === 'i' || k === 'a') ctlEnd('insert');
      else if (k === 'esc') ctlEnd();
      else if (k === 'enter' || k === 'space') { const b = buttons()[i]; ctlEnd(); b?.click(); }
      else return k.length === 1;
      return true;
    },
  };
  const toControls = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    ctl.current.un = registerTab(p.tabId, ctlSurface);
    ctlMark(0); update(s => { s.tick++; });
  };
  useEffect(() => () => ctl.current.un?.(), []);

  // ---- keys the field gives us first ----
  const onKey = (k: string, mode: Mode) => {
    if (open && menu.current && ['up', 'down', 'ctrl-n', 'ctrl-p', 'ctrl-j', 'ctrl-k', 'tab', 'shift-tab', 'enter'].includes(k)) return menu.current.key(k, { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
    if (open && k === 'esc') { setPop(null); return false; }   // the field goes to NORMAL too
    if (mode === 'NORMAL' && props.current.onNormalKey?.(k)) return true;
    return false;
  };

  // the layer behind the text paints quote chips
  const paintBk = () => { const b = bk.current, el = field.current?.el(); if (b && el) b.scrollTop = el.scrollTop; };
  useEffect(paintBk);

  const th = p.thread, ctx = th.ctx;
  const hasText = !!p.draft.text.trim() || p.draft.images.length > 0;
  return (
    <div ref={box} className={cx('comp', p.className)} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}>
      {p.draft.images.length > 0 && (
        <div className="atts">{p.draft.images.map((src, i) => (
          <span key={i} className="att"><img src={src} alt="" /><IconButton icon="x" label="Remove image" onClick={() => set({ images: p.draft.images.filter((_, j) => j !== i) })} /></span>
        ))}</div>
      )}
      <div className="taw">
        <div ref={bk} className="bk" aria-hidden="true">{p.draft.text.split(TOK).flatMap((s, i, a) => {
          const toks = p.draft.text.match(TOK) || [];
          return i < a.length - 1 ? [s, <span key={i} className="tok">{toks[i]}</span>] : [s];
        })}{'​'}</div>
        <VimField ref={field} tabId={p.tabId} value={p.draft.text} onChange={onChange} placeholder={p.placeholder || 'Send follow-up'}
          autoFocus={p.autoFocus} onEnter={() => { if (open) return; p.onSend(); }} onLeave={() => { setPop(null); p.onLeave?.(); }}
          onLeaveUp={() => p.onLeaveUp?.()} onLeaveDown={toControls} onKey={onKey}
          onPaste={e => { const fs = [...e.clipboardData.files].filter(f => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); addFiles(fs); } }} />
      </div>
      <div className="cf" ref={cf}>
        <IconButton icon="plus" label="Attach image" onClick={() => file.current?.click()} />
        {!p.bare && <Chip icon="shield" label={<span className="lbl">{permLabel(h, th.perm)}</span>} title="Permissions" onClick={e => pickPerm(e.currentTarget.getBoundingClientRect())} />}
        <span className="sp" />
        {!p.bare && <Chip icon={h} caret title="Model and effort" label={<>{modelLabel(h, th.model)} <span className="lbl dim">{effortLabel(th.effort)}</span></>} onClick={e => pickModel(e.currentTarget.getBoundingClientRect())} />}
        {p.showContext && ctx != null && <span className="ib ctx" role="img" aria-label={`Context: ${ctx}% used`} title={`Context: ${ctx}% used, ${100 - ctx}% left`}><span className="ring" style={{ ['--p' as string]: ctx }} /></span>}
        <SendButton stop={p.running && !hasText} disabled={!p.running && !hasText} onClick={() => (p.running && !hasText ? p.onStop?.() : p.onSend())} />
      </div>
      <input ref={file} type="file" accept="image/*" multiple hidden onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
      {open && box.current && (
        <Menu<string> items={items} anchor={box.current.getBoundingClientRect()} place="top-start" width="anchor" className="composer-menu" empty="Loading…"
          surface={s => { menu.current = s; }} onPick={pick} onClose={() => setPop(null)} />
      )}
    </div>
  );
});
