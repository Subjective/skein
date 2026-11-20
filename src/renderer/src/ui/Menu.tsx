// One component for every list that pops up: the palette, the : line, pickers, the / and @ menus,
// pane menus. Keys follow VIM-MODEL (List): j k / arrows / ctrl-n ctrl-p move, enter picks, esc steps back
// (INSERT in the search field -> NORMAL -> closed). A searchable menu opens in INSERT unless `normal`.
// In NORMAL the search field is still a Field (input/vimtext.ts) wherever its keys don't clash with the list's:
// j k g G enter q move and pick in the list, h l w b e 0 $ move the field's cursor, x dw D C ~ u edit it,
// i a I A / go back to typing. The owner's own keys (`keys`) come first: a folder field's h / l.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Surface } from '../input/dispatcher';
import { init, step, typed, vrange, type TextState } from '../input/vimtext';
import { forPut, getReg, setReg } from '../input/register';
import { S, update } from '../state/store';
import { cx, Icon } from './primitives';

export interface MenuItem<D = unknown> {
  label: string;
  /** shown instead of label (label is what search matches) */
  display?: ReactNode;
  hint?: string;
  icon?: ReactNode;
  right?: ReactNode;
  kbd?: string;
  on?: boolean;
  dis?: boolean;
  head?: boolean;
  data?: D;
}

export interface MenuProps<D = unknown> {
  items: MenuItem<D>[] | ((q: string) => MenuItem<D>[]);
  onPick: (it: MenuItem<D>, q: string) => void;
  onClose: () => void;
  search?: { placeholder?: string; prefix?: string; value?: string };
  /** items(q) already filtered and ranked for q: skip the default substring filter. */
  ranked?: boolean;
  /** Start in NORMAL even though there is a search field. */
  normal?: boolean;
  /** Where to draw: next to an anchor rect, or centred over a scrim (modal). */
  anchor?: DOMRect | null;
  place?: 'top-start' | 'bottom-start' | 'top-end' | 'bottom-end';
  width?: number | 'anchor';
  modal?: boolean;
  className?: string;
  /** Shown when nothing matches; a function of the query to show it only sometimes. */
  empty?: string | ((q: string) => string | undefined);
  /** Keep the menu open after a pick (toggles). */
  keep?: boolean;
  /** Extra keys handled by the menu's owner while an item is selected (NORMAL only). */
  keys?: (k: string, it: MenuItem<D> | undefined) => boolean;
  /** Controlled selection (the ctrl-tab switcher moves it from outside); onSelect hears every move. */
  select?: number;
  onSelect?: (i: number) => void;
  /** Register as the keyboard owner (default true). */
  surface?: (s: Surface | undefined) => void;
}

const defaultMatch = (it: MenuItem, q: string) => !q || (it.label + ' ' + (it.hint || '')).toLowerCase().includes(q.toLowerCase());

export function Menu<D>(p: MenuProps<D>) {
  const [q, setQ] = useState(p.search?.value || '');
  const [ins, setIns] = useState(!!p.search && !(S.settings.vim && p.normal));
  // the search field's Vim state (its NORMAL cursor, register, undo); the browser types into it in INSERT
  const fs = useRef<TextState>(null as unknown as TextState);
  if (!fs.current) { const q0 = p.search?.value || ''; fs.current = ins ? init(q0, 'INSERT') : { ...init(q0, 'NORMAL'), pos: Math.max(0, q0.length - 1) }; }
  const all = useMemo(() => (typeof p.items === 'function' ? p.items(q) : p.items), [p.items, q]);
  const items = useMemo(() => {
    const f = p.ranked ? all : all.filter(it => it.head || defaultMatch(it, q));
    return f.filter((it, i) => !it.head || (f[i + 1] && !f[i + 1].head));
  }, [all, q, p.ranked]);
  const first = () => { const on = items.findIndex(it => !it.head && !it.dis && it.on); return on >= 0 ? on : items.findIndex(it => !it.head && !it.dis); };
  const [i, setI] = useState(() => p.select ?? first());
  useEffect(() => { setI(p.select ?? first()); }, [items.length, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (p.select != null) setI(p.select); }, [p.select]);
  useEffect(() => { p.onSelect?.(i); }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const st = useRef({ i, items, q, ins }); st.current = { i, items, q, ins };
  // in NORMAL the field is drawn as text with a block cursor (.m-q, as in the mockup); in INSERT it is the input
  const [, redraw] = useState(0);
  const paintField = () => {
    const el = inp.current, s = fs.current;
    if (el && document.activeElement === el && s.mode === 'INSERT') el.setSelectionRange(s.pos, s.pos);
    redraw(n => n + 1);
  };
  /** A NORMAL key for the search field. true when the field used it. */
  const fieldKey = (k: string, reg = getReg()): boolean => {
    // the field is one line: whole lines from yy go in as text
    const before = { ...fs.current, reg: reg.line ? { text: reg.text.replace(/\n/g, ' '), line: false } : reg };
    if ((k === 'p' || k === 'P') && before.mode === 'NORMAL' && /^\d*$/.test(before.pending) && !before.reg.text) {
      void forPut().then(clip => { if (clip.text) fieldKey(k, clip); });   // the clipboard, while the register is empty
      return true;
    }
    const r = step(before, k);
    if (!r.handled || r.fx.includes('enter') || r.fx.includes('leave')) return false;
    if (r.s.reg !== before.reg) setReg(r.s.reg);
    fs.current = r.s;
    if (r.s.text !== st.current.q) setQ(r.s.text);
    if (r.fx.includes('yank')) void navigator.clipboard?.writeText(r.s.reg.text).catch(() => {});
    if (r.s.mode === 'INSERT') { setIns(true); requestAnimationFrame(() => { inp.current?.focus(); paintField(); }); }
    else requestAnimationFrame(paintField);
    return true;
  };

  const move = (d: number) => setI(cur => {
    const u = Math.sign(d);
    for (let left = Math.abs(d); left > 0; left--) { let n = cur + u; while (items[n] && (items[n].head || items[n].dis)) n += u; if (!items[n]) break; cur = n; }
    return cur;
  });
  const pick = () => { const it = st.current.items[st.current.i]; if (!it || it.dis || it.head) return; if (!p.keep) p.onClose(); p.onPick(it, st.current.q); };

  // keyboard: this menu is the List surface while it is open
  useEffect(() => {
    const surface: Surface = {
      kind: 'list',
      mode: () => (st.current.ins ? 'INSERT' : p.search && S.settings.vim && fs.current.mode.startsWith('V') ? fs.current.mode as 'VISUAL' | 'V-LINE' : 'NORMAL'),
      key: k => {
        const { ins: typing } = st.current;
        switch (k) {
          case 'down': case 'ctrl-n': case 'ctrl-j': move(1); return true;
          case 'up': case 'ctrl-p': case 'ctrl-k': move(-1); return true;
          case 'enter': pick(); return true;
          case 'tab': move(1); return true;
          case 'shift-tab': move(-1); return true;
          case 'esc':
            if (typing && S.settings.vim && p.search) {
              const r = step(typed(fs.current, st.current.q, inp.current?.selectionStart ?? st.current.q.length), 'esc');
              fs.current = r.s; setIns(false); requestAnimationFrame(paintField); return true;
            }
            if (p.search && fs.current.pending) { fs.current = { ...fs.current, pending: '' }; return true; }
            if (p.search && (fs.current.mode === 'VISUAL' || fs.current.mode === 'V-LINE')) { fs.current = { ...fs.current, mode: 'NORMAL' }; requestAnimationFrame(paintField); update(s => { s.tick++; }); return true; }
            p.onClose(); return true;
        }
        if (typing) return false; // the search field types it
        if (p.keys?.(k, st.current.items[st.current.i])) return true;
        // a count moves the list too (3j); an operator already started (d w, c b) belongs to the field
        const pend = p.search ? fs.current.pending : '', cnt = /^\d+$/.test(pend) ? Math.min(999, +pend) : 1;
        if (pend && (k === 'j' || k === 'k' || k === 'down' || k === 'up') && /^\d+$/.test(pend)) { fs.current = { ...fs.current, pending: '' }; move(k === 'j' || k === 'down' ? cnt : -cnt); return true; }
        const midField = !!pend && !/^\d+$/.test(pend);
        if (!midField) switch (k) {
          case 'j': move(1); return true;
          case 'k': move(-1); return true;
          case 'g': setI(items.findIndex(it => !it.head && !it.dis)); return true;
          case 'G': { let n = items.length - 1; while (n > 0 && (items[n].head || items[n].dis)) n--; setI(n); return true; }
          case '/': if (p.search) return fieldKey('A'); return false;
          case 'l': if (!p.search) { pick(); return true; } break;
          case 'q': p.onClose(); return true;
        }
        if (p.search && fieldKey(k)) { update(s => { s.tick++; }); return true; }
        return k.length === 1; // NORMAL: plain keys do nothing else here
      },
    };
    p.surface ? p.surface(surface) : update(s => { const top = s.layers[s.layers.length - 1]; if (top) top.surface = surface; s.tick++; });
    return () => p.surface?.(undefined);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => update(s => { s.tick++; }), [ins]);

  useEffect(() => { if (ins) { inp.current?.focus(); paintField(); } else if (p.search) (document.activeElement as HTMLElement | null)?.blur?.(); }, [ins, p.search]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { ref.current?.querySelector('.mi.sel')?.scrollIntoView({ block: 'nearest' }); }, [i]);

  // place next to the anchor
  const [pos, setPos] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (p.modal || !p.anchor) return;
    const r = p.anchor, w = Math.min(p.width === 'anchor' ? r.width : p.width || 260, innerWidth - 16);
    const place = p.place || 'top-start';
    const s: React.CSSProperties = { width: w };
    if (place.startsWith('top')) s.bottom = innerHeight - r.top + 6; else s.top = r.bottom + 6;
    if (place.endsWith('end')) s.right = Math.max(8, innerWidth - r.right); else s.left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    setPos(s);
  }, [p.anchor, p.modal, p.place, p.width]);

  // a click outside closes
  useEffect(() => {
    if (p.modal) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) p.onClose(); };
    const t = setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', h); };
  }, [p]);

  const emptyText = typeof p.empty === 'function' ? p.empty(q) : p.empty;
  const shown = () => {   // the NORMAL field: text, the block cursor (or the VISUAL selection), placeholder when empty
    const f = fs.current, t = f.text;
    if (!t) return <><i className="ncur">{' '}</i>{p.search?.placeholder && <span className="ph">{p.search.placeholder}</span>}</>;
    if (f.mode === 'VISUAL' || f.mode === 'V-LINE') { const [a, b] = vrange(f); return <>{t.slice(0, a)}<span className="mqv">{t.slice(a, b)}</span>{t.slice(b)}</>; }
    const at = Math.min(f.pos, t.length - 1);
    return <>{t.slice(0, at)}<i className="ncur">{t[at]}</i>{t.slice(at + 1)}</>;
  };
  const body = (
    <div ref={ref} className={cx('menu', p.className, !ins && 'nm', p.anchor && !p.modal && 'composer-menu')} style={p.modal ? undefined : pos} role="dialog">
      {p.search && (
        <div className="m-s" onMouseDown={e => { if (!ins) { e.preventDefault(); fs.current = { ...fs.current, mode: 'INSERT', pending: '', insertFrom: { text: fs.current.text, pos: fs.current.pos } }; setIns(true); } }}>
          {p.search.prefix ? <span className="pfx">{p.search.prefix}</span> : <Icon name="search" />}
          <input ref={inp} spellCheck={false} role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label={p.search.placeholder || p.search.prefix || 'Search'}
            aria-activedescendant={i >= 0 ? `mi-${i}` : undefined} placeholder={p.search.placeholder || ''} value={q} readOnly={!ins}
            onFocus={() => { if (!st.current.ins) { fs.current = { ...fs.current, mode: 'INSERT', pending: '', insertFrom: { text: fs.current.text, pos: fs.current.pos } }; setIns(true); } }}
            onChange={e => { fs.current = typed(fs.current, e.target.value, e.target.selectionStart ?? e.target.value.length); setQ(e.target.value); }}
            onSelect={e => { if (ins) fs.current = { ...fs.current, pos: e.currentTarget.selectionStart ?? fs.current.pos }; }} />
          {!ins && <span className="m-q" aria-hidden="true">{shown()}</span>}
        </div>
      )}
      <div className="m-l" role="listbox">
        {items.map((it, n) => it.head
          ? <div key={'h' + n} className="mi head" role="presentation">{it.icon}{it.label}</div>
          : <div key={n} id={`mi-${n}`} role="option" aria-selected={n === i} aria-disabled={it.dis || undefined} className={cx('mi', n === i && 'sel', it.dis && 'off')}
              onMouseMove={() => { if (n !== i && !it.dis) setI(n); }}
              onMouseDown={e => { e.preventDefault(); if (!it.dis) { st.current.i = n; pick(); } }}>
              {it.icon && <span className="mic">{it.icon}</span>}
              <span className="ml">{it.display ?? it.label}</span>
              {it.hint && <span className="mh">{it.hint}</span>}
              <span className="mr">{it.right}{it.kbd && <kbd>{it.kbd}</kbd>}{it.on && <Icon name="check" />}</span>
            </div>)}
        {!items.some(it => !it.head) && emptyText && <div className="m-empty" role="status">{emptyText}</div>}
      </div>
    </div>
  );
  return p.modal ? <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>{body}</div> : body;
}
