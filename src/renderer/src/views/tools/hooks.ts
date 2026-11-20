// What a tool tab does for app commands that mean something per tab: back / forward (ctrl-o / ctrl-i in an
// open file) and :w. shell/commands.ts asks here first and falls back to its own behaviour.
export interface TabHooks { back?: () => boolean; forward?: () => boolean; save?: () => boolean }
const hooks = new Map<string, TabHooks>();
export const registerHooks = (tabId: string, h: TabHooks) => { hooks.set(tabId, h); return () => { if (hooks.get(tabId) === h) hooks.delete(tabId); }; };
/** Run a tab's hook. false when the tab has none (or it did nothing), so the caller does its default. */
export const tabHook = (tabId: string, name: keyof TabHooks): boolean => !!hooks.get(tabId)?.[name]?.();
