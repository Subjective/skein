// VIM-MODEL rules that span surfaces: a menu's search field in NORMAL, Settings' two lists, counts and / ? n N
// in every reader (chat, scrollback, file, diff), and the shared register with the clipboard behind it.
import { assert, keys, mod, mode, settle, test } from './harness.mjs';

const layers = p => p.evaluate(() => window.__skein.S.layers.length);
const toastText = p => p.locator('.toast').last().innerText();
const menuInput = p => p.locator('.menu .m-s input').last();
/** The NORMAL block cursor in a menu's search field (drawn as text, .m-q): [from, to] like a selection. */
const caret = p => p.locator('.menu .m-s .m-q').last().evaluate(q => { const c = q.querySelector('.ncur'), r = document.createRange(); r.setStart(q, 0); r.setEndBefore(c); const a = r.toString().length; return [a, a + c.textContent.length]; });
const focusedTab = p => p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); const find = n => n.type === 'pane' ? (n.id === w.focus ? n : null) : find(n.a) || find(n.b); return find(w.tree).active; });

// ---------- a menu's search field ----------

test('menu search field: in NORMAL h l 0 $ w b move its cursor, x dw u edit, i A type again', async p => {
  await keys(p, `${mod}+k`);
  await p.keyboard.type('split right');
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL');
  assert.deepEqual(await caret(p), [10, 11], 'the block cursor sits on the last character');
  await keys(p, '0');
  assert.deepEqual(await caret(p), [0, 1]);
  await keys(p, 'l l');
  assert.deepEqual(await caret(p), [2, 3]);
  await keys(p, 'w');
  assert.deepEqual(await caret(p), [6, 7]);
  await keys(p, 'b h');
  assert.deepEqual(await caret(p), [0, 1], 'b back to the start, h stops at the edge');
  await keys(p, '$');
  assert.deepEqual(await caret(p), [10, 11]);
  await keys(p, '0 d w');
  assert.equal(await menuInput(p).inputValue(), 'right');
  await keys(p, 'x');
  assert.equal(await menuInput(p).inputValue(), 'ight');
  await keys(p, 'u u');
  assert.equal(await menuInput(p).inputValue(), 'split right');
  assert.equal(await mode(p), 'NORMAL');
  await keys(p, 'A');
  assert.equal(await mode(p), 'INSERT');
  await p.keyboard.type('x');
  assert.equal(await menuInput(p).inputValue(), 'split rightx');
  await keys(p, 'Escape 0 i');
  await p.keyboard.type('>');
  assert.equal(await menuInput(p).inputValue(), '>split rightx');
  await keys(p, 'Escape Escape');
  assert.equal(await layers(p), 0, 'esc esc: NORMAL, then closed');
});

test('menu search field: j k still move the list in NORMAL, with a count', async p => {
  await keys(p, `${mod}+k`);
  await keys(p, 'Escape');
  const sel = () => p.locator('.menu .mi.sel').innerText();
  const first = await sel();
  await keys(p, 'j');
  const second = await sel();
  assert.notEqual(first, second);
  await keys(p, 'k');
  assert.equal(await sel(), first);
  await keys(p, '2 j');
  const third = await sel();
  assert.notEqual(third, second);
  await keys(p, 'k');
  assert.equal(await sel(), second);
  assert.equal(await menuInput(p).inputValue(), '', 'the count did not reach the field');
});

test('model picker: in NORMAL (esc from its search field) h / l step its effort', async p => {
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  const seg = p.locator('.pane.focus .tb .seg button[aria-label^="Chat"]');
  if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
  const chip = p.locator('.pane.focus .cf .chip[title="Model and effort"]');
  await chip.click();
  await p.locator('.menu.model .eff').waitFor();
  const before = await chip.innerText();
  await keys(p, 'Escape');
  await keys(p, 'l');
  await p.waitForFunction(b => document.querySelector('.pane.focus .cf .chip[title="Model and effort"]')?.innerText !== b, before);
  await keys(p, 'h');
  await p.waitForFunction(b => document.querySelector('.pane.focus .cf .chip[title="Model and effort"]')?.innerText === b, before);
  await keys(p, 'Escape');
});

// ---------- Settings ----------

async function openSettings(p) {
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await p.locator('.menu.cmd').waitFor();
  await p.keyboard.type('settings');
  await keys(p, 'Enter');
  await p.locator('.settings').waitFor();
}
const section = p => p.locator('.settings-nav button.on').innerText();

test('settings: j k move sections, l enters the rows, h l change a value, esc steps back', async p => {
  await openSettings(p);
  assert.equal(await section(p), 'General');
  assert.ok(await p.locator('.settings-nav.kf').count(), 'the section list has the keys');
  await keys(p, 'j');
  assert.equal(await section(p), 'Appearance');
  await keys(p, 'j j j');
  assert.equal(await section(p), 'Machines');
  await keys(p, 'k k k');
  assert.equal(await section(p), 'Appearance');
  await keys(p, 'l');
  assert.equal(await p.locator('.settings-nav.kf').count(), 0);
  assert.match(await p.locator('.s-row.cur').innerText(), /Theme/);
  const theme = () => p.evaluate(() => window.__skein.S.settings.theme);
  const t0 = await theme();
  await keys(p, 'l');
  await p.waitForFunction(t => window.__skein.S.settings.theme !== t, t0);
  await keys(p, 'h');
  await p.waitForFunction(t => window.__skein.S.settings.theme === t, t0);
  await keys(p, 'Escape k l j');
  assert.match(await p.locator('.s-row.cur').innerText(), /Sidebar/);
  await keys(p, 'Escape');
  assert.ok(await p.locator('.settings-nav.kf').count(), 'esc goes back to the section list');
  assert.equal(await p.locator('.s-row.cur').count(), 0);
  assert.equal(await layers(p), 1);
  await keys(p, 'Escape');
  assert.equal(await layers(p), 0, 'esc again closes');
});

test('settings: H and L do nothing in the dialog; tab enters the rows, h on a button row goes back', async p => {
  await ldrNewTab(p);
  const tabs = () => p.locator('.pane.focus .tab').count();
  const n = await tabs();
  await openSettings(p);
  await keys(p, 'L');
  await keys(p, 'H');
  assert.equal(await section(p), 'General');
  assert.equal(await tabs(), n);
  assert.equal(await layers(p), 1);
  await keys(p, 'j j Tab j j');
  assert.match(await p.locator('.s-row.cur').innerText(), /vimrc/);
  await keys(p, 'h');
  assert.ok(await p.locator('.settings-nav.kf').count(), 'h on a row with no value goes back to the sections');
  assert.equal(await section(p), 'Vim');
});
test('settings: the key cursor shows only while the keys are in use; a click leaves no ring or filled row', async p => {
  await openSettings(p);
  assert.ok(await p.locator('.settings-nav.kf').count(), 'opened by keys: the section list shows its cursor');
  const nav = p.locator('.settings-nav button', { hasText: 'Machines' });
  await nav.click();
  assert.equal(await section(p), 'Machines');
  assert.equal(await p.locator('.settings-nav.kf').count(), 0, 'a click leaves no ring');
  const last = p.locator('.s-row').last();
  await last.hover(); await p.mouse.move(5, 5); await settle(p);
  assert.equal(await p.locator('.s-row.cur').count(), 0, 'a row the pointer left is not filled');
  await keys(p, 'k');
  assert.match(await p.locator('.s-row.cur').innerText(), /build-07/, 'a key brings the cursor back, on the rows the pointer was in');
  await keys(p, 'Escape k');
  assert.equal(await section(p), 'Notifications');
  assert.ok(await p.locator('.settings-nav.kf').count());
  assert.equal(await p.locator('.settings-nav button:focus-visible').evaluateAll(bs => bs.filter(b => getComputedStyle(b).outlineStyle !== 'none').length), 0, 'no browser focus ring on top');
  await keys(p, 'l');
  assert.match(await p.locator('.s-row.cur').innerText(), /Notify me/);
  await p.mouse.move(400, 300); await p.mouse.move(420, 320); await settle(p);
  assert.equal(await p.locator('.s-row.cur').count(), 0, 'moving the pointer hides the key cursor');
});

test('settings: rows sit in cards, descriptions carry no key or OS hints', async p => {
  await openSettings(p);
  for (const sec of ['General', 'Appearance', 'Vim', 'Notifications', 'Machines']) {
    await p.locator('.settings-nav button', { hasText: sec }).click();
    assert.equal(await p.locator('.s-body .s-row').count(), await p.locator('.s-card .s-row').count(), `${sec}: every row is in a card`);
    assert.doesNotMatch(await p.locator('.s-body').innerText(), /\bzr\b|\bzm\b|macOS|input sources/);
  }
});

test('settings: Agent work previews each density, on hover and under the key cursor', async p => {
  await openSettings(p);
  await keys(p, 'j l j');
  assert.match(await p.locator('.s-row.cur').innerText(), /Agent work/);
  const prev = p.locator('.dprev');
  const d0 = await p.evaluate(() => window.__skein.S.settings.density || 'compact');
  assert.equal(await prev.count(), 1, 'the key cursor shows the current density');
  await keys(p, 'l');
  await p.waitForFunction(d => (window.__skein.S.settings.density || 'compact') !== d, d0);
  assert.equal(await prev.count(), 1);
  const row = p.locator('.s-row', { hasText: 'Agent work' });
  await row.getByRole('button', { name: 'Detailed' }).hover();
  assert.match(await prev.innerText(), /Edited math\.ts/, 'Detailed opens every step');
  await row.getByRole('button', { name: 'Compact' }).hover();
  assert.doesNotMatch(await prev.innerText(), /Edited/, 'Compact folds the turn');
  await row.getByRole('button', { name: 'Balanced' }).hover();
  assert.match(await prev.innerText(), /Edited 2 files, ran 2 commands/, 'Balanced shows the runs folded');
  await p.mouse.move(5, 5); await settle(p);
  assert.equal(await prev.count(), 0, 'leaving the choice hides it');
  await p.evaluate(d => window.__skein.api.app.setSettings({ density: d }), d0);
});
async function ldrNewTab(p) { await keys(p, 'Control+Space c'); }

// ---------- readers: chat ----------

async function openChat(p, title) {
  await p.locator('#side').getByText(title, { exact: true }).first().click();
  const seg = p.locator('.pane.focus .tb .seg button[aria-label^="Chat"]');
  if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
  await p.waitForSelector('.pane.focus .chat .col[data-read] > *');
}
/** The chat reader's cursor: the text from the cursor on (a few characters) and where it is; on a row (a tool call,
 *  which takes the cursor whole) the row's text. */
const chatCur = p => p.evaluate(() => {
  const row = document.querySelector('.pane.focus .rowcur');
  if (row) return { at: 'row:' + [...document.querySelectorAll('.pane.focus [data-read] *')].indexOf(row), text: row.textContent };
  const r = [...(CSS.highlights.get('vcur') || [])][0]; if (!r) return null;
  const n = r.startContainer, all = [...document.querySelectorAll('.pane.focus [data-read] *')].indexOf(n.parentElement);
  return { at: `${all}:${r.startOffset}`, text: n.data.slice(r.startOffset, r.startOffset + 12) };
});
const searchHits = p => p.evaluate(() => CSS.highlights.get('rsearch')?.size || 0);

test('chat reader: counts repeat motions (3w is w w w)', async p => {
  await openChat(p, 'Fix session-restore race');
  await keys(p, 'Escape g g');
  const top = await chatCur(p);
  await keys(p, '3 w');
  const counted = await chatCur(p);
  await keys(p, 'g g w w w');
  assert.deepEqual(await chatCur(p), counted);
  assert.notDeepEqual(counted, top);
  await keys(p, 'g g 2 j');
  const two = await chatCur(p);
  await keys(p, 'g g j j');
  assert.deepEqual(await chatCur(p), two);
});

test('chat reader: / searches, highlights every match, n N step and wrap with a notice, esc clears', async p => {
  await openChat(p, 'Fix session-restore race');
  await keys(p, 'Escape g g');
  await keys(p, '/');
  await p.locator('.menu.rsearch').waitFor();
  assert.equal(await mode(p), 'INSERT');
  await p.keyboard.type('restore');
  await settle(p);
  const hits = await searchHits(p);
  assert.ok(hits >= 2, `matches highlighted (${hits})`);
  await keys(p, 'Enter');
  assert.equal(await layers(p), 0);
  const first = await chatCur(p);
  assert.match(first.text.toLowerCase(), /restore/);
  await keys(p, 'n');
  const second = await chatCur(p);
  assert.match(second.text.toLowerCase(), /restore/);
  assert.notDeepEqual(second, first);
  await keys(p, 'N');
  assert.deepEqual(await chatCur(p), first);
  await keys(p, 'g g N');
  assert.match(await toastText(p), /continuing at BOTTOM/);
  assert.match((await chatCur(p)).text.toLowerCase(), /restore/);
  await keys(p, 'Escape');
  assert.equal(await searchHits(p), 0, 'esc clears the search first');
  assert.ok(await p.locator('.pane.focus [data-read].rd').count(), 'and the reader is still on');
  await keys(p, 'Escape');
  assert.equal(await p.locator('.pane.focus [data-read].rd').count(), 0);
});

test('chat reader: ? searches backwards', async p => {
  await openChat(p, 'Fix session-restore race');
  await keys(p, 'Escape k');
  await keys(p, '?');
  await p.locator('.menu.rsearch').waitFor();
  assert.match(await p.locator('.menu.rsearch .pfx').innerText(), /\?/);
  await p.keyboard.type('restore');
  await keys(p, 'Enter');
  assert.match((await chatCur(p)).text.toLowerCase(), /restore/);
});

// ---------- readers: terminal scrollback ----------

test('scrollback: counts move by lines, / finds, n wraps with a notice, esc clears then leaves', async p => {
  await keys(p, 'Escape Control+Space %');
  await p.locator('.pane.focus .xterm').waitFor();
  await settle(p, 300);
  for (const w of ['one', 'alpha', 'two', 'alpha', 'three']) { await p.keyboard.type(w); await p.keyboard.press('Enter'); }
  await settle(p, 200);
  const id = await focusedTab(p);
  const sel = () => p.evaluate(i => window.__skein.sel(i), id);
  await keys(p, 'Control+Space [');
  assert.equal(await mode(p), 'NORMAL');
  await keys(p, 'g g');
  assert.equal((await sel()).line, 0);
  await keys(p, '3 j');
  assert.equal((await sel()).line, 3);
  await keys(p, '2 k');
  assert.equal((await sel()).line, 1);
  await keys(p, '5 G');
  assert.equal((await sel()).line, 4);
  await keys(p, 'g g /');
  await p.locator('.menu.rsearch').waitFor();
  await p.keyboard.type('mock: alpha');
  await keys(p, 'Enter');
  const a = await sel();
  assert.equal(a.text, 'mock: alpha');
  await keys(p, 'n');
  const b = await sel();
  assert.equal(b.text, 'mock: alpha');
  assert.ok(b.line > a.line);
  await keys(p, 'n');
  assert.equal((await sel()).line, a.line, 'wrapped to the first');
  assert.match(await toastText(p), /continuing at TOP/);
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL', 'esc clears the search first');
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'TERMINAL');
});

// ---------- readers: the open file and the diff ----------

const THREAD = 'Fix session-restore race';
async function openReadme(p) {
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await p.locator('.pane.focus .tab.on, .pane.focus .tab').filter({ hasText: THREAD }).first().waitFor();
  await keys(p, 'Control+Space :');
  await p.keyboard.type('filesview');
  await keys(p, 'Enter');
  await p.locator('.pane.focus .files-v .ptree').getByText('README.md', { exact: true }).click();
  await p.locator('.pane.focus .file-v .doc, .pane.focus .file-v .src').first().waitFor();
  if (await p.locator('.pane.focus .file-v .doc').count()) { await keys(p, 'g p'); await p.locator('.pane.focus .file-v .src').waitFor(); }
}
const curLine = async p => Number(await p.locator('.pane.focus .file-v .curl .n').innerText());

test('file: counts (3j, 5G, 2gg) and ? searches backwards with a wrap notice', async p => {
  await openReadme(p);
  await keys(p, '3 j');
  assert.equal(await curLine(p), 4);
  await keys(p, '5 G');
  assert.equal(await curLine(p), 5);
  await keys(p, '2 g g');
  assert.equal(await curLine(p), 2);
  await keys(p, 'g g ?');
  await p.locator('.menu.rsearch').waitFor();
  await p.keyboard.type('pnpm');
  await keys(p, 'Enter');
  assert.match(await toastText(p), /continuing at BOTTOM/);
  const last = await curLine(p);
  assert.ok(last > 1);
  assert.match(await p.locator('.pane.focus .file-v .curl').innerText(), /pnpm/);
  await keys(p, 'n');
  assert.ok((await curLine(p)) <= last, 'n keeps going backwards after ?');
  await keys(p, 'N');
  assert.equal(await curLine(p), last);
  assert.ok(await p.locator('.pane.focus .file-v .hit').count());
  await keys(p, 'Escape');
  assert.equal(await p.locator('.pane.focus .file-v .hit').count(), 0, 'esc clears the search');
});

test('diff: / searches the rows, n moves on, counts move the row cursor; f searches the tree', async p => {
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await p.locator('.pane.focus .tab.on, .pane.focus .tab').filter({ hasText: THREAD }).first().waitFor();
  await keys(p, 'Control+Space :');
  await p.keyboard.type('changes');
  await keys(p, 'Enter');
  await p.locator('.pane.focus .changes .cfile').first().waitFor();
  const cur = () => p.locator('.pane.focus .changes .rowcur, .pane.focus .changes .curl').first().evaluate(e => e.closest('.cfile').dataset.p + ':' + e.textContent);
  await keys(p, '3 j');
  const counted = await cur();
  await keys(p, 'g g j j j');
  assert.equal(await cur(), counted);
  await keys(p, 'g g /');
  await p.locator('.menu.rsearch').waitFor();
  await p.keyboard.type('restore');
  await keys(p, 'Enter');
  const first = await cur();
  assert.match(first.toLowerCase(), /restore/);
  assert.ok(await p.locator('.pane.focus .changes .hit').count(), 'matches are highlighted');
  await keys(p, 'n');
  assert.notEqual(await cur(), first);
  await keys(p, 'Escape');
  assert.equal(await p.locator('.pane.focus .changes .hit').count(), 0);
  await keys(p, 'f');
  assert.equal(await mode(p), 'INSERT');
  assert.ok(await p.locator('.pane.focus .changes .ctree .tq textarea').evaluate(el => el === document.activeElement));
}, { viewport: { width: 1600, height: 900 } });

// ---------- fields: yank and put ----------

test('fields: y and p share one register across fields; p takes the clipboard while it is empty', async p => {
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.evaluate(() => navigator.clipboard.writeText('from outside'));
  await openChat(p, 'Add timestamps to chat rows');
  const box = p.locator('.pane.focus .compw textarea');
  await box.pressSequentially('hello world');
  await keys(p, 'Escape 0 p');
  await p.waitForFunction(() => document.querySelector('.pane.focus .compw textarea').value === 'hfrom outsideello world');
  await keys(p, 'u');
  assert.equal(await box.inputValue(), 'hello world');
  await keys(p, '0 y w $ p');
  assert.equal(await box.inputValue(), 'hello worldhello ');
  // the same register in a menu's search field
  await keys(p, `${mod}+k`);
  await keys(p, 'Escape p');
  assert.equal(await menuInput(p).inputValue(), 'hello ');
  await keys(p, 'Escape');
  // whole lines, from yy: P puts them above
  await keys(p, 'y y P');
  assert.equal(await box.inputValue(), 'hello worldhello \nhello worldhello ');
});
