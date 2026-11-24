// Rubber-band at a scroll area's ends, all of it Chromium's own (scrollBounce, src/main). Chromium stretches
// an area only for a swipe that latches to it, and a swipe that starts at the very end (after a G, or while
// the last swipe's momentum still pins the area there) latches past it to the window instead, so nothing
// stretches. Chromium waits for a swipe's first wheel event to be answered before it latches, and it is the
// only cancellable one: at an end, cancel it, step a pixel back, and keep cancelling for the two frames it
// takes the new position to reach the compositor. Then the swipe latches here, reaches the end and stretches,
// held while the fingers rest. Nothing else touches the position: moving it while stretched cuts the stretch.

/** The nearest area that scrolls vertically, from the target up. */
function scroller(t: EventTarget | null): HTMLElement | null {
  for (let el = t instanceof Element ? t : null; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 2) continue;
    const o = getComputedStyle(el).overflowY;
    if (o === 'auto' || o === 'scroll') return el;
  }
  return null;
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
  document.addEventListener('wheel', e => {
    const now = performance.now();
    if (now - prevWheel > SWIPE_GAP_MS) { through = false; if (holdUntil === 0) holdUntil = -1; }
    prevWheel = now;
    dbg('wheel', e.deltaY.toFixed(1), e.cancelable ? 'begin' : '', `lag ${Math.round(now - e.timeStamp)}`, through ? '' : 'new');
    if (through) return;
    if (!e.cancelable || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { through = true; return; }
    const el = scroller(e.target);
    // not a terminal, a text box, or the ticks rail
    if (!el || el.closest('.xterm') || el instanceof HTMLTextAreaElement || el.matches('.ticks')) { through = true; return; }
    if (now < holdUntil) { e.preventDefault(); return; }
    const max = el.scrollHeight - el.clientHeight;
    const atTop = el.scrollTop < 0.5, atEnd = el.scrollTop > max - 0.5;
    if (holdUntil === -1 && (e.deltaY < 0 ? atTop : e.deltaY > 0 ? atEnd : atTop || atEnd)) {
      e.preventDefault();
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
