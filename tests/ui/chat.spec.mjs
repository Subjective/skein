// Chat view: every interactive state.
import { assert, mod, mode, settle, test } from './harness.mjs';

/** Open a thread from the sidebar in its chat view. */
async function openChat(p, title) {
  await p.locator('#side').getByText(title, { exact: true }).first().click();
  const seg = p.locator('.pane.focus .tb .seg button[aria-label^="Chat"]');
  if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
  await p.waitForSelector('.pane.focus .chat .col[data-read] > *');
}
const composer = p => p.locator('.pane.focus .compw textarea');

await test('opens in INSERT with the composer focused', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await settle(p);
  assert.equal(await mode(p), 'INSERT');
  assert.ok(await composer(p).evaluate(el => el === document.activeElement));
});

await test('send: message, streamed reply, worked row; empty send is disabled', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  assert.ok(await p.locator('.pane.focus .send').isDisabled());
  await composer(p).fill('Also show seconds');
  await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user', { hasText: 'Also show seconds' }).waitFor();
  assert.equal(await composer(p).inputValue(), '');
  await p.locator('.pane.focus .live').waitFor();
  await p.locator('.pane.focus .m-asst', { hasText: 'browser preview' }).waitFor();
  await p.locator('.pane.focus .worked').last().waitFor();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .live'));
});

await test('/ menu: lists commands, filters, picks one in place', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('/co');
  const menu = p.locator('.composer-menu');
  await menu.waitFor();
  assert.ok((await menu.innerText()).includes('/compact'));
  await composer(p).press('Enter');
  assert.equal(await composer(p).inputValue(), '/compact ');
  assert.equal(await menu.count(), 0);
});

await test('/ anywhere: /model mid-message keeps the draft and opens the picker', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('fix this /mod');
  await p.locator('.composer-menu .mi.sel', { hasText: '/model' }).waitFor();
  await composer(p).press('Enter');
  await p.locator('.menu .mi', { hasText: 'Effort' }).waitFor();
  assert.equal((await composer(p).inputValue()).trim(), 'fix this');
  await p.keyboard.press('Escape');
});

await test('/ that matches nothing (a path) opens nothing', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('see /usr/bin');
  await settle(p);
  assert.equal(await p.locator('.composer-menu').count(), 0);
});

await test('@ files: lists the folder, a folder goes in, a file is inserted', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  // the thread's folder is the fake repo (dev/fakeRepo)
  await composer(p).pressSequentially('look at @REA');
  await p.locator('.composer-menu .mi', { hasText: 'README.md' }).waitFor();
  await composer(p).press('Enter');
  assert.equal(await composer(p).inputValue(), 'look at @README.md ');
  await composer(p).pressSequentially('and @ses');
  await p.locator('.composer-menu .mi', { hasText: 'sessions/' }).waitFor();
  await composer(p).press('Enter');
  assert.equal(await composer(p).inputValue(), 'look at @README.md and @sessions/');
});

await test('esc goes NORMAL, k reads the thread, j comes back', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).press('Escape');
  assert.equal(await mode(p), 'NORMAL');
  await p.keyboard.press('k');
  await settle(p);
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'reader is on');
  await p.keyboard.press('v');
  assert.equal(await mode(p), 'VISUAL');
  await p.keyboard.press('Escape');
  assert.equal(await mode(p), 'NORMAL');
  await p.keyboard.press('j');
  await settle(p);
  assert.equal(await p.locator('.pane.focus [data-read].rd').count(), 0);
  assert.ok(await composer(p).evaluate(el => el === document.activeElement));
});

await test('reader: gg from the composer goes to the top; y in VISUAL yanks, q leaves', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).press('Escape');
  await p.keyboard.press('g'); await p.keyboard.press('g');
  await settle(p);
  const top = await p.evaluate(() => document.querySelector('.pane.focus .thread').scrollTop);
  assert.ok(top < 50, `scrolled to top (${top})`);
  await p.keyboard.press('q');
  assert.ok(await composer(p).evaluate(el => el === document.activeElement));
});

await test('requests: 1 of 3, y allows the oldest, n denies the next, buttons answer the last', async p => {
  await openChat(p, 'Plan image paste over SSH');
  await p.locator('.pane.focus .appr .count', { hasText: '1 of 3' }).waitFor();
  await composer(p).press('Escape');
  await p.keyboard.press('y');
  await p.locator('.pane.focus .appr .count', { hasText: '1 of 2' }).waitFor();
  await p.locator('.pane.focus .tool', { hasText: 'pnpm build && pnpm shot composer' }).waitFor();
  await p.keyboard.press('n');
  await p.locator('.pane.focus .tool', { hasText: 'pnpm test ui/composer' }).waitFor();
  assert.equal(await p.locator('.pane.focus .appr .count').count(), 0, 'the last request shows no count');
  await p.locator('.pane.focus .appr .af .btn.primary', { hasText: 'Allow' }).click();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .appr'));
});

await test('edit and resend: click a message, esc cancels, enter rewinds and resends', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await p.locator('.pane.focus .m-user').first().click();
  const box = p.locator('.pane.focus .m-edit textarea');
  await box.waitFor();
  assert.equal(await box.inputValue(), 'Add a timestamp to each message in the Markdown export.');
  await box.press('Escape'); await box.press('Escape');
  await p.waitForFunction(() => !document.querySelector('.pane.focus .m-edit'));
  await p.locator('.pane.focus .m-user').first().click();
  await box.fill('Add a timestamp, with seconds.');
  await box.press('Enter');
  await p.locator('.pane.focus .m-user', { hasText: 'with seconds' }).waitFor();
  assert.equal(await p.locator('.pane.focus .m-user').count(), 1, 'the old message is gone');
  assert.equal(await p.locator('.pane.focus .tool', { hasText: 'export/markdown.ts' }).count(), 0, 'its reply is gone');
});

await test('edit from the reader: x on your message edits it in NORMAL', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await composer(p).press('Escape');
  await p.keyboard.press('k'); await p.keyboard.press('k'); await p.keyboard.press('k');
  await settle(p);
  await p.keyboard.press('0');
  await p.keyboard.press('x');
  const box = p.locator('.pane.focus .m-edit textarea');
  await box.waitFor();
  assert.equal(await box.inputValue(), 'y PowerShell profile takes two seconds to load. Trim it.');
  assert.equal(await mode(p), 'NORMAL');
});

await test('error row: Retry now retries the turn', async p => {
  await openChat(p, 'Bump lockfile to fix CI');
  const err = p.locator('.pane.focus .err-row', { hasText: 'Rate limit reached' });
  await err.waitFor();
  await err.getByRole('button', { name: 'Retry now' }).click();
  await p.locator('.pane.focus .err-row.info', { hasText: 'Retrying' }).waitFor();
  await p.locator('.pane.focus .m-asst', { hasText: 'browser preview' }).waitFor();
});

await test('mirror: terminal drives, Take back gives chat the composer', async p => {
  await openChat(p, 'Migrate ETL config to TOML');
  const bar = p.locator('.pane.focus .mirror');
  await bar.waitFor();
  assert.ok((await bar.innerText()).includes('driving this thread in its terminal'));
  assert.equal(await p.locator('.pane.focus .compw .comp').count(), 0);
  await bar.getByRole('button', { name: 'Take back' }).click();
  await p.locator('.pane.focus .compw .comp').waitFor();
});

await test('subagent: a row opens its popup in INSERT, ready to message it', async p => {
  await openChat(p, 'Fix session-restore race');
  await p.locator('.pane.focus .ag', { hasText: 'Test runner' }).click();
  const pop = p.locator('.peek.focus');
  await pop.waitFor();
  assert.ok((await pop.locator('.tb').innerText()).includes('Test runner'));
  assert.equal(await pop.locator('textarea').getAttribute('placeholder'), 'Message Test runner');
  await settle(p);
  assert.equal(await mode(p), 'INSERT');
  await pop.locator('textarea').pressSequentially('anything else?');
  await pop.locator('textarea').press('Enter');
  await pop.locator('.m-user', { hasText: 'anything else?' }).waitFor();
  await pop.locator('.m-asst', { hasText: 'Nothing else failed' }).waitFor();
});

await test('/subagents lists them; picking opens the popup', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).pressSequentially('/subagents');
  await composer(p).press('Enter');
  await p.locator('.menu .mi', { hasText: 'Explore' }).waitFor();
  await p.keyboard.press('Enter');
  await p.locator('.peek.focus .sub-h').waitFor();
});

await test('side chat: link opens it; Send to thread quotes the answer back', async p => {
  await openChat(p, 'Fix session-restore race');
  await p.locator('.pane.focus .sc-link', { hasText: 'Why not a mutex here?' }).click();
  const pop = p.locator('.peek.focus');
  await pop.locator('.sc-anchor').waitFor();
  assert.ok((await pop.locator('.sc-anchor').innerText()).includes('reads lastActive before'));
  await settle(p);
  assert.equal(await mode(p), 'INSERT');
  await pop.getByRole('button', { name: 'Send to thread' }).click();
  await settle(p);
  const v = await p.locator('.pane .compw textarea').first().inputValue();
  assert.ok(v.includes('A mutex only covers'), 'quote is in the thread composer');
  assert.equal(await p.locator('.pane .compw .bk .tok').count(), 1, 'drawn as a chip');
});

await test('/side starts a new side chat popup in INSERT', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('/side');
  await composer(p).press('Enter');
  const pop = p.locator('.peek.focus');
  await pop.waitFor();
  assert.equal(await pop.locator('textarea').getAttribute('placeholder'), 'Ask in this side chat');
});

await test('fork: the branch button opens a new thread with the history so far', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await p.locator('.pane.focus .m-acts').hover();
  await p.locator('.pane.focus .m-acts [aria-label="Fork into a new thread"]').click();
  await p.locator('.toast', { hasText: 'Forked' }).waitFor();
  await p.locator('.pane.focus .m-user', { hasText: 'Add a timestamp' }).waitFor();
});

await test('model and permission pickers change the chips', async p => {
  await openChat(p, 'Fix session-restore race');
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  await p.locator('.menu .mi', { hasText: 'Sonnet' }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'Sonnet' }).waitFor();
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  await p.locator('.menu .mi', { hasText: 'High' }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'High' }).waitFor();
  await p.locator('.pane.focus .cf .chip[title="Permissions"]').click();
  await p.locator('.menu .mi', { hasText: 'Plan mode' }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'Plan mode' }).waitFor();
});

await test('composer controls: j from the text walks the row, enter presses', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).press('Escape');
  await p.keyboard.press('j');
  await settle(p);
  assert.ok(await p.locator('.pane.focus .cf > .kcur').count(), 'a control is marked');
  await p.keyboard.press('l');
  assert.equal(await p.locator('.pane.focus .cf > .kcur').getAttribute('title'), 'Permissions');
  await p.keyboard.press('Enter');
  await p.locator('.menu .mi', { hasText: 'Read only' }).waitFor();
  await p.keyboard.press('Escape');
});

await test('images: attach shows a thumbnail, x removes it, it is sent', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await p.locator('.pane.focus .comp input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
  await p.locator('.pane.focus .atts .att img').waitFor();
  assert.ok(!(await p.locator('.pane.focus .send').isDisabled()), 'an image alone can be sent');
  await p.locator('.pane.focus .att [aria-label="Remove image"]').click();
  assert.equal(await p.locator('.pane.focus .atts').count(), 0);
  await p.locator('.pane.focus .comp input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
  await composer(p).fill('see this');
  await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user .m-img').waitFor();
});

await test('quote: a selection goes into the composer as a chip (mod-l)', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await p.evaluate(() => {
    const el = document.querySelector('.pane.focus .m-asst p').firstChild; const r = document.createRange();
    r.setStart(el, 0); r.setEnd(el, 20); getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await p.keyboard.press(`${mod}+l`);
  await settle(p);
  assert.equal(await p.locator('.pane.focus .compw .bk .tok').count(), 1);
  assert.equal(await mode(p), 'INSERT');
});

await test('quote toolbar: a mouse drag shows Add to Chat', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  const para = p.locator('.pane.focus .m-asst p').first();
  const b = await para.boundingBox();
  await p.mouse.move(b.x + 4, b.y + 8); await p.mouse.down(); await p.mouse.move(b.x + 160, b.y + 8, { steps: 6 }); await p.mouse.up();
  await p.locator('.seltb').waitFor();
  assert.equal(await mode(p), 'VISUAL');
  await p.locator('.seltb').getByRole('button', { name: 'Add to Chat' }).click();
  assert.equal(await p.locator('.pane.focus .compw .bk .tok').count(), 1);
});

await test('timeline ticks: one per message, hover previews, click scrolls', async p => {
  await openChat(p, 'Fix session-restore race');
  const ticks = p.locator('.pane.focus .ticks button');
  assert.equal(await ticks.count(), 2);
  await ticks.first().hover();
  const pop = p.locator('.pane.focus .tick-pop');
  await pop.waitFor();
  const t = await pop.innerText();
  assert.ok(t.includes('stale') && t.includes('restore path'), 'shows the message and the reply start');
  await ticks.first().click();
  await p.waitForFunction(() => document.querySelector('.pane.focus .thread').scrollTop < 60);
});

await test('stop interrupts a running turn', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill('go');
  await composer(p).press('Enter');
  await p.locator('.pane.focus .send.stop').click();
  await p.locator('.pane.focus .note-row', { hasText: 'Interrupted' }).waitFor();
});

await test('drafts survive switching threads', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill('half-written');
  await openChat(p, 'Tidy PowerShell profile');
  await openChat(p, 'Add timestamps to chat rows');
  assert.equal(await composer(p).inputValue(), 'half-written');
});
