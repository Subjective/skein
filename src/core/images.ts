// Image paste into a terminal (G14): save into ~/.skein/inbox on the thread's machine, then the renderer
// pastes the path. Over SSH the bytes go up first, with progress pushed as 'upload' events.
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Machine } from '../shared/types';
import { emit } from './events';
import { write } from './files';

let n = 0;
export async function toInbox(m: Machine, png: Uint8Array, name?: string): Promise<string> {
  const file = name || `paste-${new Date().toISOString().replace(/[:.]/g, '-')}-${++n}.png`;
  if (!m.ssh) { const p = join(homedir(), '.skein', 'inbox', file); await write(m, p, png); return p; }
  const remote = `${m.home || '~'}/.skein/inbox/${file}`;
  emit({ type: 'upload', machine: m.id, name: file, pct: 0 });
  let last = 0;
  const sent = (pct: number) => { if (pct < 100 && pct - last >= 5) { last = pct; emit({ type: 'upload', machine: m.id, name: file, pct }); } };
  try { await write(m, remote, png, sent); } catch (e) { emit({ type: 'upload', machine: m.id, name: file, pct: 0, error: (e as Error).message }); throw e; }
  emit({ type: 'upload', machine: m.id, name: file, pct: 100 });
  return remote;
}
