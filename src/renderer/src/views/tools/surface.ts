// A tool view's keyboard surface: registered for its tab while the tab is focused, re-claimed when a field
// inside the view (the tree search, the file editor) hands the keys back.
import { useEffect, useRef } from 'react';
import type { Mode, Surface, SurfaceKind } from '../../input/dispatcher';
import type { KeyLike } from '../../input/keys';
import { registerTab, tabSurface } from '../../input/surfaces';
import { update } from '../../state/store';

export interface ReaderSpec { kind?: SurfaceKind; mode: () => Mode; key: (k: string, e: KeyLike) => boolean }

export function useSurface(tabId: string, focused: boolean, spec: ReaderSpec) {
  const ref = useRef(spec); ref.current = spec;
  const proxy = useRef<Surface>({ kind: spec.kind || 'reader', mode: () => ref.current.mode(), key: (k, e) => ref.current.key(k, e) }).current;
  const un = useRef<(() => void) | null>(null);
  const own = () => { un.current?.(); un.current = registerTab(tabId, proxy); update(s => { s.tick++; }); };
  useEffect(() => {
    if (!focused) return;
    // a field in the view may own the tab already (the editor); keep it
    if (!tabSurface(tabId) || tabSurface(tabId) === proxy) own();
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
