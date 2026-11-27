// One composer for threads, side chats, subagents and the edit-a-message box.
// Text is a CodeField (the file editor's CodeMirror and Vim); / anywhere a word starts opens the command menu, @ opens
// files; images come from the + button, paste or drop; quoted selections sit in the text as chips, one item each.
// Below the text: attach, permissions, model and effort, context used, send / stop. j from the text's
// last line (NORMAL) moves onto that row: h / l pick, enter presses, k goes back up.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Harness, ThreadMeta } from '@shared/types';
import { findModel, snapEffort, STANDARD_SPEED, type ModelDef } from '@shared/models';
import type { Mode, Surface } from '../../input/dispatcher';
import { registerTab } from '../../input/surfaces';
import { api } from '../../api';
import { machine, openLayer, toast, update } from '../../state/store';
import * as A from '../../state/actions';
import { openMenu } from '../../shell/overlays';
import { canBranch, HARNESSES, harnessName } from '../../shell/meta';
import { Menu, type MenuItem } from '../../ui/Menu';
import { placeBy } from '../../ui/place';
import { animate, MOTION } from '../../ui/motion';
import { Chip, cx, Icon, IconButton, SendButton } from '../../ui/primitives';
import { FileIcon } from '../../ui/FileIcon';
import { CodeField, type CodeFieldHandle } from '../../ui/editor/CodeField';
import { openLightbox } from '../../ui/Lightbox';
import { useDialogSurface } from '../../ui/Dialog';
import { effortId, effortLabel, efforts, harnessOptions, INSTALL, modelDef, modelId, modelLabel, isOurs, permChoices, permLabel, permOf, permRow, SLASH_ARGS, slashHidden, slashHit, THREAD_SLASH, useHarnessCommands, type Slash } from './options';
import { hoverQuote, paintQuotes, QI, revealQuote, saveDraft, setSpeed, setUltra, speedOf, syncQuotes, TOK, ultraOf, useChat, type Draft, type Quote } from './state';

export interface ComposerHandle {
  focus(insert?: boolean): void; caret(): number; field(): CodeFieldHandle | null
  /** The row under the text (permissions, model, send) has the keys: a menu it opened keeps them there when it closes. */
  onControls(): boolean;
}

export interface ComposerProps {
  tabId: string;
  /** Persist the draft's text under this key (tabs), or not at all (the edit box). */
  persist?: string;
  thread: ThreadMeta;
  draft: Draft;
  onDraft(d: Draft): void;
  placeholder?: string;
  running?: boolean;
  /** `alt`: mod-enter, which does the other of queue and steer while a turn runs. */
  onSend(alt?: boolean): void;
  /** The text got the keys (a click, or focus from elsewhere). */
  onFocus?(): void;
  /** Codex: a stop interrupted the last turn, so with nothing typed send (enter, the ▶ button) continues it. */
  canContinue?: boolean;
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
  startMode?: 'INSERT' | 'NORMAL';
  className?: string;
  /** A thread not started yet (the launcher): `thread` is a stand-in, the pickers offer every harness and report here. */
  fresh?: { onSettings(patch: { harness?: Harness; model?: string; effort?: string; perm?: string }, ultra?: boolean): void };
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
  const field = useRef<CodeFieldHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const cf = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const props = useRef(p); props.current = p;
  const [pop, setPop] = useState<Pop>(null);
  const menu = useRef<Surface | undefined>(undefined);
  const h: Harness = p.thread.harness;

  useImperativeHandle(handle, () => ({ focus: i => field.current?.focus(i), caret: () => field.current?.state().pos ?? 0, field: () => field.current, onControls: () => !!ctl.current.un }));

  const set = (d: Partial<Draft>) => {
    const next = { ...props.current.draft, ...d };
    if (d.text !== undefined) next.quotes = syncQuotes(next);
    props.current.onDraft(next);
    if (props.current.persist && d.text !== undefined) saveDraft(props.current.persist, next.text, next.quotes);
  };

  // ---- / and @ ----
  const onChange = (text: string) => {
    set({ text });
    const pos = field.current?.state().pos ?? text.length;
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

  // the harness's commands and skills in the thread's folder (bundled until it answers)
  const slashes = useHarnessCommands(h, p.thread.machine, p.thread.dir);
  const items = useMemo((): MenuItem<string>[] => {
    if (!pop) return [];
    if (pop.kind === 'slash') {
      // nothing typed: sections, as Codex's menu: the harness's everyday commands, Skein's own (side chats, subagents),
      // the skills, then the harness's other built-ins under More. Typing: one list of what matches, each row tagged
      // with where it comes from (Josh, 2026-11-20)
      const where = { bare: p.bare, side: !!p.thread.side, fresh: !!p.fresh };
      const hit = (c: Slash) => slashHit(c, pop.q) && !slashHidden(c.cmd, h, where);
      const typed = pop.q.replace(/^[/$]/, '') !== '';
      const row = (tag?: string) => (c: Slash): MenuItem<string> => ({ label: c.cmd, display: c.display, hint: c.hint, icon: <Icon name={c.icon} />, data: c.cmd, ...(typed && tag ? { right: <span className="src">{tag}</span> } : {}) });
      const cmds = slashes.commands.filter(hit), ours = (!p.bare && !p.thread.side && !p.fresh ? THREAD_SLASH.filter(x => canBranch(p.thread.harness) || !x.cmd.startsWith('/side')) : []).filter(hit), skills = slashes.skills.filter(hit), more = slashes.more.filter(hit);
      const part = (label: string, xs: Slash[], tag?: string): MenuItem<string>[] => (xs.length ? [...(typed ? [] : [{ head: true, label }]), ...xs.map(row(tag))] : []);
      return typed ? [...part('', [...cmds, ...more]), ...part('', ours, 'Skein'), ...part('', skills, 'Skill')]
        : [...part(harnessName(h), cmds), ...part('Skein', ours), ...part('Skills', skills), ...part('More', more)];
    }
    const base = pop.q.slice(atDir.length).toLowerCase();
    if (files.dir !== atDir) return [];
    return files.list.filter(e => e.name.toLowerCase().startsWith(base)).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 50)
      .map(e => ({ label: e.name + (e.dir ? '/' : ''), icon: <FileIcon path={e.name} dir={e.dir} />, data: atDir + e.name + (e.dir ? '/' : '') }));
  }, [pop, files, atDir, h, slashes]);
  // a word like /usr/bin that matches no command opens nothing
  const open = !!pop && (items.length > 0 || (pop.kind === 'at' && files.dir !== atDir));

  const pick = (it: MenuItem<string>) => {
    const d = props.current.draft, f = pop; if (!f || !it.data) return;
    const pos = field.current?.state().pos ?? d.text.length;
    if (f.kind === 'slash' && isOurs(it.data, h, whereNow())) {   // ours: take the word out, keep the rest, act
      const text = (d.text.slice(0, f.from) + d.text.slice(pos)).replace(/ {2,}/g, ' ');
      set({ text }); field.current?.set(text, f.from); setPop(null);
      runOurs(it.data, '', f.from, text);
      return;
    }
    const ins = f.kind === 'slash' ? it.data + ' ' : '@' + it.data + (it.data.endsWith('/') ? '' : ' ');
    const text = d.text.slice(0, f.from) + ins + d.text.slice(pos);
    set({ text }); field.current?.set(text, f.from + ins.length);
    setPop(it.data.endsWith('/') && f.kind === 'at' ? { kind: 'at', from: f.from, q: it.data } : null);
  };

  // one of our commands typed (the menu dismissed): enter runs it rather than sending it to the harness. Alone, or
  // with what /model, /effort and /plan take ('/model opus'); anything else with words after it goes as typed
  const whereNow = () => ({ bare: props.current.bare, side: !!props.current.thread.side, fresh: !!props.current.fresh });
  const ourCommand = () => {
    const m = /^(\/[\w-]+)(?:\s+([\s\S]*))?$/.exec(props.current.draft.text.trim());
    if (!m || !isOurs(m[1], h, whereNow()) || (m[2] && !SLASH_ARGS.includes(m[1]))) return false;
    // /plan <what>: Plan mode, with the request left to send in it
    const rest = m[1] === '/plan' ? m[2] ?? '' : '';
    set({ text: rest }); field.current?.set(rest);
    runOurs(m[1], m[1] === '/plan' ? '' : m[2]?.trim() ?? '', 0, rest);
    return true;
  };
  /** Act on one of ours; `text` is the draft without it, `at` where it was (/mention starts an @ there). */
  const runOurs = (cmd: string, arg: string, at: number, text: string) => {
    const anchor = box.current!.getBoundingClientRect(), t = props.current.thread;
    switch (cmd) {
      case '/model': {
        const d = arg ? findModel(h, arg, harnessOptions(h, t.machine).models) ?? findModel(h, arg) : undefined;
        if (d) choose({ model: d.id }); else pickModel(anchor);
        return;
      }
      case '/effort': {
        const e = arg && efforts(h, t.model, t.machine).find(x => x.id === effortId(arg));
        if (e) choose({ effort: e.id }); else pickModel(anchor);
        return;
      }
      case '/permissions': case '/approvals': return pickPerm(anchor);
      case '/plan': return choose({ perm: 'plan' });
      case '/mention': {
        const withAt = text.slice(0, at) + '@' + text.slice(at);
        set({ text: withAt }); field.current?.set(withAt, at + 1); setPop({ kind: 'at', from: at, q: '' });
        return;
      }
      default: props.current.onCommand?.(cmd, anchor);
    }
  };

  // ---- pickers ----
  const choose = (patch: { harness?: Harness; model?: string; effort?: string; perm?: string }) => {
    const f = props.current.fresh;
    if (f) f.onSettings(patch); else void api.threads.update(props.current.thread.id, patch);
  };
  const pickModel = (anchor: DOMRect) => {
    const th = props.current.thread;
    openModelPicker(anchor, {
      groups: props.current.fresh ? HARNESSES : [th.harness], machine: th.machine,
      value: () => {
        const t = props.current.thread, d = modelDef(t.harness, t.model, t.machine);
        return { h: t.harness, model: modelId(t.harness, t.model, t.machine) || d.id, effort: effortId(t.effort) || d.effort || 'medium', ultra: ultraOf(t.id), speed: speedOf(t.id) };
      },
      set: v => { choose({ ...(v.h !== props.current.thread.harness ? { harness: v.h } : {}), model: v.model, effort: v.effort }); setUltra(th.id, v.ultra); setSpeed(th.id, v.speed); },
    });
  };
  // like Codex desktop's: each mode's icon, name and one line on what it allows, a check on the current one; the mode
  // without limits in the warning tone
  const pickPerm = (anchor: DOMRect) => {
    const t = props.current.thread, cur = permOf(h, t.perm);
    openMenu<string>({
      anchor, place: 'top-start', width: 460, className: 'perms',
      items: permChoices(h, t.machine, cur).map(o => ({ label: o.label, hint: o.hint, icon: o.icon && <Icon name={o.icon} />, warn: o.warn, on: cur === o.id, data: o.id })),
      onPick: it => choose({ perm: it.data }),
    });
  };

  // ---- images ----
  const addFiles = (fs: Iterable<File>) => {
    for (const f of fs) {
      if (!f.type.startsWith('image/')) continue;
      const r = new FileReader();
      r.onload = () => set({ images: [...props.current.draft.images, String(r.result)] });
      r.readAsDataURL(f);
    }
  };

  const pasteFromClipboard = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(x => x.startsWith('image/'));
        if (type) { const b = await item.getType(type); addFiles([new File([b], 'paste.png', { type })]); return; }
      }
    } catch { /* no permission or nothing there */ }
  };

  // ---- the row under the text (keyboard) ----
  const ctl = useRef<{ r: number; i: number; un?: () => void }>({ r: 0, i: 0 });
  // the rows under the text: the controls, and on a new thread also its machine / folder / worktree chips and the
  // four cards (j / k between rows, h / l along one)
  const rows = () => {
    const np = p.fresh ? cf.current?.closest('.newp') : null;
    return [cf.current ? [...cf.current.querySelectorAll<HTMLButtonElement>(':scope > button')] : [],
      ...(np ? ['.under', '.cards'].map(q => [...np.querySelectorAll<HTMLButtonElement>(`${q} button`)]) : [])].filter(r => r.length);
  };
  const buttons = () => rows()[ctl.current.r] ?? [];
  const unmark = () => rows().flat().forEach(b => b.classList.remove('kcur'));
  const ctlMark = (i: number, r = ctl.current.r) => {
    const rs = rows(); unmark(); ctl.current.r = Math.max(0, Math.min(rs.length - 1, r));
    const bs = rs[ctl.current.r] ?? []; ctl.current.i = Math.max(0, Math.min(bs.length - 1, i));
    const b = bs[ctl.current.i]; b?.classList.add('kcur'); b?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const ctlEnd = (back?: 'normal' | 'insert') => {
    unmark(); ctl.current.un?.(); ctl.current.un = undefined;
    if (back) field.current?.focus(back === 'insert'); else { props.current.onLeave?.(); update(s => { s.tick++; }); }
  };
  const ctlSurface: Surface = {
    kind: 'list', mode: () => 'NORMAL',
    key: k => {
      const i = ctl.current.i;
      if (k === 'h' || k === 'left') ctlMark(i - 1);
      else if (k === 'l' || k === 'right') ctlMark(i + 1);
      else if (k === 'j' || k === 'down') ctlMark(i, ctl.current.r + 1);
      else if (k === 'k' || k === 'up') { if (ctl.current.r > 0) ctlMark(i, ctl.current.r - 1); else ctlEnd('normal'); }
      else if (k === 'i' || k === 'a') { const f = field.current; if (f) f.set(f.state().text); ctlEnd('insert'); }   // back at the END of the text (mockup keys.js)
      else if (k === 'esc') ctlEnd();
      // send leaves the row for the text (a resend closes an edit box itself); any other button opens its popup or
      // file picker with the row kept under it, so the keys come back to this chip when that closes. Leaving first
      // ran onLeave, which closed an edit box under its own permission or model menu.
      else if (k === 'enter' || k === 'space') { const b = buttons()[i]; if (b?.classList.contains('send')) ctlEnd('normal'); b?.click(); }
      else return false;   // the app's NORMAL layer gets the rest (: H L | \ ?); the dispatcher drops what nobody takes
      return true;
    },
  };
  const toControls = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const un = registerTab(p.tabId, ctlSurface);
    // any mousedown takes the row's cursor away (the click itself decides where the keys go next)
    const md = () => { unmark(); if (ctl.current.un === off) { off(); ctl.current.un = undefined; } };
    const off = () => { removeEventListener('mousedown', md, true); un(); };
    addEventListener('mousedown', md, true);
    ctl.current.un = off;
    ctlMark(0, 0); update(s => { s.tick++; });
  };
  useEffect(() => () => ctl.current.un?.(), []);
  // a pick redraws the chip (a new label or tone) and React drops the class it did not set: mark it again
  useLayoutEffect(() => { if (ctl.current.un) buttons()[ctl.current.i]?.classList.add('kcur'); });

  // ---- esc esc stops a running turn ----
  // While the turn runs, the first esc in NORMAL arms the stop button for 1.5 s and stays; a second esc in that time
  // stops the turn (as the stop button does). When the window ends nothing stops, and the next esc leaves as usual.
  const [armed, setArmed] = useState(false);
  const arm = useRef<{ timer?: ReturnType<typeof setTimeout>; lapsed: boolean; on?: boolean }>({ lapsed: false });
  const disarm = (lapsed: boolean) => { clearTimeout(arm.current.timer); arm.current = { lapsed }; setArmed(false); };
  const escStop = (): boolean => {
    if (!props.current.running || !props.current.onStop) return false;
    if (arm.current.on) { disarm(false); props.current.onStop(); return true; }
    if (arm.current.lapsed) { arm.current.lapsed = false; return false; }   // the window ended: this esc leaves
    arm.current = { lapsed: false, on: true, timer: setTimeout(() => disarm(true), 1500) };
    setArmed(true);
    return true;
  };
  useEffect(() => { if (!p.running) disarm(false); }, [p.running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(arm.current.timer), []);
  useEffect(() => {
    const b = cf.current?.querySelector('.send');
    animate(b, armed ? [{ transform: 'scale(.82)', opacity: .5 }, { transform: 'scale(1)', opacity: 1 }] : [{ opacity: .6 }, { opacity: 1 }], MOTION.fast);
  }, [armed]);

  // ---- keys the field gives us first ----
  const onKey = (k: string, mode: Mode) => {
    // tab completes like enter in the / and @ lists (the mockup's menu keys)
    if (open && k === 'enter' && !items.length) setPop(null);   // the @ list still loading: nothing to pick, enter sends
    else if (open && menu.current && ['up', 'down', 'ctrl-n', 'ctrl-p', 'ctrl-j', 'ctrl-k', 'tab', 'shift-tab', 'enter'].includes(k)) return menu.current.key(k === 'tab' || k === 'shift-tab' ? 'enter' : k, { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }) === true;
    if (open && k === 'esc') { setPop(null); return false; }   // the field goes to NORMAL too
    if (k === 'esc' && mode === 'NORMAL' && escStop()) return true;
    if (!open && (k === 'mod-enter' || k === 'ctrl-enter' || k === 'cmd-enter')) { if (!ourCommand()) props.current.onSend(true); return true; }
    if (mode === 'NORMAL' && props.current.onNormalKey?.(k)) return true;
    // NORMAL has no paste event (the keys don't type): ctrl-v / cmd-v still attach an image on the clipboard
    if (mode === 'NORMAL' && (k === 'ctrl-v' || k === 'cmd-v')) { void pasteFromClipboard(); return true; }
    return false;
  };
  const popOpen = useRef(false); popOpen.current = open;

  // ---- quotes: hover lights up the source and offers an x; a click goes to the source (mockup tokUnder, noteGo) ----
  const taw = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState<{ i: number; id: string; right: number; top: number } | null>(null);
  const tokx = useRef<HTMLButtonElement>(null);
  // a chip may be drawn in pieces (a wrapped line, its icon): each piece carries its quote's index
  const chipEls = (i?: number) => [...(taw.current?.querySelectorAll<HTMLElement>(i == null ? '.tok[data-q]' : `.tok[data-q="${i}"]`) ?? [])];
  const tokUnder = (x: number, y: number) => { const el = chipEls().find(sp => [...sp.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)); return el ? Number(el.dataset.q) : -1; };
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      const t = e.target as Node;
      if (tokx.current?.contains(t)) return;
      const i = taw.current?.contains(t) ? tokUnder(e.clientX, e.clientY) : -1;
      const q = i >= 0 ? props.current.draft.quotes[i] : undefined;
      setHot(cur => {
        if (!q) { if (cur) hoverQuote(null); return null; }
        if (cur?.id === q.id) return cur;
        const rs = chipEls(i).flatMap(el => [...el.getClientRects()]), r = rs[rs.length - 1];
        if (!r) return null;
        hoverQuote(q.id);
        return { i, id: q.id, right: r.right, top: r.top };
      });
    };
    document.addEventListener('mousemove', mv);
    return () => { document.removeEventListener('mousemove', mv); hoverQuote(null); };
  }, []);
  const dropQuote = (i: number) => {
    let k = -1;
    const text = props.current.draft.text.replace(TOK, m => (++k === i ? '' : m)).replace(/ {2,}/g, ' ');
    set({ text }); field.current?.set(text, Math.min(field.current.state().pos, text.length));
    setHot(null); hoverQuote(null);
  };
  const goQuote = (q: Quote) => {
    if (revealQuote(q)) return;
    // not on screen: open its thread (ev:) or its file (file:, in this thread's folder), then go there once it shows
    const ev = /^ev:([^:]+):/.exec(q.src), file = /^file:(.+)$/.exec(q.src), th = props.current.thread;
    if (ev) A.openThread(ev[1], { view: 'chat' });
    else if (file) A.openFile(th.machine, th.dir, file[1]);
    else return;
    let n = 0; const again = () => { if (!revealQuote(q) && ++n < 20) setTimeout(again, 80); };
    setTimeout(again, 30);
  };
  // a click on a quote goes to its source (the field keeps the caret at the quote's nearer edge)
  const onTawUp = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.detail > 1) return;
    const i = tokUnder(e.clientX, e.clientY), q = i >= 0 ? props.current.draft.quotes[i] : undefined;
    if (q) goQuote(q);
  };
  useEffect(() => { paintQuotes(); });

  // ---- context used ----
  // a layer of its own, so esc closes it through the dispatcher and the keys go back where they were
  const ctxClose = useRef<(() => void) | null>(null), ctxWas = useRef(false);
  const openCtx = (button: HTMLElement) => {
    const t = props.current.thread;
    ctxClose.current = openLayer(close => <ContextUsage button={button} ctx={t.ctx ?? 0} tokens={t.ctxTokens} onClose={close} />, () => { ctxClose.current = null; });
  };

  const th = p.thread, ctx = th.ctx;
  const hasText = !!p.draft.text.trim() || p.draft.images.length > 0;
  return (
    <div ref={box} className={cx('comp', p.className)} onFocus={() => p.onFocus?.()} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => { const fs = clipImages(e.dataTransfer); if (fs.length) { e.preventDefault(); addFiles(fs); } }}>
      {p.draft.images.length > 0 && (
        <div className="atts">{p.draft.images.map((src, i) => (
          <span key={i} className="att"><img src={src} alt="" data-zoom onClick={() => openLightbox(src)} /><IconButton icon="x" label="Remove image" onClick={() => set({ images: p.draft.images.filter((_, j) => j !== i) })} /></span>
        ))}</div>
      )}
      <div className="taw" ref={taw} onMouseUp={onTawUp}>
        <CodeField ref={field} tabId={p.tabId} id={`${p.tabId}|${p.persist ?? 'edit'}`} className="cf-text" value={p.draft.text} onChange={onChange} placeholder={p.placeholder || 'Send follow-up'}
          autoFocus={p.autoFocus} onEnter={() => { if (open) return; if (ourCommand()) return; p.onSend(); }} onLeave={() => { setPop(null); p.onLeave?.(); }}
          onLeaveUp={() => p.onLeaveUp?.()} onLeaveDown={toControls} onKey={onKey} local={() => popOpen.current}
          chips={{ re: TOK, lead: QI, hot: hot?.i ?? -1 }}
          startMode={p.startMode} onPaste={e => { const fs = clipImages(e.clipboardData); if (fs.length) { e.preventDefault(); addFiles(fs); } }} />
      </div>
      <div className="cf" ref={cf}>
        <IconButton icon="plus" label="Attach image · or paste one" onMouseDown={e => e.preventDefault()} onClick={() => file.current?.click()} />
        {!p.bare && <Chip icon={permRow(h, th.perm)?.icon ?? 'shield'} className={cx(permRow(h, th.perm)?.warn && 'warn')} lbl="lbl" label={permLabel(h, th.perm)} title="Permissions" onClick={e => pickPerm(e.currentTarget.getBoundingClientRect())} />}
        <span className="sp" />
        {!p.bare && <Chip icon={h} caret raw title="Model and effort" label={<><span>{modelLabel(h, th.model)}</span><span className="lbl dim">{effortLabel(th.effort)}{ultraOf(th.id) && modelDef(h, th.model).ultra ? ' · Ultracode' : ''}{speedTag(modelDef(h, th.model), speedOf(th.id))}</span></>}
          onClick={e => pickModel(e.currentTarget.getBoundingClientRect())} />}
        {p.showContext && ctx != null && (
          <button type="button" className="ib" aria-label={`Context usage: ${ctx}% used`} title={`Context usage: ${ctx}% used, ${100 - ctx}% available`}
            onMouseDown={() => { ctxWas.current = !!ctxClose.current; }} onClick={e => { if (!ctxWas.current) openCtx(e.currentTarget); ctxWas.current = false; }}>
            <span className={cx('ring', fill(ctx))} style={{ ['--p' as string]: ctx }} />
          </button>
        )}
        <SendButton stop={p.running && !hasText} armed={armed} play={!p.running && !hasText && p.canContinue} disabled={!p.running && !hasText && !p.canContinue} onClick={() => { if (armed) { disarm(false); p.onStop?.(); return; } if (p.running && !hasText) p.onStop?.(); else p.onSend(); }} />
      </div>
      {hot && createPortal(<button ref={tokx} type="button" className="tokx" title="Remove" aria-label="Remove quote" style={{ left: hot.right - 4, top: hot.top - 9 }}
        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); dropQuote(hot.i); }}><Icon name="x" /></button>, document.body)}
      <input ref={file} type="file" accept="image/*" multiple hidden onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
      {open && box.current && (
        <Menu<string> items={items} filter={pop?.q} anchor={box.current.getBoundingClientRect()} place="top-start" width="anchor" className="composer-menu" empty="Loading…"
          surface={s => { menu.current = s; }} onPick={pick} onClose={() => setPop(null)} />
      )}
    </div>
  );
});

/** How full the context is, for the ring and the bar: amber from 70%, red from 90%. */
const fill = (p: number) => p >= 90 ? 'full' : p >= 70 ? 'warn' : undefined;
/** 850, 8.2k, 124k, 1M, 1.5M */
const tokens = (n: number) => n < 1000 ? String(n) : n < 1e6 ? (n < 1e4 ? +(n / 1e3).toFixed(1) : Math.round(n / 1e3)) + 'k' : +(n / 1e6).toFixed(1) + 'M';

/** The context popover, centered over the ring: tokens used of the window, a bar colored by how full it is with a
 *  tick where the harness compacts on its own, and that point in words. A harness that gives only a share shows it. */
function ContextUsage({ button, ctx, tokens: tk, onClose }: { button: HTMLElement; ctx: number; tokens?: ThreadMeta['ctxTokens']; onClose(): void }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current as (HTMLElement & { showPopover?(): void; hidePopover?(): void }) | null; if (!el) return;
    try { el.showPopover?.(); } catch { /* already open */ }
    const r = button.getBoundingClientRect();
    // above the ring when there is room (an edit box near the top of the window has none: then below it)
    const at = placeBy(r, el.offsetWidth, el.offsetHeight, 'top', 'center');
    el.style.left = at.left + 'px';
    el.style.top = (at.side === 'top' ? r.top - 6 - Math.min(el.offsetHeight, at.maxHeight ?? Infinity) : r.bottom + 6) + 'px';
    if (at.maxHeight != null) { el.style.maxHeight = at.maxHeight + 'px'; el.style.overflow = 'auto'; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useDialogSurface({ onEsc: onClose, key: k => { if (k === 'enter' || k === 'space' || k === 'q') { onClose(); return true; } return false; } });
  return (
    <section id="context-usage" ref={ref} popover="auto" aria-label="Context usage" onToggle={e => { if ((e.nativeEvent as ToggleEvent).newState === 'closed') onClose(); }}>
      <div className="cu-h">Context<span>{tk ? <>{tokens(tk.used)}<em> / {tokens(tk.max)}</em></> : ctx + '%'}</span></div>
      <div className={cx('cu-bar', fill(ctx))} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ctx} aria-label="Context used"
        aria-valuetext={tk ? `${tokens(tk.used)} of ${tokens(tk.max)} tokens` : `${ctx}%`} style={{ ['--p' as string]: Math.min(100, ctx) }}>
        <i />{tk?.compactAt != null && <b style={{ left: `${Math.min(100, (tk.compactAt / tk.max) * 100)}%` }} />}
      </div>
      {tk?.compactAt != null && <div className="cu-f">Auto-compacts at {tokens(tk.compactAt)}</div>}
    </section>
  );
}

// ---------- the model picker (mockup modelMenu) ----------
// One list: each row carries its harness mark, harnesses set apart by a small gap. A search field (opens in
// INSERT; esc for NORMAL, where j / k pick and h / l step the effort), the stepped effort track (click or drag,
// left / right in either mode; a row of its own: j past the last model or k from the top lands on it, enter there
// keeps the current model), and Ultracode where the model has it. A machine without the harness dims its
// models and offers to copy the install command.
export interface ModelChoice { h: Harness; model: string; effort: string; ultra: boolean; /** ChatSend.speed; unset: the model's default */ speed?: string }
export interface ModelTarget { groups: Harness[]; machine?: string; value(): ModelChoice; set(v: ModelChoice): void }
type Row = { k: 'model'; h: Harness; id: string } | { k: 'install'; h: Harness } | { k: 'ultra' } | { k: 'speed'; id: string } | { k: 'effort' };

/** The speed tier a model runs at: the one set, else the model's default; undefined at standard speed. */
const speedIn = (d: ModelDef, speed?: string) => { const s = speed ?? d.speed; return d.speeds?.find(x => x.id === s); };
/** The chip's note for a faster tier: ' · Fast' (Claude Code's "Fast mode" shortened, as Ultracode is). */
const speedTag = (d: ModelDef, speed?: string) => { const x = speedIn(d, speed); return x ? ' · ' + x.label.replace(/ mode$/, '') : ''; };
/** The speed to keep on a model change: the same tier if the new model has it; a faster tier it lacks drops to
 *  standard (so the harness doesn't keep running one the model can't); otherwise the new model's default. */
const speedFor = (d: ModelDef, speed?: string) => (!speed || d.speeds?.some(x => x.id === speed) ? speed : speed === STANDARD_SPEED ? undefined : STANDARD_SPEED);

export function openModelPicker(anchor: DOMRect, target: ModelTarget) {
  openLayer(close => <ModelPicker anchor={anchor} target={target} close={close} />);
}

function ModelPicker({ anchor, target, close }: { anchor: DOMRect; target: ModelTarget; close(): void }) {
  const [v, setV] = useState(target.value);
  const cur = useRef(v); cur.current = v;
  const put = (n: ModelChoice) => { cur.current = n; setV(n); target.set(n); };
  useChat(); // the harness's list arrives as a chat bump
  const opts = target.groups.map(h => harnessOptions(h, target.machine));
  // the model under the cursor (j / k or the pointer) when it is not the picked one: the effort track previews its
  // levels, with the effort it would get (snapEffort), and h / l set that; picking it takes the previewed effort
  const [pv, setPv] = useState<{ h: Harness; id: string; effort: string } | null>(null);
  const pvRef = useRef(pv); pvRef.current = pv;
  const stops = () => modelDef(cur.current.h, cur.current.model, target.machine).efforts;
  const effortTo = (j: number) => { const es = stops(), e = es[Math.max(0, Math.min(es.length - 1, j))]; if (e !== cur.current.effort) put({ ...cur.current, effort: e }); };
  const effortBy = (d: number) => {
    const p = pvRef.current;
    if (!p) return effortTo(Math.max(0, stops().indexOf(cur.current.effort)) + d);
    const ps = modelDef(p.h, p.id, target.machine).efforts, e = ps[Math.max(0, Math.min(ps.length - 1, ps.indexOf(p.effort) + d))];
    if (e && e !== p.effort) setPv({ ...p, effort: e });
  };
  const onCursor = (it: MenuItem<Row> | undefined) => {
    const r = it?.data;
    if (!it || r?.k !== 'model' || it.on) { if (pvRef.current) setPv(null); return; }
    if (pvRef.current?.h === r.h && pvRef.current.id === r.id) return;
    setPv({ h: r.h, id: r.id, effort: snapEffort(cur.current.effort, modelDef(r.h, r.id, target.machine)) });
  };
  const m = machine(target.machine), has = (h: Harness) => !m || m.has.includes(h);
  const def = modelDef(v.h, v.model, target.machine);
  // every control that depends on the model shows what the model under the cursor (else the picked one) has. The
  // effort row stays in its place while any listed model has levels, dimmed with a note when this one has none;
  // Ultracode is listed only for a model that has it (Josh, 2026-11-22)
  const shown = pv ? modelDef(pv.h, pv.id, target.machine) : def, es = shown.efforts, ei = Math.max(0, es.indexOf(pv ? pv.effort : v.effort));
  const listed = target.groups.flatMap(h => harnessOptions(h, target.machine).models.map(x => modelDef(h, x.id, target.machine)));
  const anyEfforts = listed.find(d => d.efforts.length)?.efforts ?? [];
  // one function per state, so the menu re-lists only when the choice changes (not on every app render)
  const items = useMemo(() => (q: string): MenuItem<Row>[] => {
    const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
    const out: MenuItem<Row>[] = [];
    target.groups.forEach((h, gi) => {
      if (gi) out.push({ head: true, label: '', block: <i className="mgap" /> });
      for (const x of opts[gi].models) if (match(x.label)) out.push({ label: x.label, icon: <Icon name={h} />, on: v.h === h && (v.model === x.id || v.model === x.resolved && !x.isDefault), dis: !has(h), hint: has(h) ? undefined : `not on ${m!.name}`, data: { k: 'model', h, id: x.id } });
      if (!has(h)) out.push({ label: `Install ${harnessName(h)} on ${m!.name}`, icon: <Icon name="copy" />, hint: 'copies the command', data: { k: 'install', h } });
    });
    // a search that matches no model lists nothing (the menu says so): the effort row and Ultracode are never what
    // the cursor lands on, so enter picks nothing
    if (q && !out.some(it => it.data?.k === 'model')) return [];
    if (es.length) out.push({ label: 'Effort', block: <EffortTrack stops={es.map(e => effortLabel(e))} i={ei} onTo={effortTo} preview={!!pv} />, data: { k: 'effort' }, pin: true });
    else if (anyEfforts.length) out.push({ label: 'Effort', block: <EffortTrack stops={anyEfforts.map(e => effortLabel(e))} i={-1} onTo={() => {}} none={`${shown.label} has no effort levels`} />, data: { k: 'effort' }, pin: true, dis: true });
    if (shown.ultra) out.push({ label: 'Ultracode', right: <span className={cx('sw', v.ultra && 'on')} />, data: { k: 'ultra' }, pin: true });
    // the model's faster tiers, a switch each (one at most is on); like Ultracode, the picked model's state
    const on = speedIn(shown, pv ? speedFor(shown, v.speed) : v.speed)?.id;
    for (const x of shown.speeds ?? []) out.push({ label: x.label, hint: x.hint, right: <span className={cx('sw', on === x.id && 'on')} />, data: { k: 'speed', id: x.id }, pin: true });
    return out;
  }, [v, pv, ...opts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Menu<Row> items={items} ranked anchor={anchor} place="top-end" width={300} className="model" search={{ placeholder: 'Search models' }} empty="No matching models"
      keep={it => it.data?.k !== 'model' && it.data?.k !== 'effort'} arrows onClose={close} wrap={{ last: it => it.data?.k === 'effort' }} onCursor={onCursor}
      keys={k => { const d = k === 'h' || k === 'left' ? -1 : k === 'l' || k === 'right' ? 1 : 0; if (!d) return false; effortBy(d); return true; }}
      onPick={it => {
        const r = it.data; if (!r) return;
        if (r.k === 'install') { void navigator.clipboard?.writeText(INSTALL[r.h]).catch(() => {}); toast(`Copied ${INSTALL[r.h]}`, { icon: 'copy' }); return; }
        if (r.k === 'ultra') { if (def.ultra) put({ ...cur.current, ultra: !cur.current.ultra }); return; }
        if (r.k === 'speed') { if (def.speeds?.some(x => x.id === r.id)) put({ ...cur.current, speed: speedIn(def, cur.current.speed)?.id === r.id ? STANDARD_SPEED : r.id }); return; }
        if (r.k === 'effort') return;   // enter on the effort row: the current model and effort stand (h / l already set it)
        const d = modelDef(r.h, r.id, target.machine), p = pvRef.current;
        put({ h: r.h, model: r.id, effort: p && p.h === r.h && p.id === r.id ? p.effort : snapEffort(cur.current.effort, d), ultra: d.ultra ? cur.current.ultra : false, speed: speedFor(d, cur.current.speed) });
        setPv(null);
      }} />
  );
}

/** Effort as a stepped track: a stop per level, the label row under it; click or drag to a stop. */
function EffortTrack({ stops, i, onTo, preview, none }: { stops: string[]; i: number; onTo(j: number): void; preview?: boolean; /** the model has no levels: the track stays, dimmed, with this note */ none?: string }) {
  const trk = useRef<HTMLDivElement>(null);
  const to = useRef(onTo); to.current = onTo;
  const pct = (j: number) => (stops.length > 1 ? (j / (stops.length - 1)) * 100 : 0);
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    const at = (x: number) => { const r = trk.current?.getBoundingClientRect(); if (r) to.current(Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * (stops.length - 1))); };
    const mv = (ev: PointerEvent) => at(ev.clientX);
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); at(e.clientX);
  };
  return (
    <div className={cx('eff', preview && 'pv', none && 'none')} title={none || (preview ? 'The effort this model gets when you pick it' : undefined)} aria-disabled={none ? true : undefined}>
      <div className="eh"><span>Effort</span><b>{none ? 'None' : stops[i]}</b></div>
      <div className="trk" ref={trk} data-n={stops.length} role="slider" aria-label="Effort" aria-valuemin={0} aria-valuemax={stops.length - 1} aria-valuenow={i} aria-valuetext={stops[i]} onPointerDown={down}>
        <i className="fill" style={{ width: pct(i) + '%' }} />
        {stops.map((x, j) => <i key={x} className={cx('stp', j <= i && 'on')} style={{ left: pct(j) + '%' }} />)}
        <i className="thumb" style={{ left: pct(i) + '%' }} />
      </div>
      <div className="et">{stops.map((x, j) => <span key={x} className={cx(j === i && 'on')} style={{ left: pct(j) + '%' }} data-j={j} onPointerDown={e => { e.preventDefault(); onTo(j); }}>{x}</span>)}</div>
    </div>
  );
}

/** Images on a clipboard or a drop: the files, and file items (a Windows screenshot may show only as an item). */
export function clipImages(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out = [...dt.files].filter(f => f.type.startsWith('image/'));
  if (!out.length) for (const it of dt.items || []) if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) out.push(f); }
  return out;
}

