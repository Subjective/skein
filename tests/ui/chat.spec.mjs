// Chat view: every interactive state.
import { assert, keys, mod, mode, settle, test, URL } from './harness.mjs';

/** Open a thread from the sidebar in its chat view. */
async function openChat(p, title) {
  await p.locator('#side').getByText(title, { exact: true }).first().click();
  const seg = p.locator('.pane.focus .tb .seg button[aria-label^="Chat"]');
  if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
  await p.waitForSelector('.pane.focus .chat .col[data-read] > *');
}
const composer = p => p.locator('.pane.focus .compw textarea');
/** Into the reader (esc, k) and open every fold (zR), for tests about the whole transcript's text. */
async function openAll(p) { await composer(p).press('Escape'); await keys(p, 'k z Shift+R'); await settle(p); }

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
  await p.keyboard.press('j');   // v from the reply's action row started on its last character; j is the row again
  await settle(p);
  assert.match(await p.locator('.pane.focus .rowcur').getAttribute('class'), /m-acts/);
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

await test('reader: k from the composer never scrolls; leader [ goes back to where the cursor was', async p => {
  await openChat(p, 'Fix session-restore race');
  const th = p.locator('.pane.focus .thread');
  const cur = () => p.evaluate(() => { const h = [...(CSS.highlights.get('vcur') || [])][0]; const s = document.querySelector('.pane.focus .thread').getBoundingClientRect(); const r = h ? h.getBoundingClientRect() : document.querySelector('.pane.focus .rowcur')?.getBoundingClientRect(); return r && { top: r.top - s.top, bottom: s.bottom - r.bottom }; });
  await openAll(p);
  await p.keyboard.press('g'); await p.keyboard.press('g'); await settle(p);
  await p.keyboard.press('q'); await settle(p);
  // the cursor it left (the top line) is still on screen: k goes back to it
  await p.keyboard.press('k'); await settle(p);
  assert.ok((await th.evaluate(e => e.scrollTop)) < 50, 'still at the top');
  assert.ok((await cur()).top < 80, 'on the line it left');
  await p.keyboard.press('q'); await settle(p);
  // scrolled away from it: k takes the bottom line on screen, and the transcript stays put
  const mid = await th.evaluate(e => { e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) / 2); return e.scrollTop; });
  await settle(p);
  await p.keyboard.press('k'); await settle(p, 300);
  assert.equal(await th.evaluate(e => e.scrollTop), mid, 'k did not scroll');
  const c = await cur();
  assert.ok(c && c.bottom >= 20 && c.bottom < 140, `on the bottom line on screen (${JSON.stringify(c)})`);
  await p.keyboard.press('q'); await settle(p);
  // leader [ goes back to that line, scrolling to it
  await th.evaluate(e => { e.scrollTop = 0; });
  await settle(p);
  await p.keyboard.press('Control+Space'); await p.keyboard.press('[');
  await settle(p, 300);
  assert.ok((await th.evaluate(e => e.scrollTop)) > 50, 'scrolled back to it');
  const d = await cur();
  assert.ok(d && d.top >= 0 && d.bottom >= 0, 'the cursor is on screen');
});

await test('requests: 1 of 3, y allows the oldest, n denies the next, buttons answer the last', async p => {
  await openChat(p, 'Plan image paste over SSH');
  await p.locator('.pane.focus .appr .count', { hasText: '1 of 3' }).waitFor();
  await composer(p).press('Escape');
  await p.keyboard.press('y');
  await p.locator('.pane.focus .appr .count', { hasText: '1 of 2' }).waitFor();
  await p.locator('.pane.focus .tool:not(.turn):not(.run)', { hasText: 'pnpm build && pnpm shot composer' }).last().waitFor();
  await p.keyboard.press('n');
  await p.locator('.pane.focus .tool:not(.turn):not(.run)', { hasText: 'pnpm test ui/composer' }).last().waitFor();
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
  // gg, not a count of k: how many lines the reply above takes depends on the fonts (Linux CI wraps it onto two)
  await p.keyboard.press('g'); await p.keyboard.press('g');
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

await test('edit from the reader and a double-click: the cursor lands on the same character in the Markdown source', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill('Intro line\n- **bold** item');
  await composer(p).press('Enter');
  const mine = p.locator('.pane.focus .m-user', { hasText: 'Intro line' });
  await mine.waitFor();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .live'));
  await composer(p).press('Escape');
  await p.keyboard.press('['); await p.keyboard.press('['); await settle(p);
  await p.keyboard.press('j'); await p.keyboard.press('0'); await settle(p);
  await p.keyboard.press('x');
  const box = p.locator('.pane.focus .m-edit textarea');
  await box.waitFor();
  await p.waitForFunction(() => document.querySelector('#status .vim')?.textContent === 'NORMAL' && document.activeElement?.closest('.m-edit'), null, { timeout: 2000 }).catch(() => {});
  assert.equal(await box.inputValue(), 'Intro line\n- **old** item', 'x took the b, past the bullet and the stars');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('.pane.focus .m-edit'));
  // a double-click on "item" selects that word in the edit box
  const li = mine.locator('li');
  const at = await li.evaluate(el => { const t = el.lastChild; const r = document.createRange(); const i = t.textContent.indexOf('item'); r.setStart(t, i + 1); r.setEnd(t, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await p.mouse.dblclick(at.x, at.y);
  await box.waitFor();
  await p.waitForFunction(() => document.querySelector('#status .vim')?.textContent === 'VISUAL', null, { timeout: 2000 }).catch(() => {});
  const [a, z] = await box.evaluate(el => [el.selectionStart, el.selectionEnd]);
  assert.equal('Intro line\n- **bold** item'.slice(a, z), 'item');
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

await test('subagent without follow-ups: its turns show, the composer is grayed out and says why', async p => {
  await openChat(p, 'Fix session-restore race');
  await p.locator('.pane.focus .ag', { hasText: 'Explore' }).click();
  const pop = p.locator('.peek.focus');
  await pop.locator('.m-asst', { hasText: 'Three callers' }).waitFor();
  const box = pop.locator('.comp.locked');
  await box.waitFor();
  assert.equal(await box.locator('textarea').getAttribute('placeholder'), "Follow-ups aren't available for this subagent");
  assert.ok(await box.locator('textarea').isDisabled(), 'nothing to type into');
  assert.ok(await box.locator('.send').isDisabled(), 'nothing to send');
  await settle(p);
  assert.equal(await mode(p), 'NORMAL', 'the popup reads instead of typing');
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

await test('/side starts a side chat at once; /sidechats still lists them', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  const before = await p.evaluate(() => window.__skein.S.threads.filter(t => t.side).length);
  await composer(p).pressSequentially('/side');
  await p.locator('.menu .mi', { hasText: 'Side chats' }).waitFor();
  await p.locator('.menu .mi', { hasText: 'New side chat about' }).click();
  const pop = p.locator('.peek.focus');
  await pop.waitFor();
  assert.equal(await pop.locator('textarea').getAttribute('placeholder'), 'Ask in this side chat');
  assert.equal(await p.evaluate(() => window.__skein.S.threads.filter(t => t.side).length), before + 1, 'one new side chat');
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
  await p.locator('.menu .mi', { hasText: 'Sonnet 5.5' }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'Sonnet 5.5' }).waitFor();
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  await p.locator('.menu.model .eff .et span').getByText('High', { exact: true }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'High' }).waitFor();
  await p.keyboard.press('Escape');
  await p.locator('.pane.focus .cf .chip[title="Permissions"]').click();
  await p.locator('.menu .mi', { hasText: 'Plan mode' }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'Plan mode' }).waitFor();
  // bypass is offered too (the SDK's bypassPermissions)
  await p.locator('.pane.focus .cf .chip[title="Permissions"]').click();
  await p.locator('.menu .mi', { hasText: 'Bypass permissions' }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'Bypass permissions' }).waitFor();
});

await test('Codex pickers: its approval presets and its models with their own effort levels', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await p.locator('.pane.focus .cf .chip[title="Permissions"]').click();
  const menu = p.locator('.menu').last();
  await menu.waitFor();
  assert.deepEqual(await menu.locator('.mi .ml').allInnerTexts(), ['Ask for approval', 'Approve for me', 'Full Access', 'Read Only'], 'Codex\'s /permissions menu, in its order');
  assert.equal(await menu.locator('.mi:has(.i-check) .ml').innerText(), 'Ask for approval', 'no mode set: Codex\'s workspace preset, you approving');
  await menu.locator('.mi', { hasText: 'Full Access' }).click();
  await p.locator('.pane.focus .cf .chip', { hasText: 'Full Access' }).waitFor();
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  const mm = p.locator('.menu.model');
  await mm.waitFor();
  assert.deepEqual(await mm.locator('.mi .ml').allInnerTexts(), ['GPT-6.2 Sol', 'GPT-6.2 Astra']);
  assert.deepEqual(await mm.locator('.eff .et span').allInnerTexts(), ['Low', 'Medium', 'High', 'X-High']);
  await mm.locator('.mi', { hasText: 'GPT-6.2 Astra' }).click();
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]', { hasText: 'GPT-6.2 Astra' }).waitFor();
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  assert.deepEqual(await p.locator('.menu.model .eff .et span').allInnerTexts(), ['Low', 'Medium', 'High']);
  assert.equal(await p.locator('.menu.model .mi', { hasText: 'Ultracode' }).count(), 0, 'no Ultracode for Codex');
  await p.keyboard.press('Escape');
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
  const gaps = await p.evaluate(() => { const bar = document.querySelector('.seltb').getBoundingClientRect(), [a, c] = [...document.querySelectorAll('.seltb .btn')].map(e => e.getBoundingClientRect()), i = document.querySelector('.seltb i').getBoundingClientRect();
    return [a.left - bar.left - 1, i.left - a.right, c.left - i.right, bar.right - 1 - c.right].map(Math.round); });
  assert.deepEqual(gaps, [3, 3, 3, 3], 'both buttons sit the same distance from the edges and the divider');
  await p.locator('.seltb').getByRole('button', { name: 'Add to Chat' }).click();
  assert.equal(await p.locator('.pane.focus .compw .bk .tok').count(), 1);
});

await test('folds: Compact shuts a finished turn under Worked for; zr Balanced, zr Detailed, zm back; zR / zM open and shut all', async p => {
  await openChat(p, 'Fix session-restore race');
  const st = () => p.evaluate(() => {
    const d = [...document.querySelectorAll('.pane.focus .reply')][0];
    const turn = d.querySelector('details.tool.turn'), runs = [...d.querySelectorAll('details.tool.run')];
    return { head: turn.querySelector(':scope > summary').innerText.trim(), turn: turn.open, runs: runs.map(r => r.open), edited: !!d.querySelector(':scope > .tool.edited'), steps: [...d.querySelectorAll('.run .fold-b > details.tool')].map(x => x.open) };
  });
  let s = await st();
  assert.match(s.head, /^Worked for \d/, 'the header is the duration');
  assert.ok(!s.turn && s.edited, 'Compact: shut, with the edited files below');
  assert.ok(!(await p.locator('.pane.focus .reply').first().innerText()).match(/tool calls|failed/), 'no counts in the header');
  await openAll(p); await keys(p, 'z Shift+M'); await settle(p);
  await keys(p, 'z r'); s = await st();
  assert.ok(s.turn && s.runs.every(o => !o) && !s.edited, `Balanced: open, runs shut (${JSON.stringify(s)})`);
  await keys(p, 'z r'); s = await st();
  assert.ok(s.turn && s.runs.every(o => o), 'Detailed: every run open');
  await keys(p, 'z m z m'); s = await st();
  assert.ok(!s.turn, 'zm zm: back to Compact');
  await keys(p, 'z Shift+R'); s = await st();
  assert.ok(s.turn && s.runs.every(o => o) && s.steps.every(o => o), 'zR opens every fold');
  await keys(p, 'z Shift+M'); s = await st();
  assert.ok(!s.turn, 'zM shuts them');
});

await test('folds: the Agent work setting sets the density for every thread', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).press('Escape');
  await p.keyboard.press(`${mod}+k`);
  await p.keyboard.type('Detailed');
  await p.keyboard.press('Enter');
  await settle(p);
  assert.ok(await p.locator('.pane.focus details.tool.turn').first().evaluate(d => d.open), 'Detailed: the finished turn is open');
  await p.keyboard.press(`${mod}+k`); await p.keyboard.type('Compact'); await p.keyboard.press('Enter'); await settle(p);
  assert.ok(!(await p.locator('.pane.focus details.tool.turn').first().evaluate(d => d.open)), 'Compact: shut again');
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

await test('timeline ticks: a long thread caps the rail to the pane; it scrolls, follows the message you read and fades its clipped ends', async p => {
  await openChat(p, 'Walk through the backlog');
  const rail = p.locator('.pane.focus .ticks');
  const m = () => rail.evaluate(el => {
    const r = el.getBoundingClientRect(), pane = el.closest('.pane').getBoundingClientRect(), on = el.querySelector('button.on').getBoundingClientRect();
    return { top: r.top - pane.top, bottom: pane.bottom - r.bottom, sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop, cls: el.className, onIn: on.top >= r.top && on.bottom <= r.bottom };
  });
  await settle(p, 300);
  let s = await m();
  assert.ok(s.sh > s.ch, 'the rail scrolls');
  assert.ok(s.top > 30 && s.bottom > 30, `the rail stays inside the pane (${s.top}, ${s.bottom})`);
  assert.ok(s.onIn, 'the tick of the message you read is in view');
  assert.match(s.cls, /fade-up/);
  // the wheel scrolls the rail
  const box = await rail.boundingBox();
  await p.mouse.move(box.x + 6, box.y + box.height / 2);
  await p.mouse.wheel(0, -2000); await settle(p, 300);
  s = await m();
  assert.equal(s.st, 0, 'wheeled to the top'); assert.doesNotMatch(s.cls, /fade-up/); assert.match(s.cls, /fade-down/);
  await p.mouse.move(box.x + 400, box.y);
  // reading at the end of the thread (G) brings the current tick back into view
  await composer(p).press('Escape');
  await p.keyboard.press('g'); await p.keyboard.press('g'); await p.keyboard.press('Shift+G'); await settle(p, 400);
  s = await m();
  assert.ok(s.onIn && s.st > 0, 'the rail followed the reader to the end');
});

await test('timeline ticks: the tick under the pointer is darkest and longest, its neighbours less; press and drag scrubs', async p => {
  await openChat(p, 'Fix session-restore race');
  const ticks = p.locator('.pane.focus .ticks button');
  const w = () => ticks.evaluateAll(bs => bs.map(b => Number(getComputedStyle(b).getPropertyValue('--w'))));
  await ticks.first().hover();
  await p.waitForTimeout(150);
  const [a, b] = await w();
  assert.ok(a > 0.9 && b > 0.2 && b < a, `falloff from the hovered tick: ${a} ${b}`);
  const th = p.locator('.pane.focus .thread');
  await th.evaluate(e => { e.scrollTop = e.scrollHeight; });
  const r0 = await ticks.last().boundingBox(), r1 = await ticks.first().boundingBox();
  await p.mouse.move(r0.x + 8, r0.y + r0.height / 2);
  await p.mouse.down();
  await p.mouse.move(r1.x + 8, r1.y + r1.height / 2, { steps: 4 });
  await p.waitForFunction(() => document.querySelector('.pane.focus .thread').scrollTop < 60);
  assert.ok(await p.evaluate(() => document.body.classList.contains('scrubbing')), 'scrubbing while held');
  await p.mouse.up();
  assert.ok(!(await p.evaluate(() => document.body.classList.contains('scrubbing'))));
  assert.ok((await th.evaluate(e => e.scrollTop)) < 60, 'release stays there');
});

await test('clicking an open popup\'s button again closes it (model, permissions), and it stays closed', async p => {
  await openChat(p, 'Fix session-restore race');
  for (const title of ['Model and effort', 'Permissions']) {
    const chip = p.locator(`.pane.focus .cf .chip[title="${title}"]`);
    await chip.click();
    await p.locator('.menu').first().waitFor();
    await chip.click();
    await p.waitForTimeout(250);
    assert.equal(await p.locator('.menu').count(), 0, `${title}: a second click closes it`);
    assert.equal(await chip.getAttribute('aria-expanded'), 'false');
    await chip.click();
    await p.locator('.menu').first().waitFor();   // and a third opens it again
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
    await p.waitForTimeout(150);
  }
});

await test('stop interrupts a running turn', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill('go');
  await composer(p).press('Enter');
  await p.locator('.pane.focus .send.stop').click();
  await p.locator('.pane.focus .note-row', { hasText: 'Interrupted' }).waitFor();
});

await test('esc esc stops a running turn: the first arms the stop button, the second stops', async p => {
  await openChat(p, 'Fix session-restore race');   // its turn is running
  const send = p.locator('.pane.focus .cf .send');
  await composer(p).press('Escape');                 // INSERT -> NORMAL only
  assert.equal(await mode(p), 'NORMAL');
  assert.equal(await send.getAttribute('aria-label'), 'Stop');
  await p.keyboard.press('Escape');                  // arms
  await p.locator('.pane.focus .cf .send.armed', { hasText: 'Esc' }).waitFor();
  assert.equal(await send.getAttribute('aria-label'), 'Press Esc again to stop');
  assert.equal(await p.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.pane.focus .comp')), true, 'still in the composer');
  await p.keyboard.press('Escape');                  // stops
  await p.locator('.pane.focus .note-row', { hasText: 'Interrupted' }).waitFor();
  assert.equal(await p.locator('.pane.focus .cf .send.armed').count(), 0);
});

await test('esc esc: after the 1.5 s window nothing stops, and the next esc leaves the composer', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).press('Escape');
  await p.keyboard.press('Escape');
  await p.locator('.pane.focus .cf .send.armed').waitFor();
  await p.waitForTimeout(1600);
  assert.equal(await p.locator('.pane.focus .cf .send.armed').count(), 0, 'the button went back');
  assert.equal(await p.locator('.pane.focus .cf .send').getAttribute('aria-label'), 'Stop');
  assert.equal(await p.locator('.pane.focus .note-row', { hasText: 'Interrupted' }).count(), 0, 'nothing stopped');
  await p.keyboard.press('Escape');                  // as before: out of the composer
  await settle(p);
  assert.equal(await p.locator('.pane.focus .cf .send.armed').count(), 0, 'not armed again');
  assert.equal(await p.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.pane.focus .comp')), false, 'left the composer');
  assert.equal(await p.locator('.pane.focus .note-row', { hasText: 'Interrupted' }).count(), 0);
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

await test('permission chip: one label, a 200px menu of every mode the harness has, with a check', async p => {
  await openChat(p, 'Fix session-restore race');
  const chip = p.locator('.pane.focus .cf .chip[title="Permissions"]');
  assert.equal(await chip.locator(':scope > span').count(), 1);
  assert.equal(await chip.locator(':scope > span.lbl').count(), 1, 'the label is the .lbl itself');
  await chip.click();
  const menu = p.locator('.menu').last();
  await menu.waitFor();
  // Claude Code's permission modes as the Agent SDK defines them, bypass included (fakeOptions)
  assert.deepEqual(await menu.locator('.mi .ml').allInnerTexts(), ['Default', 'Accept edits', 'Plan mode', 'Auto mode', "Don't ask", 'Bypass permissions']);
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
  // what the harness lists (fakeOptions: Claude Code 2.1.329's models), each with its harness mark
  assert.equal(await menu.locator('.mi .mic .i-claude').count(), 14, 'each row has its harness mark');
  assert.deepEqual((await menu.locator('.mi .ml').allInnerTexts()).slice(0, 6), ['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1']);
  assert.equal(await menu.locator('.mi:has(.i-check) .ml').allInnerTexts().then(x => x.join()), 'Opus 5.5', 'a check on the current model');
  assert.equal(await menu.locator('.mi.head').count(), 0, 'no headings');
  await p.keyboard.type('son');
  assert.deepEqual(await menu.locator('.mi .ml').allInnerTexts(), ['Sonnet 5.5', 'Sonnet 5', 'Sonnet 4.6', 'Ultracode']);
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

await test('model picker: a search with no model match selects nothing, says so, and enter does nothing', async p => {
  await openChat(p, 'Fix session-restore race');   // Claude: the picker has Ultracode
  const chip = p.locator('.pane.focus .cf .chip[title="Model and effort"]');
  const before = (await chip.innerText()).replace(/\s+/g, ' ').trim();
  await chip.click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  await p.keyboard.type('son');
  assert.equal(await menu.locator('.mi.sel .ml').innerText(), 'Sonnet 5.5', 'a real match is selected');
  await p.keyboard.type('zzz');
  await menu.locator('.m-empty', { hasText: 'No matching models' }).waitFor();
  assert.equal(await menu.locator('.mi.sel, .mx.sel').count(), 0, 'nothing selected');
  assert.equal(await menu.locator('.mi', { hasText: 'Ultracode' }).count(), 0, 'no Ultracode row');
  assert.equal(await menu.locator('.eff').count(), 0, 'no effort row');
  await p.keyboard.press('Enter');
  await settle(p);
  assert.equal(await menu.count(), 1, 'enter did nothing: the picker is still open');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.equal((await chip.innerText()).replace(/\s+/g, ' ').trim(), before, 'the model and Ultracode are unchanged');
});

await test('model picker: the effort track is a row j / k reach (wrapping), h / l set it, enter keeps the model', async p => {
  await openChat(p, 'Add timestamps to chat rows');   // Codex: two models, no Ultracode
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  await p.keyboard.press('Escape');                     // NORMAL
  const sel = () => menu.evaluate(m => { const s = m.querySelector('.mi.sel, .mx.sel'); return s?.classList.contains('mx') ? 'effort' : s?.querySelector('.ml')?.textContent; });
  const eff = () => menu.locator('.eff .eh b').innerText();
  assert.equal(await sel(), 'GPT-6.2 Sol');
  await keys(p, 'j'); assert.equal(await sel(), 'GPT-6.2 Astra');
  await keys(p, 'j'); assert.equal(await sel(), 'effort', 'j past the last model lands on the effort row');
  assert.ok(await menu.locator('.mx.sel').evaluate(e => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'it shows a highlight');
  await keys(p, 'l'); assert.equal(await eff(), 'High');
  await keys(p, 'h'); assert.equal(await eff(), 'Medium');
  await keys(p, 'j'); assert.equal(await sel(), 'GPT-6.2 Sol', 'j off the last row wraps to the top');
  await keys(p, 'k'); assert.equal(await sel(), 'effort', 'k from the top wraps to the effort row');
  await keys(p, 'l'); assert.equal(await eff(), 'High');
  await keys(p, 'k'); assert.equal(await sel(), 'GPT-6.2 Astra');
  // on a model that is not picked, h / l set the effort it would get; the picked one keeps its own
  await keys(p, 'h'); assert.equal(await eff(), 'Medium', 'h / l work from a model row too');
  await keys(p, 'j'); assert.equal(await sel(), 'effort');
  assert.equal(await eff(), 'High', 'back on the picked model, its own effort');
  await p.keyboard.press('Enter');
  await menu.waitFor({ state: 'detached' });
  const chip = (await p.locator('.pane.focus .cf .chip[title="Model and effort"]').innerText()).replace(/\s+/g, ' ').trim();
  assert.equal(chip, 'GPT-6.2 Sol High', 'enter on the effort row keeps the current model with the effort');
  // enter on a model row picks it with the current effort
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  await menu.waitFor();
  await p.keyboard.press('Escape');
  await keys(p, 'j');
  await p.keyboard.press('Enter');
  await menu.waitFor({ state: 'detached' });
  assert.equal((await p.locator('.pane.focus .cf .chip[title="Model and effort"]').innerText()).replace(/\s+/g, ' ').trim(), 'GPT-6.2 Astra High');
});

await test('model picker: the effort track shows the levels of the model under the cursor; picking snaps the effort', async p => {
  await p.locator('#side').getByText('New thread').first().click();
  await p.locator('.pane.focus .newp textarea:visible').waitFor();
  await p.locator('.pane.focus .newp .chip[title="Model and effort"]:visible').click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  await p.keyboard.press('Escape');                     // NORMAL
  const labels = () => menu.locator('.eff .et span').allInnerTexts();
  const eff = () => menu.locator('.eff .eh b').innerText();
  const sel = () => menu.evaluate(m => m.querySelector('.mi.sel .ml')?.textContent);
  assert.deepEqual(await labels(), ['Low', 'Medium', 'High', 'X-High', 'Max'], 'Claude: its five levels');
  for (let i = 0; i < 4; i++) await keys(p, 'l');
  assert.equal(await eff(), 'Max');
  while ((await sel()) !== 'GPT-6.2 Sol') await keys(p, 'j');
  assert.deepEqual(await labels(), ['Low', 'Medium', 'High', 'X-High'], 'a Codex model under the cursor: its levels');
  assert.equal(await eff(), 'X-High', 'Max is not one: the nearest it has');
  assert.ok(await menu.locator('.eff.pv').count(), 'shown as a preview');
  await keys(p, 'j');
  assert.deepEqual(await labels(), ['Low', 'Medium', 'High'], 'GPT-6.2 Astra');
  assert.equal(await eff(), 'High');
  await keys(p, 'k');
  await p.keyboard.press('Enter');
  await menu.waitFor({ state: 'detached' });
  const chip = (await p.locator('.pane.focus .newp .chip[title="Model and effort"]:visible').innerText()).replace(/\s+/g, ' ').trim();
  assert.equal(chip, 'GPT-6.2 Sol X-High');
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
  const claudeRows = await menu.locator('.mi:has(.i-claude)').count();
  assert.ok(claudeRows >= 5, 'the Claude models are listed');
  assert.equal(await menu.locator('.mi.off', { hasText: 'not on build-07' }).count(), claudeRows);
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
  assert.equal(t, 'Context 76k / 200k Auto-compacts at 167k', 'tokens and the compact point, no percent or model');
  assert.equal(await pop.locator('.cu-bar b').count(), 1, 'a tick at the compact point');
  // centered over the ring
  const r = await ring.boundingBox(), b = await pop.boundingBox();
  assert.ok(Math.abs((r.x + r.width / 2) - (b.x + b.width / 2)) < 1.5, 'centered over the ring');
  await p.keyboard.press('Escape');
  await pop.waitFor({ state: 'detached' });
});

await test('context fill: the bar and the ring turn amber, then red; Codex shows no compact point', async p => {
  for (const [pct, cls] of [[38, null], [78, 'warn'], [92, 'full']]) {
    await p.goto(URL + '?ctx=' + pct); await p.waitForSelector('#side');
    await openChat(p, 'Fix session-restore race');
    const ring = p.locator('.pane.focus .cf button[aria-label^="Context usage"]');
    assert.equal(await ring.locator('.ring').getAttribute('class'), cls ? 'ring ' + cls : 'ring', `${pct}%: ring`);
    await ring.click();
    assert.equal(await p.locator('#context-usage .cu-bar').getAttribute('class'), cls ? 'cu-bar ' + cls : 'cu-bar', `${pct}%: bar`);
    if (cls) {
      const c = await p.locator('#context-usage .cu-bar i').evaluate(e => getComputedStyle(e).backgroundColor);
      const want = await p.evaluate(v => { const d = document.createElement('i'); d.style.color = `var(${v})`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }, cls === 'warn' ? '--amber' : '--red');
      assert.equal(c, want, `${pct}%: fill color`);
    }
  }
  await p.keyboard.press('Escape');
  await openChat(p, 'Add timestamps to chat rows');
  await p.locator('.pane.focus .cf button[aria-label^="Context usage"]').click();
  assert.equal((await p.locator('#context-usage').innerText()).replace(/\s+/g, ' '), 'Context 238k / 258k');
  assert.equal(await p.locator('#context-usage .cu-bar b').count(), 0);
});

await test('attach button says how to attach', async p => {
  await openChat(p, 'Fix session-restore race');
  assert.equal(await p.locator('.pane.focus .cf .ib').first().getAttribute('title'), 'Attach image · or paste one');
});

await test('/ menu: the harness\'s commands with icons, thread commands, then its Skills (fakeOptions)', async p => {
  await openChat(p, 'Fix session-restore race');   // Claude, in ~/projects/skein
  await composer(p).pressSequentially('/');
  const menu = p.locator('.composer-menu');
  await menu.waitFor();
  await menu.locator('.mi', { hasText: 'Mockup parity' }).waitFor();   // the folder's project skill: the harness answered
  const names = await menu.locator('.mi:not(.head) .ml').allInnerTexts();
  // Claude Code's built-in commands (sorted), then the thread's own, then its custom skills under Skills
  assert.deepEqual(names.slice(0, 4), ['Clear', 'Code review', 'Compact', 'Config']);
  assert.ok(names.includes('Usage') && !names.includes('Plan'), 'the harness\'s list, not the bundled one');
  assert.ok(names.indexOf('Side chats') > names.indexOf('Usage') && names.indexOf('Subagents') === names.indexOf('Side chats') + 1);
  assert.equal(await menu.locator('.mi.head', { hasText: 'Skills' }).count(), 1);
  assert.deepEqual(names.slice(-2), ['Changelog', 'Mockup parity']);
  assert.equal(await menu.locator('.mi:not(.head)').first().locator('.i-compose').count(), 1, 'Clear has its icon');
  // ctrl-p moves the list (the popup's keys win over global file search)
  await p.keyboard.press('Control+n');
  assert.equal(await menu.locator('.mi.sel .ml').innerText(), 'Code review');
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
  assert.equal(await newp.locator('.cf .chip[title="Permissions"]').innerText(), 'Default');
  assert.equal(await newp.locator('.cf .ib[title^="Attach image"]').count(), 1);
  assert.equal(await newp.locator('.under .chip[title="Start in a new git worktree"]').innerText(), 'main');
  await T.pressSequentially('/');
  const menu = p.locator('.composer-menu');
  await menu.waitFor();
  assert.ok((await menu.innerText()).includes('Compact'));
  assert.equal(await menu.locator('.mi', { hasText: 'Side chats' }).count(), 0, 'no side chats before the thread exists');
  await p.keyboard.press('Backspace');
  await T.pressSequentially('@');
  await p.locator('.composer-menu .mi svg.fi').first().waitFor();
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

await test('/ menu on Codex: its commands and its skills, a skill goes in as $name', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('/');
  const menu = p.locator('.composer-menu');
  await menu.locator('.mi', { hasText: 'Release notes' }).waitFor();
  const names = await menu.locator('.mi:not(.head) .ml').allInnerTexts();
  assert.deepEqual(names.slice(0, 3), ['New', 'Compact', 'Model']);
  assert.deepEqual(names.slice(-2), ['Pdf', 'Release notes']);
  await composer(p).pressSequentially('rel');   // '/rel' finds $release-notes by its name
  assert.deepEqual(await menu.locator('.mi:not(.head) .ml').allInnerTexts(), ['Release notes']);
  await composer(p).press('Enter');
  assert.equal(await composer(p).inputValue(), '$release-notes ');
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

// ---- the reader: a reply's action row is a line; a selection is bounded by its message (KNOWN-52..54) ----
const cursorRow = p => p.evaluate(() => { const r = document.querySelector('.pane.focus .rowcur'); return r ? r.className : null; });
const ringed = p => p.evaluate(() => document.querySelector('.pane.focus .m-acts .kcur')?.getAttribute('aria-label') ?? null);

await test('reader: j lands on a reply\'s action row; l moves between its buttons; enter presses it', async p => {
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).press('Escape');
  await keys(p, 'g g');
  for (let i = 0; i < 8 && !(await cursorRow(p))?.includes('m-acts'); i++) await keys(p, 'j');
  assert.match(await cursorRow(p), /m-acts/, 'j reached the action row');
  assert.equal(await p.locator('.pane.focus .m-acts').evaluate(el => getComputedStyle(el).opacity), '1', 'the row shows while the cursor is on it');
  assert.equal(await ringed(p), 'Copy');
  await keys(p, 'l');
  assert.equal(await ringed(p), 'Fork into a new thread');
  await keys(p, 'h');
  assert.equal(await ringed(p), 'Copy');
  await keys(p, 'Enter');
  await p.locator('.toast', { hasText: 'Copied' }).waitFor();
  assert.match(await p.evaluate(() => navigator.clipboard.readText()), /HH:mm/);
  assert.match(await cursorRow(p), /m-acts/, 'copy keeps the cursor on the row');
  await keys(p, 'k');
  assert.equal(await ringed(p), null, 'leaving the row drops the ring');
});

await test('reader: enter on Fork in the action row forks', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).press('Escape');
  await keys(p, 'k');
  assert.match(await cursorRow(p), /m-acts/, 'k from the composer is the action row (the last line)');
  await keys(p, 'l Enter');
  await p.locator('.toast', { hasText: 'Forked' }).waitFor();
});

await test('reader: G goes to the last action row, gg to the top', async p => {
  await openChat(p, 'Profile slow orders query');
  await composer(p).press('Escape');
  await keys(p, 'g g');
  assert.equal(await cursorRow(p), null);
  await keys(p, 'Shift+G');
  assert.match(await cursorRow(p), /m-acts/);
  assert.ok(await p.evaluate(() => { const all = document.querySelectorAll('.pane.focus .m-acts'); return all[all.length - 1].classList.contains('rowcur'); }), 'the last one');
  await keys(p, 'g g');
  assert.equal(await cursorRow(p), null);
  assert.ok(await p.evaluate(() => document.querySelector('.pane.focus .thread').scrollTop) < 50);
});

await test('reader: VISUAL gg / G stay inside one reply and select across prose and code', async p => {
  await openChat(p, 'Profile slow orders query');
  await openAll(p);
  // the cursor into the first reply's prose, after the code block
  await p.locator('.pane.focus .m-asst', { hasText: 'Then run the plan again' }).getByText('Then run the plan again').click();
  await settle(p);
  await keys(p, 'v g g');
  assert.equal(await mode(p), 'VISUAL');
  let sel = await p.evaluate(() => getSelection().toString());
  assert.match(sel, /^Worked/, `starts at the reply's first line: ${sel.slice(0, 40)}`);
  assert.match(sel, /CREATE INDEX orders_account_created/, 'prose and code together');
  assert.ok(!sel.includes('orders-by-account'), 'not the message above');
  await keys(p, 'Shift+G');
  sel = await p.evaluate(() => getSelection().toString());
  assert.match(sel, /ready to review\.?$/, `ends at the reply's last character: ${sel.slice(-40)}`);
  assert.ok(!sel.includes('business hours'), 'not the next message');
  for (let i = 0; i < 4; i++) await keys(p, 'j');
  assert.ok(!(await p.evaluate(() => getSelection().toString())).includes('business hours'), 'j stops at the edge');
  await keys(p, 'Escape g g');
  assert.equal(await mode(p), 'NORMAL');
  assert.ok(await p.evaluate(() => document.querySelector('.pane.focus .thread').scrollTop) < 50, 'NORMAL gg is the whole conversation');
});

await test('reader: a mouse drag past a reply stops at its end, across a code block', async p => {
  await openChat(p, 'Profile slow orders query');
  const from = await p.locator('.pane.focus .m-asst', { hasText: 'sequential scan' }).boundingBox();
  const to = await p.locator('.pane.focus .m-user', { hasText: 'business hours' }).boundingBox();
  await p.mouse.move(from.x + 4, from.y + 6); await p.mouse.down();
  await p.mouse.move(to.x + 20, to.y + 10, { steps: 8 }); await p.mouse.up();
  await settle(p);
  const sel = await p.evaluate(() => getSelection().toString());
  assert.match(sel, /CREATE INDEX/);
  assert.ok(!sel.includes('business hours'), 'not into the next message');
});

// ---- V then y copies the Markdown behind the lines; v then y the text as shown (KNOWN-56) ----
const clip = p => p.evaluate(() => navigator.clipboard.readText());
async function readAt(p, text, position) {
  await p.locator('.pane.focus .m-asst').getByText(text, { exact: false }).first().click(position ? { position } : undefined);
  await settle(p);
}

await test('reader yank: V y on list items copies their bullets, numbers and emphasis', async p => {
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openChat(p, 'Profile slow orders query');
  await readAt(p, 'then on the primary');
  await keys(p, 'Shift+V k y');
  assert.equal((await clip(p)).trimEnd(), '- build it on a **replica** first\n- then on the primary');
  await readAt(p, 'drop the old one');
  await keys(p, 'Shift+V k y');
  assert.equal((await clip(p)).trimEnd(), '1. check the plan\n2. drop the old one');
  await readAt(p, 'it does not lock writes');
  await keys(p, 'Shift+V y');
  assert.equal((await clip(p)).trimEnd(), 'Yes, with `CONCURRENTLY` it does not lock writes ([docs](https://www.postgresql.org/docs/current/sql-createindex.html)):', 'inline code and the link as written');
});

await test('reader yank: V y in a code block copies it with its fences; v y copies the text as shown', async p => {
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openChat(p, 'Profile slow orders query');
  await readAt(p, 'CREATE INDEX orders_account_created', { x: 12, y: 12 });   // the code block's first line
  await keys(p, 'Shift+V j y');
  let got = (await clip(p)).trimEnd();
  assert.equal(got, '```sql\nCREATE INDEX orders_account_created\n  ON orders (account_id, created_at);\n```', JSON.stringify(got));
  // prose and code together keep the blank line between them
  await readAt(p, 'ON orders (account_id', { x: 40, y: 32 });   // its second line
  await keys(p, 'Shift+V j y');
  got = (await clip(p)).trimEnd();
  assert.equal(got, '```sql\n  ON orders (account_id, created_at);\n```\n\nThen run the plan again.', JSON.stringify(got));
  // charwise stays the rendered text
  await readAt(p, 'build it on a');
  await keys(p, '0 v $ y');
  got = await clip(p);
  assert.equal(got, 'build it on a replica first', JSON.stringify(got));
});

await test('edit box: a long message scrolls with the NORMAL cursor (j, G, gg), and the block cursor stays drawn', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await p.locator('.pane.focus .m-user').first().click();
  const box = p.locator('.pane.focus .m-edit textarea');
  await box.waitFor();
  await box.fill(Array.from({ length: 30 }, (_, i) => (i % 5 === 3 ? '' : `line ${i}`)).join('\n'));
  await box.press('Escape');
  // the cursor's line is inside the box: the selection (a character) or the drawn block (a line end, an empty line)
  const seen = () => box.evaluate(el => {
    const r = el.getBoundingClientRect(), hc = el.closest('.taw').querySelector('.hc i');
    if (hc) { const b = hc.getBoundingClientRect(); return b.top >= r.top - 1 && b.bottom <= r.bottom + 1; }
    const lh = parseFloat(getComputedStyle(el).lineHeight), line = el.value.slice(0, el.selectionStart).split('\n').length - 1;
    const y = 4 + line * lh - el.scrollTop;   // no line here wraps
    return y >= 0 && y + lh <= el.clientHeight + 1;
  });
  assert.ok(await box.evaluate(el => el.scrollHeight > el.clientHeight), 'the box scrolls');
  await keys(p, 'G');
  assert.ok(await box.evaluate(el => el.scrollTop > 0), 'G scrolled down');
  assert.ok(await seen(), 'G: cursor in view');
  await keys(p, 'g g');
  assert.equal(await box.evaluate(el => el.scrollTop), 0);
  for (let i = 0; i < 25; i++) { await p.keyboard.press('j'); assert.ok(await seen(), `j ${i + 1}: cursor in view`); }
  for (let i = 0; i < 25; i++) { await p.keyboard.press('k'); assert.ok(await seen(), `k ${i + 1}: cursor in view`); }
});

await test('a long link wraps inside your message bubble and inside a reply', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await composer(p).fill('see https://example.com/' + 'averyverylongsegment'.repeat(14) + ' please');
  await composer(p).press('Enter');
  const u = p.locator('.pane.focus .m-user', { hasText: 'please' });
  await u.waitFor();
  const fits = await u.evaluate(el => { const col = el.closest('[data-read]').getBoundingClientRect(), r = el.getBoundingClientRect(); return el.scrollWidth <= el.clientWidth && r.right <= col.right + 1; });
  assert.ok(fits, 'the bubble holds the link');
  assert.equal(await p.locator('.pane.focus .prose').first().evaluate(el => getComputedStyle(el).overflowWrap), 'anywhere');
});

await test('handoff: after chat sends, the terminal starts again and resumes (one writer at a time)', async p => {
  // the terminal drives: show it, so its TUI runs
  await p.locator('#side').getByText('Migrate ETL config to TOML', { exact: true }).first().click();
  await p.evaluate(() => { const a = window.__skein.api, spawn = a.pty.spawn; window.__spawns = []; a.pty.spawn = async s => { window.__spawns.push(s); return spawn(s); }; });
  const seg = v => p.locator(`.pane.focus .tb .seg button[aria-label^="${v}"]`);
  await seg('Terminal').click();
  await p.locator('.pane.focus .term-host .xterm').waitFor();
  await p.waitForFunction(() => window.__spawns.length === 1);
  // a look at chat and back keeps the same TUI
  await seg('Chat').click();
  await p.locator('.pane.focus .mirror').waitFor();
  await seg('Terminal').click();
  await p.locator('.pane.focus .term-host .xterm').waitFor();
  await settle(p, 200);
  assert.equal(await p.evaluate(() => window.__spawns.length), 1, 'no restart when chat sent nothing');
  // chat takes it back and sends: the TUI closes (no "exited" row), and showing the terminal starts it again
  await seg('Chat').click();
  await p.locator('.pane.focus .mirror').getByRole('button', { name: 'Take back' }).click();
  await composer(p).fill('Rename the env var too');
  await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user', { hasText: 'Rename the env var too' }).waitFor();
  await seg('Terminal').click();
  await p.waitForFunction(() => window.__spawns.length === 2);
  const [first, again] = await p.evaluate(() => window.__spawns);
  assert.equal(again.run.kind, 'claude');
  assert.equal(again.run.session, first.run.session, 'the same session, resumed');
  assert.equal(again.run.args, undefined, 'a first prompt is not sent again');
  assert.equal(await p.locator('.pane.focus .t-exit').count(), 0);
});

await test('send refused (the terminal is mid-turn): the message comes back to the composer, with the reason', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await p.evaluate(() => { window.__skein.api.chat.send = async () => { throw new Error("Error invoking remote method 'chat.send': Error: Claude Code is still running a turn in the terminal."); }; });
  await composer(p).fill('Also show seconds');
  await composer(p).press('Enter');
  await p.locator('.toast', { hasText: 'Claude Code is still running a turn in the terminal.' }).waitFor();
  assert.equal(await composer(p).inputValue(), 'Also show seconds');
});

await test('reader: gg scrolls the transcript all the way to the top, G all the way to the bottom', async p => {
  await openChat(p, 'Fix session-restore race');
  await openAll(p);
  const sc = () => p.locator('.pane.focus .thread').evaluate(t => ({ top: t.scrollTop, max: t.scrollHeight - t.clientHeight }));
  assert.ok((await sc()).max > 40, 'the thread scrolls');
  await keys(p, 'g g');
  assert.equal((await sc()).top, 0, 'gg: at the very top');
  await keys(p, 'G');
  const s = await sc();
  assert.ok(s.max - s.top <= 1, `G: at the very bottom (${s.top} of ${s.max})`);
});

await test('/ menu: sections when nothing is typed; one list with source tags while typing', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).pressSequentially('/');
  const menu = p.locator('.composer-menu');
  await menu.waitFor();
  const heads = await menu.locator('.mi.head').allInnerTexts();
  assert.deepEqual(heads.map(h => h.trim()), ['Claude Code', 'Skein', 'Skills']);
  await composer(p).pressSequentially('si');
  await p.waitForFunction(() => !document.querySelector('.composer-menu .mi.head'));
  assert.equal(await menu.locator('.mi', { hasText: 'Side chat' }).first().locator('.src').innerText(), 'Skein');
});

await test('your message keeps its line breaks and renders Markdown', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await composer(p).fill('first line\nsecond line\n\n- one\n- **two**\n\nsee `code` here');
  await composer(p).press('Enter');
  const u = p.locator('.pane.focus .m-user', { hasText: 'second line' });
  await u.waitFor();
  assert.equal(await u.locator('br').count(), 1, 'the single line break is kept');
  assert.equal(await u.locator('li').count(), 2);
  assert.equal(await u.locator('strong, b').first().innerText(), 'two');
  assert.equal(await u.locator('code').innerText(), 'code');
});

await test('a triple click selects the whole paragraph, not one wrapped line, and stops at its end', async p => {
  await p.setViewportSize({ width: 1000, height: 800 });
  await openChat(p, 'Fix session-restore race');
  await openAll(p);
  const para = p.locator('.pane.focus .m-asst p').filter({ hasText: 'The restore path reads lastActive' }).first();
  await para.scrollIntoViewIfNeeded();
  const r = await para.boundingBox();
  assert.ok(r.height > 30, 'the paragraph wraps');
  await p.mouse.click(r.x + 30, r.y + 8, { clickCount: 3 });
  await settle(p, 200);
  assert.equal(await mode(p), 'VISUAL');
  assert.equal(await p.evaluate(() => getSelection().toString()), await para.innerText());
});

await test('popups fit the window: the model picker of an edit box near the top opens below its button', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await p.locator('.pane.focus .m-user').first().click();
  await p.locator('.pane.focus .m-edit textarea').waitFor();
  const chip = p.locator('.pane.focus .m-edit .chip[title="Model and effort"]');
  const c = await chip.boundingBox();
  await chip.click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  const m = await menu.boundingBox();
  assert.ok(m.y >= c.y + c.height, `below the button (${m.y} vs ${c.y + c.height})`);
  assert.ok(m.y + m.height <= 800 && m.x >= 0 && m.x + m.width <= 1280, 'inside the window');
});

await test('the transcript fades out above the composer', async p => {
  await openChat(p, 'Fix session-restore race');
  assert.match(await p.locator('.pane.focus .chat > .thread').evaluate(t => getComputedStyle(t).maskImage || getComputedStyle(t).webkitMaskImage), /linear-gradient/);
});

await test('Markdown tables render as tables: alignment, formatting in cells, sideways scroll when wide', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  const wide = 'x'.repeat(30);
  await composer(p).fill(`before\n| Name | Count | Note |\n|:-----|------:|:----:|\n| **a** | 1 | \`code\` |\n| b \\| c | 22 | ${wide} ${wide} ${wide} ${wide} |\nafter`);
  await composer(p).press('Enter');
  const u = p.locator('.pane.focus .m-user', { hasText: 'after' });
  await u.waitFor();
  const t = u.locator('table');
  assert.deepEqual(await t.locator('th').allInnerTexts(), ['Name', 'Count', 'Note']);
  assert.equal(await t.locator('tbody tr').count(), 2);
  assert.equal(await t.locator('tbody tr').first().locator('td b').innerText(), 'a');
  assert.equal(await t.locator('tbody tr').nth(1).locator('td').first().innerText(), 'b | c', 'an escaped pipe stays in its cell');
  assert.equal(await t.locator('td').nth(1).evaluate(e => getComputedStyle(e).textAlign), 'right');
  assert.equal(await u.locator('p').first().innerText(), 'before', 'the paragraph above ends where the table starts');
  assert.equal(await u.locator('.tbl').evaluate(e => getComputedStyle(e).overflowX), 'auto');
});

await test('new thread: after the model or permissions picker closes, the composer has the keys again in INSERT', async p => {
  const box = p.locator('.pane.focus .comp textarea').first();
  await box.click();
  const back = async why => {
    await p.waitForFunction(() => !document.querySelector('.layer .menu') && document.activeElement?.matches('.pane.focus .comp textarea'), null, { timeout: 2000 }).catch(() => {});
    assert.ok(await box.evaluate(el => el === document.activeElement), `${why}: the composer has focus`);
    assert.equal(await mode(p), 'INSERT', `${why}: INSERT`);
  };
  // /model, enter on a model
  await p.keyboard.type('/model'); await settle(p);
  await p.keyboard.press('Enter'); await p.locator('.menu.model').waitFor();
  await p.keyboard.press('Enter');
  await back('picked with enter');
  // /model, esc (the picker's NORMAL), esc (closed)
  await p.keyboard.type('/model'); await settle(p);
  await p.keyboard.press('Enter'); await p.locator('.menu.model').waitFor();
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await back('closed with esc');
  // the chips, by mouse
  await p.locator('.pane.focus .comp .cf [title="Model and effort"]').click(); await p.locator('.menu.model').waitFor();
  await p.locator('.menu.model .mi').filter({ hasNotText: 'Effort' }).nth(1).click();
  await back('picked with the mouse');
  await p.locator('.pane.focus .comp .cf [title="Permissions"]').click(); await p.locator('.layer .menu').waitFor();
  await p.keyboard.press('Escape');
  await back('permissions closed with esc');
});

await test('model picker: hovering a model previews every control that depends on it, in place (no row comes or goes)', async p => {
  await p.locator('.pane.focus .comp .cf [title="Model and effort"]').click();
  const menu = p.locator('.menu.model'); await menu.waitFor();
  const ultra = menu.locator('.mi', { hasText: 'Ultracode' });
  const state = () => menu.evaluate(m => ({ h: Math.round(m.getBoundingClientRect().height), pins: m.querySelectorAll('.m-pin > *').length, none: !!m.querySelector('.eff.none'), ultraOff: !![...m.querySelectorAll('.mi')].find(x => x.textContent.includes('Ultracode'))?.classList.contains('off') }));
  const s0 = await state();
  assert.equal(s0.pins, 2, 'effort and Ultracode'); assert.ok(!s0.none && !s0.ultraOff);
  await menu.locator('.mi', { hasText: 'Haiku 4.5' }).hover(); await settle(p, 200);
  const s1 = await state();
  assert.equal(s1.pins, 2, 'the effort row stays'); assert.ok(s1.none, 'dimmed: Haiku 4.5 has no effort levels'); assert.equal(s1.h, s0.h, 'the menu keeps its height');
  await menu.locator('.mi', { hasText: 'GPT-6.2 Sol' }).hover(); await settle(p, 200);
  const s2 = await state();
  assert.ok(!s2.none, 'Sol has levels'); assert.ok(s2.ultraOff, 'Ultracode is dimmed for a Codex model'); assert.equal(s2.h, s0.h);
  assert.match(await ultra.innerText(), /not on GPT-6.2 Sol/);
  await menu.locator('.mi', { hasText: 'Opus 5.5' }).hover(); await settle(p, 200);
  const s3 = await state();
  assert.ok(!s3.none && !s3.ultraOff, 'back on a Claude model: both live');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
});

await test('reader: a double- or triple-click drag that ends past a paragraph keeps its selection in VISUAL', async p => {
  await openChat(p, 'Fix session-restore race');
  const para = p.locator('.pane.focus .m-asst p').first();
  const drag = async (clicks, dx, dy) => {
    await p.evaluate(() => getSelection().removeAllRanges()); await p.keyboard.press('Escape');
    await para.evaluate(e => e.scrollIntoView({ block: 'center' })); await settle(p);
    const bb = await para.boundingBox();
    await p.mouse.move(bb.x + 30, bb.y + 8);
    for (let c = 1; c <= clicks; c++) { await p.mouse.down({ clickCount: c }); if (c < clicks) await p.mouse.up({ clickCount: c }); }
    const end = await para.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const rs = r.getClientRects(); const l = rs[rs.length - 1]; return { x: l.right, y: l.bottom }; });
    await p.mouse.move(end.x + dx, end.y + dy, { steps: 8 });
    await p.mouse.up({ clickCount: clicks }); await settle(p, 250);
    return { mode: await mode(p), text: await p.evaluate(() => getSelection().toString()), bar: await p.locator('.seltb').count() };
  };
  for (const [clicks, dx, dy, why] of [[2, 40, -4, 'double, past the line end'], [1, 40, -4, 'single, past the line end'], [3, 40, -4, 'triple, past the line end'], [3, 40, 14, 'triple, onto the row below']]) {
    const r = await drag(clicks, dx, dy);
    assert.equal(r.mode, 'VISUAL', why);
    assert.ok(r.text.includes('sees the old value.'), `${why}: through the paragraph's end (${JSON.stringify(r.text.slice(-30))})`);
    assert.equal(r.bar, 1, `${why}: the quote bar`);
  }
  await p.keyboard.press('Escape');
});

// ---------- quote chips: a chat icon and blue words, as Cursor's (Josh, 2026-11-21) ----------
async function quoteFirst(p) {
  await openChat(p, 'Tidy PowerShell profile');
  await p.evaluate(() => {
    const el = document.querySelector('.pane.focus .m-asst p').firstChild; const r = document.createRange();
    r.setStart(el, 0); r.setEnd(el, 20); getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await p.keyboard.press(`${mod}+l`);
  await settle(p);
}
/** The chip as drawn: its colour and background, where its icon sits against its words, and whether the icon is in front of the textarea. */
const chipLook = p => p.evaluate(() => {
  const comp = document.querySelector('.pane.focus .compw'), tok = comp.querySelector('.bk .tok'), ta = comp.querySelector('textarea');
  const icon = comp.querySelector('.fk .qi svg'), words = tok.getBoundingClientRect(), ib = icon?.getBoundingClientRect(), cs = getComputedStyle(tok);
  return {
    color: cs.color, blue: getComputedStyle(document.documentElement).getPropertyValue('--blue').trim(), bg: cs.backgroundColor, hot: tok.classList.contains('hot'),
    textarea: getComputedStyle(ta).color, icon: !!icon && getComputedStyle(icon).color === cs.color,
    iconIn: !!ib && ib.left >= words.left - 1 && ib.right <= words.left + 22 && ib.top >= words.top - 2 && ib.bottom <= words.bottom + 2,
    front: !!icon && ta.compareDocumentPosition(icon.closest('.fk')) === Node.DOCUMENT_POSITION_FOLLOWING && Number(getComputedStyle(icon.closest('.fk')).zIndex) > 0,
  };
});
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

await test('quote chip: a chat icon, then the words in blue with no pill (dark and light)', async p => {
  await quoteFirst(p);
  for (const theme of ['dark', 'light']) {
    await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    await settle(p, 60);
    const c = await chipLook(p);
    assert.equal(c.color, rgb(c.blue), `${theme}: the words are blue`);
    assert.equal(c.bg, 'rgba(0, 0, 0, 0)', `${theme}: no pill while idle`);
    assert.equal(c.textarea, 'rgba(0, 0, 0, 0)', 'the layer behind draws the words, not the textarea');
    assert.ok(c.icon && c.iconIn, `${theme}: the blue chat icon sits at the chip's start`);
    assert.ok(c.front, 'the icon is in front of the textarea');
  }
  const v = await composer(p).inputValue();
  assert.ok(v.startsWith('⁣  “'), 'the icon holds its own space in the text');
});

await test('quote chip: typed words stay the normal colour, and INSERT shows the caret', async p => {
  await quoteFirst(p);
  await p.keyboard.type('why');
  const [plain, caret] = await p.evaluate(() => {
    const bk = document.querySelector('.pane.focus .compw .bk'), ta = document.querySelector('.pane.focus .compw textarea');
    return [getComputedStyle(bk).color === getComputedStyle(document.body).color, getComputedStyle(ta).caretColor];
  });
  assert.ok(plain, 'words outside the chip use --fg');
  assert.notEqual(caret, 'rgba(0, 0, 0, 0)', 'the INSERT caret still shows');
});

await test('quote chip: hover gives it a soft fill and the x; leaving takes both away', async p => {
  await quoteFirst(p);
  const tok = await p.locator('.pane.focus .compw .bk .tok').boundingBox();
  await p.mouse.move(tok.x + tok.width / 2, tok.y + tok.height / 2);
  await p.locator('.tokx').waitFor();
  await settle(p, 200);
  let c = await chipLook(p);
  assert.ok(c.hot && c.bg !== 'rgba(0, 0, 0, 0)', 'hovered: filled');
  assert.ok(c.iconIn, 'the icon stays put');
  await p.mouse.move(tok.x + tok.width / 2, tok.y - 150);
  await settle(p, 200);
  c = await chipLook(p);
  assert.ok(!c.hot && c.bg === 'rgba(0, 0, 0, 0)', 'left: plain again');
  assert.equal(await p.locator('.tokx').count(), 0);
});

await test('quote chip: the NORMAL block and VISUAL cover it whole, and its icon still shows', async p => {
  await quoteFirst(p);
  const end = (await composer(p).inputValue()).indexOf('⁣', 1) + 1;
  const sel = () => composer(p).evaluate(t => [t.selectionStart, t.selectionEnd]);
  await keys(p, 'Escape 0');
  assert.deepEqual(await sel(), [0, end], 'NORMAL: the block is the whole chip');
  assert.ok((await chipLook(p)).front, 'NORMAL: the icon is drawn over the block');
  await keys(p, 'v l');
  assert.equal(await mode(p), 'VISUAL');
  const [a, b] = await sel();
  assert.ok(a === 0 && b > end, 'VISUAL: the selection takes the chip and goes on');
  const c = await chipLook(p);
  assert.ok(c.front && c.iconIn, 'VISUAL: the icon still shows');
  assert.equal(c.color, rgb(c.blue), 'VISUAL: the words stay blue under the selection');
});

await test('quote chip: removed from the keyboard, icon and all (x in NORMAL, d in VISUAL)', async p => {
  await quoteFirst(p);
  await p.keyboard.type('why');
  await keys(p, 'Escape 0 x');
  assert.equal(await p.locator('.pane.focus .compw .bk .tok').count(), 0);
  assert.equal(await p.locator('.pane.focus .compw .fk').count(), 0, 'no icon left behind');
  await keys(p, 'u');
  assert.equal(await p.locator('.pane.focus .compw .fk .qi svg').count(), 1, 'undo brings the chip and its icon back');
  const tok = await p.locator('.pane.focus .compw .bk .tok').boundingBox();
  await p.mouse.move(tok.x + tok.width / 2, tok.y + tok.height / 2);
  await p.locator('.tokx').waitFor();   // still a quote (it lights up its source), not just its words
  await p.mouse.move(tok.x, tok.y - 150);
  await keys(p, '0 v d');
  assert.equal(await p.locator('.pane.focus .compw .bk .tok').count(), 0, 'VISUAL d takes it whole');
  assert.ok((await composer(p).inputValue()).endsWith('why'));
});

await test('quote chip: two chips each get an icon, in order', async p => {
  await quoteFirst(p);
  await p.evaluate(() => {
    const el = document.querySelectorAll('.pane.focus .m-asst p')[1]?.firstChild ?? document.querySelector('.pane.focus .m-asst p').firstChild; const r = document.createRange();
    r.setStart(el, 0); r.setEnd(el, Math.min(12, el.length)); getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await p.keyboard.press(`${mod}+l`);
  await settle(p);
  const xs = await p.evaluate(() => [...document.querySelectorAll('.pane.focus .compw .fk .qi svg')].map(s => s.getBoundingClientRect().left));
  const ts = await p.evaluate(() => [...document.querySelectorAll('.pane.focus .compw .bk .tok')].map(s => s.getBoundingClientRect().left));
  assert.equal(xs.length, 2);
  assert.ok(Math.abs(xs[0] - ts[0]) < 3 && Math.abs(xs[1] - ts[1]) < 3, 'each icon at its own chip');
});
