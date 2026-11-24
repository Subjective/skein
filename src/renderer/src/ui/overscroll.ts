// Rubber-band at a scroll area's ends, all of it Chromium's own (scrollBounce, src/main). Chromium stretches
// an area only for a swipe that latches to it, and a swipe that starts at the very end (after a G, or while
// the last swipe's momentum still pins the area there) latches past it to the window instead, so nothing
// stretches. Chromium waits for a swipe's first wheel event to be answered before it latches, and it is the
// only cancellable one: at an end, cancel it, step a pixel back, and keep cancelling for the two frames it
// takes the new position to reach the compositor. Then the swipe latches here, reaches the end and stretches,
// held while the fingers rest. Nothing else touches the position: moving it while stretched cuts the stretch.
//
// One case Chromium can't do: a swipe that lands while the last one's momentum still runs. macOS doesn't end
// the old scroll first, so Chromium carries the new swipe on in it, and its bounce ignores finger movement in
// a scroll that is already springing back. Those swipes stay cancellable (their start was held), so Skein
// draws their stretch itself, with AppKit's resistance curve, and springs back when the fingers lift.

/** The nearest area that scrolls vertically, from the target up. */
function scroller(t: EventTarget | null): HTMLElement | null {
  for (let el = t instanceof Element ? t : null; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 2) continue;
    const o = getComputedStyle(el).overflowY;
    if (o === 'auto' || o === 'scroll') return el;
  }
  return null;
}

/** AppKit's rubber-band constant: stretch = (1 - 1 / (PULL * pulled / height + 1)) * height */
const PULL = 0.55;
/** With no wheel event for this long, the fingers have lifted (or rest, which the wheel can't tell apart) */
const LIFT_MS = 60;

type Band = { el: HTMLElement; dir: 1 | -1; pulled: number; peak: number; falling: number; prev: number; released?: boolean; timer?: ReturnType<typeof setTimeout> };

function stretch(b: Band) {
  const h = b.el.clientHeight, s = (1 - 1 / ((PULL * b.pulled) / h + 1)) * h;
  b.el.classList.remove('rb-back');
  b.el.classList.add('rb');
  b.el.style.setProperty('--rb', `${(-b.dir * s).toFixed(1)}px`);
}

function springBack(b: Band) {
  clearTimeout(b.timer);
  if (b.released) return;
  b.released = true;
  const el = b.el;
  el.classList.add('rb-back');
  el.style.removeProperty('--rb');
  el.addEventListener('transitionend', () => { if (!el.style.getPropertyValue('--rb')) el.classList.remove('rb', 'rb-back'); }, { once: true });
}

/** A pause between wheel events this long starts a new swipe (a swipe's own events, momentum included, come ~8 ms apart). */
const SWIPE_GAP_MS = 25;

// TEMP (overscroll debugging, PR #52): a trace of wheel and scroll events when the main process asks for it,
// buffered so logging doesn't slow the events it records
const trace: string[] = [];
let flush: ReturnType<typeof setTimeout> | undefined;
function dbg(...a: unknown[]) {
  if (!(window as unknown as { skeinDebugScroll?: boolean }).skeinDebugScroll) return;
  trace.push(['[scroll]', Math.round(performance.now()), ...a].join(' '));
  clearTimeout(flush);
  flush = setTimeout(() => { for (const l of trace.splice(0)) console.log(l); }, 300);
}

export function startOverscroll() {
  document.addEventListener('scroll', e => { const el = e.target instanceof HTMLElement ? e.target : null; if (el) dbg('scroll', el.className.split(' ')[0], `${el.scrollTop.toFixed(1)}/${el.scrollHeight - el.clientHeight}`); }, { passive: true, capture: true });

  let through = false;  // this swipe was left alone, or let through after its step back
  let holdUntil = -1;   // -1 not holding; Infinity holding; 0 the step back has landed
  let prevWheel = -Infinity;
  let streaming = false; // wheel events are still coming in one unbroken scroll (no end event yet)
  let band: Band | null = null;  // a swipe whose stretch Skein draws
  document.addEventListener('wheel', e => {
    const now = performance.now();
    const gap = now - prevWheel;
    const fresh = gap > SWIPE_GAP_MS;
    const carriedOn = streaming && gap < LIFT_MS;  // Chromium will carry this swipe on in the old scroll
    prevWheel = now;
    streaming = e.deltaX !== 0 || e.deltaY !== 0;  // a swipe's end (and its momentum's) comes with no delta
    if (fresh) { through = false; if (holdUntil === 0) holdUntil = -1; if (band) { springBack(band); band = null; } }
    dbg('wheel', e.deltaY.toFixed(1), e.cancelable ? 'begin' : '', `lag ${Math.round(now - e.timeStamp)}`, fresh ? 'new' : '', band ? 'band' : '');

    if (band) {
      if (!e.cancelable) { springBack(band); band = null; return; }
      const b = band, dy = Math.abs(e.deltaY);
      e.preventDefault();
      if (b.released) return;  // the rest of its momentum
      // momentum: the deltas only fall once the fingers lift; it doesn't stretch further, the band springs back
      b.falling = dy <= b.prev + 1 && dy < b.peak * 0.9 ? b.falling + 1 : 0;
      b.peak = Math.max(b.peak, dy);
      b.prev = dy;
      if (b.falling >= 3) { springBack(b); return; }
      b.pulled = Math.max(0, b.pulled + Math.sign(e.deltaY) * b.dir * dy);
      if (b.pulled === 0) { springBack(b); band = null; through = true; return; }  // pulled all the way back
      stretch(b);
      clearTimeout(b.timer);
      b.timer = setTimeout(() => springBack(b), LIFT_MS);
      return;
    }
    if (through) return;
    if (!e.cancelable || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { through = true; return; }
    const el = scroller(e.target);
    // not a terminal, a text box, or the ticks rail
    if (!el || el.closest('.xterm') || el instanceof HTMLTextAreaElement || el.matches('.ticks')) { through = true; return; }
    if (now < holdUntil) { e.preventDefault(); return; }
    const max = el.scrollHeight - el.clientHeight;
    const atTop = el.scrollTop < 0.5, atEnd = el.scrollTop > max - 0.5;
    const dir: 1 | -1 = e.deltaY < 0 ? -1 : 1;
    if (holdUntil === -1 && (e.deltaY < 0 ? atTop : e.deltaY > 0 ? atEnd : atTop || atEnd)) {
      e.preventDefault();
      if (fresh && carriedOn && e.deltaY !== 0) {
        // the native bounce can't take this one: draw it
        band = { el, dir, pulled: Math.abs(e.deltaY), peak: Math.abs(e.deltaY), falling: 0, prev: Math.abs(e.deltaY) };
        stretch(band);
        band.timer = setTimeout(() => band && springBack(band), LIFT_MS);
        dbg('band', el.className.split(' ')[0]);
        return;
      }
      el.scrollTop = atTop ? 1 : max - 1;
      holdUntil = Infinity;
      requestAnimationFrame(() => requestAnimationFrame(() => { holdUntil = 0; }));
      dbg('hold', el.className.split(' ')[0], el.scrollTop.toFixed(1));
      return;
    }
    holdUntil = -1;
    through = true;
  }, { passive: false, capture: true });
}
