// A modal panel over a scrim. Its keys are a List surface given by useDialogSurface; esc closes,
// a click on the scrim closes, focus returns to where it was (the layer stack handles that).
import { useEffect, useRef, type ReactNode } from 'react';
import type { Surface } from '../input/dispatcher';
import { update } from '../state/store';
import { cx } from './primitives';

export function Dialog({ onClose, className, label, children }: { onClose: () => void; className?: string; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { (document.activeElement as HTMLElement | null)?.blur?.(); }, []);
  return (
    <div className="scrim sheet" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={cx(className)} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

/** Make the topmost layer's keyboard surface this dialog's. `key` returns true when it used the key. */
export function useDialogSurface(o: { onEsc: () => void; key?: (k: string) => boolean; mode?: () => Surface['mode'] extends () => infer M ? M : never }, deps: unknown[] = []) {
  const ref = useRef(o); ref.current = o;
  useEffect(() => {
    const surface: Surface = {
      kind: 'list',
      mode: () => ref.current.mode?.() ?? 'NORMAL',
      key: k => { if (k === 'esc') { ref.current.onEsc(); return true; } return ref.current.key?.(k) ?? false; },
    };
    update(s => { const top = s.layers[s.layers.length - 1]; if (top) top.surface = surface; s.tick++; });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}
