// Pushes to the renderer. main/index.ts sets the sink once the window exists.
import type { SkeinEvent } from '../shared/api';

let sink: ((e: SkeinEvent) => void) | null = null;
const queue: SkeinEvent[] = [];
export function setSink(fn: (e: SkeinEvent) => void) { sink = fn; for (const e of queue.splice(0)) fn(e); }
export function emit(e: SkeinEvent) { if (sink) sink(e); else if (e.type !== 'pty.data') queue.push(e); }
