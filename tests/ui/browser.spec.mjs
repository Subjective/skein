// The Browser tab, in a plain browser where an <iframe> stands in for the app's <webview>. Pages are served by
// the test itself (page.route) on the dev server's own origin, so the frame is same-origin and reports its title,
// in-page navigation and the keys Skein keeps, the way main does for a webview.
import { assert, keys, mod, mode, settle, test } from './harness.mjs';

const PAGES = {
  'one.html': '<title>Page one</title><h1>One</h1><input id="q"><a id="next" href="two.html">two</a><div style="height:3000px"></div>',
  'two.html': '<title>Page two</title><h1>Two</h1>',
};
async function serve(p) {
  await p.route('**/preview/*', r => {
    const name = new URL(r.request().url()).pathname.split('/').pop();
    return PAGES[name] ? r.fulfill({ contentType: 'text/html', body: PAGES[name] }) : r.fulfill({ status: 404, body: 'nope' });
  });
}
const B = p => p.locator('.pane.focus .browser-v');
const bar = p => B(p).locator('.br-bar textarea');
const frame = p => B(p).locator('.br-page iframe');
const page = p => p.frameLocator('.pane.focus .br-page iframe');
const btn = (p, label) => B(p).locator(`.tool-h button[aria-label="${label}"]`);
const tabTitle = p => p.locator('.pane.focus .tab.on').innerText();
const activeIn = p => p.evaluate(() => document.activeElement?.tagName);

async function openBrowser(p) {
  await serve(p);
  await p.locator('.cards .card', { hasText: 'Browser' }).click();
  await B(p).waitFor();
  await settle(p, 150);
}
async function visit(p, addr) {
  await p.keyboard.type(addr);
  await keys(p, 'Enter');
  await page(p).locator('h1').waitFor();
  await settle(p, 150);
}

test('browser: opens from the launcher in its address bar, loads a typed address, names the tab', async p => {
  await openBrowser(p);
  assert.equal(await tabTitle(p), 'Browser');
  assert.equal(await mode(p), 'INSERT');
  assert.equal(await activeIn(p), 'TEXTAREA');
  assert.ok(await btn(p, 'Back').isDisabled());
  assert.ok(await btn(p, 'Reload').isDisabled());
  await visit(p, 'localhost:5199/preview/one.html');
  assert.equal(await frame(p).getAttribute('src'), 'http://localhost:5199/preview/one.html');
  assert.equal(await page(p).locator('h1').innerText(), 'One');
  assert.equal(await bar(p).inputValue(), 'localhost:5199/preview/one.html');
  assert.equal(await tabTitle(p), 'Page one');
  assert.equal(await mode(p), 'NORMAL');
  assert.ok(await btn(p, 'Back').isDisabled());
  assert.ok(await btn(p, 'Forward').isDisabled());
  assert.ok(!(await btn(p, 'Reload').isDisabled()));
});

test('browser: back and forward follow the history, buttons enable to match', async p => {
  await openBrowser(p);
  await visit(p, 'localhost:5199/preview/one.html');
  await keys(p, 'o');
  assert.equal(await mode(p), 'INSERT');
  await p.keyboard.press(`${mod}+a`);
  await visit(p, 'localhost:5199/preview/two.html');
  assert.equal(await tabTitle(p), 'Page two');
  assert.ok(!(await btn(p, 'Back').isDisabled()));
  assert.ok(await btn(p, 'Forward').isDisabled());
  await btn(p, 'Back').click();
  await settle(p, 300);
  assert.equal(await page(p).locator('h1').innerText(), 'One');
  assert.equal(await bar(p).inputValue(), 'localhost:5199/preview/one.html');
  assert.ok(await btn(p, 'Back').isDisabled());
  assert.ok(!(await btn(p, 'Forward').isDisabled()));
  await btn(p, 'Forward').click();
  await settle(p, 300);
  assert.equal(await page(p).locator('h1').innerText(), 'Two');
  // keys: [ and ctrl-o back, ] forward
  await keys(p, '[');
  await settle(p, 250);
  assert.equal(await page(p).locator('h1').innerText(), 'One');
  await keys(p, ']');
  await settle(p, 250);
  assert.equal(await page(p).locator('h1').innerText(), 'Two');
  await keys(p, 'Control+o');
  await settle(p, 250);
  assert.equal(await page(p).locator('h1').innerText(), 'One');
});

test('browser: a link inside the page moves the address bar and history', async p => {
  await openBrowser(p);
  await visit(p, 'localhost:5199/preview/one.html');
  await page(p).locator('#next').click();
  await page(p).locator('h1', { hasText: 'Two' }).waitFor();
  await settle(p, 200);
  assert.equal(await bar(p).inputValue(), 'localhost:5199/preview/two.html');
  assert.ok(!(await btn(p, 'Back').isDisabled()));
});

test('browser: i gives the page the keys (TERMINAL), esc takes them back, keys reach the app again', async p => {
  await openBrowser(p);
  await visit(p, 'localhost:5199/preview/one.html');
  assert.equal(await mode(p), 'NORMAL');
  await keys(p, 'i');
  assert.equal(await mode(p), 'TERMINAL');
  assert.equal(await activeIn(p), 'IFRAME');
  // plain keys type into the page; H and L do not switch tabs while it has them
  await page(p).locator('#q').click();
  await p.keyboard.type('HL jk');
  assert.equal(await page(p).locator('#q').inputValue(), 'HL jk');
  assert.equal(await mode(p), 'TERMINAL');
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL');
  assert.notEqual(await activeIn(p), 'IFRAME');
  // g i does the same as i, and r reloads (the typed text is gone)
  await keys(p, 'g i');
  assert.equal(await mode(p), 'TERMINAL');
  await keys(p, 'Escape');
  await keys(p, 'r');
  await settle(p, 300);
  assert.equal(await page(p).locator('#q').inputValue(), '');
  assert.equal(await mode(p), 'NORMAL');
});

test('browser: clicking into the page gives it the keys; mod-l from the page edits the address', async p => {
  await openBrowser(p);
  await visit(p, 'localhost:5199/preview/one.html');
  await page(p).locator('h1').click();
  await settle(p, 150);
  assert.equal(await mode(p), 'TERMINAL', 'click');
  await keys(p, `${mod}+l`);
  assert.equal(await mode(p), 'INSERT', 'mod-l');
  assert.equal(await activeIn(p), 'TEXTAREA', 'mod-l focus');
  // esc esc: NORMAL in the bar, then out of it, with the address put back
  await p.keyboard.type('zzz');
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL', 'esc 1');
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL', 'esc 2');
  assert.equal(await bar(p).inputValue(), 'localhost:5199/preview/one.html');
  assert.notEqual(await activeIn(p), 'TEXTAREA');
});

test('browser: the leader works from inside the page (rule 11)', async p => {
  await openBrowser(p);
  await visit(p, 'localhost:5199/preview/one.html');
  await keys(p, 'i');
  assert.equal(await mode(p), 'TERMINAL');
  await keys(p, 'Control+Space v');
  assert.equal(await p.locator('.pane[data-pane]').count(), 2);
});

test('browser: H and L in NORMAL still switch tabs', async p => {
  await openBrowser(p);
  await visit(p, 'localhost:5199/preview/one.html');
  await keys(p, 'Control+Space c');
  await settle(p, 150);
  assert.equal(await tabTitle(p), 'New thread');
  await keys(p, 'Escape H');
  assert.equal(await tabTitle(p), 'Page one');
});

test('browser: a bare port means localhost; text that is not an address says so', async p => {
  await openBrowser(p);
  await p.keyboard.type('hello world');
  await keys(p, 'Enter');
  assert.match(await B(p).locator('.err-row').innerText(), /Not a web address: hello world/);
  await keys(p, 'Escape');
  await keys(p, 'o');
  await p.keyboard.press(`${mod}+a`);
  await p.keyboard.type('5199');
  await keys(p, 'Enter');
  await settle(p, 200);
  assert.equal(await frame(p).getAttribute('src'), 'http://localhost:5199/');
  assert.equal(await B(p).locator('.err-row').count(), 0);
});

test('browser: open outside hands the address to the system browser', async p => {
  await openBrowser(p);
  await visit(p, 'localhost:5199/preview/one.html');
  await btn(p, 'Open in browser').click();
  assert.deepEqual(await p.evaluate(() => window.__external), ['http://localhost:5199/preview/one.html']);
});

test('browser: from the palette and the : line, beside the thread', async p => {
  await serve(p);
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await settle(p, 450);
  await keys(p, `${mod}+k`);
  await p.keyboard.type('browser');
  await keys(p, 'Enter');
  await B(p).waitFor();
  assert.equal(await p.locator('.pane[data-pane]').count(), 2);
  assert.equal(await mode(p), 'INSERT');
});

test('browser: a thread on an SSH machine forwards its localhost and says so', async p => {
  await serve(p);
  await p.locator('#side').getByText('Refactor queue worker', { exact: true }).first().click();
  await settle(p, 450);
  await keys(p, 'Control+Space :');
  await p.keyboard.type('browser');
  await keys(p, 'Enter');
  await B(p).waitFor();
  await settle(p, 150);
  await visit(p, 'localhost:5199/preview/one.html');
  assert.match(await B(p).locator('.br-via').innerText(), /linux → :5199/);
  assert.equal(await bar(p).inputValue(), 'localhost:5199/preview/one.html');
});

test('browser: a failed forward shows an error row with Retry', async p => {
  await serve(p);
  await p.locator('#side').getByText('Bump lockfile to fix CI', { exact: true }).first().click();
  await settle(p, 450);
  await keys(p, 'Control+Space :');
  await p.keyboard.type('browser');
  await keys(p, 'Enter');
  await B(p).waitFor();
  await settle(p, 150);
  await p.keyboard.type('5173');
  await keys(p, 'Enter');
  await B(p).locator('.err-row').waitFor();
  assert.match(await B(p).locator('.err-row').innerText(), /Couldn't forward port 5173 from build-07: Connection timed out/);
  await B(p).locator('.err-row button', { hasText: 'Retry' }).click();
  await settle(p, 400);
  assert.equal(await B(p).locator('.err-row').count(), 1);
});
