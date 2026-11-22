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
import { placeBy, placeStyle } from './place';

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
  /** A row that is not an option (with head): drawn as is, in a .mx block (the model picker's effort track, a gap). */
  block?: ReactNode;
  /** Stays in view under the list instead of scrolling with it (the model picker's effort and Ultracode). */
  pin?: boolean;
  data?: D;
}

export interface MenuProps<D = unknown> {
  items: MenuItem<D>[] | ((q: string) => MenuItem<D>[]);
  onPick: (it: MenuItem<D>, q: string) => void;
  onClose: () => void;
  search?: { placeholder?: string; prefix?: string; value?: string };
  /** items(q) already filtered and ranked for q: skip the default substring filter. */
  ranked?: boolean;
  /** Only for a popup that remounts itself (the folder picker going into a folder): come back in NORMAL if it was in
   *  NORMAL. A popup with a search field always OPENS in INSERT (VIM-MODEL rule 21); don't use this to change that. */
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
  keep?: boolean | ((it: MenuItem<D>) => boolean);
  /** Extra keys handled by the menu's owner while an item is selected (NORMAL only). */
  keys?: (k: string, it: MenuItem<D> | undefined) => boolean;
  /** `keys` also hears left / right while the search field is typing (the model picker's effort). */
  arrows?: boolean;
  /** Moving past the last row goes to the first, and up past the first goes to the last row `last` accepts (the
   *  model picker: its effort row). */
  wrap?: { last?: (it: MenuItem<D>) => boolean };
  /** A folder list: tab goes into the folder (the owner's `keys`), and on a row with nothing to go into moves on
   *  instead of picking (the mockup's Dirs). */
  tabMoves?: boolean;
  /** Controlled selection (the ctrl-tab switcher moves it from outside); onSelect hears every move. */
  select?: number;
  onSelect?: (i: number) => void;
  /** The row under the cursor (keys or pointer), each time it or the list changes. */
  onCursor?: (it: MenuItem<D> | undefined) => void;
  /** Register as the keyboard owner (default true). */
  surface?: (s: Surface | undefined) => void;
}

// The button that opened a menu shows it is open (aria-expanded: its caret turns, as in the mockup). Menus are
// placed from a rect, so the trigger is the button last pressed whose box is that rect.
let pressed: HTMLElement | null = null;
if (typeof document !== 'undefined') document.addEventListener('mousedown', e => { pressed = (e.target as Element)?.closest?.('button') ?? null; }, true);
function triggerOf(r: DOMRect | null | undefined): HTMLElement | null {
  const b = pressed ?? (document.activeElement instanceof HTMLButtonElement ? document.activeElement : null);
  if (!r || !b || !b.isConnected) return null;
  const q = b.getBoundingClientRect();
  return Math.abs(q.left - r.left) < 1 && Math.abs(q.top - r.top) < 1 && Math.abs(q.width - r.width) < 1 ? b : null;
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
    return f.filter((it, i) => !it.head || it.block != null || (f[i + 1] && !f[i + 1].head));
  }, [all, q, p.ranked]);
  const first = () => { const on = items.findIndex(it => !it.head && !it.dis && it.on); return on >= 0 ? on : items.findIndex(it => !it.head && !it.dis); };
  const [i, setI] = useState(() => p.select ?? first());
  // a refilter starts on the first row; a menu that stays open (keep) keeps the row it was on, by label
  const prevLabel = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = p.keep && prevLabel.current != null ? items.findIndex(it => !it.head && !it.dis && it.label === prevLabel.current) : -1;
    setI(p.select ?? (was >= 0 ? was : first()));
  }, [items.length, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { prevLabel.current = items[i]?.label; }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (p.select != null) setI(p.select); }, [p.select]);
  useEffect(() => { p.onSelect?.(i); }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { p.onCursor?.(items[i]); }, [i, items]); // eslint-disable-line react-hooks/exhaustive-deps
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
    const u = Math.sign(d), ok = (n: number) => !!items[n] && !items[n].head && !items[n].dis;
    for (let left = Math.abs(d); left > 0; left--) {
      let n = cur + u; while (items[n] && !ok(n)) n += u;
      if (!items[n] && p.wrap) {
        if (u > 0) n = items.findIndex((_, x) => ok(x));
        else { n = items.length - 1; while (n >= 0 && !(ok(n) && (!p.wrap.last || p.wrap.last(items[n])))) n--; }
      }
      if (!items[n] || n === cur) break; cur = n;
    }
    return cur;
  });
  /** Pick the row under the cursor; `stay` (space) picks without closing. */
  const pick = (stay = false) => { const it = st.current.items[st.current.i]; if (!it || it.dis || it.head) return; if (!stay && !(typeof p.keep === 'function' ? p.keep(it) : p.keep)) p.onClose(); p.onPick(it, st.current.q); };

  // keyboard: this menu is the List surface while it is open
  useEffect(() => {
    const surface: Surface = {
      kind: 'list',
      local: () => true,
      dismiss: () => p.onClose(),
      mode: () => (st.current.ins ? 'INSERT' : p.search && S.settings.vim && fs.current.mode.startsWith('V') ? fs.current.mode as 'VISUAL' | 'V-LINE' : 'NORMAL'),
      key: k0 => {
        const { ins: typing } = st.current;
        const k = k0 === 'ctrl-h' ? 'left' : k0 === 'ctrl-l' ? 'right' : k0;   // ctrl-h / ctrl-l are left / right, as arrows
        const cur = st.current.items[st.current.i];
        // tab goes into a folder in a folder field (the owner says so), in INSERT too
        if (k === 'tab' && p.keys?.(k, cur)) return true;
        switch (k) {
          case 'down': case 'ctrl-n': case 'ctrl-j': move(1); return true;
          case 'up': case 'ctrl-p': case 'ctrl-k': move(-1); return true;
          case 'enter': case 'tab':
            if (k === 'tab' && p.tabMoves) { move(1); return true; }
            // enter or tab picks; with nothing to pick, a menu without a search field closes and lets the key through
            if (st.current.items.some(it => !it.head && !it.dis)) { pick(); return true; }
            if (p.search) return true;
            p.onClose(); return false;
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
        if (typing && p.arrows && (k === 'left' || k === 'right') && p.keys?.(k, st.current.items[st.current.i])) return true;
        if (typing) return k0 !== k; // the search field types it (ctrl-h / ctrl-l are not typing)
        if (S.settings.vim && k === 'space') { pick(true); return true; }   // NORMAL: space picks without closing
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
          case 'l': case 'right': if (!p.search) { pick(); return true; } break;
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
  useEffect(() => { ref.current?.querySelector('.mi.sel, .mx.sel')?.scrollIntoView({ block: 'nearest' }); }, [i]);

  // a menu opened from a composer's controls or the new-thread row has the composer look, and its selection
  // follows the pointer; other menus keep the keyboard's selection under a hover (as in the mockup)
  const [composer] = useState(() => !!p.className?.split(' ').includes('composer-menu') || !!(!p.modal && triggerOf(p.anchor)?.closest('.comp, .under.pick')));
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const b = p.modal ? null : triggerOf(p.anchor);
    trigger.current = b;
    if (!b) return;
    b.setAttribute('aria-expanded', 'true');
    return () => b.setAttribute('aria-expanded', 'false');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // place next to the anchor
  // on its side of the anchor when it fits there, else flipped, else capped and scrolling (ui/place.ts); measured
  // again when the list grows or shrinks, so a menu that fills in after opening still fits
  const [pos, setPos] = useState<React.CSSProperties>({});
  // an open menu never shrinks: a row that goes away (the model picker's Ultracode, on hovering a model without it)
  // would otherwise move every row under the pointer of a menu that opens upward. Typing a search may shrink it
  const tallest = useRef(0), forQ = useRef(q);
  if (forQ.current !== q) { forQ.current = q; tallest.current = 0; }
  useLayoutEffect(() => {
    if (p.modal || !p.anchor) return;
    const r = p.anchor, w = Math.min(p.width === 'anchor' ? r.width : p.width || 260, innerWidth - 16);
    const place = p.place || 'top-start', el = ref.current;
    if (el) { el.style.maxHeight = ''; el.style.minHeight = ''; el.style.width = w + 'px'; }
    const h = tallest.current = Math.max(tallest.current, el?.offsetHeight ?? 0);
    const at = placeBy(r, w, h, place.startsWith('top') ? 'top' : 'bottom', place.endsWith('end') ? 'end' : 'start');
    const st = placeStyle(r, at);
    // the cap is put back by hand too: React skips a style prop that did not change, and it was just cleared above
    if (el && st.maxHeight != null) el.style.maxHeight = st.maxHeight + 'px';
    if (el) el.style.minHeight = Math.min(h, st.maxHeight ?? h) + 'px';
    setPos({ width: w, ...st });
  }, [p.anchor, p.modal, p.place, p.width, items.length, q]); // eslint-disable-line react-hooks/exhaustive-deps

  // a click outside closes
  useEffect(() => {
    if (p.modal) return;
    const h = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // a press on the button that opened it closes it, and the click that follows must not open it again
      const b = trigger.current;
      if (b && b.contains(e.target as Node)) {
        const eat = (c: MouseEvent) => { if (b.contains(c.target as Node)) { c.stopPropagation(); c.preventDefault(); } };
        document.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', eat, { capture: true }), 1000);
      }
      p.onClose();
    };
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
  const row = (it: MenuItem<D>, n: number) => (
    it.block != null ? (it.head
    ? <div key={'x' + n} className="mx" role="presentation">{it.block}</div>
    // a block that is a row (the model picker's effort): the keyboard lands on it; the pointer works its contents
    : <div key={'x' + n} id={`mi-${n}`} role="option" aria-selected={n === i} aria-label={it.label} className={cx('mx', n === i && 'sel')}>{it.block}</div>) : it.head
    ? <div key={'h' + n} className="mi head" role="presentation">{it.icon}{it.label}</div>
    : <div key={n} id={`mi-${n}`} role="option" aria-selected={n === i} aria-disabled={it.dis || undefined} className={cx('mi', n === i && 'sel', it.dis && 'off')}
        onPointerMove={e => { if (composer && e.pointerType !== 'touch' && n !== i && !it.dis) setI(n); }}
        onMouseDown={e => { e.preventDefault(); if (!it.dis) { st.current.i = n; pick(); } }}>
        {it.icon && <span className="mic">{it.icon}</span>}
        <span className="ml">{it.display ?? it.label}</span>
        {it.hint && <span className="mh">{it.hint}</span>}
        <span className="mr">{it.right}{it.kbd && <kbd>{it.kbd}</kbd>}{it.on && <Icon name="check" />}</span>
      </div>);
  const body = (
    <div ref={ref} className={cx('menu', p.className, composer && 'composer-menu', !ins && 'nm', !p.search && !items.length && !emptyText && 'none')} style={p.modal ? undefined : pos} role="dialog">
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
        {items.map((it, n) => (it.pin ? null : row(it, n)))}
        {!items.some(it => !it.head) && emptyText && <div className="m-empty" role="status">{emptyText}</div>}
      </div>
      {items.some(it => it.pin) && <div className="m-pin" role="group">{items.map((it, n) => (it.pin ? row(it, n) : null))}</div>}
    </div>
  );
  return p.modal ? <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>{body}</div> : body;
}
