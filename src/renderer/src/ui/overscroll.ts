// Rubber-band at a scroll area's ends, all of it Chromium's own (scrollBounce, src/main). Chromium stretches
// an area only for a gesture that starts with room to scroll in it: one that starts at the very end chains
// past the area to the window, which doesn't scroll, so nothing moves. Resting a pixel short of each end
// keeps that room, so a pull at the end bounces natively: held while the fingers rest, momentum ignored.

/** The nearest area that scrolls vertically, from the target up. */
function scroller(t: EventTarget | null): HTMLElement | null {
  for (let el = t instanceof Element ? t : null; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 2) continue;
    const o = getComputedStyle(el).overflowY;
    if (o === 'auto' || o === 'scroll') return el;
  }
  return null;
}

/** Step a pixel back from whichever end the area rests at. */
function keepRoom(el: HTMLElement | null) {
  // not a terminal, a text box, or the ticks rail (its fades key on a scrollTop of 0)
  if (!el || el.closest('.xterm') || el instanceof HTMLTextAreaElement || el.matches('.ticks')) return;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 2) return;
  if (el.scrollTop < 1) el.scrollTop = 1;
  else if (el.scrollTop > max - 1) el.scrollTop = max - 1;
}

export function startOverscroll() {
  // The moment a scroll reaches an end (a swipe, its momentum, a key, the chat following new text), step back
  // off it. Waiting for the swipe or its bounce to finish left quick repeat swipes starting at the very end.
  document.addEventListener('scroll', e => keepRoom(e.target instanceof HTMLElement ? scroller(e.target) : null), { passive: true, capture: true });
  // an area that hasn't scrolled yet gets its room when the pointer comes over it, before any swipe
  document.addEventListener('pointerover', e => keepRoom(scroller(e.target)), { passive: true, capture: true });
}
