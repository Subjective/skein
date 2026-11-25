// The status bar's branch and place: a click or the leader opens the branch picker or the move menu above them.
import { assert, keys, mode, settle, test } from './harness.mjs';

async function openThread(p, title) {
  await p.locator('#side').getByText(title, { exact: true }).first().click();
  await settle(p, 400);
}
const branchBtn = p => p.locator('#status .sb-branch');
const locBtn = p => p.locator('#status button.sb-loc');
const menu = p => p.locator('.menu').last();
/** The menu sits above the control, starting at its left edge. */
async function above(p, ctl) {
  const a = await ctl.boundingBox(), m = await menu(p).boundingBox();
  assert.ok(m.y + m.height <= a.y + 1, `menu above the control (${m.y + m.height} <= ${a.y})`);
  assert.ok(Math.abs(m.x - a.x) < 2, `menu starts at the control (${m.x} vs ${a.x})`);
}

test('status bar: the branch opens the picker above it, marks the current branch and its uncommitted changes', async p => {
  await openThread(p, 'Add timestamps to chat rows');
  assert.equal(await branchBtn(p).innerText(), 'fix/restore-race');
  await branchBtn(p).click();
  await settle(p, 300);
  await above(p, branchBtn(p));
  assert.equal(await branchBtn(p).getAttribute('aria-expanded'), 'true');
  assert.equal(await p.locator('.menu input').getAttribute('placeholder'), 'Switch branch or name a new one');
  assert.equal(await mode(p), 'INSERT');
  const cur = menu(p).locator('.mi', { hasText: 'fix/restore-race' });
  assert.equal(await cur.locator('.bdot[aria-label="Uncommitted changes"]').count(), 1);
  assert.equal(await menu(p).locator('.mi', { hasText: /^main/ }).locator('.bdot').count(), 0);
  // pick main: the bar follows
  await menu(p).locator('.mi', { hasText: /^main/ }).click();
  await settle(p, 400);
  assert.equal(await p.locator('.menu').count(), 0);
  assert.equal(await branchBtn(p).innerText(), 'main');
  assert.match(await p.locator('.toast').innerText(), /On main/);
});

test('status bar: typing a new name creates the branch and switches to it', async p => {
  await openThread(p, 'Add timestamps to chat rows');
  await branchBtn(p).click();
  await settle(p, 300);
  await p.keyboard.type('feat/bar');
  await settle(p);
  assert.match(await menu(p).innerText(), /Create branch feat\/bar/);
  await keys(p, 'Enter');
  await settle(p, 400);
  assert.equal(await branchBtn(p).innerText(), 'feat/bar');
  assert.match(await p.locator('.toast').innerText(), /Created feat\/bar/);
});

test('status bar: leader g and :branch open the same picker; esc gives the keys back', async p => {
  await openThread(p, 'Add timestamps to chat rows');
  await keys(p, 'Escape');
  await keys(p, 'Control+Space g');
  await settle(p, 300);
  assert.equal(await p.locator('.menu.branches').count(), 1);
  await above(p, branchBtn(p));
  await keys(p, 'Escape Escape');
  assert.equal(await p.locator('.menu').count(), 0);
  assert.equal(await mode(p), 'NORMAL');
  // :branch name switches (or creates) without the menu
  await keys(p, ':');
  await p.keyboard.type('branch main');
  await keys(p, 'Enter');
  await settle(p, 400);
  assert.equal(await branchBtn(p).innerText(), 'main');
  await keys(p, ':');
  await p.keyboard.type('branch');
  await keys(p, 'Enter');
  await settle(p, 300);
  assert.equal(await p.locator('.menu.branches').count(), 1);
});

test('status bar: a folder outside a repository shows no branch', async p => {
  await openThread(p, 'Tidy PowerShell profile');
  assert.equal(await branchBtn(p).count(), 0);
  assert.match(await locBtn(p).innerText(), /This PC[\s\S]*~\/projects\/dotfiles/);
});

test('status bar: the machine and folder open the move menu above them, by click or leader m', async p => {
  await openThread(p, 'Add timestamps to chat rows');
  await locBtn(p).click();
  await settle(p, 300);
  assert.equal(await p.locator('.menu.move-to').count(), 1);
  await above(p, locBtn(p));
  assert.equal(await locBtn(p).getAttribute('aria-expanded'), 'true');
  await keys(p, 'Escape Escape');
  assert.equal(await p.locator('.menu').count(), 0);
  await keys(p, 'Control+Space m');
  await settle(p, 300);
  assert.equal(await p.locator('.menu.move-to').count(), 1);
  await above(p, locBtn(p));
  await p.keyboard.type('trade');
  await keys(p, 'Enter');
  await settle(p);
  assert.match(await p.locator('[role=dialog].mv .mv-route').innerText(), /To[\s\S]*linux[\s\S]*~\/repo\/trade-ticker/);
  await keys(p, 'Enter');
  await settle(p, 500);
  assert.match(await locBtn(p).innerText(), /linux[\s\S]*~\/repo\/trade-ticker/);
});

test('status bar: a tab with no thread has no move button, and leader m says why', async p => {
  // the app opens on a new-thread tab
  assert.equal(await locBtn(p).count(), 0);
  assert.equal(await p.locator('#status span.sb-loc').count(), 1);
  await p.locator('#status').click({ position: { x: 1000, y: 13 } });
  await keys(p, 'Control+Space m');
  await settle(p, 200);
  assert.equal(await p.locator('.menu').count(), 0);
  assert.match(await p.locator('.toast').innerText(), /Only a thread can move/);
});

test('status bar: hover, open and focus states in light and dark', async p => {
  await openThread(p, 'Add timestamps to chat rows');
  const bg = l => l.evaluate(el => getComputedStyle(el).backgroundColor);
  const token = (name) => p.evaluate(n => { const d = document.createElement('div'); d.style.background = `var(${n})`; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; }, name);
  for (const theme of ['dark', 'light']) {
    await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    await p.mouse.move(640, 300);
    await settle(p, 250);
    for (const b of [branchBtn(p), locBtn(p)]) {
      assert.equal(await bg(b), 'rgba(0, 0, 0, 0)', `${theme}: no fill at rest`);
      await b.hover(); await settle(p, 250);
      assert.equal(await bg(b), await token('--hover'), `${theme}: hover fill`);
      await b.click(); await settle(p, 300);
      assert.equal(await bg(b), await token('--active'), `${theme}: open fill`);
      await keys(p, 'Escape Escape');
      await p.mouse.move(640, 300); await settle(p, 250);
    }
    // keyboard focus shows the ring
    await branchBtn(p).focus();
    await p.keyboard.press('Shift'); // focus-visible needs a keyboard modality
    const ring = await branchBtn(p).evaluate(el => el.matches(':focus-visible') ? getComputedStyle(el).boxShadow : 'none');
    assert.match(ring, /inset/, `${theme}: focus ring, inside the clipped bar`);
    await branchBtn(p).evaluate(el => el.blur());
  }
});

// ---------- a new thread's branch chip ----------
const chip = p => p.locator('.pane.focus .newp .bchip');
async function launcherIn(p, q) {
  await p.locator('.newp .under .path').click(); await settle(p, 300);
  await p.keyboard.type(q); await settle(p, 200); await keys(p, 'Enter'); await settle(p, 500);
}

test('new thread: the branch chip shows the folder\'s branch, hides outside a repository, and the bar shows it too', async p => {
  await launcherIn(p, 'dotfiles');
  assert.equal(await chip(p).count(), 0);
  await launcherIn(p, 'skein');
  assert.match(await chip(p).innerText(), /fix\/restore-race/);
  assert.equal(await chip(p).locator('.bdot').count(), 1, 'uncommitted changes');
  assert.equal(await branchBtn(p).innerText(), 'fix/restore-race');
});

test('new thread: the chip opens the picker with New worktree; picking a branch switches the folder', async p => {
  await launcherIn(p, 'skein');
  await chip(p).click(); await settle(p, 300);
  assert.equal(await chip(p).getAttribute('aria-expanded'), 'true');
  const rows = await menu(p).locator('.mi').allInnerTexts();
  assert.match(rows[0], /New worktree/);
  await p.keyboard.type('main'); await settle(p);
  await keys(p, 'Enter'); await settle(p, 400);
  assert.match(await chip(p).innerText(), /^main/);
  assert.equal(await branchBtn(p).innerText(), 'main');
});

test('new thread: New worktree (also by leader g) starts the thread in a new worktree', async p => {
  await launcherIn(p, 'skein');
  await keys(p, 'Escape Control+Space g'); await settle(p, 300);
  assert.equal(await p.locator('.menu.branches').count(), 1);
  assert.match(await menu(p).locator('.mi').first().innerText(), /New worktree/);
  await keys(p, 'Escape g g Enter');   // NORMAL in the search, to the first row, pick
  await settle(p, 300);
  assert.match(await chip(p).innerText(), /New worktree[\s\S]*from fix\/restore-race/);
  assert.equal(await chip(p).evaluate(el => el.classList.contains('on')), true);
  // send: the thread lives in the worktree
  await p.locator('.pane.focus .newp .cm-content').click();
  await p.keyboard.type('try the worktree');
  await keys(p, 'Enter'); await settle(p, 600);
  const dir = await p.evaluate(() => { const s = window.__skein.S; return s.threads[0].dir; });
  assert.equal(dir, '~/.skein/worktrees/skein/a1b2c3');
});

test('new thread: the worktree row toggles off again', async p => {
  await launcherIn(p, 'skein');
  for (const on of [true, false]) {
    await chip(p).click(); await settle(p, 300);
    await menu(p).locator('.mi', { hasText: 'New worktree' }).click(); await settle(p, 300);
    assert.equal(await chip(p).evaluate(el => el.classList.contains('on')), on);
  }
});
