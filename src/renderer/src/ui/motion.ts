// Motion tokens. CSS uses --ease (120ms); scripted animations use these so everything moves alike.
export const MOTION = { fast: 120, base: 160, slow: 220, ease: 'cubic-bezier(.2, .7, .2, 1)', out: 'ease-out' } as const;
export const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Animate an element unless the user asked for reduced motion. */
export function animate(el: Element | null | undefined, frames: Keyframe[], ms: number = MOTION.base) {
  if (!el || reduced()) return;
  el.animate(frames, { duration: ms, easing: MOTION.ease });
}
