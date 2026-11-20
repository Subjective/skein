// Pasting an image into a terminal (G14): the image is saved to ~/.skein/inbox on the thread's machine
// (uploaded first over SSH), then its path is pasted into the program, which turns it into [Image #n].
// A shell gets the path as text. Text pastes go straight to xterm.
// While an upload runs, the terminal shows a small card under it; a failed upload offers Retry or Discard
// and pastes nothing.
import { api } from '../../api';
import { machine, update } from '../../state/store';
import type { TermEntry } from './TerminalView';

export type Upload = { name: string; host: string; state: 'up' | 'fail'; pct: number; error?: string; retry: () => void };
export const uploads = new Map<string, Upload>();

const setUpload = (tabId: string, u: Upload | null) => update(() => { if (u) uploads.set(tabId, u); else uploads.delete(tabId); });

// main pushes an upload's progress as 'upload' events, named by the file
let wired = false;
function wire() {
  if (wired) return; wired = true;
  api.on(e => {
    if (e.type !== 'upload' || e.error) return;
    for (const u of uploads.values()) if (u.state === 'up' && u.name === e.name && e.pct > u.pct) update(() => { u.pct = e.pct; });
  });
}

/** Why an upload failed, in a few words: the machine dropped, else the first line of what went wrong. */
export function uploadCause(host: string, linkUp: boolean, error = ''): string {
  if (!linkUp || /connection (closed|reset|refused|timed out)|broken pipe|lost connection|could not resolve|no route/i.test(error)) return `${host} disconnected`;
  return error.split('\n').map(x => x.trim()).find(Boolean) || 'the upload failed';
}

let n = 0;
function send(tabId: string, t: TermEntry, bytes: Uint8Array) {
  wire();
  const m = machine(t.spec.machine);
  const remote = !!m?.ssh;
  const name = `paste-${++n}-${Date.now().toString(36)}.png`;
  const run = async () => {
    if (remote) setUpload(tabId, { name, host: m!.name, state: 'up', pct: 0, retry: run });
    try {
      const path = await api.images.toInbox(t.spec.machine, bytes, name);
      setUpload(tabId, null);
      t.term.paste((/\s/.test(path) ? `"${path}"` : path) + ' ');
      t.term.focus();
    } catch (e) {
      const now = machine(t.spec.machine), msg = String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      setUpload(tabId, { name, host: now?.name ?? 'this machine', state: 'fail', pct: uploads.get(tabId)?.pct ?? 0, error: msg, retry: run });
    }
  };
  void run();
}

/** A native paste event (cmd-v, the Edit menu, a right-click paste). Returns true when it was an image. */
export function pasteImage(tabId: string, t: TermEntry, ev: ClipboardEvent): boolean {
  const item = [...(ev.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  const file = item?.getAsFile(); if (!file) return false;
  void file.arrayBuffer().then(b => send(tabId, t, new Uint8Array(b)));
  return true;
}

/** A paste key the terminal handles itself (ctrl-v / ctrl-shift-v on Windows and Linux): image first, then text. */
export async function pasteClipboard(tabId: string, t: TermEntry) {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(x => x.startsWith('image/'));
      if (type) { send(tabId, t, new Uint8Array(await (await item.getType(type)).arrayBuffer())); return; }
    }
  } catch { /* no permission or no image: fall back to text */ }
  const text = await navigator.clipboard.readText().catch(() => '');
  if (text) t.term.paste(text);
}

export const discardUpload = (tabId: string) => setUpload(tabId, null);
