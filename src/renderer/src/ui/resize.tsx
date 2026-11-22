// Every drag-to-resize edge in the app: the sidebar's right edge, the file tree's left edge and the divider of a
// pane split. They are one component (ResizeHandle, styled by .rsz in skein.css) so they look, hit and feel the same:
// a hairline at rest, a thin blue line on hover (after a short delay) and while dragging, a resize cursor and a
// 9px hit area. Floating popups resize from invisible edge grips instead (Workspace.tsx), like a window.
//
// A side panel's width lives in a CSS variable on #app, so every panel of the kind follows, and it is kept for the
// next launch.
import type React from 'react';
import { cx } from './primitives';

/** A resize edge. `axis` is the direction it moves in: 'x' for a vertical line dragged sideways. */
export function ResizeHandle({ axis, label, className, onPointerDown, onDoubleClick }: {
  axis: 'x' | 'y'; label: string; className?: string;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void; onDoubleClick?: () => void;
}) {
  return <div className={cx('rsz', axis, className)} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label}
    onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} />;
}

/** Shows the handle as held from pointerdown until the pointer is let go (the line stays while dragging). */
export function hold(h: HTMLElement, id: number, onEnd?: () => void) {
  h.setPointerCapture(id); h.classList.add('on');
  const end = () => { h.classList.remove('on'); h.removeEventListener('lostpointercapture', end); onEnd?.(); };
  h.addEventListener('lostpointercapture', end);
}

export interface Edge {
  /** The CSS variable the panel's width reads. */
  cssVar: string;
  /** Where the width is kept. */
  key: string;
  min: number;
  /** Largest width, as a share of the window. */
  maxShare: number;
  /** Which side of the panel the handle is on: a left edge grows the panel as it moves left. */
  side: 'left' | 'right';
}

export const setEdgeWidth = (e: Edge, px: number) => document.getElementById('app')?.style.setProperty(e.cssVar, px + 'px');
const clamp = (e: Edge, w: number) => Math.round(Math.min(innerWidth * e.maxShare, Math.max(e.min, w)));

/** The kept width, applied (call once at startup or when the panel first shows). */
export function restoreEdge(e: Edge) {
  try { const w = +(localStorage.getItem(e.key) || 0); if (w >= e.min) setEdgeWidth(e, clamp(e, w)); } catch { /* the default width */ }
}

/** onPointerDown for the handle: the last child of the panel for a right edge, or just before the panel for a left edge. */
export function dragEdge(e: Edge) {
  return (ev: React.PointerEvent<HTMLElement>) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const h = ev.currentTarget, panel = (e.side === 'right' ? h.parentElement : h.nextElementSibling)!, w0 = panel.getBoundingClientRect().width, x0 = ev.clientX, id = ev.pointerId, dir = e.side === 'right' ? 1 : -1;
    let w = w0;
    h.onpointermove = m => { if (m.pointerId !== id) return; w = clamp(e, w0 + dir * (m.clientX - x0)); setEdgeWidth(e, w); };
    hold(h, id, () => { h.onpointermove = null; try { localStorage.setItem(e.key, String(w)); } catch { /* not kept */ } });
  };
}

/** Double-click: back to the default width (the CSS fallback), forgetting the kept one. */
export function resetEdge(e: Edge) {
  document.getElementById('app')?.style.removeProperty(e.cssVar);
  try { localStorage.removeItem(e.key); } catch { /* nothing kept */ }
}

export const SIDEBAR_EDGE: Edge = { cssVar: '--sidebar-width', key: 'skein.sidebarWidth', min: 200, maxShare: 0.6, side: 'right' };
export const TREE_EDGE: Edge = { cssVar: '--tree-width', key: 'skein.treeWidth', min: 160, maxShare: 0.5, side: 'left' };
