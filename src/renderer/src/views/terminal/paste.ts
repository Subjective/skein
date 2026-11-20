// Pasting an image into a terminal (G14): the image is saved to ~/.skein/inbox on the thread's machine
// (uploaded first over SSH), then its path is pasted into the program, which turns it into [Image #n].
// A shell gets the path as text. Text pastes are left to xterm.
import { api } from '../../api';
import { toast } from '../../state/store';
import type { TermEntry } from './TerminalView';

export function pasteImage(_tabId: string, t: TermEntry, ev: ClipboardEvent): boolean {
  const item = [...(ev.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item) return false;
  const file = item.getAsFile(); if (!file) return false;
  void (async () => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const remote = !!t.spec.machine && t.spec.machine !== 'local';
      if (remote) toast('Uploading image…', { icon: 'upload' }, 1500);
      const path = await api.images.toInbox(t.spec.machine, bytes);
      const quoted = /\s/.test(path) ? `"${path}"` : path;
      t.term.paste(quoted + ' ');
      t.term.focus();
    } catch (e) {
      toast(`Image paste failed: ${(e as Error).message}`, { icon: 'alert' }, 6000);
    }
  })();
  return true;
}
