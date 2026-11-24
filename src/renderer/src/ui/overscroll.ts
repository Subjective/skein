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
const dbgRoom = (el: HTMLElement) => { if ((window as unknown as { skeinDebugScroll?: boolean }).skeinDebugScroll) console.log('[scroll]', Math.round(performance.now()), 'room', el.className.split(' ')[0], el.scrollTop.toFixed(1)); };
function roomy(el: HTMLElement | null): el is HTMLElement {
  // not a terminal, a text box, or the ticks rail (its fades key on a scrollTop of 0)
  return !!el && !el.closest('.xterm') && !(el instanceof HTMLTextAreaElement) && !el.matches('.ticks') && el.scrollHeight - el.clientHeight > 2;
}
function keepRoom(el: HTMLElement | null) {
  if (!roomy(el)) return;
  const max = el.scrollHeight - el.clientHeight;
  if (el.scrollTop < 1) { el.scrollTop = 1; dbgRoom(el); }
  else if (el.scrollTop > max - 1) { el.scrollTop = max - 1; dbgRoom(el); }
}

/** A scroll this soon after a wheel event is the fingers' own; this long without one, the fingers have stopped. */
const WHEEL_DRIVEN_MS = 40;
const WHEEL_QUIET_MS = 80;
/** A pause between wheel events this long starts a new swipe (a swipe's own events come ~8 ms apart). */
const SWIPE_GAP_MS = 25;

export function startOverscroll() {
  // TEMP (overscroll debugging, PR #52): a trace of wheel and scroll events, when the main process asks for it
  const dbg = (...a: unknown[]) => { if ((window as unknown as { skeinDebugScroll?: boolean }).skeinDebugScroll) console.log('[scroll]', Math.round(performance.now()), ...a); };
  document.addEventListener('wheel', e => { const el = scroller(e.target); dbg('wheel', e.deltaY.toFixed(1), e.cancelable ? 'begin' : '', el ? `${el.scrollTop.toFixed(1)}/${el.scrollHeight - el.clientHeight}` : '-'); }, { passive: true, capture: true });
  document.addEventListener('scroll', e => { const el = e.target instanceof HTMLElement ? e.target : null; if (el) dbg('scroll', el.className.split(' ')[0], `${el.scrollTop.toFixed(1)}/${el.scrollHeight - el.clientHeight}`); }, { passive: true, capture: true });
  // Step back off an end the moment a scroll reaches it (momentum, a key, the chat following new text), so a
  // quick repeat swipe starts with room. But not while the fingers are moving: a pull at the end must reach
  // the end and stay there, or each wheel event spends the pixel and Chromium never sees an overscroll to
  // stretch. Once the fingers stop (the wheel goes quiet), the area gets its room back.
  let lastWheel = -Infinity;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener('wheel', e => {
    lastWheel = performance.now();
    const el = scroller(e.target);
    clearTimeout(quiet);
    quiet = setTimeout(() => keepRoom(el), WHEEL_QUIET_MS);
  }, { passive: true, capture: true });
  document.addEventListener('scroll', e => {
    if (performance.now() - lastWheel < WHEEL_DRIVEN_MS) return;
    keepRoom(e.target instanceof HTMLElement ? scroller(e.target) : null);
  }, { passive: true, capture: true });
  // A swipe that starts at an end (the area stayed there through the last swipe's stretch and momentum)
  // would chain past the area and never stretch. Chromium doesn't start a swipe's scroll until its first
  // wheel event is answered, and while we cancel them every event of the swipe stays cancellable: at an end,
  // cancel, step a pixel back, and keep cancelling for the two frames it takes the new position to reach the
  // compositor. Then let the swipe through and leave it alone, so it latches here, reaches the end, stretches.
  let holdUntil = -1;
  let through = false;  // this swipe has been let through
  let prevWheel = -Infinity;
  document.addEventListener('wheel', e => {
    const now = performance.now();
    // events of one swipe, momentum included, come a frame apart; a new swipe comes after a pause
    if (now - prevWheel > SWIPE_GAP_MS) { through = false; if (holdUntil === 0) holdUntil = -1; }
    prevWheel = now;
    if (through || !e.cancelable || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { through = true; return; }
    const el = scroller(e.target);
    if (!roomy(el)) { through = true; return; }
    if (now < holdUntil) { e.preventDefault(); return; }
    const max = el.scrollHeight - el.clientHeight;
    const atTop = el.scrollTop < 0.5, atEnd = el.scrollTop > max - 0.5;
    if (holdUntil === -1 && (e.deltaY < 0 ? atTop : e.deltaY > 0 ? atEnd : atTop || atEnd)) {
      e.preventDefault();
      keepRoom(el);
      holdUntil = Infinity;
      requestAnimationFrame(() => requestAnimationFrame(() => { holdUntil = 0; }));
      dbg('hold', el.className.split(' ')[0]);
      return;
    }
    holdUntil = -1;
    through = true;
  }, { passive: false, capture: true });
  // an area that hasn't scrolled yet gets its room when the pointer comes over it, before any swipe
  document.addEventListener('pointerover', e => keepRoom(scroller(e.target)), { passive: true, capture: true });
}
