// Who owns the keyboard. Exactly one surface at a time (VIM-MODEL section 2):
//   the topmost overlay (menu, palette, dialog) > the sidebar when focused > the focused popup's tab >
//   the focused pane's active tab > the layout itself (NORMAL, nothing to type into).
import type { Surface } from './dispatcher';

// A tab's surfaces stack: the latest one registered has the keys (a row of buttons over a terminal, rule 16),
// and when it goes the one under it has them again.
const byTab = new Map<string, Surface[]>();
export const registerTab = (tabId: string, s: Surface) => {
  byTab.set(tabId, [...(byTab.get(tabId) || []).filter(x => x !== s), s]);
  return () => { const l = (byTab.get(tabId) || []).filter(x => x !== s); if (l.length) byTab.set(tabId, l); else byTab.delete(tabId); };
};
export const tabSurface = (tabId?: string) => { const l = tabId ? byTab.get(tabId) : undefined; return l?.[l.length - 1]; };

/** A pane with nothing that takes keys: NORMAL, and the app's normal layer gets every key. */
export const layoutSurface: Surface = { kind: 'layout', mode: () => 'NORMAL', key: () => false };
