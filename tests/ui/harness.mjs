// The UI test harness: one Chromium, one dev:web server, `test(name, fn)` registration and shared helpers.
// Specs (tests/ui/*.spec.mjs) register tests; run.mjs runs them. Each test gets a fresh page.
import assert from 'node:assert/strict';

export { assert };
export const URL = 'http://localhost:5199/';
export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const registry = [];
/** Register a test. Specs call this at the top level (awaiting it is harmless). */
export function test(name, fn, o = {}) { registry.push({ name, fn, file: current, ...o }); }
let current = '';
export const _setFile = f => { current = f; };
export const _tests = () => registry;

let browser = null;
export const _setBrowser = b => { browser = b; };

/** A fresh page on the app with page errors collected (a test fails on any). */
export async function page(o = {}) {
  const p = await browser.newPage({ viewport: o.viewport || { width: 1280, height: 800 } });
  p.setDefaultTimeout(o.timeout || 8000);
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') p.errors.push(m.text()); });
  // { os: 'mac' | 'win' } runs the app as on that OS (on a Mac cmd is mod), whatever this machine is
  if (o.os === 'mac' || o.os === 'win') await p.addInitScript(os => Object.defineProperty(Navigator.prototype, 'platform', { get: () => os }), o.os === 'mac' ? 'MacIntel' : 'Win32');
  await p.goto(URL);
  await p.waitForSelector('#side');
  return p;
}

export const settle = (p, ms = 120) => p.waitForTimeout(ms);
/** The Vim mode shown in the status bar. */
export const mode = p => p.locator('#status .vim').innerText();
/** Type keys one at a time, as a person would ('j', 'g g', 'Control+d' ...). Space-separated. */
export async function keys(p, seq) { for (const k of seq.split(' ')) { await p.keyboard.press(k); } await settle(p, 60); }
