// One component for every list that pops up: the palette, the : line, pickers, the / and @ menus,
// pane menus. Keys follow VIM-MODEL (List): j k / arrows / ctrl-n ctrl-p move, enter picks, esc steps back
// (INSERT in the search field -> NORMAL -> closed). A searchable menu opens in INSERT unless `normal`.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Surface } from '../input/dispatcher';
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
  empty?: string;
  /** Keep the menu open after a pick (toggles). */
  keep?: boolean;
  /** Extra keys handled by the menu's owner while an item is selected (NORMAL only). */
  keys?: (k: string, it: MenuItem<D> | undefined) => boolean;
  /** Register as the keyboard owner (default true). */
  surface?: (s: Surface | undefined) => void;
}

const defaultMatch = (it: MenuItem, q: string) => !q || (it.label + ' ' + (it.hint || '')).toLowerCase().includes(q.toLowerCase());

export function Menu<D>(p: MenuProps<D>) {
  const [q, setQ] = useState(p.search?.value || '');
  const [ins, setIns] = useState(!!p.search && !(S.settings.vim && p.normal));
  const all = useMemo(() => (typeof p.items === 'function' ? p.items(q) : p.items), [p.items, q]);
  const items = useMemo(() => {
    const f = p.ranked ? all : all.filter(it => it.head || defaultMatch(it, q));
    return f.filter((it, i) => !it.head || (f[i + 1] && !f[i + 1].head));
  }, [all, q, p.ranked]);
  const first = () => { const on = items.findIndex(it => !it.head && !it.dis && it.on); return on >= 0 ? on : items.findIndex(it => !it.head && !it.dis); };
  const [i, setI] = useState(first);
  useEffect(() => { setI(first()); }, [items.length, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const st = useRef({ i, items, q, ins }); st.current = { i, items, q, ins };

  const move = (d: number) => setI(cur => { let n = cur + d; while (items[n] && (items[n].head || items[n].dis)) n += d; return items[n] ? n : cur; });
  const pick = () => { const it = st.current.items[st.current.i]; if (!it || it.dis || it.head) return; if (!p.keep) p.onClose(); p.onPick(it, st.current.q); };

  // keyboard: this menu is the List surface while it is open
  useEffect(() => {
    const surface: Surface = {
      kind: 'list',
      mode: () => (st.current.ins ? 'INSERT' : 'NORMAL'),
      key: k => {
        const { ins: typing } = st.current;
        switch (k) {
          case 'down': case 'ctrl-n': case 'ctrl-j': move(1); return true;
          case 'up': case 'ctrl-p': case 'ctrl-k': move(-1); return true;
          case 'enter': pick(); return true;
          case 'tab': move(1); return true;
          case 'shift-tab': move(-1); return true;
          case 'esc':
            if (typing && S.settings.vim && p.search) { setIns(false); inp.current?.blur(); return true; }
            p.onClose(); return true;
        }
        if (typing) return false; // the search field types it
        if (p.keys?.(k, st.current.items[st.current.i])) return true;
        switch (k) {
          case 'j': move(1); return true;
          case 'k': move(-1); return true;
          case 'g': setI(items.findIndex(it => !it.head && !it.dis)); return true;
          case 'G': { let n = items.length - 1; while (n > 0 && (items[n].head || items[n].dis)) n--; setI(n); return true; }
          case 'i': case 'a': case '/': if (p.search) { setIns(true); inp.current?.focus(); return true; } return false;
          case 'l': pick(); return true;
          case 'q': p.onClose(); return true;
        }
        return k.length === 1; // NORMAL: plain keys do nothing else here
      },
    };
    p.surface ? p.surface(surface) : update(s => { const top = s.layers[s.layers.length - 1]; if (top) top.surface = surface; s.tick++; });
    return () => p.surface?.(undefined);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => update(s => { s.tick++; }), [ins]);

  useEffect(() => { if (ins) inp.current?.focus(); else if (p.search) (document.activeElement as HTMLElement | null)?.blur?.(); }, [ins, p.search]);
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

  const body = (
    <div ref={ref} className={cx('menu', p.className, !ins && 'nm', p.anchor && !p.modal && 'composer-menu')} style={p.modal ? undefined : pos} role="dialog">
      {p.search && (
        <div className="m-s" onMouseDown={e => { if (!ins) { e.preventDefault(); setIns(true); } }}>
          {p.search.prefix ? <span className="pfx">{p.search.prefix}</span> : <Icon name="search" />}
          <input ref={inp} spellCheck={false} role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label={p.search.placeholder || p.search.prefix || 'Search'}
            aria-activedescendant={i >= 0 ? `mi-${i}` : undefined} placeholder={p.search.placeholder || ''} value={q} readOnly={!ins}
            onChange={e => setQ(e.target.value)} onFocus={() => setIns(true)} />
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
        {!items.some(it => !it.head) && p.empty && <div className="m-empty" role="status">{p.empty}</div>}
      </div>
    </div>
  );
  return p.modal ? <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>{body}</div> : body;
}
