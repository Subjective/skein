// The queue: messages sent while a turn runs wait above the composer (views/chat/QueueTray). Every state and key.
import { assert, keys, mod, mode, settle, test } from './harness.mjs';

async function openChat(p, title) {
  await p.locator('#side').getByText(title, { exact: true }).first().click();
  const seg = p.locator('.pane.focus .tb .seg button[aria-label^="Chat"]');
  if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
  await p.waitForSelector('.pane.focus .chat .col[data-read] > *');
}
const composer = p => p.locator('.pane.focus .compw textarea').last();
const rows = p => p.locator('.pane.focus .qrow');
const texts = p => rows(p).locator('.qtext').allInnerTexts();
const cur = p => p.evaluate(() => [...document.querySelectorAll('.pane.focus .qrow')].findIndex(r => r.classList.contains('cur')));
const users = p => p.locator('.pane.focus .m-user').allInnerTexts();
/** The running sample thread (Claude) with three queued messages. */
async function queued(p, n = 3, title = 'Fix session-restore race') {
  await openChat(p, title);
  for (const m of ['alpha', 'bravo', 'charlie'].slice(0, n)) { await composer(p).fill(m); await composer(p).press('Enter'); await settle(p, 60); }
  await p.waitForFunction(n => document.querySelectorAll('.pane.focus .qrow').length === n, n);
}

await test('enter queues while a turn runs; nothing shows in the transcript yet; no tray when idle', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  assert.equal(await p.locator('.qtray').count(), 0);
  await queued(p);
  assert.deepEqual(await texts(p), ['alpha', 'bravo', 'charlie']);
  assert.ok(!(await users(p)).some(t => t.includes('alpha')));
  assert.equal(await composer(p).inputValue(), '');
  assert.equal(await p.locator('.qtray').getAttribute('aria-label'), '3 queued');
});

await test('mod-enter steers while a turn runs (into the transcript, not the queue)', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).fill('steer this');
  await composer(p).press(`${mod}+Enter`);
  await p.locator('.pane.focus .m-user', { hasText: 'steer this' }).waitFor();
  assert.equal(await rows(p).count(), 0);
});

await test('setting: enter steers and mod-enter queues', async p => {
  await openChat(p, 'Fix session-restore race');
  // the setting, through ⋯ > Turn off queueing (the same row as Settings, General)
  await composer(p).fill('first'); await composer(p).press('Enter');
  await rows(p).first().hover(); await rows(p).first().getByRole('button', { name: 'More' }).click();
  await p.locator('.menu').getByText('Turn off queueing').click();
  await p.waitForFunction(() => !document.querySelector('.menu'));
  await rows(p).first().hover(); await rows(p).first().getByRole('button', { name: 'Delete' }).click();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .qtray'));
  await composer(p).fill('now'); await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user', { hasText: 'now' }).waitFor();
  await composer(p).fill('later'); await composer(p).press(`${mod}+Enter`);
  await rows(p).first().waitFor();
  assert.deepEqual(await texts(p), ['later']);
});

await test('hover shows Steer, delete and more; the buttons work', async p => {
  await queued(p);
  const r = rows(p).nth(1);
  assert.equal(await r.locator('.qact').evaluate(el => getComputedStyle(el).opacity), '0');
  await r.hover(); await settle(p, 200);
  assert.equal(await r.locator('.qact').evaluate(el => getComputedStyle(el).opacity), '1');
  assert.equal((await r.locator('.qsteer').innerText()).trim(), 'Steer');
  await r.getByRole('button', { name: 'Delete' }).click();
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .qrow').length === 2);
  assert.deepEqual(await texts(p), ['alpha', 'charlie']);
  await rows(p).nth(1).hover(); await rows(p).nth(1).locator('.qsteer').click();
  await p.locator('.pane.focus .m-user', { hasText: 'charlie' }).waitFor();
  assert.deepEqual(await texts(p), ['alpha']);
});

await test('keys: k from the composer lands on the last row; j / k move; j past the end returns, k past the top reads', async p => {
  await queued(p);
  await composer(p).press('Escape');
  await keys(p, 'k');
  assert.equal(await cur(p), 2);
  assert.equal(await mode(p), 'NORMAL');
  assert.ok(await p.locator('.qtray.kb').count());
  await keys(p, 'k k');
  assert.equal(await cur(p), 0);
  await keys(p, 'G'); assert.equal(await cur(p), 2);
  await keys(p, 'g g'); assert.equal(await cur(p), 0);
  await keys(p, 'k');   // past the top: the reader
  assert.equal(await cur(p), -1);
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'reading the thread');
  await composer(p).click(); await composer(p).press('Escape'); await keys(p, 'k j');
  assert.equal(await cur(p), -1);
  assert.ok(await composer(p).evaluate(el => el === document.activeElement));
});

await test('keys: s steers, x deletes with Undo, dd deletes', async p => {
  await queued(p);
  await composer(p).press('Escape');
  await keys(p, 'k s');   // charlie
  await p.locator('.pane.focus .m-user', { hasText: 'charlie' }).waitFor();
  assert.deepEqual(await texts(p), ['alpha', 'bravo']);
  assert.equal(await cur(p), 1);   // the row under it has the keys now
  await keys(p, 'k x');   // alpha
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .qrow').length === 1);
  await p.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .qrow').length === 2);
  assert.deepEqual(await texts(p), ['alpha', 'bravo']);
  await composer(p).click(); await composer(p).press('Escape');
  await keys(p, 'k d d');
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .qrow').length === 1);
  assert.deepEqual(await texts(p), ['alpha']);
});

await test('keys: h / l ring the row buttons; enter presses the ringed one', async p => {
  await queued(p);
  await composer(p).press('Escape');
  await keys(p, 'k');
  assert.equal(await rows(p).nth(2).locator('.rng').getAttribute('class').then(c => c.includes('qsteer')), true);
  await keys(p, 'l');
  assert.equal(await rows(p).nth(2).locator('.rng').getAttribute('aria-label'), 'Delete');
  await keys(p, 'l l');
  assert.equal(await rows(p).nth(2).locator('.rng').getAttribute('aria-label'), 'More');
  await keys(p, 'h Enter');
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .qrow').length === 2);
  assert.deepEqual(await texts(p), ['alpha', 'bravo']);
});

await test('keys: K / J move a row; the cursor goes with it', async p => {
  await queued(p);
  await composer(p).press('Escape');
  await keys(p, 'k Shift+K');
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .qrow')[1]?.innerText.includes('charlie'));
  assert.deepEqual(await texts(p), ['alpha', 'charlie', 'bravo']);
  assert.equal(await cur(p), 1);
  await keys(p, 'Shift+J'); await settle(p);
  assert.deepEqual(await texts(p), ['alpha', 'bravo', 'charlie']);
  assert.equal(await cur(p), 2);
});

await test('edit in place: e, type, enter saves; esc twice keeps it; double-click edits too', async p => {
  await queued(p);
  await composer(p).press('Escape');
  await keys(p, 'k k e');
  assert.equal(await mode(p), 'INSERT');
  const f = p.locator('.pane.focus .qrow.editing textarea');
  assert.equal(await f.inputValue(), 'bravo');
  await p.keyboard.type(' two');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => [...document.querySelectorAll('.pane.focus .qtext')].some(x => x.textContent === 'bravo two'));
  assert.equal(await cur(p), 1);   // the row keeps the keys
  await keys(p, 'e');
  await p.keyboard.type(' nope');
  await keys(p, 'Escape Escape');
  assert.equal(await p.locator('.qrow.editing').count(), 0);
  assert.deepEqual(await texts(p), ['alpha', 'bravo two', 'charlie']);
  await rows(p).first().dblclick();
  await p.locator('.pane.focus .qrow.editing textarea').waitFor();
  await p.locator('.pane.focus .qrow.editing').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await p.locator('.qrow.editing').count(), 0);
});

await test('more menu: . opens it, esc gives the keys back to the row; Move to top, Edit, Turn off queueing', async p => {
  await queued(p);
  await composer(p).press('Escape');
  await keys(p, 'k .');
  const menu = p.locator('.menu');
  await menu.waitFor();
  const labels = await menu.innerText();
  for (const l of ['Edit message', 'Move to top', 'Open in side chat', 'Turn off queueing']) assert.ok(labels.includes(l), l);
  await keys(p, 'Escape');
  assert.equal(await cur(p), 2);
  await keys(p, '.');
  await menu.getByText('Move to top').click();
  await p.waitForFunction(() => document.querySelector('.pane.focus .qrow .qtext')?.textContent === 'charlie');
  assert.deepEqual(await texts(p), ['charlie', 'alpha', 'bravo']);
  await rows(p).nth(1).hover(); await rows(p).nth(1).getByRole('button', { name: 'More' }).click();
  await menu.getByText('Edit message').click();
  await p.locator('.pane.focus .qrow.editing textarea').waitFor();
  assert.equal(await p.locator('.pane.focus .qrow.editing textarea').inputValue(), 'alpha');
  await p.waitForFunction(() => document.querySelector('#status .vim')?.textContent === 'INSERT');
  await keys(p, 'Escape Escape');
  await p.waitForFunction(() => !document.querySelector('.qrow.editing'));
  await rows(p).nth(1).hover(); await rows(p).nth(1).getByRole('button', { name: 'More' }).click();
  await menu.getByText('Turn off queueing').click();
  await settle(p, 200);
  await composer(p).fill('steered'); await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user', { hasText: 'steered' }).waitFor();
});

await test('open in side chat: the message leaves the queue and is sent there', async p => {
  await queued(p, 1);
  await rows(p).first().hover(); await rows(p).first().getByRole('button', { name: 'More' }).click();
  await p.locator('.menu').getByText('Open in side chat').click();
  await p.locator('.m-user', { hasText: 'alpha' }).first().waitFor();
  await p.waitForFunction(() => !document.querySelector('.qtray'));
});

await test('drag a row by its grip to reorder', async p => {
  await queued(p);
  await rows(p).nth(2).dragTo(rows(p).nth(0));
  await p.waitForFunction(() => document.querySelector('.pane.focus .qrow .qtext')?.textContent === 'charlie');
  assert.deepEqual(await texts(p), ['charlie', 'alpha', 'bravo']);
});

await test('a stop pauses the queue: Resume (or r) starts the next; then it drains in order', async p => {
  await queued(p, 2);
  await composer(p).press('Escape');
  await keys(p, 'Escape Escape');
  const head = p.locator('.pane.focus .qhead');
  await head.waitFor();
  assert.ok((await head.innerText()).includes('Queue paused after stop'));
  assert.equal((await rows(p).first().locator('.qsteer').innerText()).trim(), 'Send now');
  await keys(p, 'k r');
  await p.locator('.pane.focus .m-user', { hasText: 'alpha' }).waitFor();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .qhead'));
  assert.deepEqual(await texts(p), ['bravo']);
  // alpha's turn ends, then bravo starts by itself
  await p.locator('.pane.focus .m-user', { hasText: 'bravo' }).waitFor({ timeout: 12000 });
  await p.waitForFunction(() => !document.querySelector('.pane.focus .qtray'));
});

await test('Codex: after a stop, an empty composer continues the turn (▶, enter): a Continued note, no message', async p => {
  await openChat(p, 'Refactor queue worker');
  const send = p.locator('.pane.focus .send');
  assert.equal(await send.getAttribute('aria-label'), 'Stop');
  await composer(p).press('Escape'); await keys(p, 'Escape Escape');
  await p.locator('.pane.focus .note-row', { hasText: 'Interrupted' }).waitFor();
  assert.equal(await send.getAttribute('aria-label'), 'Continue the stopped turn');
  assert.equal(await send.isDisabled(), false);
  await composer(p).click(); await composer(p).fill('x');
  assert.equal(await send.getAttribute('aria-label'), 'Send');   // typing makes it send again
  await composer(p).fill('');
  const before = (await users(p)).length;
  await composer(p).press('Enter');
  await p.locator('.pane.focus', { hasText: 'Continued' }).waitFor();
  assert.equal((await users(p)).length, before);
  await p.waitForFunction(() => document.querySelector('.pane.focus .send')?.getAttribute('aria-label') === 'Stop');
});

await test('Claude Code: no continue after a stop (send stays disabled); a new message resumes a paused queue', async p => {
  await queued(p, 1);
  await composer(p).press('Escape'); await keys(p, 'Escape Escape');
  await p.locator('.pane.focus .qhead').waitFor();
  const send = p.locator('.pane.focus .send');
  assert.equal(await send.getAttribute('aria-label'), 'Send');
  assert.ok(await send.isDisabled());
  await composer(p).click(); await composer(p).press('Enter'); await settle(p, 200);
  assert.ok(!(await p.locator('.pane.focus').innerText()).includes('Continued'));
  await composer(p).fill('go on'); await composer(p).press('Enter');
  await p.waitForFunction(() => !document.querySelector('.pane.focus .qhead'));
  await p.locator('.pane.focus .m-user', { hasText: 'alpha' }).waitFor({ timeout: 12000 });
});

await test('Codex: continue with a paused queue, and the queue goes on after the continued turn', async p => {
  await queued(p, 1, 'Refactor queue worker');
  await composer(p).press('Escape'); await keys(p, 'Escape Escape');
  await p.locator('.pane.focus .qhead').waitFor();
  await p.locator('.pane.focus .send').click();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .qhead'));
  await p.locator('.pane.focus .m-user', { hasText: 'alpha' }).waitFor({ timeout: 12000 });
  await p.waitForFunction(() => !document.querySelector('.pane.focus .qtray'));
});
