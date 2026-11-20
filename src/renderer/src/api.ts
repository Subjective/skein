// The bridge to the main process (src/preload). In a plain browser (vite dev without Electron, or UI tests)
// a stand-in answers so the UI can still be driven; it is never used inside the app.
import type { SkeinBridge } from '@shared/api';
import { fakeApi } from './dev/fakeApi';

declare global { interface Window { skein?: SkeinBridge } }

export const inElectron = typeof window !== 'undefined' && !!window.skein;
export const api: SkeinBridge = (typeof window !== 'undefined' && window.skein) || fakeApi;
