// Who owns the keyboard. Exactly one surface at a time (VIM-MODEL section 2):
//   the topmost overlay (menu, palette, dialog) > the sidebar when focused > the focused popup's tab >
//   the focused pane's active tab > the layout itself (NORMAL, nothing to type into).
import type { Surface } from './dispatcher';

const byTab = new Map<string, Surface>();
export const registerTab = (tabId: string, s: Surface) => { byTab.set(tabId, s); return () => { if (byTab.get(tabId) === s) byTab.delete(tabId); }; };
export const tabSurface = (tabId?: string) => (tabId ? byTab.get(tabId) : undefined);

/** A pane with nothing that takes keys: NORMAL, and the app's normal layer gets every key. */
export const layoutSurface: Surface = { kind: 'layout', mode: () => 'NORMAL', key: () => false };
