// What a tool tab does for app commands that mean something per tab: back / forward (ctrl-o / ctrl-i in an
// open file or a Browser tab), :w, and mod-l (the Browser tab's address bar instead of quoting a selection). shell/commands.ts asks here first and falls back to its own behaviour.
export interface TabHooks {
  back?: () => boolean; forward?: () => boolean; save?: () => boolean; addr?: () => boolean;
  /** Rule 15: where the keyboard is in this tab (a reader cursor, a composer's mode and position), and putting it
   *  back. A popup notes its pane's place when it opens and restores it when it closes or on ctrl-o. */
  place?: () => unknown; restore?: (p: unknown) => void;
}
const hooks = new Map<string, TabHooks>();
export const registerHooks = (tabId: string, h: TabHooks) => { hooks.set(tabId, h); return () => { if (hooks.get(tabId) === h) hooks.delete(tabId); }; };
/** Run a tab's hook. false when the tab has none (or it did nothing), so the caller does its default. */
export const tabHook = (tabId: string, name: 'back' | 'forward' | 'save' | 'addr'): boolean => !!hooks.get(tabId)?.[name]?.();
export const tabPlace = (tabId: string): unknown => hooks.get(tabId)?.place?.();
export const tabRestore = (tabId: string, p: unknown) => { hooks.get(tabId)?.restore?.(p); };
