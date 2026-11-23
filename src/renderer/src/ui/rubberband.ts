// Rubber-band pull at a scroll area's end. Chromium bounces a flick that runs into the end by itself
// (scrollBounce, src/main), but a trackpad gesture that starts at the end chains past the area and never
// stretches it. This fills that one case the way AppKit does: the content follows the fingers with strong
// resistance, momentum after the fingers lift never adds to it, and it springs back at once.

const GESTURE_GAP = 100;   // ms without a wheel event that ends a gesture (trackpads send one about every 16 ms)
const REACH = 160;         // px the stretch approaches but never reaches; a hard pull shows about 100
const PULL = 0.55;         // AppKit's rubber-band constant: stretch = (1 - 1 / (PULL * x / REACH + 1)) * REACH
const MOMENTUM = 3;        // shrinking deltas in a row: the fingers have lifted and this is inertia

type Band = { el: HTMLElement; dir: 1 | -1; pulled: number; timer: number };
let band: Band | null = null;
let last = 0;
let prev = 0;              // the last delta's size, to spot momentum
let shrinking = 0;
// whether this gesture may stretch: null until its first trackpad event, false once it is spent
let mayPull: boolean | null = null;

/** A notched mouse wheel: whole steps of 120 (macOS, Windows) never bounce, as in native apps. */
const isWheelNotch = (e: WheelEvent) => {
  const w = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 0;
  return e.deltaMode !== 0 || (w !== 0 && w % 120 === 0);
};

/** The nearest area that scrolls vertically, from the target up. */
function scroller(t: EventTarget | null): HTMLElement | null {
  for (let el = t instanceof Element ? t : null; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) continue;
    const o = getComputedStyle(el).overflowY;
    if (o === 'auto' || o === 'scroll') return el;
  }
  return null;
}

const atEnd = (el: HTMLElement, dir: 1 | -1) =>
  dir < 0 ? el.scrollTop <= 0 : el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

function stretch(b: Band) {
  const s = (1 - 1 / ((PULL * b.pulled) / REACH + 1)) * REACH;
  b.el.style.setProperty('--rb', `${(-b.dir * s).toFixed(1)}px`);
}

/** Spring back; the rest of this gesture (its momentum) leaves the content alone. */
function release() {
  if (!band) return;
  const el = band.el;
  clearTimeout(band.timer);
  el.classList.add('rb-back');
  el.style.removeProperty('--rb');
  el.addEventListener('transitionend', () => { if (band?.el !== el) el.classList.remove('rb', 'rb-back'); }, { once: true });
  band = null;
  mayPull = false;
}

function onWheel(e: WheelEvent) {
  if (e.timeStamp - last > GESTURE_GAP) { mayPull = null; prev = 0; shrinking = 0; }
  last = e.timeStamp;
  if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.ctrlKey || isWheelNotch(e)) return;
  const dir: 1 | -1 = e.deltaY > 0 ? 1 : -1, size = Math.abs(e.deltaY);
  shrinking = size < prev ? shrinking + 1 : 0;
  prev = size;
  if (band) {
    if (shrinking >= MOMENTUM) { release(); return; }
    // the fingers go on: pull further, or give back what was pulled when they turn around
    band.pulled = Math.max(0, band.pulled + dir * band.dir * size);
    clearTimeout(band.timer);
    if (band.pulled === 0) { band.el.style.removeProperty('--rb'); band.el.classList.remove('rb'); band = null; return; }
    stretch(band);
    band.timer = window.setTimeout(release, GESTURE_GAP);
    return;
  }
  // Only a gesture that begins at the end; Chromium handles one that scrolls into it.
  const el = scroller(e.target);
  mayPull ??= !!el && atEnd(el, dir);
  if (!mayPull || !el || !atEnd(el, dir) || el.closest('.xterm') || el instanceof HTMLTextAreaElement) return;
  el.classList.remove('rb-back');
  el.classList.add('rb');
  band = { el, dir, pulled: size, timer: window.setTimeout(release, GESTURE_GAP) };
  stretch(band);
}

export function startRubberBand() {
  document.addEventListener('wheel', onWheel, { passive: true, capture: true });
}
