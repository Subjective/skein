// Pasting an image into a terminal (G14): the image is saved to ~/.skein/inbox on the thread's machine
// (uploaded first over SSH), then its path is pasted into the program, which turns it into [Image #n].
// A shell gets the path as text. Text pastes go straight to xterm.
// While an upload runs, the terminal shows a small card under it; a failed upload offers Retry or Discard
// and pastes nothing.
import { api } from '../../api';
import { machine, update } from '../../state/store';
import type { TermEntry } from './TerminalView';

export type Upload = { name: string; host: string; state: 'up' | 'fail'; error?: string; retry: () => void };
export const uploads = new Map<string, Upload>();

const setUpload = (tabId: string, u: Upload | null) => update(() => { if (u) uploads.set(tabId, u); else uploads.delete(tabId); });

function send(tabId: string, t: TermEntry, bytes: Uint8Array) {
  const m = machine(t.spec.machine);
  const remote = !!m?.ssh;
  const run = async () => {
    if (remote) setUpload(tabId, { name: 'clipboard image', host: m!.name, state: 'up', retry: run });
    try {
      const path = await api.images.toInbox(t.spec.machine, bytes);
      setUpload(tabId, null);
      t.term.paste((/\s/.test(path) ? `"${path}"` : path) + ' ');
      t.term.focus();
    } catch (e) {
      setUpload(tabId, { name: 'clipboard image', host: m?.name ?? 'this machine', state: 'fail', error: (e as Error).message, retry: run });
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
