// Chat view: every interactive state.
import { assert, keys, mod, mode, settle, test, URL } from './harness.mjs';

/** Open a thread from the sidebar in its chat view. */
async function openChat(p, title) {
  await p.locator('#side').getByText(title, { exact: true }).first().click();
  const seg = p.locator('.pane.focus .tb .seg button[aria-label^="Chat"]');
  if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
  await p.waitForSelector('.pane.focus .chat .col[data-read] > *');
}
const composer = p => p.locator('.pane.focus .compw .cm-content');
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

await test('model picker: INSERT -> NORMAL moves nothing (the empty field\'s cursor sits over the placeholder)', async p => {
  await openChat(p, 'Fix session-restore race');
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  const where = () => menu.evaluate(m => {
    const r = e => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    // the placeholder's first letter: the input's text box in INSERT, the drawn .ph in NORMAL
    const ph = m.querySelector('.m-q .ph'), inp = m.querySelector('.m-s input');
    const x = ph && ph.offsetParent ? ph.getBoundingClientRect().x : inp.getBoundingClientRect().x + parseFloat(getComputedStyle(inp).paddingLeft);
    return { menu: r(m), row: r(m.querySelector('.mi')), ph: Math.round(x) };
  });
  assert.equal(await mode(p), 'INSERT');
  const ins = await where();
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL');
  await menu.locator('.m-q .hc i').waitFor();
  assert.deepEqual(await where(), ins, 'the popup, its rows and the placeholder stay put');
  await keys(p, 'i');
  assert.deepEqual(await where(), ins, 'and back');
  await p.keyboard.press('Escape');
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

/** The reader's cursor: its message's text (a bubble or a reply) and whether it is on screen. */
const cursorAt = p => p.evaluate(() => {
  const h = [...(CSS.highlights.get('vcur') || [])][0], row = document.querySelector('.pane.focus .rowcur');
  const node = row || (h && h.toString() ? h.startContainer.parentElement : null), r = row ? row.getBoundingClientRect() : h?.getBoundingClientRect();
  const s = document.querySelector('.pane.focus .thread').getBoundingClientRect();
  return node ? { msg: node.closest('[data-read] > *')?.textContent.trim().slice(0, 30), on: !!r && r.height > 0 && r.top >= s.top && r.bottom <= s.bottom } : null;
});
await test('reader: j and k near the edge of the screen go one line at a time, never past a message', async p => {
  await openChat(p, 'Walk through the backlog');
  await composer(p).press('Escape');
  await keys(p, 'g g'); await settle(p);
  const seen = new Set([(await cursorAt(p)).msg]);
  for (let i = 0; i < 40; i++) { await p.keyboard.press('j'); const c = await cursorAt(p); assert.ok(c?.on, `j ${i + 1}: the cursor is on screen`); seen.add(c.msg); }
  for (let n = 1; n <= 12; n++) assert.ok(seen.has(`Backlog item ${n}: what is left?`), `j reached your message ${n}`);
  await keys(p, 'Shift+G'); await settle(p);
  seen.clear();
  for (let i = 0; i < 40; i++) { await p.keyboard.press('k'); const c = await cursorAt(p); assert.ok(c?.on, `k ${i + 1}: the cursor is on screen`); seen.add(c.msg); }
  for (let n = 70; n >= 59; n--) assert.ok(seen.has(`Backlog item ${n}: what is left?`), `k reached your message ${n}`);
});
await test('reader: a cursor on a running turn\'s Working line stays drawn when the turn\'s work replaces it', async p => {
  await openChat(p, 'Profile slow orders query');
  // "slowly" holds the Working line for 4s, not 500ms, so a loaded runner can still put the cursor on it
  await composer(p).fill('hello there, slowly'); await composer(p).press('Enter');
  // a click, not k from the composer: k goes back to where the reader was left while that is on screen
  await p.locator('.pane.focus .live span', { hasText: 'Working' }).click(); await settle(p, 50);
  assert.equal(await mode(p), 'NORMAL');
  assert.equal(await p.evaluate(() => [...CSS.highlights.get('vcur')][0].startContainer.parentElement.closest('.live') != null), true, 'on the Working line');
  // the work (a Read row, then the streamed reply) takes the Working line's place
  await p.locator('.pane.focus .live').waitFor({ state: 'detached', timeout: 15000 }); await settle(p, 200);
  const c = await cursorAt(p);
  assert.ok(c?.on, `the cursor is still drawn on screen (${JSON.stringify(c)})`);
  await keys(p, 'k'); assert.ok((await cursorAt(p))?.on, 'and it moves from there');
});

await test('reader: closing ctrl-k, ctrl-p, : or the workspace menu puts the reading cursor back (rule 15)', async p => {
  await openChat(p, 'Profile slow orders query');
  await composer(p).press('Escape'); await keys(p, 'k k k w'); await settle(p);
  const at = () => p.evaluate(() => { const h = [...(CSS.highlights.get('vcur') || [])][0]; return h ? h.startContainer.data.slice(0, 20) + '@' + h.startOffset : null; });
  const where = await at();
  assert.ok(where, 'reading');
  for (const k of [`${mod}+k`, `${mod}+p`, 'Shift+:', 'Control+Space w']) {
    await keys(p, k); await settle(p);
    assert.equal(await p.locator('.menu, .pal').count() > 0, true, `${k} opened`);
    await keys(p, 'Escape Escape'); await settle(p, 200);
    assert.equal(await at(), where, `after ${k}: the cursor is back on its character`);
    assert.ok(!(await composer(p).evaluate(el => el === document.activeElement)), `after ${k}: the composer did not take the keys`);
  }
  await keys(p, 'j'); assert.ok(await at() !== where || await p.locator('.pane.focus .rowcur').count(), 'and the reader still moves');
});

await test('reader: back from the sidebar or another pane, the reading cursor comes back; opening the thread again types', async p => {
  await openChat(p, 'Profile slow orders query');
  await composer(p).press('Escape');
  await p.keyboard.press('Control+Space'); await p.keyboard.press(':'); await p.keyboard.type('vsplit'); await keys(p, 'Enter'); await settle(p, 300);
  await keys(p, 'Alt+h'); await settle(p);
  await keys(p, 'Escape k k w'); await settle(p);
  const at = () => p.evaluate(() => { const h = [...(CSS.highlights.get('vcur') || [])][0]; return h ? h.startContainer.data.slice(0, 20) + '@' + h.startOffset : null; });
  const where = await at(); assert.ok(where, 'reading');
  await keys(p, 'Alt+l'); await settle(p); await keys(p, 'Alt+h'); await settle(p, 200);
  assert.equal(await at(), where, 'back from the other pane: on the same character');
  await keys(p, 'Alt+h'); await settle(p); assert.equal(await at(), null, 'the sidebar has the keys');
  await keys(p, 'Escape'); await settle(p, 200);
  assert.equal(await at(), where, 'back from the sidebar: on the same character');
  await keys(p, 'Alt+h'); await settle(p); await keys(p, 'Enter'); await settle(p, 300);
  assert.equal(await at(), null, 'opening the thread from the sidebar gives the composer the keys');
  assert.ok(await composer(p).evaluate(el => el === document.activeElement));
});

await test('reader: a subagent popup opened with enter on its row closes back onto that row (rule 15)', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).press('Escape'); await keys(p, 'k'); await settle(p);
  const row = () => p.evaluate(() => document.querySelector('.pane.focus .rowcur')?.textContent || '');
  for (let i = 0; i < 6 && !/Review/.test(await row()); i++) await keys(p, 'k');
  assert.match(await p.locator('.pane.focus .rowcur').textContent(), /Review/);
  await keys(p, 'Enter'); await settle(p, 300);
  assert.equal(await p.locator('.pop').count() + await p.locator('.popped').count() > 0, true, 'the popup opened');
  await keys(p, 'Escape'); await settle(p, 300);
  assert.match(await p.locator('.pane.focus .rowcur').textContent(), /Review/, 'the cursor is back on the row');
  assert.ok(!(await composer(p).evaluate(el => el === document.activeElement)), 'the composer did not take the keys');
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
  const box = p.locator('.pane.focus .m-edit .cm-content');
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

await test('edit: a click on your message puts the caret before the clicked letter, with no blank line after the text', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  const mt = p.locator('.pane.focus .m-user .mt').first();
  const pt = await mt.evaluate(el => {   // the left half of the "i" in "timestamp"
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode()) && !n.data.includes('timestamp'));
    const r = document.createRange(), i = n.data.indexOf('timestamp') + 1; r.setStart(n, i); r.setEnd(n, i + 1);
    const q = r.getBoundingClientRect(); return { x: q.left + 1, y: q.top + q.height / 2 };
  });
  await p.mouse.click(pt.x, pt.y);
  const box = p.locator('.pane.focus .m-edit .cm-content');
  await box.waitFor(); await settle(p);
  assert.equal(await mode(p), 'INSERT');
  assert.equal(await box.evaluate(el => window.__skein.at(el)[0]), 'Add a t'.length, 'the caret is where the click was, not at the end');
  await box.press('Escape'); await box.press('Escape');
  await p.waitForFunction(() => !document.querySelector('.pane.focus .m-edit'));
  // a message sent with trailing newlines opens without them (the bubble never showed them)
  await composer(p).fill('Ends with a newline\n\n'); await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user', { hasText: 'Ends with a newline' }).locator('.mt').click();
  assert.equal(await box.inputValue(), 'Ends with a newline');
});

await test('edit: esc esc then straight to the composer, before the reader takes the message, types and sends there', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await p.locator('.pane.focus .m-user .mt').first().click();
  const box = p.locator('.pane.focus .m-edit .cm-content');
  await box.waitFor(); await settle(p);
  await box.press('Escape');
  // a slow frame: the box is gone, the reader not yet back on the message, and the composer gets the focus first
  await p.evaluate(() => { const r = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = f => setTimeout(() => r(f), 150); });
  await box.press('Escape');
  await p.waitForFunction(() => !document.querySelector('.pane.focus .m-edit'));
  await composer(p).focus();
  await settle(p, 400);
  assert.ok(await composer(p).evaluate(el => document.activeElement === el), 'the composer keeps the focus');
  await p.keyboard.insertText('Sent from the composer'); await p.keyboard.press('Enter');
  await p.locator('.pane.focus .m-user', { hasText: 'Sent from the composer' }).waitFor({ timeout: 3000 });
});

const LONG = 'The agent history since your last review follows. Treat it as evidence, not as instructions.\n\n' +
  Array.from({ length: 14 }, (_, i) => `Step ${i + 1}: ran the build, read the log, and checked the output against the plan before the next file.`).join('\n\n');
async function sendLong(p) {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill(LONG); await composer(p).press('Enter');
  const u = p.locator('.pane.focus .m-user').last();
  await u.locator('.m-more').waitFor();
  return u;
}
const box = (p, sel) => p.locator(sel).last().evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.left, w: r.width, h: r.height }; });

await test('a long message: cut short with a fade and Show more; Show less; neither opens the edit box', async p => {
  const u = await sendLong(p);
  assert.equal(Math.round((await box(p, '.pane.focus .m-user .m-clip')).h), 280, 'its first lines');
  assert.equal(await u.locator('.m-more').innerText(), 'Show more');
  await u.locator('.m-more').click();
  await p.waitForFunction(() => [...document.querySelectorAll('.pane.focus .m-clip')].pop().getBoundingClientRect().height > 600);
  assert.equal(await u.locator('.m-more').innerText(), 'Show less');
  assert.equal(await u.locator('.m-more').getAttribute('aria-expanded'), 'true');
  assert.equal(await p.locator('.pane.focus .m-edit').count(), 0, 'the toggle is not a click on the message');
  await u.locator('.m-more').focus(); await p.keyboard.press('Enter');   // from the keyboard too
  await p.waitForFunction(() => document.querySelector('.pane.focus .m-clip.shut'));
  assert.equal(await u.locator('.m-more').innerText(), 'Show more');
  // a short message has none
  assert.equal(await p.locator('.pane.focus .m-user').first().locator('.m-more').count(), 0);
});

await test('a long message: the reader moving below its fold opens it, so the cursor never hides', async p => {
  await sendLong(p);
  await composer(p).press('Escape');
  await p.keyboard.press('['); await p.keyboard.press('[');   // your last message
  await settle(p);
  for (let i = 0; i < 16; i++) await p.keyboard.press('j');
  await settle(p);
  assert.equal(await p.locator('.pane.focus .m-clip.shut').count(), 0, 'the message opened');
  assert.equal(await mode(p), 'NORMAL');
});

await test('a long message: k from Show more goes to its last line above the fade and leaves it shut', async p => {
  await sendLong(p);
  await p.waitForFunction(() => !document.querySelector('.pane.focus .live'));
  await settle(p, 300);
  const u = () => p.evaluate(() => {
    const m = [...document.querySelectorAll('.pane.focus .m-user')].pop(), clip = m.querySelector('.m-clip').getBoundingClientRect();
    const r = document.querySelector('.pane.focus .rowcur'), g = CSS.highlights.get('vcur')?.values().next().value;
    const at = r ? (r.matches('.m-more') && m.contains(r) ? 'more' : 'row') : g && m.contains(g.startContainer) ? 'mine' : 'other';
    return { at, shut: !!m.querySelector('.m-clip.shut'), fold: clip.bottom, bottom: g?.getBoundingClientRect().bottom ?? 0 };
  });
  await composer(p).press('Escape');
  for (let i = 0; i < 30 && (await u()).at !== 'more'; i++) await keys(p, 'k');   // up from the reply below onto Show more
  assert.equal((await u()).at, 'more');
  await keys(p, 'k');
  const s = await u();
  assert.equal(s.at, 'mine', 'k goes into the message');
  assert.ok(s.shut, 'and leaves it cut short');
  assert.ok(s.bottom <= s.fold - 32, `on a line clear of the fade (${s.bottom} vs fold ${s.fold})`);
  await keys(p, 'k');
  assert.equal((await u()).at, 'mine', 'k goes on up through it');
  assert.ok((await u()).shut);
});

await test('edit from the reader: x on your message edits it in NORMAL', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await composer(p).press('Escape');
  // gg, not a count of k: how many lines the reply above takes depends on the fonts (Linux CI wraps it onto two)
  await p.keyboard.press('g'); await p.keyboard.press('g');
  await settle(p);
  await p.keyboard.press('0');
  await p.keyboard.press('x');
  const box = p.locator('.pane.focus .m-edit .cm-content');
  await box.waitFor();
  // the edit box animates in and takes the keys a frame later; on a loaded CI runner the first read can land before that
  await p.waitForFunction(() => document.querySelector('#status .vim')?.textContent === 'NORMAL' && document.activeElement?.closest('.m-edit'), null, { timeout: 2000 }).catch(() => {});
  assert.equal(await box.inputValue(), 'y PowerShell profile takes two seconds to load. Trim it.');
  assert.equal(await mode(p), 'NORMAL');
});

await test('edit from the reader: i, a and cw on your message type into it in INSERT', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  const box = p.locator('.pane.focus .m-edit .cm-content');
  await composer(p).press('Escape');   // into the reader; esc esc out of each edit puts it back on the message
  for (const [ks, typed, want] of [['i', 'Z', 'ZMy PowerShell'], ['a', 'Z', 'MZy PowerShell'], ['c w', 'Our', 'Our PowerShell']]) {
    await p.keyboard.press('g'); await p.keyboard.press('g'); await settle(p);
    await p.keyboard.press('0');
    for (const k of ks.split(' ')) await p.keyboard.press(k);
    await box.waitFor();
    await p.waitForFunction(() => document.querySelector('#status .vim')?.textContent === 'INSERT' && document.activeElement?.closest('.m-edit'), null, { timeout: 2000 }).catch(() => {});
    assert.equal(await mode(p), 'INSERT', `${ks} types into the message`);
    await p.keyboard.type(typed);
    assert.ok((await box.inputValue()).startsWith(want), `${ks}: ${JSON.stringify((await box.inputValue()).slice(0, 20))}`);
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('.pane.focus .m-edit'));
  }
});

await test('edit from the reader: keys typed before the edit box shows (c w, i Z on a slow frame) still go into it', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  const box = p.locator('.pane.focus .m-edit .cm-content');
  await composer(p).press('Escape');
  // a slow machine: the box mounts a while after the key that opens it, and the next key comes before that
  await p.evaluate(() => { const r = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = f => setTimeout(() => r(f), 60); });
  for (const [ks, want] of [['c w', 'Our PowerShell'], ['i Z', 'ZMy PowerShell']]) {
    await p.keyboard.press('g'); await p.keyboard.press('g'); await settle(p);
    await p.keyboard.press('0');
    for (const k of ks.split(' ')) await p.keyboard.press(k);
    await box.waitFor();
    await p.waitForFunction(() => document.querySelector('#status .vim')?.textContent === 'INSERT', null, { timeout: 2000 }).catch(() => {});
    assert.equal(await mode(p), 'INSERT', `${ks} ends in INSERT`);
    if (ks === 'c w') await p.keyboard.type('Our');
    assert.ok((await box.inputValue()).startsWith(want), `${ks}: ${JSON.stringify((await box.inputValue()).slice(0, 20))}`);
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('.pane.focus .m-edit'));
  }
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
  const box = p.locator('.pane.focus .m-edit .cm-content');
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
  const [a, z] = await box.evaluate(el => window.__skein.at(el).slice(0, 2));
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

await test('mirror: holding j past the end of the reader never moves the sidebar', async p => {
  await openChat(p, 'Migrate ETL config to TOML');
  await p.locator('.pane.focus .mirror').waitFor();
  const side = () => p.evaluate(() => ({ cur: window.__skein.S.sideCursor, top: document.querySelector('#side .list, #side')?.scrollTop ?? 0, rows: document.querySelectorAll('#side .row.cur').length }));
  await keys(p, 'k k k k');   // the reader, a few lines up from the end
  const before = await side();
  // a held key: the first press, then repeats (keyboard.down again without up sends repeat: true)
  for (let i = 0; i < 30; i++) { await p.keyboard.down('j'); await settle(p, 15); }
  await p.keyboard.up('j'); await settle(p, 100);
  assert.deepEqual(await side(), before, 'the repeats stop at the bottom of the chat');
  await keys(p, 'k k');
  for (let i = 0; i < 20; i++) { await p.keyboard.down('ArrowDown'); await settle(p, 15); }
  await p.keyboard.up('ArrowDown'); await settle(p, 100);
  assert.deepEqual(await side(), before, 'the arrow too');
  // k held to the top, and ctrl-d / ctrl-u held, stay in the chat too
  await keys(p, 'k');
  for (let i = 0; i < 40; i++) { await p.keyboard.down('k'); await settle(p, 10); }
  await p.keyboard.up('k');
  await p.keyboard.down('Control');
  for (const c of ['d', 'u', 'd']) { for (let i = 0; i < 15; i++) { await p.keyboard.down(c); await settle(p, 10); } await p.keyboard.up(c); }
  await p.keyboard.up('Control'); await settle(p, 100);
  assert.deepEqual(await side(), before, 'k, ctrl-d and ctrl-u');
  await keys(p, 'Escape');
  // a fresh press there still moves the sidebar cursor (app NORMAL, as in the mockup), and holding it keeps moving it
  await keys(p, 'j');
  const one = await side();
  assert.notEqual(one.cur, before.cur);
  await p.evaluate(() => { window.__skein.S.sideCursor = 't1'; });   // room to move: this thread is near the end
  for (let i = 0; i < 3; i++) await p.keyboard.down('j');
  await p.keyboard.up('j'); await settle(p, 100);
  const steps = await p.evaluate(() => { const ids = [...document.querySelectorAll('#side .row[data-thread]')].map(r => r.dataset.thread); return ids.indexOf(window.__skein.S.sideCursor) - ids.indexOf('t1'); });
  assert.equal(steps, 3, 'a hold that starts on the sidebar cursor keeps moving it');
});

await test('subagent: a row opens its popup in INSERT, ready to message it', async p => {
  await openChat(p, 'Fix session-restore race');
  await p.locator('.pane.focus .ag', { hasText: 'Test runner' }).click();
  const pop = p.locator('.peek.focus');
  await pop.waitFor();
  assert.ok((await pop.locator('.tb').innerText()).includes('Test runner'));
  assert.equal(await pop.locator('.cm-content').getAttribute('placeholder'), 'Message Test runner');
  await settle(p);
  assert.equal(await mode(p), 'INSERT');
  await pop.locator('.cm-content').pressSequentially('anything else?');
  await pop.locator('.cm-content').press('Enter');
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
  const v = await p.locator('.pane .compw .cm-content').first().inputValue();
  assert.ok(v.includes('A mutex only covers'), 'quote is in the thread composer');
  assert.equal(await p.locator('.pane .compw .cm-content .tok').count(), 1, 'drawn as a chip');
});

await test('side chat links on one reply: h / l move the cursor between them; enter opens one', async p => {
  await openChat(p, 'Fix session-restore race');
  // a second side chat from the same reply
  await p.evaluate(async () => {
    const { api, S } = window.__skein, at = S.threads.find(t => t.id === 's1').parent.at;
    const t = await api.threads.create({ harness: 'claude', machine: 'local', dir: '~/projects/skein', view: 'chat', side: true, parent: { id: 't1', at } });
    await api.threads.update(t.id, { title: 'Second side chat' });
  });
  const links = p.locator('.pane.focus .sc-links').first().locator('.sc-link');
  await links.nth(1).waitFor();
  await composer(p).press('Escape');
  await keys(p, 'g g');
  const on = () => p.evaluate(() => document.querySelector('.pane.focus .sc-link.rowcur')?.textContent ?? null);
  for (let i = 0; i < 12 && !(await on()); i++) await keys(p, 'j');
  const [first, second] = await links.allTextContents();
  assert.ok([first, second].includes(await on()), 'j lands on a link');
  await keys(p, '0');
  assert.equal(await on(), first, '0 goes to the first');
  await keys(p, 'l');
  assert.equal(await on(), second, 'l moves to the next one');
  await keys(p, 'l');
  assert.equal(await on(), second, 'and stops at the last');
  await keys(p, 'h');
  assert.equal(await on(), first, 'h moves back');
  await keys(p, '$');
  assert.equal(await on(), second, '$ goes to the last');
  await keys(p, 'Enter');
  await p.locator('.peek.focus .sc-anchor').waitFor();
});

await test('/sidechats offers New side chat; it opens a side chat popup in INSERT', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('/sidech');
  await composer(p).press('Enter');
  await p.locator('.menu .mi', { hasText: 'New side chat' }).click();
  const pop = p.locator('.peek.focus');
  await pop.waitFor();
  assert.equal(await pop.locator('.cm-content').getAttribute('placeholder'), 'Ask in this side chat');
});

await test('/side starts a side chat at once; /sidechats still lists them', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  const before = await p.evaluate(() => window.__skein.S.threads.filter(t => t.side).length);
  await composer(p).pressSequentially('/side');
  await p.locator('.menu .mi', { hasText: 'Side chats' }).waitFor();
  await p.locator('.menu .mi', { hasText: 'New side chat about' }).click();
  const pop = p.locator('.peek.focus');
  await pop.waitFor();
  assert.equal(await pop.locator('.cm-content').getAttribute('placeholder'), 'Ask in this side chat');
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
  assert.deepEqual(await menu.locator('.mi .ml').allInnerTexts(), ['Read only', 'Ask for approval', 'Approve for me', 'Full access'], 'Codex desktop\'s modes and the TUI\'s Read only, least access first');
  assert.equal(await menu.locator('.mi:has(.i-check) .ml').innerText(), 'Ask for approval', 'no mode set: Codex\'s workspace preset, you approving');
  await menu.locator('.mi', { hasText: 'Full access' }).click();
  const full = p.locator('.pane.focus .cf .chip', { hasText: 'Full access' });
  await full.waitFor();
  assert.equal(await full.locator('.i-shieldAlert').count(), 1, 'the chip shows the mode\'s icon');
  assert.ok(await full.evaluate(e => e.classList.contains('warn')), 'the chip is in the warning tone');
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]').click();
  const mm = p.locator('.menu.model');
  await mm.waitFor();
  assert.deepEqual(await mm.locator('.mi .ml').allInnerTexts(), ['GPT-6.2 Sol', 'GPT-6.2 Astra', 'Fast']);
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

await test('edit box controls: enter on permissions or model opens its menu and the edit stays open', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  const edit = p.locator('.pane.focus .m-edit');
  await composer(p).press('Escape');
  await p.keyboard.press('g'); await p.keyboard.press('g'); await settle(p);
  await p.keyboard.press('0');
  await p.keyboard.press('i');
  await edit.locator('.cm-content').waitFor();
  await p.waitForFunction(() => document.querySelector('#status .vim')?.textContent === 'INSERT' && document.activeElement?.closest('.m-edit'), null, { timeout: 2000 }).catch(() => {});
  await p.keyboard.press('Escape');
  await p.keyboard.press('j');
  await settle(p);
  const mark = edit.locator('.cf > .kcur');
  await p.keyboard.press('l');
  assert.equal(await mark.getAttribute('title'), 'Permissions');
  await p.keyboard.press('Enter');
  const perms = p.locator('.menu.perms');
  await perms.waitFor();
  assert.equal(await edit.count(), 1, 'the edit box stays open under its menu');
  await p.keyboard.press('Escape');
  await perms.waitFor({ state: 'detached' });
  assert.equal(await edit.count(), 1, 'esc closes only the menu');
  assert.equal(await mark.getAttribute('title'), 'Permissions', 'the keys are back on the chip');
  // a pick redraws the chip: the mark stays on it
  await p.keyboard.press('Enter');
  await perms.waitFor();
  await p.keyboard.press('G');
  const last = await perms.locator('.mi .ml').last().innerText();
  await p.keyboard.press('Enter');
  await perms.waitFor({ state: 'detached' });
  await edit.locator('.cf .chip[title="Permissions"]', { hasText: last }).waitFor();
  assert.equal(await edit.count(), 1, 'a pick keeps the edit box open');
  assert.equal(await mark.getAttribute('title'), 'Permissions');
  await p.keyboard.press('l');
  assert.equal(await mark.getAttribute('title'), 'Model and effort');
  await p.keyboard.press('Enter');
  await p.locator('.menu.model').waitFor();
  assert.equal(await edit.count(), 1, 'the model picker leaves the edit box open too');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');   // out of its search field, then the menu
  await p.locator('.menu.model').waitFor({ state: 'detached' });
  assert.equal(await mark.getAttribute('title'), 'Model and effort');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('.pane.focus .m-edit'));
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

/** A plain PNG of w x h pixels, for an image taller than a few lines of text. */
async function pngOf(w, h) {
  const { deflateSync, crc32 } = await import('node:zlib');
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h, 0xcc); for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

await test('images: j and k cross a tall image to the text on its other side', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await p.locator('.pane.focus .comp input[type=file]').setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer: await pngOf(260, 420) });
  await composer(p).fill('Browser comments: the text under a tall image');
  await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user .m-img').last().waitFor();
  await p.waitForFunction(() => [...document.querySelectorAll('.pane.focus .m-user .m-img')].pop().getBoundingClientRect().height > 400);
  await settle(p, 400);
  const at = () => p.evaluate(() => {
    const row = document.querySelector('.pane.focus .rowcur'), n = row ?? [...(CSS.highlights.get('vcur') ?? [])][0]?.startContainer, el = n && (n.nodeType === 1 ? n : n.parentElement);
    const u = [...document.querySelectorAll('.pane.focus .m-user')].pop();
    return el && u.contains(el) ? 'mine' : el?.closest('.pane.focus [data-read]') ? 'above' : 'none';
  });
  await composer(p).press('Escape');
  await keys(p, '[ [');   // the text of your last message, below its image
  assert.equal(await at(), 'mine');
  await keys(p, 'k');      // up over the image, to the reply before it
  assert.equal(await at(), 'above');
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'still reading');
  await keys(p, 'j');      // and back down over it: the message, not the composer
  assert.equal(await at(), 'mine');
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'still reading');
});

await test('images: a message of only images is reachable; its images and Show more are rows', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  const send = async h => {
    await p.locator('.pane.focus .comp input[type=file]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: await pngOf(260, h) });
    await p.locator('.pane.focus .atts .att img').waitFor();
    await composer(p).press('Enter');
    await p.waitForFunction(n => document.querySelectorAll('.pane.focus .m-user .m-pic').length >= n, h > 300 ? 2 : 1);
  };
  await send(120); await send(420);
  await p.locator('.pane.focus .m-user .m-more').last().waitFor();
  await settle(p, 400);
  const cur = () => p.evaluate(() => {
    const r = document.querySelector('.pane.focus .rowcur'), us = [...document.querySelectorAll('.pane.focus .m-user')];
    return r ? `${r.matches('.m-pic') ? 'pic' : r.matches('.m-more') ? 'more' : 'row'}${us.findIndex(u => u.contains(r)) - us.length}` : 'text';
  });
  await composer(p).press('Escape');
  await keys(p, '[ [');
  assert.equal(await cur(), 'pic-1', 'your last message: its image');
  assert.equal(await p.locator('.pane.focus .m-user').last().locator('.m-clip.shut').count(), 1, 'landing on the picture leaves it shut');
  await keys(p, 'j');
  assert.equal(await cur(), 'more-1', 'then its Show more');
  await keys(p, 'Enter');
  assert.equal(await p.locator('.pane.focus .m-user').last().locator('.m-clip.shut').count(), 0, 'enter opens it');
  assert.equal(await cur(), 'more-1', 'the cursor stays on Show less');
  await keys(p, 'k');
  assert.equal(await cur(), 'pic-1');
  await keys(p, 'k');
  assert.notEqual(await cur(), 'pic-1', 'k goes on above it');
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'still reading');
  await keys(p, '[ [');
  assert.equal(await cur(), 'pic-2', 'the message before: a short picture, no Show more');
  await keys(p, 'j');
  assert.ok(!['pic-2', 'text-composer'].includes(await cur()), 'j goes on to the reply below it');
  await keys(p, 'k');
  assert.equal(await cur(), 'pic-2', 'and k comes back to the picture');
  await keys(p, 'Enter');
  await p.locator('.lightbox img').waitFor();
  await p.keyboard.press('Escape');
  await p.locator('.lightbox').waitFor({ state: 'detached' });
});

await test('images: j from Show less of a tall message goes on to the reply below, not the composer', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await p.locator('.pane.focus .comp input[type=file]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: await pngOf(260, 1400) });
  await p.locator('.pane.focus .atts .att img').waitFor();
  await composer(p).press('Enter');
  await p.locator('.pane.focus .m-user .m-more').last().waitFor();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .live'));
  await settle(p, 400);
  // where the cursor is: a row of your last message, or below it (the reply), or in it
  const cur = () => p.evaluate(() => {
    const u = [...document.querySelectorAll('.pane.focus .m-user')].pop(), r = document.querySelector('.pane.focus .rowcur');
    if (r) return u.contains(r) ? (r.matches('.m-more') ? 'more' : r.matches('.m-pic') ? 'pic' : 'mine') : u.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING ? 'below' : 'above';
    const n = CSS.highlights.get('vcur')?.values().next().value?.startContainer ?? getSelection().focusNode;
    return !n ? 'none' : u.contains(n) ? 'mine' : u.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING ? 'below' : 'above';
  });
  await composer(p).press('Escape');
  await keys(p, '[ [ j');
  assert.equal(await cur(), 'more', 'on Show more');
  await keys(p, 'Enter');
  await settle(p, 400);   // the message opens taller than the screen: Show less, with the cursor on it, is below it
  assert.equal(await cur(), 'more', 'the cursor stays on Show less');
  await keys(p, 'j');
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'still reading, not in the composer');
  assert.equal(await cur(), 'below', 'j goes on to the reply below');
  await keys(p, 'k');
  assert.equal(await cur(), 'more', 'and k comes back to Show less');
});

await test('quote: a selection goes into the composer as a chip (mod-l)', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await p.evaluate(() => {
    const el = document.querySelector('.pane.focus .m-asst p').firstChild; const r = document.createRange();
    r.setStart(el, 0); r.setEnd(el, 20); getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await p.keyboard.press(`${mod}+l`);
  await settle(p);
  assert.equal(await p.locator('.pane.focus .compw .cm-content .tok').count(), 1);
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
  assert.equal(await p.locator('.pane.focus .compw .cm-content .tok').count(), 1);
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
  assert.doesNotMatch(s.head, /m 0\d/, 'no zero-padded seconds: 1m 6s, not 1m 06s');
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
  assert.equal(await p.evaluate(() => !!document.activeElement?.matches('.cm-content') && !!document.activeElement.closest('.pane.focus .comp')), true, 'still in the composer');
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
  assert.equal(await p.evaluate(() => !!document.activeElement?.matches('.cm-content') && !!document.activeElement.closest('.pane.focus .comp')), false, 'left the composer');
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

await test('permission chip: one label, a menu of the harness\'s own modes with icons and descriptions, a check', async p => {
  await openChat(p, 'Fix session-restore race');
  const chip = p.locator('.pane.focus .cf .chip[title="Permissions"]');
  assert.equal(await chip.locator(':scope > span').count(), 1);
  assert.equal(await chip.locator(':scope > span.lbl').count(), 1, 'the label is the .lbl itself');
  assert.equal(await chip.locator('.i-pencil').count(), 1, 'the chip shows the current mode\'s icon');
  await chip.click();
  const menu = p.locator('.menu.perms').last();
  await menu.waitFor();
  // Claude Code's shift-tab modes, in its words, plus Bypass permissions; Don't ask is not in its picker (fakeOptions)
  assert.deepEqual(await menu.locator('.mi .ml').allInnerTexts(), ['Manual mode', 'Accept edits', 'Plan mode', 'Auto mode', 'Bypass permissions']);
  assert.equal(await menu.locator('.mi .mic svg').count(), 5, 'an icon per mode');
  assert.equal(await menu.locator('.mi .mh').count(), 5, 'a description per mode');
  assert.equal(await menu.locator('.mi.sel', { hasText: 'Accept edits' }).locator('.i-check').count(), 1);
  // the mode without limits in the warning tone, label and description
  const warn = menu.locator('.mi.warn');
  assert.deepEqual(await warn.locator('.ml').allInnerTexts(), ['Bypass permissions']);
  const [l, d, n] = await Promise.all([warn.locator('.ml'), warn.locator('.mh'), menu.locator('.mi:not(.warn) .ml').first()].map(x => x.evaluate(e => getComputedStyle(e).color)));
  assert.equal(l, d, 'description in the same tone'); assert.notEqual(l, n, 'not the plain text color');
  // the description sits under the name, and nothing is cut off
  const [lb, db] = [await warn.locator('.ml').boundingBox(), await warn.locator('.mh').boundingBox()];
  assert.ok(db.y >= lb.y + lb.height - 1 && Math.abs(db.x - lb.x) < 1, 'description under the name');
  assert.deepEqual(await menu.locator('.mi .ml, .mi .mh').evaluateAll(xs => xs.filter(x => x.scrollWidth > x.clientWidth).map(x => x.textContent)), [], 'nothing is cut off');
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

await test('model picker: fast mode is a switch for the models that have it, keys and pointer, shown on the chip', async p => {
  await openChat(p, 'Fix session-restore race');   // Claude, Opus 5.5: Claude Code lists fast mode for it
  const chip = p.locator('.pane.focus .cf .chip[title="Model and effort"]');
  const text = async () => (await chip.innerText()).replace(/\s+/g, ' ').trim();
  await chip.click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  const fast = menu.locator('.mi', { hasText: 'Fast mode' });
  await fast.waitFor();   // once the harness's list is in
  assert.equal(await fast.locator('.sw.on').count(), 0, 'off to begin with');
  await p.keyboard.press('Escape');                     // NORMAL
  const sel = () => menu.evaluate(m => m.querySelector('.mi.sel .ml')?.textContent);
  assert.equal(await sel(), 'Opus 5.5');
  await keys(p, 'k k');                                 // past the top: the effort row
  await keys(p, 'j j');
  assert.equal(await sel(), 'Fast mode', 'j from the effort row: Ultracode, then Fast mode');
  await p.keyboard.press('Enter');                      // toggles, and the picker stays open
  await fast.locator('.sw.on').waitFor();
  assert.equal(await menu.count(), 1, 'the picker stays open');
  await p.locator('.pane.focus .cf .chip[title="Model and effort"]', { hasText: 'Medium · Fast' }).waitFor();
  // a model without it: no row while the cursor is on it
  await keys(p, 'g g');
  for (let i = 0; i < 4; i++) await keys(p, 'j');
  assert.equal(await sel(), 'Haiku 5.5');
  assert.equal(await fast.count(), 0, 'no Fast mode row for Haiku 5.5');
  await p.keyboard.press('Enter');                      // picking it turns fast mode off
  await menu.waitFor({ state: 'detached' });
  assert.equal(await text(), 'Haiku 5.5 Medium');
  await chip.click();
  await menu.waitFor();
  await menu.locator('.mi', { hasText: 'Opus 5.5' }).click();
  await menu.waitFor({ state: 'detached' });
  assert.equal(await text(), 'Opus 5.5 Medium', 'back on Opus: still off');
  await chip.click();
  await fast.click();                                   // the pointer toggles it too
  await fast.locator('.sw.on').waitFor();
  await fast.click();
  await fast.locator('.sw:not(.on)').waitFor();
  assert.equal(await text(), 'Opus 5.5 Medium');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
});

await test('model picker: Codex\'s Fast tier, in its words, with its description', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  const chip = p.locator('.pane.focus .cf .chip[title="Model and effort"]');
  await chip.click();
  const menu = p.locator('.menu.model');
  await menu.waitFor();
  const fast = menu.locator('.mi', { hasText: 'Fast' });
  await fast.waitFor();   // once the harness's list is in
  assert.match(await fast.innerText(), /2x speed, increased usage/);
  await fast.click();
  await fast.locator('.sw.on').waitFor();
  assert.match((await chip.innerText()).replace(/\s+/g, ' '), / · Fast$/);
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
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
  await keys(p, 'j'); assert.equal(await sel(), 'Fast', 'below the effort row: the model\'s speed switch');
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
  await p.locator('.pane.focus .newp .cm-content:visible').waitFor();
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
  const T = p.locator('.pane.focus .newp .cm-content:visible');
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
  // Claude Code's everyday commands (in CORE's order), then the thread's own, its skills, then its other built-ins
  assert.deepEqual(names.slice(0, 4), ['Clear', 'Compact', 'Model', 'Effort']);
  assert.ok(names.includes('Usage') && !names.includes('Plan'), 'the harness\'s list, not the bundled one');
  assert.ok(names.indexOf('Side chats') > names.indexOf('Usage') && names.indexOf('Subagents') === names.indexOf('Side chats') + 1);
  assert.equal(await menu.locator('.mi.head', { hasText: 'Skills' }).count(), 1);
  assert.ok(names.indexOf('Mockup parity') > names.indexOf('Subagents') && names.indexOf('Mockup parity') < names.indexOf('Advisor'), 'custom skills under Skills, before More');
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
  const sel = () => composer(p).evaluate(t => window.__skein.at(t).slice(0, 2));
  const block = () => p.locator('.pane.focus .compw .tok.on').count();
  await keys(p, 'Escape 0');
  assert.deepEqual(await sel(), [0, 0]);
  assert.equal(await block(), 1, 'the block covers the whole quote');
  await keys(p, 'l');
  assert.deepEqual(await sel(), [end, end], 'l steps over it');
  assert.equal(await block(), 0);
  await keys(p, 'h');
  assert.deepEqual(await sel(), [0, 0]);
  assert.equal(await block(), 1);
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
  const tok = await p.locator('.pane.focus .compw .cm-content .tok').boundingBox();
  await p.mouse.move(tok.x + tok.width / 2, tok.y + tok.height / 2);
  await p.locator('.tokx').waitFor();
  assert.deepEqual(await hl(), [0, 1], 'hovering it brightens its source');
  await p.mouse.move(tok.x + tok.width / 2, tok.y + tok.height / 2 + 1);
  await p.mouse.down(); await p.mouse.up();
  const [a, b] = await composer(p).evaluate(t => window.__skein.at(t).slice(0, 2));
  assert.equal(a, b);
  const v = await composer(p).inputValue();
  assert.ok(a === 0 || a === v.indexOf('⁣', 1) + 1, 'the caret is never inside the quote');
  await p.locator('.tokx').hover();
  await p.locator('.tokx').click();
  assert.equal(await p.locator('.pane.focus .compw .cm-content .tok').count(), 0);
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
  const T = p.locator('.pane.focus .newp .cm-content:visible');
  await T.waitFor();
  const newp = p.locator('.pane.focus .newp:visible');
  assert.equal(await newp.locator('.cf .chip[title="Permissions"]').innerText(), 'Manual mode');
  assert.equal(await newp.locator('.cf .ib[title^="Attach image"]').count(), 1);
  assert.equal(await newp.locator('.under .bchip').count(), 0, 'no branch chip outside a repository (statusbar.spec covers it in one)');
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
  const toks = p.locator('.pane.focus .compw .cm-content .tok');
  assert.equal(await toks.count(), 2);
  const [v, caret] = await composer(p).evaluate(el => [window.__skein.val(el), window.__skein.at(el)[0]]);
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
  assert.equal(await composer(p).evaluate(el => window.__skein.at(el)[0]), 'one two three'.length);
});

// ---------- wave 3: clicks ----------

await test('a click on chrome while typing drops the composer to NORMAL; reader cursor cleared', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  await composer(p).click();
  assert.equal(await mode(p), 'INSERT');
  await p.locator('#status').click({ position: { x: 1000, y: 13 } });  // blank bar, past its buttons
  await settle(p);
  assert.equal(await mode(p), 'NORMAL');
  const b = await p.locator('.pane.focus .m-asst p').first().boundingBox();
  await p.mouse.click(b.x + 10, b.y + 8);
  await settle(p);
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'reader on');
  await p.locator('#status').click({ position: { x: 1000, y: 13 } });  // blank bar, past its buttons
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
  assert.equal(await p.locator('.pane.focus .m-edit .cm-content').evaluate(el => { const [a, b] = window.__skein.at(el); return window.__skein.val(el).slice(a, b); }), 'regression');
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
  assert.equal(await composer(p).evaluate(el => window.__skein.at(el)[0]), 7);
});

await test('launcher: j walks from the controls to the chips and the cards', async p => {
  await p.locator('#side').getByText('New thread').first().click();
  const T = p.locator('.pane.focus .newp .cm-content:visible');
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
  // a reply skips paint off screen (content-visibility), which clips at its edge: the ring must fit inside the clip margin
  const fit = await p.evaluate(() => {
    const b = document.querySelector('.pane.focus .m-acts .kcur'), r = b.closest('.reply');
    const bs = getComputedStyle(b), rs = getComputedStyle(r);
    const ring = parseFloat(bs.outlineWidth) + parseFloat(bs.outlineOffset);
    return rs.contentVisibility !== 'auto' || parseFloat(rs.overflowClipMargin || '0') >= ring;
  });
  assert.ok(fit, 'the ring is not clipped by the reply');
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
  assert.match(sel, /^It is a sequential scan/, `starts at the answer's first line, not "Worked for" (Josh, 2026-11-22): ${sel.slice(0, 40)}`);
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
  const box = p.locator('.pane.focus .m-edit .cm-content');
  await box.waitFor();
  await box.fill(Array.from({ length: 30 }, (_, i) => (i % 5 === 3 ? '' : `line ${i}`)).join('\n'));
  await box.press('Escape');
  // the block cursor is inside the box's visible part
  const seen = () => box.evaluate(el => {
    const sc = el.closest('.cm-scroller'), r = sc.getBoundingClientRect(), c = sc.querySelector('.cm-fat-cursor, .cm-cursor-primary');
    if (!c) return false;
    const b = c.getBoundingClientRect(); return b.height > 0 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
  });
  const sc = f => box.evaluate((el, f) => { const s = el.closest('.cm-scroller'); return f === 'top' ? s.scrollTop : s.scrollHeight > s.clientHeight; }, f);
  assert.ok(await sc('scrolls'), 'the box scrolls');
  await keys(p, 'G');
  assert.ok(await sc('top') > 0, 'G scrolled down');
  assert.ok(await seen(), 'G: cursor in view');
  await keys(p, 'g g');
  assert.ok(await sc('top') <= 4, 'gg: back at the top (within the padding)');
  for (let i = 0; i < 25; i++) { await p.keyboard.press('j'); assert.ok(await seen(), `j ${i + 1}: cursor in view`); }
  for (let i = 0; i < 25; i++) { await p.keyboard.press('k'); assert.ok(await seen(), `k ${i + 1}: cursor in view`); }
});

await test('composer: ctrl-d / ctrl-u in NORMAL page a long draft (wrapped lines too) and a short one', async p => {
  await openChat(p, 'Tidy PowerShell profile');
  const box = composer(p);
  const long = 'A paragraph long enough to wrap over several lines of the composer, '.repeat(6).trim();
  await box.fill(Array.from({ length: 24 }, (_, i) => (i % 6 === 2 ? long : `line ${i}`)).join('\n'));
  await box.press('Escape');   // NORMAL at the end of the draft (gg here would read the thread)
  await settle(p);
  const st = () => box.evaluate(el => {
    const sc = el.closest('.cm-scroller'), lh = parseFloat(getComputedStyle(el).lineHeight);
    return { top: Math.round(sc.scrollTop), max: sc.scrollHeight - sc.clientHeight, half: Math.round(sc.clientHeight / 2), lh, pos: window.__skein.at(el)[2], h: sc.clientHeight };
  });
  // the cursor's line on screen, against the top of the field
  const y = () => box.evaluate(el => {
    const sc = el.closest('.cm-scroller'), c = sc.querySelector('.cm-fat-cursor, .cm-cursor-primary');
    return c.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  });
  let s = await st(), presses = 0;
  assert.ok(s.max > s.half * 2, `the draft scrolls (${s.max})`);
  assert.ok(s.top >= s.max - s.lh, 'it starts at the bottom');
  const page = async (key, d) => {
    while (d > 0 ? s.top < s.max - s.lh : s.top > 0) {
      const y0 = await y();
      await keys(p, key); presses++;
      const n = await st(), y1 = await y();
      assert.ok(d > 0 ? n.top > s.top : n.top < s.top, `${key} ${presses} scrolled (${s.top} to ${n.top})`);
      assert.ok(d > 0 ? n.pos > s.pos : n.pos < s.pos, `${key} ${presses} moved the cursor`);
      assert.ok(y1 >= 0 && y1 + n.lh <= n.h + 1, `the cursor is in the field (${y1})`);
      if (Math.abs(n.top - s.top) >= n.half - 1) assert.ok(Math.abs(y1 - y0) <= n.lh, `a full step keeps the cursor's place (${y0} to ${y1})`);
      assert.ok(presses < 60); s = n;
    }
  };
  await page('Control+u', -1);
  await page('Control+d', 1);
  assert.equal(await mode(p), 'NORMAL');
  // a short draft: nothing scrolls, the cursor goes down half the field and back
  await box.press('i'); await box.fill('one\ntwo\nthree\nfour\nfive'); await box.press('Escape');
  const end = (await st()).pos;
  await keys(p, 'Control+u');
  const up = await st();
  assert.ok(up.pos < end && up.top === 0, `ctrl-u moved the cursor up a short draft (${end} to ${up.pos})`);
  await keys(p, 'Control+d');
  assert.ok((await st()).pos > up.pos, 'ctrl-d back down');
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
  assert.deepEqual(heads.map(h => h.trim()), ['Claude Code', 'Skein', 'Skills', 'More']);
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
  await p.locator('.pane.focus .m-edit .cm-content').waitFor();
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
  const box = p.locator('.pane.focus .comp .cm-content').first();
  await box.click();
  const back = async why => {
    await p.waitForFunction(() => !document.querySelector('.layer .menu') && document.activeElement?.matches('.pane.focus .comp .cm-content'), null, { timeout: 2000 }).catch(() => {});
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

await test('model picker: hovering a model previews every control that depends on it, the effort row stays dimmed, Ultracode only for a model that has it', async p => {
  await p.locator('.pane.focus .comp .cf [title="Model and effort"]').click();
  const menu = p.locator('.menu.model'); await menu.waitFor();
  const state = () => menu.evaluate(m => ({ h: Math.round(m.getBoundingClientRect().height), pins: m.querySelectorAll('.m-pin > *').length, none: !!m.querySelector('.eff.none'), ultra: [...m.querySelectorAll('.mi')].some(x => x.textContent.includes('Ultracode')) }));
  const s0 = await state();
  assert.equal(s0.pins, 3, 'effort, Ultracode and Fast mode'); assert.ok(!s0.none && s0.ultra);
  await menu.locator('.mi', { hasText: 'Haiku 4.5' }).hover(); await settle(p, 200);
  const s1 = await state();
  assert.ok(s1.none, 'the effort row stays, dimmed: Haiku 4.5 has no effort levels'); assert.ok(!s1.ultra, 'no Ultracode on Haiku 4.5'); assert.equal(s1.h, s0.h, 'the open menu keeps its height, so no row moves under the pointer');
  await menu.locator('.mi', { hasText: 'GPT-6.2 Sol' }).hover(); await settle(p, 200);
  const s2 = await state();
  assert.ok(!s2.none, 'Sol has levels'); assert.ok(!s2.ultra, 'no Ultracode row for a Codex model'); assert.equal(s2.pins, 2, 'effort and Codex\'s Fast'); assert.equal(s2.h, s0.h);
  await menu.locator('.mi', { hasText: 'Opus 5.5' }).hover(); await settle(p, 200);
  const s3 = await state();
  assert.ok(!s3.none && s3.ultra, 'back on a Claude model: both rows');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
});

await test('reader: a double- or triple-click drag that ends past a paragraph keeps its selection in VISUAL', async p => {
  await openChat(p, 'Fix session-restore race');
  await openAll(p);
  const para = p.locator('.pane.focus .m-asst p').first();
  const tail = (await para.innerText()).trim().slice(-12);
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
    assert.ok(r.text.includes(tail), `${why}: through the paragraph's end (${JSON.stringify(r.text.slice(-30))})`);
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
/** The chip as drawn: its colour and background, and where its icon sits against its words. */
const chipLook = p => p.evaluate(() => {
  const comp = document.querySelector('.pane.focus .compw'), toks = [...comp.querySelectorAll('.cm-content .tok')], tok = toks[0];
  const icon = comp.querySelector('.cm-content .qi svg'), ib = icon?.getBoundingClientRect(), cs = getComputedStyle(tok);
  const left = Math.min(...toks.flatMap(t => [...t.getClientRects()].map(r => r.left))), top = Math.min(...toks.map(t => t.getBoundingClientRect().top)), bottom = Math.max(...toks.map(t => t.getBoundingClientRect().bottom));
  return {
    color: cs.color, blue: getComputedStyle(document.documentElement).getPropertyValue('--blue').trim(), bg: cs.backgroundColor, hot: tok.classList.contains('hot'), on: tok.classList.contains('on'),
    icon: !!icon && (getComputedStyle(icon).color === cs.color || tok.classList.contains('on')),
    iconIn: !!ib && ib.left >= left - 1 && ib.right <= left + 22 && ib.top >= top - 2 && ib.bottom <= bottom + 2,
  };
});
/** The composer's selection, from its editor. */
const compSel = p => p.evaluate(() => { const s = window.__skein.cm('.pane.focus .compw'); return [Math.min(s.head, s.anchor), Math.max(s.head, s.anchor)]; });
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

await test('quote chip: a chat icon, then the words in blue with no pill (dark and light)', async p => {
  await quoteFirst(p);
  for (const theme of ['dark', 'light']) {
    await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    await settle(p, 60);
    const c = await chipLook(p);
    assert.equal(c.color, rgb(c.blue), `${theme}: the words are blue`);
    assert.equal(c.bg, 'rgba(0, 0, 0, 0)', `${theme}: no pill while idle`);
    assert.ok(c.icon && c.iconIn, `${theme}: the blue chat icon sits at the chip's start`);
  }
  const v = await composer(p).inputValue();
  assert.ok(v.startsWith('⁣  “'), 'the icon holds its own space in the text');
});

await test('quote chip: typed words stay the normal colour, and INSERT shows the caret', async p => {
  await quoteFirst(p);
  await p.keyboard.type('why');
  const [plain, caret] = await p.evaluate(() => {
    const ln = document.querySelector('.pane.focus .compw .cm-line');
    return [getComputedStyle(ln).color === getComputedStyle(document.body).color, !!document.querySelector('.pane.focus .compw .cm-cursor-primary')];
  });
  assert.ok(plain, 'words outside the chip use --fg');
  assert.ok(caret, 'the INSERT caret still shows');
});

await test('quote chip: hover gives it a soft fill and the x; leaving takes both away', async p => {
  await quoteFirst(p);
  const tok = await p.locator('.pane.focus .compw .cm-content .tok').last().boundingBox();
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
  await keys(p, 'Escape 0');
  assert.ok((await chipLook(p)).on, 'NORMAL: the block is the whole chip');
  assert.ok((await chipLook(p)).icon, 'NORMAL: the icon shows on the block');
  await keys(p, 'v l');
  assert.equal(await mode(p), 'VISUAL');
  const [a, b] = await compSel(p);
  assert.ok(a === 0 && b >= end, `VISUAL: the selection takes the chip and goes on (${a}, ${b}, ${end})`);
  const c = await chipLook(p);
  assert.ok(c.iconIn, 'VISUAL: the icon still shows');
  assert.equal(c.color, rgb(c.blue), 'VISUAL: the words stay blue under the selection');
});

await test('quote chip: removed from the keyboard, icon and all (x in NORMAL, d in VISUAL)', async p => {
  await quoteFirst(p);
  await p.keyboard.type('why');
  await keys(p, 'Escape 0 x');
  assert.equal(await p.locator('.pane.focus .compw .cm-content .tok').count(), 0);
  assert.equal(await p.locator('.pane.focus .compw .qi').count(), 0, 'no icon left behind');
  await keys(p, 'u');
  assert.equal(await p.locator('.pane.focus .compw .qi svg').count(), 1, 'undo brings the chip and its icon back');
  const tok = await p.locator('.pane.focus .compw .cm-content .tok').last().boundingBox();
  await p.mouse.move(tok.x + tok.width / 2, tok.y + tok.height / 2);
  await p.locator('.tokx').waitFor();   // still a quote (it lights up its source), not just its words
  await p.mouse.move(tok.x, tok.y - 150);
  await keys(p, '0 v d');
  assert.equal(await p.locator('.pane.focus .compw .cm-content .tok').count(), 0, 'VISUAL d takes it whole');
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
  const xs = await p.evaluate(() => [...document.querySelectorAll('.pane.focus .compw .qi svg')].map(s => s.getBoundingClientRect().left));
  const ts = await p.evaluate(() => [...new Set([...document.querySelectorAll('.pane.focus .compw .tok[data-q]')].map(s => s.dataset.q))].map(q => Math.min(...[...document.querySelectorAll(`.pane.focus .compw .tok[data-q="${q}"]`)].map(s => s.getBoundingClientRect().left))));
  assert.equal(xs.length, 2);
  assert.ok(Math.abs(xs[0] - ts[0]) < 3 && Math.abs(xs[1] - ts[1]) < 3, 'each icon at its own chip');
});

await test('popups keep the side they opened on: filtering the / menu and the model picker never flips them', async p => {
  await p.setViewportSize({ width: 1100, height: 800 });
  const side = () => p.evaluate(() => { const m = document.querySelector('.menu'), c = document.querySelector('.pane.focus .comp'); return m && (m.getBoundingClientRect().top >= c.getBoundingClientRect().bottom - 1 ? 'below' : 'above'); });
  await p.locator('.pane.focus .comp .cm-content').first().click();
  await p.keyboard.type('/'); await settle(p, 250);
  const first = await side();
  assert.equal(first, 'below', 'the whole list has no room above the new-thread composer');
  for (const k of ['c', 'o', 'm']) { await p.keyboard.type(k); await settle(p); assert.equal(await side(), first, `still ${first} after /…${k}`); }
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.locator('.pane.focus .comp .cf [title="Model and effort"]').click();
  await p.locator('.menu.model').waitFor(); await settle(p, 250);
  const m = await side();
  for (const q of ['h', 'a', 'i']) { await p.keyboard.type(q); await settle(p); assert.equal(await side(), m, 'the model picker stays put while searching'); }
});

await test('model picker: stays inside the window after its list is measured again (rows past Haiku 4.5 stay reachable)', async p => {
  await p.setViewportSize({ width: 1100, height: 620 });
  await p.locator('.pane.focus .comp .cf [title="Model and effort"]').click();
  const menu = p.locator('.menu.model'); await menu.waitFor(); await settle(p, 250);
  const inside = async why => { const b = await menu.boundingBox(); assert.ok(b.y + b.height <= 620, `${why}: bottom ${Math.round(b.y + b.height)} inside 620`); };
  await inside('open');
  // a search re-measures the list; one that ends where it started used to drop the height cap
  await p.keyboard.type('o'); await settle(p); await p.keyboard.press('Backspace'); await settle(p);
  await inside('after a search');
  for (let i = 0; i < 12; i++) await p.keyboard.press('ArrowDown');
  await settle(p);
  await inside('after moving down the list');
  const sel = await menu.locator('.mi.sel').boundingBox();
  assert.ok(sel.y >= 0 && sel.y + sel.height <= 620, 'the selected row is in view');
});

await test('/ menu: Claude Code lists its everyday commands first with their own icons and short hints, skills and the rest after', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).click();
  await p.keyboard.type('/');
  const menu = p.locator('.menu.composer-menu'); await menu.waitFor(); await settle(p, 250);
  assert.deepEqual(await menu.locator('.mi.head').allInnerTexts(), ['Claude Code', 'Skein', 'Skills', 'More']);
  const rows = await menu.locator('.mi:not(.head)').evaluateAll(xs => xs.map(x => ({ l: x.querySelector('.ml').textContent, h: x.querySelector('.mh')?.textContent ?? '', i: x.querySelector('.mic svg')?.getAttribute('class') ?? '' })));
  const core = rows.slice(0, rows.findIndex(r => r.l === 'Side chat'));
  assert.deepEqual(core.map(r => r.l), ['Clear', 'Compact', 'Model', 'Effort', 'Code review', 'Context', 'Usage', 'MCP', 'Init']);
  assert.ok(core.every(r => !/bolt/.test(r.i)), 'each everyday command has its own icon');
  assert.ok(core.every(r => r.h.length <= 30), 'short hints');
  assert.equal(rows.find(r => r.l === 'Batch').h, 'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR', 'other built-ins keep the harness text, cut to its first clause');
  assert.equal(rows.find(r => r.l === 'Claude api').h, 'Reference for the Claude API / Anthropic SDK');
  // typing: one list, no headings
  await p.keyboard.type('co'); await settle(p);
  assert.equal(await menu.locator('.mi.head').count(), 0);
  assert.deepEqual((await menu.locator('.mi .ml').allInnerTexts()).slice(0, 4), ['Compact', 'Code review', 'Context', 'Color']);
});

await test('reader: "Worked for" is not part of the answer\'s selection (mouse, V k, v on its row)', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  const reply = p.locator('.pane.focus .reply').first(), sum = reply.locator('.turn > summary');
  const para = reply.locator('p').filter({ hasNot: p.locator('xpath=ancestor::details[contains(@class,"turn")]') }).last();
  const sel = () => p.evaluate(() => getSelection().toString());
  // a drag from the answer up past the header stops at the answer
  const pb = await para.boundingBox(), sb = await sum.boundingBox();
  await p.mouse.move(pb.x + 60, pb.y + 8); await p.mouse.down();
  await p.mouse.move(sb.x + 4, sb.y + sb.height / 2, { steps: 8 }); await p.mouse.up(); await settle(p, 200);
  let s = await sel();
  assert.ok(s.length > 0 && !/Worked/.test(s), `drag: ${JSON.stringify(s.slice(0, 40))}`);
  // V then k: the selection stays in the answer
  await keys(p, 'Escape'); await keys(p, 'Escape');
  await para.dblclick({ position: { x: 30, y: 8 } }); await keys(p, 'Escape');
  await keys(p, 'Shift+V k k k'); s = await sel();
  assert.equal(await mode(p), 'V-LINE'); assert.ok(s.length > 0 && !/Worked/.test(s), `V k: ${JSON.stringify(s.slice(0, 40))}`);
  // the cursor on the header row: v starts at the answer below
  await keys(p, 'Escape');
  for (let i = 0; i < 12 && !(await sum.evaluate(e => e.classList.contains('rowcur'))); i++) await keys(p, 'k');
  assert.ok(await sum.evaluate(e => e.classList.contains('rowcur')), 'the cursor reaches the header row');
  await keys(p, 'v l'); s = await sel();
  assert.equal(await mode(p), 'VISUAL'); assert.ok(s.length > 0 && !/Worked/.test(s), `v on the header: ${JSON.stringify(s)}`);
  await keys(p, 'Escape');
});

await test('/ menu: shrinks to fit as you type, on the side it opened on', async p => {
  await p.setViewportSize({ width: 1100, height: 620 });
  await p.locator('.pane.focus .comp .cm-content').first().click();
  await p.keyboard.type('/'); await settle(p, 250);
  const menu = p.locator('.menu.composer-menu');
  const full = await menu.boundingBox();
  await p.keyboard.type('model'); await settle(p);
  const one = await menu.boundingBox(), row = await menu.locator('.mi').first().boundingBox();
  assert.equal(await menu.locator('.mi').count(), 1);
  assert.ok(one.height < row.height + 24, `fits its one row (${Math.round(one.height)}px for a ${Math.round(row.height)}px row)`);
  assert.equal(Math.round(one.y), Math.round(full.y), 'same side, same edge');
});

await test('timeline ticks: on hover each tick is lighter the further it is from the pointer (light and dark)', async p => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme }); await settle(p, 200);
    await openChat(p, 'Walk through the backlog');
    const ticks = p.locator('.pane.focus .ticks button');
    const mid = Math.floor((await ticks.count()) / 2), at = ticks.nth(mid);
    await at.scrollIntoViewIfNeeded(); await at.hover(); await settle(p, 300);
    // distance of each tick's color from the hovered one, for the hovered tick and four on each side
    let far = 0;
    const d = await ticks.evaluateAll((bs, m) => {
      const rgb = b => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = getComputedStyle(b.querySelector('i')).backgroundColor; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const h = rgb(bs[m]), dist = b => { const x = rgb(b); return Math.hypot(x[0] - h[0], x[1] - h[1], x[2] - h[2]); };
      return { d: [1, 2, 3, 4].map(k => [dist(bs[m - k]), dist(bs[m + k])]), far: dist(bs[m + 10] || bs[m - 10]) };
    }, mid).then(r => { far = r.far; return r.d; });
    for (let k = 1; k < d.length; k++) for (const s of [0, 1]) assert.ok(d[k][s] >= d[k - 1][s] - 0.5, `${scheme}: tick ${k + 1} away is no darker than tick ${k} (${JSON.stringify(d)})`);
    // not all near-black: the next tick is already past halfway to a resting tick's shade
    assert.ok(d[0][0] > far * 0.45 && d[0][1] > far * 0.45, `${scheme}: the next tick is clearly lighter (${JSON.stringify(d[0])} of ${far})`);
    await p.mouse.move(600, 400);
  }
});

await test('timeline ticks: a green dot follows the tick of a turn that changed files, and only those', async p => {
  await openChat(p, 'Walk through the backlog');
  const r = await p.evaluate(() => {
    const bs = [...document.querySelectorAll('.pane.focus .ticks button')];
    const dots = bs.map(b => getComputedStyle(b, '::after').content !== 'none');
    const green = bs.filter(b => b.classList.contains('changed')).map(b => getComputedStyle(b, '::after').backgroundColor);
    return { n: bs.length, ed: bs.map((b, i) => b.classList.contains('changed') ? i : -1).filter(i => i >= 0), dots: dots.filter(Boolean).length, green: [...new Set(green)], label: bs.find(b => b.classList.contains('changed'))?.getAttribute('aria-label') };
  });
  assert.deepEqual(r.ed, [3, 10, 17, 24, 31, 38, 45, 52, 59, 66], 'every 7th item changed a file');
  assert.equal(r.dots, r.ed.length, 'a dot on those ticks only');
  assert.equal(r.green.length, 1); assert.match(r.label, /changed files/);
});

await test('reader: ctrl-d / ctrl-u scroll half a page and the cursor goes along, staying where it was on screen', async p => {
  await openChat(p, 'Walk through the backlog');
  const th = p.locator('.pane.focus .thread');
  await th.evaluate(e => { e.scrollTop = 0; }); await settle(p, 200);
  await readAt(p, 'Item 3 needs one more test');
  assert.equal(await mode(p), 'NORMAL');
  const st = () => p.evaluate(() => { const t = document.querySelector('.pane.focus .thread'), s = getSelection(), r = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null; const h = (CSS.highlights?.get('vcur'))?.values().next().value; const hr = h ? h.getBoundingClientRect() : r; return { top: t.scrollTop, half: Math.round(t.clientHeight / 2), y: Math.round(hr?.top ?? -1), text: (h?.startContainer || s.anchorNode)?.parentElement?.closest('.m-user, .m-asst')?.innerText.trim().slice(0, 30) }; });
  const s0 = await st();
  await keys(p, 'Control+d'); await settle(p, 200);
  const s1 = await st();
  assert.ok(Math.abs(s1.top - s0.top - s0.half) <= 2, `scrolled half a page (${s0.top} to ${s1.top}, half ${s0.half})`);
  assert.ok(Math.abs(s1.y - s0.y) < 40, `the cursor stays about where it was on screen (${s0.y} to ${s1.y})`);
  assert.notEqual(s1.text, s0.text, `the cursor moved on (${s0.text} to ${s1.text})`);
  assert.equal(await mode(p), 'NORMAL');
  await keys(p, 'Control+u'); await settle(p, 200);
  const s2 = await st();
  assert.ok(Math.abs(s2.top - s0.top) <= 2, `ctrl-u scrolls back (${s2.top})`);
});

/** Page the reader with ctrl-d to the bottom of the thread, then ctrl-u back to the top. Every press must scroll the
 *  thread (by half its height, less only at an end) and leave the cursor on screen; a press that scrolls nowhere,
 *  or that the reader scrolls back to where the cursor was, is the stall. */
async function pageThrough(p) {
  const st = () => p.evaluate(() => {
    const t = document.querySelector('.pane.focus .thread'), b = t.getBoundingClientRect();
    const row = document.querySelector('.pane.focus .rowcur'), h = CSS.highlights?.get('vcur')?.values().next().value;
    const r = row ? row.getBoundingClientRect() : h?.getBoundingClientRect();
    const n = row ?? h?.startContainer, el = n && (n.nodeType === 1 ? n : n.parentElement);
    const drawn = !!el && el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) && !el.closest('details:not([open]) > :not(summary)');
    const shows = !!r && (row && r.height > b.height ? r.bottom > b.top && r.top < b.bottom : r.top >= b.top - 1 && r.bottom <= b.bottom + 1);
    return { top: Math.round(t.scrollTop), max: t.scrollHeight - t.clientHeight, half: Math.round(t.clientHeight / 2), shows: shows && drawn };
  });
  // pictures decode and a message opened with Show more grows: page only once the thread's height holds still
  await p.waitForFunction(() => new Promise(ok => { const t = document.querySelector('.pane.focus .thread'), h = t.scrollHeight; setTimeout(() => ok(t.scrollHeight === h), 400); }));
  let s = await st(), downs = 0, ups = 0;
  assert.ok(s.max > s.half * 3, `the thread is several pages long (${s.max})`);
  while (s.top < s.max - 1) {
    await keys(p, 'Control+d'); downs++;
    const n = await st();
    assert.ok(n.top > s.top, `ctrl-d ${downs} scrolled (${s.top} to ${n.top} of ${n.max})`);
    assert.ok(n.top - s.top <= n.half + 2 && (n.top - s.top >= n.half - 2 || n.top >= n.max - 1), `by half a page (${n.top - s.top}, half ${n.half}, at ${n.top} of ${n.max})`);
    assert.ok(n.shows, `the cursor is on screen after ctrl-d ${downs}`);
    assert.ok(downs < 200); s = n;
  }
  while (s.top > 0) {
    await keys(p, 'Control+u'); ups++;
    const n = await st();
    assert.ok(n.top < s.top, `ctrl-u ${ups} scrolled (${s.top} to ${n.top})`);
    assert.ok(n.shows, `the cursor is on screen after ctrl-u ${ups}`);
    assert.ok(ups < 200); s = n;
  }
  assert.equal(await mode(p), 'NORMAL');
}

await test('reader: ctrl-d from the first line (gg) pages down a long thread, past its edit rows, and ctrl-u back', async p => {
  await openChat(p, 'Walk through the backlog');
  await composer(p).press('Escape'); await keys(p, 'k g g'); await settle(p);
  assert.equal(await p.locator('.pane.focus .thread').evaluate(e => e.scrollTop), 0);
  await pageThrough(p);
});

await test('reader: ctrl-d / ctrl-u never stall on tall blocks (open tool output, diffs, subagents) in a short window', async p => {
  await openChat(p, 'Fix session-restore race');
  await composer(p).press('Escape'); await keys(p, 'k z Shift+R g g'); await settle(p);
  await pageThrough(p);
}, { viewport: { width: 1280, height: 420 } });

await test('reader: ctrl-d / ctrl-u cross a picture taller than the window and a long message', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  for (const h of [900, 120, 600]) {
    await p.locator('.pane.focus .comp input[type=file]').setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer: await pngOf(260, h) });
    await p.locator('.pane.focus .atts .att img').waitFor();
    await composer(p).fill(LONG); await composer(p).press('Enter');
    await settle(p, 700); await p.waitForFunction(() => !document.querySelector('.pane.focus .live'));   // the reply has ended
  }
  await p.locator('.pane.focus .m-user .m-more').nth(1).click();   // one long message open, all of it
  await settle(p, 400);
  await p.locator('.pane.focus .m-asst').last().click(); await settle(p);   // into the reader
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'reading');
  await keys(p, 'g g'); await settle(p);
  await pageThrough(p);
}, { viewport: { width: 1280, height: 400 } });

await test('reader: a cursor on the running turn\'s timer stays drawn as the timer ticks', async p => {
  await openChat(p, 'Refactor queue worker');
  await p.locator('.pane.focus .live .dim').click(); await settle(p);
  assert.equal(await mode(p), 'NORMAL');
  const cur = () => p.evaluate(() => { const h = CSS.highlights.get('vcur')?.values().next().value; return h ? { text: h.startContainer.data, on: !h.collapsed && h.startContainer.parentElement.matches('.live .dim') } : null; });
  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    const c = await cur();
    assert.ok(c?.on, `the cursor is drawn on the timer (${JSON.stringify(c)})`);
    seen.add(c.text); await settle(p, 200);
  }
  assert.ok(seen.size >= 2, `the timer ticked (${[...seen]})`);
});

// ---- links in a reply: a click puts the reader's cursor on the link and follows it; enter / g x do from the keys ----
async function linksReply(p) {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).fill('Show me the links');
  await composer(p).press('Enter');
  await p.locator('.pane.focus .m-asst a.clink', { hasText: 'an odd one' }).waitFor();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .live'));
  await p.evaluate(() => { window.__external = []; window.__opened = []; });
}
const link = (p, text) => p.locator('.pane.focus .m-asst a.clink', { hasText: text });
/** The text of the link the reader's cursor is on, or null. */
const cursorLink = p => p.evaluate(() => { const n = [...(CSS.highlights.get('vcur') || [])][0]?.startContainer; const el = n && (n.nodeType === 1 ? n : n.parentElement); return el?.closest('.clink')?.textContent ?? null; });
const toastText = p => p.locator('.toast').last().innerText();

await test('links in a reply: a click puts the cursor on the link and opens it (web in the browser, HTML in its app)', async p => {
  await linksReply(p);
  await link(p, 'the docs').click();
  await settle(p);
  assert.equal(await mode(p), 'NORMAL');
  assert.equal(await cursorLink(p), 'the docs', 'the cursor is where the click was');
  assert.deepEqual(await p.evaluate(() => window.__external), ['https://example.com/skein']);
  await link(p, 'Open the mockup HTML').click();
  await settle(p);
  assert.equal(await cursorLink(p), 'Open the mockup HTML');
  assert.deepEqual(await p.evaluate(() => window.__opened), ['~/projects/skein/mockups/index.html'], 'a page opens in the system browser');
  await link(p, 'an odd one').click();
  assert.match(await toastText(p), /Skein does not open ftp: links/);
  assert.ok(!(await p.locator('.pane.focus .m-edit').count()), 'no edit box, no navigation');
});

await test('links in a reply: a file link opens in Skein at its line, from a relative or an absolute path', async p => {
  await linksReply(p);
  await link(p, 'the README').click();
  await p.waitForFunction(() => window.__skein.cm('.file-v .src')?.text.startsWith('# Skein') && window.__skein.cm('.file-v .src').line === 3);
  await linksReply(p);
  await link(p, 'the types').click();
  await p.waitForFunction(() => /interface Session/.test(window.__skein.cm('.file-v .src')?.text || '') && window.__skein.cm('.file-v .src').line === 2);
});

await test('links in a reply: enter and g x follow the link under the cursor', async p => {
  await linksReply(p);
  await composer(p).press('Escape');
  await keys(p, 'k');
  // to the link's text with search, then enter
  await keys(p, '/'); await p.keyboard.type('the docs'); await keys(p, 'Enter');
  assert.equal(await cursorLink(p), 'the docs');
  await keys(p, 'Enter');
  assert.deepEqual(await p.evaluate(() => window.__external), ['https://example.com/skein']);
  assert.equal(await cursorLink(p), 'the docs', 'the cursor stays on it');
  await keys(p, 'g x');
  assert.equal(await p.evaluate(() => window.__external.length), 2, 'g x follows it too');
});

// ---- harness commands that only work in the harness's terminal UI: Skein acts on them instead ----
const threadOf = (p, title) => p.evaluate(t => window.__skein.S.threads.find(x => x.title === t), title);

await test('/approvals (Codex) and /permissions (Claude) open the permissions menu; nothing is sent', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('/approvals');
  await composer(p).press('Enter');
  await p.locator('.layer .menu.perms').waitFor();
  await p.keyboard.press('Escape');
  assert.equal((await composer(p).inputValue()).trim(), '');
  await openChat(p, 'Fix session-restore race');
  await composer(p).fill('/permissions');
  await settle(p); await p.keyboard.press('Escape');   // the menu closed: enter runs what is typed
  await keys(p, 'i'); await composer(p).press('Enter');
  await p.locator('.layer .menu.perms').waitFor();
  await p.keyboard.press('Escape');
});

await test('/effort high, /model <name> and /plan (Claude) set the thread at once; /effort alone opens the picker', async p => {
  await openChat(p, 'Fix session-restore race');
  const send = async text => { await composer(p).fill(text); await settle(p); if (await p.locator('.composer-menu').count()) { await p.keyboard.press('Escape'); await keys(p, 'i'); } await composer(p).press('Enter'); await settle(p); };
  await send('/effort high');
  await p.waitForFunction(() => window.__skein.S.threads.find(x => x.title === 'Fix session-restore race')?.effort === 'high');
  await send('/model sonnet');
  await p.waitForFunction(() => /sonnet/i.test(window.__skein.S.threads.find(x => x.title === 'Fix session-restore race')?.model ?? ''));
  await send('/plan sketch the fix first');
  await p.waitForFunction(() => window.__skein.S.threads.find(x => x.title === 'Fix session-restore race')?.perm === 'plan');
  assert.equal(await composer(p).inputValue(), 'sketch the fix first', 'the request stays, to send in Plan mode');
  await composer(p).fill('/effort'); await settle(p);
  await composer(p).press('Enter');   // picks the menu's row
  await p.locator('.menu.model .eff').waitFor();
  await p.keyboard.press('Escape');
});

await test('/mention (Codex) starts an @ file mention where it was', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('see /menti');
  await composer(p).press('Enter');
  await p.locator('.composer-menu .mi', { hasText: 'README.md' }).waitFor();
  assert.equal(await composer(p).inputValue(), 'see @');
});

await test('/diff (Codex) opens Changes beside the thread', async p => {
  await openChat(p, 'Add timestamps to chat rows');
  await composer(p).pressSequentially('/diff');
  await composer(p).press('Enter');
  await p.waitForFunction(() => [...document.querySelectorAll('.tb .tab')].some(t => /Changes/.test(t.textContent)));
});

await test('/new (Codex) and /clear (Claude) start a fresh thread with the same harness, folder and settings in this tab', async p => {
  for (const [title, cmd] of [['Add timestamps to chat rows', '/new'], ['Fix session-restore race', '/clear']]) {
    await openChat(p, title);
    const from = await threadOf(p, title);
    const before = await p.evaluate(() => window.__skein.S.threads.length);
    await composer(p).pressSequentially(cmd);
    await composer(p).press('Enter');
    await p.waitForFunction(n => window.__skein.S.threads.length === n + 1, before);
    const made = await p.evaluate(() => window.__skein.S.threads[0]);
    assert.equal(made.harness, from.harness); assert.equal(made.dir, from.dir); assert.equal(made.machine, from.machine);
    assert.equal(made.perm, from.perm);
    await p.waitForFunction(() => document.querySelector('.pane.focus .chat') && !document.querySelector('.pane.focus .m-user'));
  }
});
