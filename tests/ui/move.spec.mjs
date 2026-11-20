// Moving a thread to another folder or machine: m in the sidebar, dragging a row, and refusing a running thread.
import { assert, keys, settle, test } from './harness.mjs';

const layers = p => p.evaluate(() => window.__skein.S.layers.length);
const meta = (p, id) => p.evaluate(id => { const t = window.__skein.S.threads.find(x => x.id === id); return { machine: t.machine, dir: t.dir }; }, id);

/** Focus the sidebar and walk its cursor to a thread. */
async function cursorTo(p, id) {
  await keys(p, 'Control+Space h');
  for (let i = 0; i < 40; i++) {
    if (await p.evaluate(() => window.__skein.S.sideCursor) === id) return;
    await keys(p, 'j');
  }
  throw new Error(`sidebar cursor never reached ${id}`);
}

async function drag(p, from, to) {
  const a = await from.boundingBox(), b = await to.boundingBox();
  await p.mouse.move(a.x + 30, a.y + a.height / 2); await p.mouse.down();
  await p.mouse.move(a.x + 40, a.y + a.height / 2 + 12, { steps: 4 });
  await p.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 10 });
}

test('m on a thread picks a project on another machine, confirms the route, and moves it', async p => {
  await cursorTo(p, 't4');
  await keys(p, 'm');
  assert.equal(await layers(p), 1);
  const menu = await p.locator('.menu').first().innerText();
  assert.match(menu, /This PC/); assert.match(menu, /linux/); assert.match(menu, /Other folder/);
  await p.keyboard.type('trade');
  await keys(p, 'Enter');
  await settle(p);
  const dlg = p.locator('[role=dialog].mv');
  assert.equal(await dlg.count(), 1);
  const route = await dlg.locator('.mv-route').innerText();
  assert.match(route, /From[\s\S]*This PC[\s\S]*~\/projects\/dotfiles[\s\S]*To[\s\S]*linux[\s\S]*~\/repo\/trade-ticker/);
  await keys(p, 'Enter');
  await settle(p, 500);
  assert.deepEqual(await meta(p, 't4'), { machine: 'linux', dir: '~/repo/trade-ticker' });
  assert.equal(await layers(p), 0);
  assert.match(await p.locator('.toast').innerText(), /Moved to linux ~\/repo\/trade-ticker/);
  // the row now sits under linux > trade-ticker
  assert.equal(await p.locator('#side .s-d[data-machine=linux][data-dir="~/repo/trade-ticker"] + .project-threads .row[data-thread=t4]').count(), 1);
});

test('m then Other folder walks the folder menu, and esc cancels the dialog', async p => {
  await cursorTo(p, 't3');
  await keys(p, 'm');
  await p.keyboard.type('other');
  await keys(p, 'ArrowDown');  // the This PC entry comes first; the second is linux's
  await keys(p, 'Enter');
  await settle(p, 200);
  assert.match(await p.locator('.menu input').getAttribute('placeholder'), /Folder on linux/);
  await keys(p, 'Enter'); // "Use this folder"
  await settle(p);
  assert.equal(await p.locator('[role=dialog].mv').count(), 1);
  await keys(p, 'Escape');
  assert.equal(await layers(p), 0);
  assert.deepEqual(await meta(p, 't3'), { machine: 'local', dir: '~/projects/skein' });
});

test('dragging a thread onto a project marks it and moves the thread there', async p => {
  const row = p.locator('#side .row[data-thread=t4]');
  const target = p.locator('#side .s-d[data-machine=local][data-dir="~/projects/skein"]');
  await drag(p, row, target);
  assert.equal(await row.evaluate(e => e.classList.contains('drag-source')), true);
  assert.equal(await target.evaluate(e => e.classList.contains('drop-into')), true);
  await p.mouse.up(); await settle(p, 200);
  assert.equal(await p.locator('#side .drop-into').count(), 0);
  assert.equal(await row.evaluate(e => e.classList.contains('drag-source')), false);
  const dlg = p.locator('[role=dialog].mv');
  assert.equal(await dlg.count(), 1);
  assert.match(await dlg.locator('.mv-route').innerText(), /~\/projects\/dotfiles[\s\S]*~\/projects\/skein/);
  await dlg.locator('button.primary').click();
  await settle(p, 500);
  assert.deepEqual(await meta(p, 't4'), { machine: 'local', dir: '~/projects/skein' });
  assert.equal(await p.locator('.toast').count(), 1);
  // the click that ended the drag did not open the thread
  const open = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); const all = []; const walk = n => n.type === 'pane' ? all.push(...n.tabs.map(t => t.thread)) : (walk(n.a), walk(n.b)); walk(w.tree); return all; });
  assert.ok(!open.includes('t4'), open.join(','));
});

test('dragging a thread onto a machine heading asks for the folder there', async p => {
  const row = p.locator('#side .row[data-thread=t3]');
  const head = p.locator('#side .s-h[data-machine=linux]');
  await drag(p, row, head);
  assert.equal(await head.evaluate(e => e.classList.contains('drop-into')), true);
  await p.mouse.up(); await settle(p, 250);
  assert.match(await p.locator('.menu input').getAttribute('placeholder'), /Folder on linux/);
  await keys(p, 'Enter');
  await settle(p);
  await p.locator('[role=dialog].mv button.primary').click();
  await settle(p, 500);
  assert.equal((await meta(p, 't3')).machine, 'linux');
});

test('a running thread is refused, with the reason', async p => {
  await cursorTo(p, 't1');
  await keys(p, 'm');
  await p.keyboard.type('dotfiles');
  await keys(p, 'Enter');
  await settle(p);
  const dlg = p.locator('[role=dialog].mv');
  assert.match(await dlg.locator('.mv-note').innerText(), /working.*turn ends/i);
  assert.equal(await dlg.locator('button.primary').isDisabled(), true);
  await keys(p, 'l Enter'); // l can't reach the disabled Move; enter presses Cancel
  await settle(p);
  assert.equal(await layers(p), 0);
  assert.deepEqual(await meta(p, 't1'), { machine: 'local', dir: '~/projects/skein' });
  // the same refusal comes from the API when asked directly
  const err = await p.evaluate(() => window.__skein.api.threads.move('t1', 'linux', '~/repo/etl-config').then(() => '', e => e.message));
  assert.match(err, /turn ends/);
});

test('a machine without the harness is refused, with the reason', async p => {
  const row = p.locator('#side .row[data-thread=t4]');
  await drag(p, row, p.locator('#side .s-h[data-machine=build]'));
  await p.mouse.up(); await settle(p, 250);
  const dlg = p.locator('[role=dialog].mv');
  assert.match(await dlg.locator('.mv-note').innerText(), /isn’t (connected|installed)/);
  assert.equal(await dlg.locator('button.primary').isDisabled(), true);
});
