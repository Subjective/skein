// Your message becomes its edit box in place, and the box becomes the bubble again (Cursor's feel: the words stay put
// while the surface changes around them). The bubble is right-aligned and the box is full width, so the box's surface
// grows out of the bubble's rectangle (a clip that opens), its words glide from where the bubble had them, and the
// row under them (attach, model, send) fades in once the words are in place. Leaving runs it backwards, faster.
import { MOTION, reduced } from '../../ui/motion';

/** Where your message's bubble sat, relative to the column it's in (so a scroll in between doesn't matter). */
export interface Shape {
  x: number; y: number; w: number; h: number;   // the bubble
  tx: number; ty: number; tw: number; th: number;   // its words: where they start, how wide, how much of them shows
  lines: number; col: number; plain: boolean; shut: boolean; ghost: HTMLElement | null;
}

const LINE = 21.7;   // 14px/1.55: one line of a message, in the bubble and the box alike
const rel = (r: DOMRect, p: DOMRect) => ({ x: r.left - p.left, y: r.top - p.top });

/** Measure the bubble of message `id` before it's swapped for the edit box. */
export function bubbleShape(root: Element | null | undefined, id: string): Shape | null {
  const u = root?.querySelector<HTMLElement>(`.m-user[data-ev="${CSS.escape(id)}"]`), col = u?.parentElement;
  if (!u || !col) return null;
  const p = col.getBoundingClientRect(), b = u.getBoundingClientRect(), mt = u.querySelector<HTMLElement>('.mt'), clip = u.querySelector('.m-clip');
  const t = mt?.getBoundingClientRect() ?? b, at = rel(b, p), tat = rel(t, p), shut = !!clip?.classList.contains('shut');
  const th = Math.min(t.bottom, clip?.getBoundingClientRect().bottom ?? t.bottom) - t.top;
  // paragraphs of plain words lay out the same in the box (a blank line between them in both); lists, quotes and code don't
  const plain = !!mt && [...mt.children].every(k => k.tagName === 'P');
  return { ...at, w: b.width, h: b.height, tx: tat.x, ty: tat.y, tw: t.width, th, lines: Math.round(t.height / LINE), col: p.width, plain, shut, ghost: mt ? mt.cloneNode(true) as HTMLElement : null };
}

interface Parts { comp: HTMLElement; taw: HTMLElement; rest: HTMLElement[]; p: DOMRect; c: DOMRect; t: DOMRect }
function parts(edit: HTMLElement): Parts | null {
  const comp = edit.querySelector<HTMLElement>('.comp'), taw = comp?.querySelector<HTMLElement>('.taw'), col = edit.parentElement;
  if (!comp || !taw || !col) return null;
  const rest = [...comp.querySelectorAll<HTMLElement>(':scope > .cf, :scope > .atts'), ...edit.querySelectorAll<HTMLElement>(':scope > .edit-note')];
  return { comp, taw, rest, p: col.getBoundingClientRect(), c: comp.getBoundingClientRect(), t: taw.getBoundingClientRect() };
}

/** The clip that shows only the bubble's rectangle of the box. */
function clipOf(s: Shape, q: Parts) {
  const c = rel(q.c, q.p), l = s.x - c.x, t = s.y - c.y;
  return `inset(${t}px ${q.c.width - l - s.w}px ${q.c.height - t - s.h}px ${l}px round 18px)`;
}

/** The bubble's words over the box, moving with the box's own and fading (only when the wider box rewraps them). */
function ghost(edit: HTMLElement, s: Shape, q: Parts): HTMLElement | null {
  // one line glides; so do several lines of plain words at the same width (a long message: the box is the bubble's width)
  const same = s.lines <= 1 || s.plain && Math.abs(q.t.width - s.tw) < 1;
  if (same || !s.ghost) return null;
  const g = document.createElement('div'); g.className = 'm-ghost'; g.setAttribute('aria-hidden', 'true'); g.appendChild(s.ghost.cloneNode(true));
  const e = rel(edit.getBoundingClientRect(), q.p);
  Object.assign(g.style, { left: `${s.tx - e.x}px`, top: `${s.ty - e.y}px`, width: `${s.tw}px`, height: `${s.th}px` });
  if (s.shut) g.classList.add('shut');
  edit.appendChild(g);
  return g;
}

/** Usable only while the column is the width it was when the bubble was measured. */
const fits = (s: Shape, q: Parts) => Math.abs(q.p.width - s.col) < 1;

/** Bubble → box. `frame` runs each frame while the height changes (to keep a chat stuck to its bottom). */
export function morphIn(edit: HTMLElement | null | undefined, s: Shape | null, frame?: () => void): Animation[] {
  const q = edit && s && !reduced() ? parts(edit) : null;
  if (!edit || !s || !q || !fits(s, q)) return [];
  const o = { duration: MOTION.slow, easing: MOTION.ease };
  const dx = s.tx - (q.t.left - q.p.left), dy = s.ty - (q.t.top - q.p.top), g = ghost(edit, s, q), full = edit.getBoundingClientRect().height;
  const as = [
    q.comp.animate([{ clipPath: clipOf(s, q), backgroundColor: 'var(--bubble)', borderColor: 'transparent' }, { clipPath: 'inset(0px 0px 0px 0px round 18px)' }], o),
    edit.animate([{ height: `${s.h}px` }, { height: `${full}px` }], o),
    q.taw.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: g ? 0 : 1 }, { transform: 'none', opacity: 1 }], o),
    ...q.rest.map(el => el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 0, offset: .3 }, { opacity: 1, transform: 'none' }], o)),
  ];
  if (g) as.push(g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate(${-dx}px, ${-dy}px)` }], { ...o, duration: MOTION.slow * .6, fill: 'forwards' }));
  follow(as, frame, () => g?.remove());
  return as;
}

/** Box → bubble. The caller unmounts the box when the first animation settles. */
export function morphOut(edit: HTMLElement | null | undefined, s: Shape | null, frame?: () => void): Animation[] {
  const q = edit && s && !reduced() ? parts(edit) : null;
  if (!edit || !s || !q || !fits(s, q)) return [];
  const o: KeyframeAnimationOptions = { duration: MOTION.base, easing: MOTION.ease, fill: 'forwards' };
  const dx = s.tx - (q.t.left - q.p.left), dy = s.ty - (q.t.top - q.p.top), g = ghost(edit, s, q), full = edit.getBoundingClientRect().height;
  edit.style.pointerEvents = 'none';
  const as = [
    q.comp.animate([{ clipPath: 'inset(0px 0px 0px 0px round 18px)' }, { clipPath: clipOf(s, q), backgroundColor: 'var(--bubble)', borderColor: 'transparent' }], o),
    edit.animate([{ height: `${full}px` }, { height: `${s.h}px` }], o),
    q.taw.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: g ? 0 : 1 }], o),
    ...q.rest.map(el => el.animate([{ opacity: 1 }, { opacity: 0 }], { ...o, duration: MOTION.base * .55 })),
  ];
  if (g) as.push(g.animate([{ opacity: 0, transform: `translate(${-dx}px, ${-dy}px)` }, { opacity: 1, transform: 'none' }], o));
  follow(as, frame);
  return as;
}

function follow(as: Animation[], frame?: () => void, done?: () => void) {
  let on = true;
  const tick = () => { if (!on) return; frame?.(); requestAnimationFrame(tick); };
  if (frame) requestAnimationFrame(tick);
  const end = () => { on = false; done?.(); };
  void Promise.all(as.map(a => a.finished)).then(end, end);
}
