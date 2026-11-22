// Which hand is on the app: the keyboard or the pointer. A cursor that only the keys move (Settings' rows and
// section list) shows while the keys are in use and hides once the pointer moves, so a click never leaves a ring
// or a filled row behind. The pointer has to really move: layout shifts under a still pointer do not count.
import { useCallback, useRef, useState } from 'react';

let last: 'key' | 'pointer' = 'key';
if (typeof window !== 'undefined') {
  addEventListener('keydown', () => { last = 'key'; }, true);
  addEventListener('pointerdown', () => { last = 'pointer'; }, true);
}

/** `kb`: show the key cursor. Call `onKey` from the surface's key handler; spread `pointer` on the surface. */
export function useKeyCursor() {
  const [kb, setKb] = useState(last === 'key');
  const at = useRef<[number, number] | null>(null);
  const onKey = useCallback(() => setKb(true), []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = at.current; at.current = [e.clientX, e.clientY];
    if (p && (p[0] !== e.clientX || p[1] !== e.clientY)) setKb(false);
  }, []);
  const onPointerDown = useCallback(() => setKb(false), []);
  return { kb, onKey, pointer: { onPointerMove, onPointerDown } };
}
