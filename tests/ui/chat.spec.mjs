// Chat view: every interactive state.
import { assert, keys, mod, mode, settle, test } from './harness.mjs';

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
  assert.ok((await menu.innerText()).includes('Compact'));
  await composer(p).press('Enter');
  assert.equal(await composer(p).inputValue(), '/compact ');
  assert.equal(await menu.count(), 0);
});

await test('/ anywhere: /model mid-message keeps the draft and opens the picker', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('fix this /mod');
  await p.locator('.composer-menu .mi.sel', { hasText: 'Model' }).waitFor();
  await composer(p).press('Enter');
  await p.locator('.menu.model .eff').waitFor();
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

await test('reader: G goes to the last line and stays in the reader', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).press('Escape');
  await p.keyboard.press('g'); await p.keyboard.press('g');
  await settle(p);
  await p.keyboard.press('Shift+G');
  await settle(p, 300);
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'still reading');
  assert.equal(await mode(p), 'NORMAL');
  assert.ok(!(await composer(p).evaluate(el => el === document.activeElement)), 'the composer did not take the keys');
  const gap = await p.evaluate(() => { const s = document.querySelector('.pane.focus .thread'); return s.scrollHeight - s.scrollTop - s.clientHeight; });
  assert.ok(gap < 60, `scrolled to the last line (${gap})`);
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
  // the edit box animates in and takes the keys a frame later; on a loaded CI runner the first read can land before that
  await p.waitForFunction(() => document.querySelector('#status .vim')?.textContent === 'NORMAL' && document.activeElement?.closest('.m-edit'), null, { timeout: 2000 }).catch(() => {});
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

await test('/sidechats offers New side chat; it opens a side chat popup in INSERT', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('/sidech');
  await composer(p).press('Enter');
  await p.locator('.menu .mi', { hasText: 'New side chat' }).click();
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
  await p.locator('.menu.model .eff .et span', { hasText: 'High' }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'High' }).waitFor();
  await p.keyboard.press('Escape');
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

// ---------- mockup parity: pickers, / menu, context, quotes, images, the launcher ----------

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** Paste an image into a textarea, as a clipboard with only a file item (a Windows screenshot). */
const pasteImage = (loc, b64 = png.toString('base64')) => loc.evaluate((el, b) => {
  const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0)), dt = new DataTransfer();
  dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, b64);

await test('permission chip: one label, a 200px menu of plain modes with a check', async p => {
  await openChat(p, 'Fix session-restore race');
  const chip = p.locator('.pane.focus .cf .chip[title="Permissions"]');
  assert.equal(await chip.locator(':scope > span').count(), 1);
  assert.equal(await chip.locator(':scope > span.lbl').count(), 1, 'the label is the .lbl itself');
  await chip.click();
  const menu = p.locator('.menu').last();
  await menu.waitFor();
  assert.deepEqual(await menu.locator('.mi .ml').allInnerTexts(), ['Ask before edits', 'Accept edits', 'Plan mode']);
  assert.equal(await menu.locator('.mi .mic').count(), 0, 'no icons');
  assert.equal(await menu.locator('.mi .mh').count(), 0, 'no hints');
  assert.equal(await menu.locator('.mi.sel', { hasText: 'Accept edits' }).locator('.i-check').count(), 1);
  assert.equal(Math.round((await menu.boundingBox()).width), 200);
  await p.keyboard.press('Escape');
});

await test('model picker: search, harness marks, effort track, Ultracode', async p => {
  await openChat(p, 'Fix session-restore race');
  const chip = p.locator('.pane.focus .cf .chip[title="Model and effort"]');
  assert.equal((await chip.innerText()).replace(/\s+/g, ' ').trim(), 'Opus 5.5 Medium');
  await chip.click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  assert.equal(await menu.locator('.m-s input').getAttribute('placeholder'), 'Search models');
  assert.equal(await mode(p), 'INSERT', 'opens ready to type');
  assert.equal(await menu.locator('.mi .mic .i-claude').count(), 4, 'each row has its harness mark');
  assert.equal(await menu.locator('.mi.head').count(), 0, 'no headings');
  await p.keyboard.type('son');
  assert.deepEqual(await menu.locator('.mi .ml').allInnerTexts(), ['Sonnet 5.5', 'Ultracode']);
  await p.keyboard.press('ArrowRight');   // arrows step the effort while typing
  await p.waitForFunction(() => document.querySelector('.menu.model .eff .eh b')?.textContent === 'High');
  await p.keyboard.press('Escape');       // NORMAL: h / l step it, j / k pick
  await p.keyboard.press('h');
  await p.waitForFunction(() => document.querySelector('.menu.model .eff .eh b')?.textContent === 'Medium');
  // click a stop on the track
  const max = menu.locator('.eff .et span', { hasText: 'Max' });
  await max.click();
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]', { hasText: 'Max' }).waitFor();
  await menu.locator('.mi', { hasText: 'Ultracode' }).click();
  await menu.locator('.mi', { hasText: 'Ultracode' }).locator('.sw.on').waitFor();
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]', { hasText: 'Max · Ultracode' }).waitFor();
  await p.keyboard.press('Escape');
});

await test('model picker on a machine without the harness: dimmed rows and Install copies', async p => {
  await p.locator('#side').getByText('New thread').first().click();
  const T = p.locator('.pane.focus .newp textarea:visible');
  await T.waitFor();
  await p.locator('.pane.focus .newp .chip[title="Machine"]:visible').click();
  await p.locator('.menu .mi', { hasText: 'build-07' }).click();
  await p.locator('.pane.focus .newp .chip[title="Model and effort"]:visible').click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  assert.equal(await menu.locator('.mi.off', { hasText: 'not on build-07' }).count(), 4);
  assert.equal(await menu.locator('.mx .mgap').count(), 1, 'a gap between the harnesses');
  await menu.locator('.mi', { hasText: 'Install Claude Code on build-07' }).click();
  await p.locator('.toast', { hasText: 'Copied' }).waitFor();
});

await test('context ring opens the context popover', async p => {
  await openChat(p, 'Fix session-restore race');
  const ring = p.locator('.pane.focus .cf button[aria-label^="Context usage"]');
  await ring.click();
  const pop = p.locator('#context-usage');
  await pop.waitFor();
  const t = (await pop.innerText()).replace(/\s+/g, ' ');
  assert.match(t, /Context \d+%/);
  assert.match(t, /\d+% left · Opus 5\.5/);
  assert.equal(await pop.locator('.cu-bar').count(), 1);
  await p.keyboard.press('Escape');
  await pop.waitFor({ state: 'detached' });
});

await test('attach button says how to attach', async p => {
  await openChat(p, 'Fix session-restore race');
  assert.equal(await p.locator('.pane.focus .cf .ib').first().getAttribute('title'), 'Attach image · or paste one');
});

await test('/ menu: the mockup list with icons, thread commands, then Skills', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).pressSequentially('/');
  const menu = p.locator('.composer-menu');
  await menu.waitFor();
  const names = await menu.locator('.mi:not(.head) .ml').allInnerTexts();
  assert.deepEqual(names.slice(0, 4), ['Clear', 'Compact', 'Model', 'Plan']);
  assert.ok(names.indexOf('Side chats') > names.indexOf('Status') && names.indexOf('Subagents') === names.indexOf('Side chats') + 1);
  assert.equal(await menu.locator('.mi.head', { hasText: 'Skills' }).count(), 1);
  assert.ok(names.at(-1) === 'Security review');
  assert.equal(await menu.locator('.mi:not(.head)').first().locator('.i-compose').count(), 1, 'Clear has its icon');
  // ctrl-p moves the list (the popup's keys win over global file search)
  await p.keyboard.press('Control+n');
  assert.equal(await menu.locator('.mi.sel .ml').innerText(), 'Compact');
  await p.keyboard.press('Control+p');
  assert.equal(await menu.locator('.mi.sel .ml').innerText(), 'Clear');
  await settle(p);
  assert.equal(await p.locator('.menu.pal').count(), 0, 'file search did not open');
});

await test('quotes are one item: motions, the block cursor, x and backspace take them whole', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await p.evaluate(() => {
    const el = document.querySelector('.pane.focus .m-asst p').firstChild; const r = document.createRange();
    r.setStart(el, 0); r.setEnd(el, 20); getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await p.keyboard.press(`${mod}+l`);
  await settle(p);
  await p.keyboard.type('is wrong');
  const v = await composer(p).inputValue(), end = v.indexOf('⁣', 1) + 1;
  assert.ok(v.startsWith('⁣') && v.endsWith('is wrong'), 'the typing goes after the quote');
  const sel = () => composer(p).evaluate(t => [t.selectionStart, t.selectionEnd]);
  await keys(p, 'Escape 0');
  assert.deepEqual(await sel(), [0, end], 'the block covers the whole quote');
  await keys(p, 'l');
  assert.deepEqual(await sel(), [end, end + 1], 'l steps over it');
  await keys(p, 'h');
  assert.deepEqual(await sel(), [0, end]);
  await keys(p, 'x');
  assert.equal(await composer(p).inputValue(), ' is wrong');
  await keys(p, 'u A');
  for (let i = 0; i < 9; i++) await p.keyboard.press('ArrowLeft');
  assert.deepEqual(await sel(), [end, end]);
  await p.keyboard.press('ArrowLeft');
  assert.deepEqual(await sel(), [0, 0], 'left steps over it');
  await p.keyboard.press('ArrowRight');
  assert.deepEqual(await sel(), [end, end]);
  await p.keyboard.press('Backspace');
  assert.equal(await composer(p).inputValue(), ' is wrong', 'backspace deletes it whole');
});

await test('quotes stay linked: the source lights up, hover brightens it, x removes, a click goes there', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await p.evaluate(() => {
    const el = document.querySelector('.pane.focus .m-asst p').firstChild; const r = document.createRange();
    r.setStart(el, 0); r.setEnd(el, 20); getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await p.keyboard.press(`${mod}+l`);
  await settle(p);
  const hl = () => p.evaluate(() => [CSS.highlights.get('note')?.size ?? 0, CSS.highlights.get('note-hot')?.size ?? 0]);
  assert.deepEqual(await hl(), [1, 0], 'the quoted text is marked while the quote waits');
  const tok = await p.locator('.pane.focus .compw .bk .tok').boundingBox();
  await p.mouse.move(tok.x + tok.width / 2, tok.y + tok.height / 2);
  await p.locator('.tokx').waitFor();
  assert.deepEqual(await hl(), [0, 1], 'hovering it brightens its source');
  await p.mouse.move(tok.x + tok.width / 2, tok.y + tok.height / 2 + 1);
  await p.mouse.down(); await p.mouse.up();
  const [a, b] = await composer(p).evaluate(t => [t.selectionStart, t.selectionEnd]);
  assert.equal(a, b);
  const v = await composer(p).inputValue();
  assert.ok(a === 0 || a === v.indexOf('⁣', 1) + 1, 'the caret is never inside the quote');
  await p.locator('.tokx').hover();
  await p.locator('.tokx').click();
  assert.equal(await p.locator('.pane.focus .compw .bk .tok').count(), 0);
  await settle(p);
  assert.deepEqual(await hl(), [0, 0]);
});

await test('images open in the viewer: composer thumbnails and sent ones; esc or a click closes', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await pasteImage(composer(p));
  await p.locator('.pane.focus .atts .att img').click();
  await p.locator('.lightbox img').waitFor();
  await p.keyboard.press('Escape');
  await p.locator('.lightbox').waitFor({ state: 'detached' });
  assert.equal(await mode(p), 'INSERT', 'the composer has the keys again');
  await composer(p).fill('see');
  await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user .m-img').click();
  await p.locator('.lightbox').click();
  await p.locator('.lightbox').waitFor({ state: 'detached' });
});

await test('launcher: the chat composer, with / and @ menus, attach, paste, permission and branch chips', async p => {
  await p.locator('#side').getByText('New thread').first().click();
  const T = p.locator('.pane.focus .newp textarea:visible');
  await T.waitFor();
  const newp = p.locator('.pane.focus .newp:visible');
  assert.equal(await newp.locator('.cf .chip[title="Permissions"]').innerText(), 'Ask before edits');
  assert.equal(await newp.locator('.cf .ib[title^="Attach image"]').count(), 1);
  assert.equal(await newp.locator('.under .chip[title="Start in a new git worktree"]').innerText(), 'main');
  await T.pressSequentially('/');
  const menu = p.locator('.composer-menu');
  await menu.waitFor();
  assert.ok((await menu.innerText()).includes('Compact'));
  assert.equal(await menu.locator('.mi', { hasText: 'Side chats' }).count(), 0, 'no side chats before the thread exists');
  await p.keyboard.press('Backspace');
  await T.pressSequentially('@');
  await p.locator('.composer-menu .mi .i-folder, .composer-menu .mi .i-file').first().waitFor();
  await p.keyboard.press('Escape');
  await T.fill('');
  await pasteImage(T);
  await newp.locator('.atts .att img').waitFor();
  await newp.locator('.cf .chip[title="Permissions"]').click();
  await p.locator('.menu .mi', { hasText: 'Plan mode' }).click();
  await newp.locator('.cf .chip[title="Permissions"]', { hasText: 'Plan mode' }).waitFor();
});

await test('paste: an image on the clipboard attaches in an existing thread', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await pasteImage(composer(p));
  await p.locator('.pane.focus .atts .att img').waitFor();
});

await test('quote toolbar: a click elsewhere (transcript or sidebar) dismisses it', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  const drag = async () => {
    const b = await p.locator('.pane.focus .m-asst p').first().boundingBox();
    await p.mouse.move(b.x + 4, b.y + 8); await p.mouse.down(); await p.mouse.move(b.x + 160, b.y + 8, { steps: 6 }); await p.mouse.up();
    await p.locator('.seltb').waitFor();
  };
  await drag();
  const th = await p.locator('.pane.focus .thread').boundingBox();
  await p.mouse.click(th.x + th.width / 2, th.y + th.height - 20);
  await p.locator('.seltb').waitFor({ state: 'detached' });
  await drag();
  await p.locator('#side .s-h').first().click();
  await p.locator('.seltb').waitFor({ state: 'detached' });
});

// ---------- wave 2: quotes order, mouse selection, menus, links ----------

const selectIn = (p, i, a, b) => p.evaluate(([i, a, b]) => {
  const el = document.querySelectorAll('.pane.focus .m-asst p')[i].firstChild; const r = document.createRange();
  r.setStart(el, a); r.setEnd(el, b); getSelection().removeAllRanges(); getSelection().addRange(r);
}, [i, a, b]);

await test('quotes: a second Add to chat goes after the first, the caret after it', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await selectIn(p, 0, 0, 8);
  await p.keyboard.press(`${mod}+l`);
  await settle(p);
  await selectIn(p, 0, 10, 18);
  await p.keyboard.press(`${mod}+l`);
  await settle(p);
  const toks = p.locator('.pane.focus .compw .bk .tok');
  assert.equal(await toks.count(), 2);
  const [v, caret] = await composer(p).evaluate(el => [el.value, el.selectionStart]);
  const first = await p.evaluate(() => document.querySelectorAll('.pane.focus .m-asst p')[0].firstChild.textContent);
  assert.ok(v.indexOf(first.slice(0, 8)) < v.indexOf(first.slice(10, 18)), 'quotes keep their order');
  assert.ok(caret >= v.lastIndexOf('⁣'), 'the caret sits after the last quote');
});

await test('composer: a double-click selects a word in VISUAL', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill('hello brave world');
  await composer(p).dblclick();
  await settle(p);
  assert.equal(await mode(p), 'VISUAL');
});

await test('/ menu: Tab picks the highlighted command', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('/co');
  await p.locator('.composer-menu').waitFor();
  await p.keyboard.press('Tab');
  assert.equal(await composer(p).inputValue(), '/compact ');
});

await test('composer controls: a mouse click clears the keyboard mark', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).press('Escape');
  await p.keyboard.press('j');
  await settle(p);
  assert.ok(await p.locator('.pane.focus .cf > .kcur').count());
  await composer(p).click();
  await settle(p);
  assert.equal(await p.locator('.pane.focus .cf > .kcur').count(), 0);
});

await test('undo past the oldest change toasts', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).press('Escape');
  await p.keyboard.press('u');
  await p.locator('.toast', { hasText: 'Already at oldest change' }).waitFor();
});

await test('leader [ in a chat tab enters the reader', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).press('Escape');
  await keys(p, 'Control+Space [');
  await settle(p);
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'reader is on');
});

await test('composer controls: i goes back into the text at its end', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill('one two three');
  await composer(p).press('Escape');
  await p.keyboard.press('0');
  await p.keyboard.press('j');
  await settle(p);
  assert.ok(await p.locator('.pane.focus .cf > .kcur').count());
  await p.keyboard.press('i');
  await settle(p);
  assert.equal(await mode(p), 'INSERT');
  assert.equal(await composer(p).evaluate(el => el.selectionStart), 'one two three'.length);
});

// ---------- wave 3: clicks ----------

await test('a click on chrome while typing drops the composer to NORMAL; reader cursor cleared', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await composer(p).click();
  assert.equal(await mode(p), 'INSERT');
  await p.locator('#status').click({ position: { x: 300, y: 5 } });
  await settle(p);
  assert.equal(await mode(p), 'NORMAL');
  const b = await p.locator('.pane.focus .m-asst p').first().boundingBox();
  await p.mouse.click(b.x + 10, b.y + 8);
  await settle(p);
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'reader on');
  await p.locator('#status').click({ position: { x: 300, y: 5 } });
  await settle(p);
  assert.equal(await p.locator('.pane.focus [data-read].rd').count(), 0, 'reader cleared');
});

await test('double-click on blank space beside a line does nothing', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  const th = await p.locator('.pane.focus .thread').boundingBox();
  const b = await p.locator('.pane.focus .m-asst p').last().boundingBox();
  await p.mouse.dblclick(th.x + 6, b.y + b.height - 6);
  await settle(p);
  assert.equal(await p.locator('.seltb').count(), 0, 'no quote bar');
  assert.notEqual(await mode(p), 'VISUAL');
});

await test('double-click on your own message: edit box with the word in VISUAL; triple-click opens no menus', async p => {
  await openChat(p, 'Fix session-restore race');
  const word = async () => p.locator('.pane.focus .m-user', { hasText: 'Add a regression test too' }).evaluate(el => {
    const t = [...el.querySelectorAll('.mt *, .mt')].flatMap(e => [...e.childNodes]).find(n => n.nodeType === 3 && n.data.includes('regression'));
    const r = document.createRange(), i = t.data.indexOf('regression') + 3; r.setStart(t, i); r.setEnd(t, i + 1);
    const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  const at = await word();
  await p.mouse.dblclick(at.x, at.y);
  await p.locator('.pane.focus .m-edit').waitFor();
  await settle(p);
  assert.equal(await mode(p), 'VISUAL');
  assert.equal(await p.locator('.pane.focus .m-edit textarea').evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), 'regression');
  assert.equal(await p.locator('.menu').count(), 0);
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await settle(p);
  const at2 = await word();
  await p.mouse.move(at2.x, at2.y);
  for (const n of [1, 2, 3]) { await p.mouse.down({ clickCount: n }); await p.mouse.up({ clickCount: n }); }
  await settle(p);
  assert.equal(await p.locator('.menu').count(), 0, 'no model menu');
});

await test('esc esc leaves the composer unfocused; i types at the end', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill('abc def');
  await composer(p).press('Escape');
  await p.keyboard.press('0');
  await p.keyboard.press('Escape');
  await settle(p);
  assert.ok(!(await composer(p).evaluate(el => el === document.activeElement)), 'nothing focused');
  await p.keyboard.press('i');
  await settle(p);
  assert.equal(await mode(p), 'INSERT');
  assert.equal(await composer(p).evaluate(el => el.selectionStart), 7);
});

await test('launcher: j walks from the controls to the chips and the cards', async p => {
  await p.locator('#side').getByText('New thread').first().click();
  const T = p.locator('.pane.focus .newp textarea:visible');
  await T.waitFor();
  await T.press('Escape');
  await p.keyboard.press('j');
  await p.keyboard.press('j');
  await settle(p);
  assert.ok(await p.locator('.pane.focus .newp .under .kcur').count(), 'a chip is marked');
  await p.keyboard.press('j');
  await settle(p);
  assert.ok(await p.locator('.pane.focus .newp .cards .kcur').count(), 'a card is marked');
});
