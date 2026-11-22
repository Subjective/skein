// A tool view's keyboard surface: registered for its tab while the tab is focused, re-claimed when a field
// inside the view (the tree search, the file editor) hands the keys back.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Mode, Surface, SurfaceKind } from '../../input/dispatcher';
import type { KeyLike } from '../../input/keys';
import { registerTab, tabSurface } from '../../input/surfaces';
import { update } from '../../state/store';

export interface ReaderSpec {
  kind?: SurfaceKind; mode: () => Mode; key: (k: string, e: KeyLike) => boolean;
  /** Whether a field in the view has the keys now. Without it, any field registered for the tab is taken to (so a
   *  field that handed the keys back but stays mounted, the file's editor, would keep them after a popup). */
  fieldOwns?: () => boolean;
}

export function useSurface(tabId: string, focused: boolean, spec: ReaderSpec) {
  const ref = useRef(spec); ref.current = spec;
  const proxy = useRef<Surface>({ kind: spec.kind || 'reader', mode: () => ref.current.mode(), key: (k, e) => ref.current.key(k, e) }).current;
  const un = useRef<(() => void) | null>(null);
  const own = () => { un.current?.(); un.current = registerTab(tabId, proxy); update(s => { s.tick++; }); };
  useEffect(() => {
    if (!focused) return;
    // a field in the view may own the tab already (the editor); keep it
    const cur = tabSurface(tabId);
    if (!cur || cur === proxy || ref.current.fieldOwns?.() === false) own();
    return () => { un.current?.(); un.current = null; };
  }, [focused, tabId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { own, owns: () => tabSurface(tabId) === proxy };
}

/** Keys a button or field under the keyboard focus should get as usual (Tab reaching a header button, then enter). */
export const nativeTarget = () => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === 'BUTTON' || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !a.closest('[data-read]');
};

/** Half a page of rows, for ctrl-d / ctrl-u. */
export const halfPage = (el: HTMLElement | null, rowPx = 20) => Math.max(4, Math.floor((el?.clientHeight || 400) / rowPx / 2));

/** A side tree (changed files, project files) that steps aside when the pane is narrow: below `px` it is hidden
 *  unless asked for there, so narrowing a split never crushes the code. `tree` is the wide choice, `treeN` the narrow one. */
export function useSideTree(v: { tree: boolean; treeN?: boolean }, px = 640) {
  const [el, ref] = useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width > 0 && e.contentRect.width < px));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, px]);
  const show = narrow ? !!v.treeN : v.tree;
  const set = (on: boolean) => { if (narrow) v.treeN = on; else v.tree = on; update(); };
  return { ref, show, narrow, set, toggle: () => set(!show) };
}
