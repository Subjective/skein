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

/** Two tabs in the pane: the launcher becomes a shell, then ldr c adds a launcher (on a launcher it only focuses it). */
async function twoTabs(p) {
  await p.locator('.pane .card', { hasText: 'Shell' }).click();
  await ldr(p, 'c');
}

test('leader keys: new tab, split, zoom, close', async p => {
  await ldr(p, 'c');
  assert.deepEqual(await tabsIn(p), [1], 'ldr c on a launcher focuses it, no second launcher');
  await twoTabs(p);
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
  await twoTabs(p);
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

// ---------- mockup parity: the keyboard sheet, workspaces, : line, palette, pane search, machines ----------
const vimrc = p => p.evaluate(() => window.__skein.S.settings.vimrc);
const field = p => p.locator('.menu .m-s input').inputValue();

test('keyboard sheet: j moves, enter then leader and a key writes an nnoremap line, x resets it', async p => {
  await keys(p, 'Escape');
  await p.keyboard.type('?');
  await p.locator('.keys2').waitFor();
  assert.match(await p.locator('.keys2 header').innerText(), /Keyboard/);
  await keys(p, 'j j j j');
  assert.match(await p.locator('.k-row.cur').innerText(), /Split right/);
  await keys(p, 'Enter');
  assert.match(await p.locator('.k-row.cur .kk.cap').innerText(), /press a key/);
  await keys(p, 'Control+Space');
  assert.match(await p.locator('.k-row.cur .kk.cap').innerText(), /ldr/);
  await keys(p, 'y');
  await p.waitForFunction(() => /nnoremap <leader>y :vsplit<CR>/.test(window.__skein.S.settings.vimrc));
  assert.match(await p.locator('.k-row.cur .kk.set').innerText(), /ldr\s*y/);
  assert.equal(await panes(p), 1, 'the captured keys did not run anything');
  await keys(p, 'x');
  await p.waitForFunction(() => !/:vsplit<CR>/.test(window.__skein.S.settings.vimrc));
  await keys(p, 'Escape');
  assert.equal(await layers(p), 0);
  assert.doesNotMatch(await vimrc(p), /vsplit/);
});

test('keyboard sheet: the vimrc button opens the vimrc beside the pane', async p => {
  await keys(p, 'Escape');
  await p.keyboard.type('?');
  await p.locator('.keys2 .btn', { hasText: 'vimrc' }).click();
  await settle(p, 200);
  assert.equal(await panes(p), 2);
  assert.match(await p.locator('.pane.focus .vimrc-view .tool-h').innerText(), /~\/\.config\/skein\/vimrc/);
});

test('workspaces menu: anchored above the status bar, walks a path with tab and h', async p => {
  await ldr(p, 'w');
  await p.locator('.menu.ws.dirs').waitFor();
  assert.equal(await p.locator('.scrim').count(), 0, 'not modal');
  const list = await p.locator('.menu.ws').innerText();
  assert.match(list, /Workspaces/); assert.match(list, /Recent folders/); assert.match(list, /Browse/); assert.match(list, /Add a machine/);
  await p.keyboard.type('linux:~/re');
  await p.locator('.menu .mi', { hasText: 'repo' }).first().waitFor();
  await keys(p, 'Tab');
  await settle(p, 200);
  assert.equal(await field(p), 'linux:~/repo/');
  assert.match(await p.locator('.menu .mi.head').first().innerText(), /linux · ~\/repo\//);
  await keys(p, 'Escape h');
  assert.equal(await field(p), 'linux:~/');
});

test('workspaces menu: New workspace “name”, r renames, d closes', async p => {
  await ldr(p, 'w');
  await p.keyboard.type('review');
  assert.match(await p.locator('.menu .mi.sel').innerText(), /New workspace “review”/);
  await keys(p, 'Enter');
  assert.match(await p.locator('#status .wsb').innerText(), /review/);
  await ldr(p, 'w');
  await keys(p, 'Escape');
  assert.match(await p.locator('.menu .mi.sel').innerText(), /review/);
  await keys(p, 'r');
  await p.keyboard.type(' two');
  await keys(p, 'Enter');
  assert.match(await p.locator('#status .wsb').innerText(), /review two/);
  await p.locator('.menu.ws').waitFor();
  await keys(p, 'Escape');
  await keys(p, 'd');
  await settle(p, 150);
  assert.equal(await p.evaluate(() => window.__skein.S.workspaces.length), 1);
  assert.doesNotMatch(await p.locator('#status .wsb').innerText(), /review/);
});

test('command line: docked above the status bar, prefix match, arguments', async p => {
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await p.locator('.menu.cmd').waitFor();
  assert.equal(await p.locator('.scrim').count(), 0, 'not modal');
  await p.keyboard.type('vs');
  assert.deepEqual(await p.locator('.menu.cmd .mi .ml').allInnerTexts(), ['vsplit', 'vshell']);
  await keys(p, 'Escape Escape');
  await p.keyboard.type(':');
  await p.keyboard.type('workspace notes');
  await keys(p, 'Enter');
  assert.match(await p.locator('#status .wsb').innerText(), /notes/);
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await p.keyboard.type('new linux ~/repo/x');
  await keys(p, 'Enter');
  assert.equal(await panes(p), 2);
  const t = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); const f = n => n.type === 'pane' ? (n.id === w.focus ? n : null) : f(n.a) || f(n.b); const g = f(w.tree); return g.tabs.find(x => x.id === g.active); });
  assert.equal(t.machine, 'linux'); assert.equal(t.dir, '~/repo/x');
});

test('palette: no key hints, thread status and project, the mockup actions', async p => {
  await keys(p, `${mod}+k`);
  assert.equal(await p.locator('.menu.pal kbd').count(), 0);
  const row = p.locator('.menu.pal .mi', { hasText: 'Fix session-restore race' });
  assert.match(await row.locator('.mh').innerText(), /^This PC · skein$/);
  assert.equal(await row.locator('.spin').count(), 1);
  const list = await p.locator('.menu.pal').innerText();
  for (const a of ['Show thread as chat / terminal', 'Open changes beside', 'Machines', 'Keyboard shortcuts']) assert.match(list, new RegExp(a.replace(/[/]/g, '\\/')));
});

test('pane search: mod-shift-a drops from the pane chevron with the thread, tabs and pane groups', async p => {
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await p.locator('.pane.focus .chat').waitFor();
  await keys(p, `${mod}+Shift+a`);
  await p.locator('.menu', { hasText: 'Pane' }).waitFor();
  assert.equal(await p.locator('.scrim').count(), 0, 'not modal');
  assert.equal(await p.locator('.menu .m-s input').getAttribute('placeholder'), 'Search this thread');
  const list = await p.locator('.menu').innerText();
  for (const a of ['side chat', 'subagent', 'Tabs', 'Changes', 'Shell', 'Split right', 'Close pane']) assert.match(list, new RegExp(a));
  await p.keyboard.type('split right');
  await keys(p, 'Enter');
  assert.equal(await panes(p), 2);
});

test('machines popover: machines with marks, picking one opens a new thread there', async p => {
  await p.locator('#side .mbtn').click();
  await p.locator('.menu.mach').waitFor();
  assert.match(await p.locator('.menu.mach').innerText(), /Add SSH host/);
  await p.locator('.menu.mach .mi', { hasText: 'linux' }).click();
  await settle(p, 150);
  const t = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); const g = w.tree; return g.tabs.find(x => x.id === g.active); });
  assert.equal(t.kind, 'new'); assert.equal(t.machine, 'linux');
});

test('sidebar: the edge drags to resize, open threads are tinted', async p => {
  const h = await p.locator('#side .side-resize').boundingBox();
  const w0 = (await p.locator('#side').boundingBox()).width;
  await p.mouse.move(h.x + 4, h.y + 200); await p.mouse.down();
  await p.mouse.move(h.x + 84, h.y + 200, { steps: 5 }); await p.mouse.up();
  const w1 = (await p.locator('#side').boundingBox()).width;
  assert.ok(Math.abs(w1 - w0 - 80) < 4, `${w0} -> ${w1}`);
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await p.locator('#side .row.vis').first().waitFor();
});

test('toasts: one at a time, names in bold', async p => {
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await p.keyboard.type('new nowhere');
  await keys(p, 'Enter');
  await p.locator('.toast b', { hasText: 'nowhere' }).waitFor();
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await p.keyboard.type('tabclose');
  await keys(p, 'Enter');
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await p.keyboard.type('5');
  await keys(p, 'Enter');
  await keys(p, 'Escape');
  await p.evaluate(() => window.__skein.api.app.setSettings({}));
  await p.keyboard.type(':');
  await p.keyboard.type('new elsewhere');
  await keys(p, 'Enter');
  await settle(p, 50);
  assert.equal(await p.locator('.toast').count(), 1);
  assert.match(await p.locator('.toast').innerText(), /elsewhere/);
});

test('settings: General has On launch, Appearance has the theme, the vimrc row shows its path', async p => {
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await p.keyboard.type('settings');
  await keys(p, 'Enter');
  await p.locator('.settings').waitFor();
  assert.deepEqual(await p.locator('.settings-nav button').allInnerTexts(), ['General', 'Appearance', 'Vim', 'Notifications', 'Machines']);
  await p.locator('.s-row', { hasText: 'On launch' }).getByText('Start empty').click();
  await p.waitForFunction(() => window.__skein.S.settings.launch === 'empty');
  await p.locator('.settings-nav button', { hasText: 'Notifications' }).click();
  assert.match(await p.locator('.s-body').innerText(), /A thread counts as read/);
  await p.locator('.settings-nav button', { hasText: 'Vim' }).click();
  assert.match(await p.locator('.s-row', { hasText: 'vimrc' }).innerText(), /~\/\.config\/skein\/vimrc/);
  await p.evaluate(() => window.__skein.api.app.setSettings({ launch: 'restore' }));
});

test('sidebar: a machine\'s + lists known folders and Browse, and browsing walks the machine', async p => {
  await p.locator('#side .s-h', { hasText: 'linux' }).hover();
  await p.locator('#side .s-h', { hasText: 'linux' }).getByRole('button', { name: 'Add a project on linux' }).click();
  await p.locator('.menu.dirs').waitFor();
  assert.match(await p.locator('.menu.dirs').innerText(), /Browse/);
  await p.locator('.menu.dirs .mi', { hasText: '~/' }).last().click();
  await settle(p, 200);
  assert.equal(await field(p), '~/');
  await p.locator('.menu.dirs .mi', { hasText: 'scratch' }).first().waitFor();
});

// ---------- wave 2: leader layer, app NORMAL keys, menus, sidebar ----------
const tree = p => p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); return JSON.parse(JSON.stringify(w.tree)); });

test('leader: ctrl-w arms it in NORMAL, r rotates, + and - resize stacked panes', async p => {
  await keys(p, 'Escape');
  await keys(p, 'Control+w v');
  assert.equal(await panes(p), 2);
  assert.equal((await tree(p)).dir, 'row');
  await ldr(p, 'r');
  assert.equal((await tree(p)).dir, 'col');
  const r0 = (await tree(p)).ratio;
  await ldr(p, '+');
  assert.notEqual((await tree(p)).ratio, r0);
});

test('leader: o focuses each popup then the panes, d docks it', async p => {
  await twoTabs(p);
  await ldr(p, 'f');
  const pf = () => p.evaluate(() => { const S = window.__skein.S; return S.workspaces.find(x => x.id === S.wid).pf; });
  assert.ok(await pf());
  await ldr(p, 'o');
  assert.equal(await pf(), null);
  await ldr(p, 'o');
  assert.ok(await pf());
  await ldr(p, 'd');
  assert.equal(await p.locator('.peek').count(), 0);
  assert.deepEqual(await tabsIn(p), [2]);
});

test('app NORMAL: g v switches chat and terminal', async p => {
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await p.locator('.pane .chat').first().waitFor();
  await keys(p, 'Escape Escape');   // composer NORMAL, then app NORMAL
  const view = () => p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); return w.tree.tabs.find(t => t.id === w.tree.active).view; });
  const v0 = await view();
  await keys(p, 'g v');
  assert.notEqual(await view(), v0);
});

test('app NORMAL: / opens the palette', async p => {
  await keys(p, 'Escape');
  await p.keyboard.press('/');
  await p.locator('.menu.pal').waitFor();
});

test('menus: tab picks like enter, space picks and stays open', async p => {
  await keys(p, 'Escape');
  await p.keyboard.type(':');
  await p.keyboard.type('vspl');
  await keys(p, 'Tab');
  assert.equal(await panes(p), 2);
  await p.locator('#side .mbtn').click();
  await p.locator('.menu.mach').waitFor();
  await keys(p, 'Space');
  assert.equal(await p.locator('.menu.mach').count(), 1, 'space keeps it open');
});

test('sidebar: a click gives it the keys, the view toggle says click to switch, Archived is always there', async p => {
  await p.locator('#side .s-h', { hasText: 'Pinned' }).click();
  assert.equal(await p.evaluate(() => window.__skein.S.sideFocus), true);
  await keys(p, 'j');
  assert.ok(await p.evaluate(() => window.__skein.S.sideCursor));
  await p.locator('.pane').first().click({ position: { x: 300, y: 300 } });
  assert.equal(await p.evaluate(() => window.__skein.S.sideFocus), false);
  assert.match(await p.locator('#side .s-top button').nth(2).getAttribute('title'), /click to switch/);
  assert.equal(await p.locator('#side .s-arch').count(), 1);
});
