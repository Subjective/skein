// Run every UI spec in Chromium against `pnpm dev:web` (the fake API). Starts the server if nothing answers.
// Usage: pnpm test:ui [name-filter]     e.g. pnpm test:ui changes   (matches test names and spec files)
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { URL, _setBrowser, _setFile, _tests, page } from './harness.mjs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

async function up() { try { await fetch(URL); return true; } catch { return false; } }
let server = null;
if (!(await up())) {
  server = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['dev:web'], { stdio: 'ignore', shell: process.platform === 'win32', detached: process.platform !== 'win32' });
  for (let i = 0; i < 120 && !(await up()); i++) await new Promise(r => setTimeout(r, 500));
  if (!(await up())) { console.error('dev:web did not start on :5199'); process.exit(1); }
}

for (const f of readdirSync(here).filter(f => f.endsWith('.spec.mjs')).sort()) {
  _setFile(f.replace('.spec.mjs', ''));
  await import(pathToFileURL(join(here, f)).href);
}

const browser = await chromium.launch();
_setBrowser(browser);
const shots = join(here, 'failures');
rmSync(shots, { recursive: true, force: true });
let failed = 0, ran = 0, file = '';
for (const t of _tests()) {
  if (only && !only.test(t.name) && !only.test(t.file)) continue;
  if (t.file !== file) { file = t.file; console.log(`\n${file}`); }
  ran++;
  const p = await page(t);
  const t0 = Date.now();
  try {
    await t.fn(p);
    assert.deepEqual(p.errors, [], 'no page errors');
    console.log(`  ✓ ${t.name} \x1b[2m${Date.now() - t0}ms\x1b[0m`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${t.name}\n      ${String(e.message).split('\n').slice(0, 3).join('\n      ')}`);
    mkdirSync(shots, { recursive: true });
    await p.screenshot({ path: join(shots, `${t.file}-${t.name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
  }
  await p.close();
}
await browser.close();
if (server) { try { process.kill(-server.pid); } catch { server.kill(); } }
console.log(`\n${ran - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
