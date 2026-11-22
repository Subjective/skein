// Where a popup anchored to a trigger goes so that it fits in the window: on its preferred side (above or below the
// trigger) when it fits there, flipped to the other side when only that one has room, else on the roomier side with
// its height capped (the popup scrolls). Sideways it stays inside the window. Menus and popovers share this.
export type Side = 'top' | 'bottom';
export interface Placed { side: Side; left: number; maxHeight?: number }

const GAP = 6, EDGE = 8;

/** `h` is the popup's natural height; `align` lines its start or end edge (or its middle) up with the trigger's. */
export function placeBy(r: DOMRect, w: number, h: number, prefer: Side, align: 'start' | 'end' | 'center'): Placed {
  const room = { top: r.top - GAP - EDGE, bottom: innerHeight - r.bottom - GAP - EDGE };
  const other: Side = prefer === 'top' ? 'bottom' : 'top';
  const side = h <= room[prefer] ? prefer : h <= room[other] ? other : room[other] > room[prefer] ? other : prefer;
  const at = align === 'end' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
  const left = Math.max(EDGE, Math.min(at, innerWidth - w - EDGE));
  return { side, left, ...(h > room[side] ? { maxHeight: Math.max(80, room[side]) } : {}) };
}

/** CSS for a fixed popup at that place: above the trigger it grows upward from its bottom edge. */
export function placeStyle(r: DOMRect, p: Placed): { left: number; top?: number; bottom?: number; maxHeight?: number } {
  return { left: p.left, ...(p.side === 'top' ? { bottom: innerHeight - r.top + GAP } : { top: r.bottom + GAP }), ...(p.maxHeight != null ? { maxHeight: p.maxHeight } : {}) };
}
