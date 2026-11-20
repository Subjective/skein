// The app shell: palette, file search, command line, tabs and panes, tab drag, workspaces, the sidebar.
import { assert, keys, mode, mod, page, settle, test } from './harness.mjs';

const panes = p => p.locator('.pane[data-pane]').count();
const tabsIn = p => p.$$eval('.pane[data-pane]', ps => ps.map(e => e.querySelectorAll('.tab').length));
const layers = p => p.evaluate(() => window.__skein.S.layers.length);
const ldr = (p, k) => keys(p, `Control+Space ${k}`);

test('palette opens in INSERT, filters, and esc esc closes it', async p => {
  await keys(p, `${mod}+k`);
  assert.equal(await layers(p), 1);
  assert.equal(await mode(p), 'INSERT');
  await p.keyboard.type('split');
  const list = await p.locator('.menu').first().innerText();
  assert.match(list, /Split right/);
  assert.doesNotMatch(list, /Workspaces|Settings/);
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL');
  await keys(p, 'Escape');
  assert.equal(await layers(p), 0);
});

test('palette runs an action: split right', async p => {
  await keys(p, `${mod}+k`);
  await p.keyboard.type('split right');
  await keys(p, 'Enter');
  assert.equal(await panes(p), 2);
});

test('file search ranks by file name and opens a file tab', async p => {
  await keys(p, `${mod}+p`);
  await settle(p, 300);
  assert.equal(await layers(p), 1);
  await p.keyboard.type('readme');
  const list = (await p.locator('.menu').first().innerText()).trim();
  assert.match(list.split('\n').find(l => l.trim() && !/Search files/.test(l)) || '', /README/i, list);
  await keys(p, 'Enter');
  await settle(p, 200);
  const kinds = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); const all = []; const walk = n => n.type === 'pane' ? all.push(...n.tabs.map(t => t.kind)) : (walk(n.a), walk(n.b)); walk(w.tree); return all; });
  assert.ok(kinds.includes('file'), kinds.join(','));
});

test('command line lists commands and runs one', async p => {
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await settle(p);
  assert.equal(await layers(p), 1);
  await p.keyboard.type('vsplit');
  await keys(p, 'Enter');
  assert.equal(await panes(p), 2);
});

test('leader keys: new tab, split, zoom, close', async p => {
  await ldr(p, 'c');
  assert.deepEqual(await tabsIn(p), [2]);
  await ldr(p, 'v');
  assert.equal(await panes(p), 2);
  await ldr(p, 'z');
  assert.equal(await panes(p), 1, 'zoom shows one pane');
  await ldr(p, 'z');
  assert.equal(await panes(p), 2);
  await ldr(p, 'q');
  assert.equal(await panes(p), 1);
});

test('keyboard sheet opens with ? and closes with esc', async p => {
  await keys(p, 'Escape');
  await p.keyboard.type('?');
  await settle(p);
  assert.equal(await layers(p), 1);
  assert.ok(await p.locator('text=Split right').first().isVisible());
  await keys(p, 'Escape');
  assert.equal(await layers(p), 0);
});

async function drag(p, from, to) {
  const a = await from.boundingBox();
  await p.mouse.move(a.x + 20, a.y + 10); await p.mouse.down();
  await p.mouse.move(a.x + 60, a.y + 60, { steps: 5 });
  await p.mouse.move(to.x, to.y, { steps: 10 });
  await p.mouse.up(); await settle(p, 250);
}

test('tab drag: edge splits, tab bar moves back, outside pops out', async p => {
  await ldr(p, 'c');
  const pane = await p.locator('.pane').first().boundingBox();
  await drag(p, p.locator('.pane .tab').first(), { x: pane.x + pane.width - 30, y: pane.y + pane.height / 2 });
  assert.deepEqual(await tabsIn(p), [1, 1]);
  const bar = await p.locator('.pane .tabs').first().boundingBox();
  await drag(p, p.locator('.pane').nth(1).locator('.tab').first(), { x: bar.x + bar.width - 10, y: bar.y + bar.height / 2 });
  assert.deepEqual(await tabsIn(p), [2]);
  await drag(p, p.locator('.pane .tab').first(), { x: 60, y: 400 });
  assert.equal(await p.locator('.peek').count(), 1);
});

test('workspaces: create, ctrl-tab back and forth', async p => {
  await ldr(p, 'v');
  await ldr(p, 'w');
  await p.keyboard.type('review');
  await keys(p, 'Enter');
  assert.equal(await panes(p), 1);
  await keys(p, 'Control+Tab');
  assert.equal(await panes(p), 2);
  await keys(p, 'Control+Tab');
  assert.equal(await panes(p), 1);
  assert.match(await p.locator('#status').innerText(), /review/);
});

test('sidebar: leader h focuses it, j moves, esc returns to the panes', async p => {
  await ldr(p, 'h');
  assert.equal(await p.evaluate(() => window.__skein.S.sideFocus), true);
  await keys(p, 'j j');
  assert.ok(await p.evaluate(() => window.__skein.S.sideCursor));
  await keys(p, 'Escape');
  assert.equal(await p.evaluate(() => window.__skein.S.sideFocus), false);
});

test('sidebar: enter on a thread opens it', async p => {
  await ldr(p, 'h');
  for (let i = 0; i < 12; i++) {
    const cur = await p.evaluate(() => window.__skein.S.sideCursor);
    if (cur && !cur.startsWith('fold:')) break;
    await keys(p, 'j');
  }
  const id = await p.evaluate(() => window.__skein.S.sideCursor);
  await keys(p, 'Enter');
  await settle(p, 300);
  const open = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); const all = []; const walk = n => n.type === 'pane' ? all.push(...n.tabs.map(t => t.thread)) : (walk(n.a), walk(n.b)); walk(w.tree); return all; });
  assert.ok(open.includes(id), `${id} not in ${open}`);
});
