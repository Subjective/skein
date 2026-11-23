// The cursor while an operator (d, c, y) waits for its motion: a half block, as Vim and the code editor draw it, so
// a half-typed command shows. One style (`.vop` in skein.css) for every field: a field with a layer behind its text
// (the composer) draws it there; any other field gets this one floating box over the character.
import { caretBox } from './caret';

let box: HTMLElement | null = null;

/** Show the half block over character `pos` of `el`, or hide it (`el` null). */
export function opCursor(el: HTMLTextAreaElement | HTMLInputElement | null, pos = 0) {
  if (!el) { box?.remove(); return; }
  if (!box) { box = document.createElement('i'); box.className = 'vop vop-float'; box.setAttribute('aria-hidden', 'true'); }
  const r = caretBox(el, pos);
  Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: Math.max(r.width, 7) + 'px', height: r.height + 'px' });
  if (!box.isConnected) document.body.appendChild(box);
}
