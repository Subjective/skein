// A row of buttons that stands in for a field (VIM-MODEL rule 16): the handoff card, a terminal's exit row, a
// failed upload, the Claude Code mirror bar. While the tab has the keys the row does: h / l (or the arrows) move
// along it, enter / space press, esc presses the row's way out ([data-esc]) or leaves to NORMAL, k / [ / { read
// the thread above (`onRead`), i / a press the button that gets you typing (`onInsert`). Tab passes, and every
// other key goes on to the app's NORMAL layer (H / L tabs, : and so on). The primary button has the focus first.
import { useEffect, type RefObject } from 'react';
import { registerTab } from '../input/surfaces';
import { update } from '../state/store';

export interface KbRowOptions {
  /** Read the thread above (k, [, {). Return false when there is nothing to read. */
  onRead?: () => boolean;
  /** i / a: the button that gets you typing. */
  onInsert?: () => void;
}

const buttons = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];

/** Give a row of buttons the tab's keys while `on` (the tab is focused and the row is showing). */
export function useKbRow(tabId: string, on: boolean, row: RefObject<HTMLElement | null>, o: KbRowOptions = {}) {
  useEffect(() => {
    const el = row.current;
    if (!on || !el) return;
    const first = el.querySelector<HTMLButtonElement>('button.primary:not([disabled])') || buttons(el)[0];
    if (first && !el.contains(document.activeElement)) { (document.activeElement as HTMLElement | null)?.blur?.(); first.focus({ preventScroll: true }); }
    const un = registerTab(tabId, {
      kind: 'list',
      mode: () => 'NORMAL',
      key: k => {
        const bs = buttons(el);
        if (!bs.length) return false;
        const cur = bs.indexOf(document.activeElement as HTMLButtonElement), i = cur < 0 ? 0 : cur;
        switch (k) {
          case 'h': case 'left': bs[Math.max(0, i - 1)].focus(); return true;
          case 'l': case 'right': bs[Math.min(bs.length - 1, i + 1)].focus(); return true;
          case 'enter': case 'space': bs[i].click(); return true;
          case 'esc': { const out = el.querySelector<HTMLButtonElement>('[data-esc]'); if (out) { out.click(); return true; } (document.activeElement as HTMLElement | null)?.blur?.(); update(s => { s.tick++; }); return true; }
          case 'k': case '[': case '{': return o.onRead ? o.onRead() : false;
          case 'i': case 'a': if (o.onInsert) { o.onInsert(); return true; } return false;
          default: return false;
        }
      },
    });
    update(s => { s.tick++; });
    return un;
  }, [tabId, on]); // eslint-disable-line react-hooks/exhaustive-deps
}
