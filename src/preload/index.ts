// Exposes window.skein: a typed proxy over ipcRenderer, built from API_SHAPE. No logic lives here.
import { contextBridge, ipcRenderer } from 'electron';
import { API_SHAPE, FIRE_AND_FORGET, type SkeinEvent } from '../shared/api';

const bridge: Record<string, unknown> = {};
for (const [ns, methods] of Object.entries(API_SHAPE)) {
  const o: Record<string, unknown> = {};
  for (const m of methods as string[]) {
    const ch = `${ns}.${m}`;
    o[m] = FIRE_AND_FORGET.has(ch) ? (...a: unknown[]) => ipcRenderer.send(ch, ...a) : (...a: unknown[]) => ipcRenderer.invoke(ch, ...a);
  }
  bridge[ns] = o;
}
bridge.on = (fn: (e: SkeinEvent) => void) => {
  const h = (_: unknown, e: SkeinEvent) => fn(e);
  ipcRenderer.on('skein.event', h);
  return () => ipcRenderer.removeListener('skein.event', h);
};
/** Window chrome follows the app theme (Windows caption buttons). */
bridge.setTheme = (dark: boolean) => ipcRenderer.send('shell.theme', dark);
contextBridge.exposeInMainWorld('skein', bridge);
