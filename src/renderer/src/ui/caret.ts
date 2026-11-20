// Where a character of a textarea sits, measured on a hidden copy of its text (a textarea has no API for it).
// Used to keep the Vim cursor in view: a NORMAL motion moves the selection, and the browser only scrolls a
// textarea to its caret while typing, so j, G, w or a search would otherwise leave the cursor out of sight.
const COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'wordSpacing', 'lineHeight',
  'textTransform', 'textIndent', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;

let copy: HTMLDivElement | null = null;

/** The top and height of the line holding character `pos`, in the textarea's scrolled content (like scrollTop). */
export function caretLine(el: HTMLTextAreaElement, pos: number): { top: number; height: number } {
  if (!copy) {
    copy = document.createElement('div');
    Object.assign(copy.style, { position: 'absolute', top: '0', left: '-10000px', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'content-box', border: '0', height: 'auto', overflow: 'hidden' });
    copy.setAttribute('aria-hidden', 'true');
  }
  const cs = getComputedStyle(el), d = copy;
  for (const k of COPY) d.style[k] = cs[k];
  d.style.width = Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) + 'px';
  const text = el.value, ch = text[pos];
  d.textContent = text.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = !ch || ch === '\n' ? '​' : ch;   // a line end or an empty line still has a line to show
  mark.style.display = 'inline-block';   // its box is the whole line's height, not just the glyphs'
  d.appendChild(mark);
  document.body.appendChild(d);
  const r = { top: mark.offsetTop, height: mark.offsetHeight };
  d.remove();
  return r;
}

/** Scroll the textarea just enough that character `pos` is on screen. */
export function revealCaret(el: HTMLTextAreaElement, pos: number) {
  if (el.scrollHeight <= el.clientHeight) { if (el.scrollTop) el.scrollTop = 0; return; }
  const { top, height } = caretLine(el, pos), cs = getComputedStyle(el);
  const padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom);
  if (top - padT < el.scrollTop) el.scrollTop = Math.max(0, top - padT);
  else if (top + height + padB > el.scrollTop + el.clientHeight) el.scrollTop = top + height + padB - el.clientHeight;
}
