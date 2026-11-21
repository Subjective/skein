// Drag an edge to resize a side panel (the sidebar's right edge, the file tree's left edge). The width lives in a
// CSS variable on #app, so every panel of the kind follows, and it is kept for the next launch.
import type React from 'react';

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

/** onPointerDown for the handle: inside the panel on its right edge, or just before the panel for a left edge. */
export function dragEdge(e: Edge) {
  return (ev: React.PointerEvent<HTMLElement>) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const h = ev.currentTarget, panel = (e.side === 'right' ? h.parentElement : h.nextElementSibling)!, w0 = panel.getBoundingClientRect().width, x0 = ev.clientX, id = ev.pointerId, dir = e.side === 'right' ? 1 : -1;
    h.setPointerCapture(id);
    let w = w0;
    h.onpointermove = m => { if (m.pointerId !== id) return; w = clamp(e, w0 + dir * (m.clientX - x0)); setEdgeWidth(e, w); };
    h.onlostpointercapture = () => { h.onpointermove = null; h.onlostpointercapture = null; try { localStorage.setItem(e.key, String(w)); } catch { /* not kept */ } };
  };
}

export const SIDEBAR_EDGE: Edge = { cssVar: '--sidebar-width', key: 'skein.sidebarWidth', min: 200, maxShare: 0.6, side: 'right' };
export const TREE_EDGE: Edge = { cssVar: '--tree-width', key: 'skein.treeWidth', min: 160, maxShare: 0.5, side: 'left' };
