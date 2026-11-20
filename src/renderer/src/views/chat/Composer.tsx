// One composer for threads, side chats, subagents and the edit-a-message box.
// Text is a VimField; / anywhere a word starts opens the command menu, @ opens files; images come from
// the + button, paste or drop; quoted selections sit in the text as chips (painted by the layer behind).
// Below the text: attach, permissions, model and effort, context used, send / stop. j from the text's
// last line (NORMAL) moves onto that row: h / l pick, enter presses, k goes back up.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Harness, ThreadMeta } from '@shared/types';
import { MODELS } from '@shared/models';
import type { Mode, Surface } from '../../input/dispatcher';
import { registerTab } from '../../input/surfaces';
import { tokAt } from '../../input/vimtext';
import { api } from '../../api';
import { machine, openLayer, toast, update } from '../../state/store';
import * as A from '../../state/actions';
import { openMenu } from '../../shell/overlays';
import { harnessName } from '../../shell/meta';
import { Menu, type MenuItem } from '../../ui/Menu';
import { Chip, cx, Icon, IconButton, SendButton } from '../../ui/primitives';
import { VimField, type VimFieldHandle } from '../../ui/VimField';
import { openLightbox } from '../../ui/Lightbox';
import { useDialogSurface } from '../../ui/Dialog';
import { effortId, effortLabel, HARNESS_SLASH, INSTALL, modelDef, modelId, modelLabel, OURS, permChoices, permLabel, SKILLS, THREAD_SLASH, type Slash } from './options';
import { hoverQuote, paintQuotes, revealQuote, saveDraft, setUltra, syncQuotes, TOK, ultraOf, type Draft, type Quote } from './state';

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

/** The text behind the textarea: quotes as chips, plus the block cursor (.hc) or VISUAL's moving end (.vcur). */
function backLayer(text: string, cur: { hollow: number; vcur: number } | null): React.ReactNode[] {
  const part = (str: string, key: string) => {
    const toks = str.match(TOK) || [];
    return str.split(TOK).flatMap((x, i, a) => (i < a.length - 1 ? [x, <span key={key + i} className="tok">{toks[i]}</span>] : [x]));
  };
  if (cur && cur.hollow >= 0) { const at = Math.min(cur.hollow, text.length); return [...part(text.slice(0, at), 'a'), <span key="hc" className="hc"><i /></span>, ...part(text.slice(at), 'b')]; }
  if (cur && cur.vcur >= 0 && cur.vcur < text.length) return [...part(text.slice(0, cur.vcur), 'a'), <span key="vc" className="vcur">{text[cur.vcur]}</span>, ...part(text.slice(cur.vcur + 1), 'b')];
  return part(text, 'a');
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(p, handle) {
  const field = useRef<VimFieldHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const cf = useRef<HTMLDivElement>(null);
  const bk = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const props = useRef(p); props.current = p;
  const [pop, setPop] = useState<Pop>(null);
  // the NORMAL cursor where there is no character, and VISUAL's moving end, drawn in the layer behind the text
  const [cur, setCur] = useState<{ hollow: number; vcur: number } | null>(null);
  const menu = useRef<Surface | undefined>(undefined);
  const h: Harness = p.thread.harness;

  useImperativeHandle(handle, () => ({ focus: i => field.current?.focus(i), caret: () => field.current?.state().pos ?? 0, field: () => field.current }));

  const set = (d: Partial<Draft>) => {
    const next = { ...props.current.draft, ...d };
    if (d.text !== undefined) next.quotes = syncQuotes(next);
    props.current.onDraft(next);
    if (props.current.persist && d.text !== undefined) saveDraft(props.current.persist, next.text, next.quotes);
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
      // the harness's commands, then the thread's own (side chats, subagents), then its skills under a heading
      const hit = (c: Slash) => c.cmd.startsWith(pop.q) && !(p.bare && c.cmd === '/model');
      const row = (c: Slash): MenuItem<string> => ({ label: c.cmd, display: c.display, hint: c.hint, icon: <Icon name={c.icon} />, data: c.cmd });
      const cmds = [...HARNESS_SLASH[h], ...(!p.bare && !p.thread.side && !p.fresh ? THREAD_SLASH : [])].filter(hit), skills = SKILLS[h].filter(hit);
      return [...cmds.map(row), ...(skills.length ? [{ head: true, label: 'Skills' }, ...skills.map(row)] : [])];
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
    if (f.kind === 'slash' && OURS.includes(it.data)) {   // ours: take the word out, keep the rest, act
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

  // one of our commands typed alone (the menu dismissed): enter runs it rather than sending it to the harness
  const ourCommand = () => {
    const c = props.current.draft.text.trim();
    if (!OURS.includes(c) || (c !== '/model' && (props.current.bare || props.current.thread.side || props.current.fresh)) || (c === '/model' && props.current.bare)) return false;
    set({ text: '' }); field.current?.set('');
    const anchor = box.current!.getBoundingClientRect();
    if (c === '/model') pickModel(anchor); else props.current.onCommand?.(c, anchor);
    return true;
  };

  // ---- pickers ----
  const choose = (patch: { harness?: Harness; model?: string; effort?: string; perm?: string }) => {
    const f = props.current.fresh;
    if (f) f.onSettings(patch); else void api.threads.update(props.current.thread.id, patch);
  };
  const pickModel = (anchor: DOMRect) => {
    const th = props.current.thread;
    openModelPicker(anchor, {
      groups: props.current.fresh ? ['claude', 'codex'] : [th.harness], machine: th.machine,
      value: () => { const t = props.current.thread; return { h: t.harness, model: modelId(t.harness, t.model) || MODELS[t.harness][0].id, effort: effortId(t.effort) || 'medium', ultra: ultraOf(t.id) }; },
      set: v => { choose({ ...(v.h !== props.current.thread.harness ? { harness: v.h } : {}), model: v.model, effort: v.effort }); setUltra(th.id, v.ultra); },
    });
  };
  // the mockup's act.pickPerm: plain labels, a check on the current one
  const pickPerm = (anchor: DOMRect) => openMenu<string>({
    anchor, place: 'top-start', width: 200,
    items: permChoices(h).map(o => ({ label: o.label, on: permLabel(h, props.current.thread.perm) === o.label, data: o.id })),
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

  const pasteFromClipboard = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(x => x.startsWith('image/'));
        if (type) { const b = await item.getType(type); addFiles([new File([b], 'paste.png', { type })]); return; }
      }
    } catch { /* no permission or nothing there */ }
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
      else if (k === 'i' || k === 'a') { const f = field.current; if (f) f.set(f.state().text); ctlEnd('insert'); }   // back at the END of the text (mockup keys.js)
      else if (k === 'esc') ctlEnd();
      else if (k === 'enter' || k === 'space') { const b = buttons()[i]; ctlEnd(); b?.click(); }
      else return false;   // the app's NORMAL layer gets the rest (: H L | \ ?); the dispatcher drops what nobody takes
      return true;
    },
  };
  const toControls = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const un = registerTab(p.tabId, ctlSurface);
    // any mousedown takes the row's cursor away (the click itself decides where the keys go next)
    const md = () => { buttons().forEach(b => b.classList.remove('kcur')); if (ctl.current.un === off) { off(); ctl.current.un = undefined; } };
    const off = () => { removeEventListener('mousedown', md, true); un(); };
    addEventListener('mousedown', md, true);
    ctl.current.un = off;
    ctlMark(0); update(s => { s.tick++; });
  };
  useEffect(() => () => ctl.current.un?.(), []);

  // ---- keys the field gives us first ----
  const onKey = (k: string, mode: Mode) => {
    // tab completes like enter in the / and @ lists (the mockup's menu keys)
    if (open && k === 'enter' && !items.length) setPop(null);   // the @ list still loading: nothing to pick, enter sends
    else if (open && menu.current && ['up', 'down', 'ctrl-n', 'ctrl-p', 'ctrl-j', 'ctrl-k', 'tab', 'shift-tab', 'enter'].includes(k)) return menu.current.key(k === 'tab' || k === 'shift-tab' ? 'enter' : k, { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
    if (open && k === 'esc') { setPop(null); return false; }   // the field goes to NORMAL too
    if (mode === 'NORMAL' && props.current.onNormalKey?.(k)) return true;
    // NORMAL has no paste event (the keys don't type): ctrl-v / cmd-v still attach an image on the clipboard
    if (mode === 'NORMAL' && (k === 'ctrl-v' || k === 'cmd-v')) { void pasteFromClipboard(); return true; }
    // INSERT: a quote is one item. Arrows step over it, backspace / delete take it whole.
    if (mode === 'INSERT' && (k === 'left' || k === 'right' || k === 'backspace' || k === 'delete')) {
      const el = field.current?.el();
      if (el && el.selectionStart === el.selectionEnd) {
        const v = el.value, at = el.selectionStart, tk = tokAt(v, k === 'left' || k === 'backspace' ? at - 1 : at);
        if (tk) {
          if (k === 'left' || k === 'right') field.current!.set(v, k === 'left' ? tk[0] : tk[1]);
          else { const text = v.slice(0, tk[0]) + v.slice(tk[1]); field.current!.set(text, tk[0]); set({ text }); }
          return true;
        }
      }
    }
    return false;
  };
  const popOpen = useRef(false); popOpen.current = open;

  // ---- quotes: hover lights up the source and offers an x; a click goes to the source (mockup tokUnder, noteGo) ----
  const taw = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState<{ i: number; id: string; right: number; top: number } | null>(null);
  const tokx = useRef<HTMLButtonElement>(null);
  const tokUnder = (x: number, y: number) => [...(bk.current?.querySelectorAll('.tok') ?? [])].findIndex(sp => [...sp.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      const t = e.target as Node;
      if (tokx.current?.contains(t)) return;
      const i = taw.current?.contains(t) ? tokUnder(e.clientX, e.clientY) : -1;
      const q = i >= 0 ? props.current.draft.quotes[i] : undefined;
      setHot(cur => {
        if (!q) { if (cur) hoverQuote(null); return null; }
        if (cur?.id === q.id) return cur;
        const rs = bk.current!.querySelectorAll('.tok')[i].getClientRects(), r = rs[rs.length - 1];
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
  // a click never leaves the caret inside a quote (it goes to the nearer edge); a click on one goes to its source
  const onTawUp = (e: React.MouseEvent) => {
    const el = field.current?.el(); if (!el || e.button !== 0 || el.selectionStart !== el.selectionEnd) return;
    const v = el.value, a = el.selectionStart, tk = tokAt(v, a);
    if (tk && a > tk[0]) field.current!.set(v, a - tk[0] < tk[1] - a ? tk[0] : tk[1]);
    const i = tokUnder(e.clientX, e.clientY), q = i >= 0 ? props.current.draft.quotes[i] : undefined;
    if (q) goQuote(q);
  };
  useEffect(() => { paintQuotes(); });

  // ---- context used ----
  // a layer of its own, so esc closes it through the dispatcher and the keys go back where they were
  const ctxClose = useRef<(() => void) | null>(null), ctxWas = useRef(false);
  const openCtx = (button: HTMLElement) => {
    const c = props.current.thread.ctx ?? 0, model = modelLabel(h, props.current.thread.model);
    ctxClose.current = openLayer(close => <ContextUsage button={button} ctx={c} model={model} onClose={close} />, () => { ctxClose.current = null; });
  };

  // the layer behind the text paints quote chips
  const paintBk = () => { const b = bk.current, el = field.current?.el(); if (b && el) b.scrollTop = el.scrollTop; };
  useEffect(paintBk);

  const th = p.thread, ctx = th.ctx;
  const hasText = !!p.draft.text.trim() || p.draft.images.length > 0;
  return (
    <div ref={box} className={cx('comp', p.className)} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => { const fs = clipImages(e.dataTransfer); if (fs.length) { e.preventDefault(); addFiles(fs); } }}>
      {p.draft.images.length > 0 && (
        <div className="atts">{p.draft.images.map((src, i) => (
          <span key={i} className="att"><img src={src} alt="" data-zoom onClick={() => openLightbox(src)} /><IconButton icon="x" label="Remove image" onClick={() => set({ images: p.draft.images.filter((_, j) => j !== i) })} /></span>
        ))}</div>
      )}
      <div className="taw" ref={taw} onMouseUp={onTawUp}>
        <div ref={bk} className="bk" aria-hidden="true">{backLayer(p.draft.text, cur)}{'\u200b'}</div>
        <VimField ref={field} tabId={p.tabId} value={p.draft.text} onChange={onChange} onCursor={setCur} placeholder={p.placeholder || 'Send follow-up'}
          autoFocus={p.autoFocus} onEnter={() => { if (open) return; if (ourCommand()) return; p.onSend(); }} onLeave={() => { setPop(null); p.onLeave?.(); }}
          onLeaveUp={() => p.onLeaveUp?.()} onLeaveDown={toControls} onKey={onKey} local={() => popOpen.current}
          startMode={p.startMode} onPaste={e => { const fs = clipImages(e.clipboardData); if (fs.length) { e.preventDefault(); addFiles(fs); } }} />
      </div>
      <div className="cf" ref={cf}>
        <IconButton icon="plus" label="Attach image · or paste one" onClick={() => file.current?.click()} />
        {!p.bare && <Chip icon="shield" lbl="lbl" label={permLabel(h, th.perm)} title="Permissions" onClick={e => pickPerm(e.currentTarget.getBoundingClientRect())} />}
        <span className="sp" />
        {!p.bare && <Chip icon={h} caret raw title="Model and effort" label={<><span>{modelLabel(h, th.model)}</span><span className="lbl dim">{effortLabel(th.effort)}{ultraOf(th.id) && modelDef(h, th.model).ultra ? ' · Ultracode' : ''}</span></>}
          onClick={e => pickModel(e.currentTarget.getBoundingClientRect())} />}
        {p.showContext && ctx != null && (
          <button type="button" className="ib" aria-label={`Context usage: ${ctx}% used`} title={`Context usage: ${ctx}% used, ${100 - ctx}% available`}
            onMouseDown={() => { ctxWas.current = !!ctxClose.current; }} onClick={e => { if (!ctxWas.current) openCtx(e.currentTarget); ctxWas.current = false; }}>
            <span className="ring" style={{ ['--p' as string]: ctx }} />
          </button>
        )}
        <SendButton stop={p.running && !hasText} disabled={!p.running && !hasText} onClick={() => (p.running && !hasText ? p.onStop?.() : p.onSend())} />
      </div>
      {hot && createPortal(<button ref={tokx} type="button" className="tokx" title="Remove" aria-label="Remove quote" style={{ left: hot.right - 4, top: hot.top - 9 }}
        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); dropQuote(hot.i); }}><Icon name="x" /></button>, document.body)}
      <input ref={file} type="file" accept="image/*" multiple hidden onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
      {open && box.current && (
        <Menu<string> items={items} anchor={box.current.getBoundingClientRect()} place="top-start" width="anchor" className="composer-menu" empty="Loading…"
          surface={s => { menu.current = s; }} onPick={pick} onClose={() => setPop(null)} />
      )}
    </div>
  );
});

/** The context popover over the ring (the mockup's act.contextUsage): used, a bar, what is left and the model. */
function ContextUsage({ button, ctx, model, onClose }: { button: HTMLElement; ctx: number; model: string; onClose(): void }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current as (HTMLElement & { showPopover?(): void; hidePopover?(): void }) | null; if (!el) return;
    try { el.showPopover?.(); } catch { /* already open */ }
    const r = button.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth)) + 'px';
    el.style.top = Math.max(8, r.top - el.offsetHeight - 6) + 'px';
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useDialogSurface({ onEsc: onClose, key: k => { if (k === 'enter' || k === 'space' || k === 'q') { onClose(); return true; } return false; } });
  return (
    <section id="context-usage" ref={ref} popover="auto" aria-label="Context usage" onToggle={e => { if ((e.nativeEvent as ToggleEvent).newState === 'closed') onClose(); }}>
      <div className="cu-h">Context<span>{ctx}%</span></div>
      <div className="cu-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ctx} aria-label="Context used" style={{ ['--p' as string]: ctx }}><i /></div>
      <div className="cu-f">{100 - ctx}% left · {model}</div>
    </section>
  );
}

// ---------- the model picker (mockup modelMenu) ----------
// One list: each row carries its harness mark, harnesses set apart by a small gap. A search field (opens in
// INSERT; esc for NORMAL, where j / k pick and h / l step the effort), the stepped effort track (click or drag,
// left / right in either mode), and Ultracode where the model has it. A machine without the harness dims its
// models and offers to copy the install command.
export interface ModelChoice { h: Harness; model: string; effort: string; ultra: boolean }
export interface ModelTarget { groups: Harness[]; machine?: string; value(): ModelChoice; set(v: ModelChoice): void }
type Row = { k: 'model'; h: Harness; id: string } | { k: 'install'; h: Harness } | { k: 'ultra' };

export function openModelPicker(anchor: DOMRect, target: ModelTarget) {
  openLayer(close => <ModelPicker anchor={anchor} target={target} close={close} />);
}

function ModelPicker({ anchor, target, close }: { anchor: DOMRect; target: ModelTarget; close(): void }) {
  const [v, setV] = useState(target.value);
  const cur = useRef(v); cur.current = v;
  const put = (n: ModelChoice) => { cur.current = n; setV(n); target.set(n); };
  const stops = () => modelDef(cur.current.h, cur.current.model).efforts;
  const effortTo = (j: number) => { const es = stops(), e = es[Math.max(0, Math.min(es.length - 1, j))]; if (e !== cur.current.effort) put({ ...cur.current, effort: e }); };
  const effortBy = (d: number) => effortTo(Math.max(0, stops().indexOf(cur.current.effort)) + d);
  const m = machine(target.machine), has = (h: Harness) => !m || m.has.includes(h);
  const def = modelDef(v.h, v.model), es = def.efforts, ei = Math.max(0, es.indexOf(v.effort));
  // one function per state, so the menu re-lists only when the choice changes (not on every app render)
  const items = useMemo(() => (q: string): MenuItem<Row>[] => {
    const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
    const out: MenuItem<Row>[] = [];
    target.groups.forEach((h, gi) => {
      if (gi) out.push({ head: true, label: '', block: <i className="mgap" /> });
      for (const x of MODELS[h]) if (match(x.label)) out.push({ label: x.label, icon: <Icon name={h} />, on: v.h === h && v.model === x.id, dis: !has(h), hint: has(h) ? undefined : `not on ${m!.name}`, data: { k: 'model', h, id: x.id } });
      if (!has(h)) out.push({ label: `Install ${harnessName(h)} on ${m!.name}`, icon: <Icon name="copy" />, hint: 'copies the command', data: { k: 'install', h } });
    });
    out.push({ head: true, label: '', block: <EffortTrack stops={es.map(e => effortLabel(e))} i={ei} onTo={effortTo} /> });
    if (def.ultra) out.push({ label: 'Ultracode', right: <span className={cx('sw', v.ultra && 'on')} />, data: { k: 'ultra' } });
    return out;
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Menu<Row> items={items} ranked anchor={anchor} place="top-end" width={300} className="model" search={{ placeholder: 'Search models' }}
      keep={it => it.data?.k !== 'model'} arrows onClose={close}
      keys={k => { const d = k === 'h' || k === 'left' ? -1 : k === 'l' || k === 'right' ? 1 : 0; if (!d) return false; effortBy(d); return true; }}
      onPick={it => {
        const r = it.data; if (!r) return;
        if (r.k === 'install') { void navigator.clipboard?.writeText(INSTALL[r.h]).catch(() => {}); toast(`Copied ${INSTALL[r.h]}`, { icon: 'copy' }); return; }
        if (r.k === 'ultra') { put({ ...cur.current, ultra: !cur.current.ultra }); return; }
        const d = MODELS[r.h].find(x => x.id === r.id)!;
        put({ h: r.h, model: r.id, effort: d.efforts.includes(cur.current.effort) ? cur.current.effort : d.efforts[d.efforts.length - 1], ultra: d.ultra ? cur.current.ultra : false });
      }} />
  );
}

/** Effort as a stepped track: a stop per level, the label row under it; click or drag to a stop. */
function EffortTrack({ stops, i, onTo }: { stops: string[]; i: number; onTo(j: number): void }) {
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
    <div className="eff">
      <div className="eh"><span>Effort</span><b>{stops[i]}</b></div>
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
