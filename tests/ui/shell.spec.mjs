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

test('file search shows each result\'s file-type icon', async p => {
  await keys(p, `${mod}+p`);
  await p.keyboard.type('readme');
  const row = p.locator('.menu.files .mi', { hasText: /README\.md/i }).first();
  await row.waitFor();
  assert.equal(await row.locator('svg.fi').getAttribute('data-icon'), 'readme', 'README.md gets the readme icon, not a text badge');
  assert.ok(await row.locator('svg.fi path').count(), 'the icon is drawn inline');
});

test('file search opens at once while a slow folder is still being listed, then fills in', async p => {
  // a big repo, a slow disk or SSH: the walk takes seconds; the popup must not wait for it
  await p.evaluate(() => { const fs = window.__skein.api.fs, f = fs.find; fs.find = (m, d) => new Promise(r => setTimeout(() => r(f(m, d)), 1500)); });
  await p.locator('#side').getByText('Tidy PowerShell profile', { exact: true }).first().click();   // a folder not indexed yet
  await p.waitForTimeout(450);
  const t0 = Date.now();
  await keys(p, `${mod}+p`);
  await p.locator('.menu.files').waitFor({ timeout: 400 });
  assert.ok(Date.now() - t0 < 400, 'opened before the listing finished');
  await p.keyboard.type('readme');
  await p.locator('.menu.files .mi', { hasText: /README/i }).first().waitFor({ timeout: 4000 });
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

/** Two tabs in the pane: the launcher becomes a shell, then ldr c adds a launcher. */
async function twoTabs(p) {
  await p.locator('.pane .card', { hasText: 'Shell' }).click();
  await ldr(p, 'c');
}

test('leader keys: new tab, split, zoom, close', async p => {
  await ldr(p, 'c');
  assert.deepEqual(await tabsIn(p), [2], 'ldr c opens another launcher, even from a launcher');
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
    if (cur && cur !== 'new' && !cur.startsWith('fold:')) break;
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
  await keys(p, 'j j j j j');   // past the five Find rows
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
  // the link's dot sits beside the name; the harness marks line up in one column, local and remote alike
  assert.ok(await p.locator('.menu.mach .mi .ml .dot').count() > 0, 'dots beside the names');
  assert.equal(await p.locator('.menu.mach .mi .mr .dot').count(), 0, 'no dot among the marks');
  const cols = await p.locator('.menu.mach .mi .mr').evaluateAll(rs => rs.filter(r => r.querySelector('.has')).map(r => [...r.querySelectorAll('.has')].map(h => Math.round(h.getBoundingClientRect().left)).join(',')));
  assert.ok(cols.length > 1 && cols.every(c => c === cols[0]), `marks aligned: ${cols.join(' | ')}`);
  await p.locator('.menu.mach .mi', { hasText: 'linux' }).click();
  await settle(p, 150);
  const t = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); const g = w.tree; return g.tabs.find(x => x.id === g.active); });
  assert.equal(t.kind, 'new'); assert.equal(t.machine, 'linux');
});

test('sidebar: the edge drags to resize, open threads are tinted', async p => {
  const h = await p.locator('#side > .rsz').boundingBox();
  const w0 = (await p.locator('#side').boundingBox()).width;
  await p.mouse.move(h.x + 3, h.y + 200); await p.mouse.down();
  await p.mouse.move(h.x + 83, h.y + 200, { steps: 5 }); await p.mouse.up();
  const w1 = (await p.locator('#side').boundingBox()).width;
  assert.ok(Math.abs(w1 - w0 - 80) < 4, `${w0} -> ${w1}`);
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await p.locator('#side .row.vis').first().waitFor();
});

// Josh, 2026-11-22: the sidebar's edge showed a thick grey bar, a split's divider a thin blue line. Every resize
// edge is one component now (ui/resize.tsx): same hairline, line, delay, cursor and hit area.
test('resize edges: the sidebar, the file tree and both split dividers look and behave the same', async p => {
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await settle(p, 450);
  await keys(p, 'Escape'); await p.keyboard.type(':'); await p.keyboard.type('filesview'); await keys(p, 'Enter');
  await p.locator('.pane.focus .files-v .ptree').getByText('README.md', { exact: true }).click();
  await p.locator('.pane.focus .file-v').waitFor();
  if (!(await p.locator('.pane.focus .ctree').count())) await p.locator('.pane.focus .file-v').getByRole('button', { name: 'Project files' }).click();
  const edges = { sidebar: '#side > .rsz', tree: '.file-v .rsz', across: '.split.d-row > .rsz', down: '.split.d-col > .rsz' };
  const look = sel => p.locator(sel).first().evaluate(e => {
    const s = getComputedStyle(e), b = getComputedStyle(e, '::before'), a = getComputedStyle(e, '::after'), r = e.getBoundingClientRect();
    const across = r.width === 1;
    return { cursor: s.cursor, rest: s.backgroundColor, line: a.backgroundColor, lineW: across ? a.width : a.height, hit: across ? b.width : b.height, opacity: a.opacity, thick: across ? r.width : r.height, on: e.classList.contains('on') };
  });
  const seen = {};
  for (const [name, sel] of Object.entries(edges)) {
    if (name === 'across') {   // split after the tree is checked: a narrow pane hides its tree
      await keys(p, 'Escape'); await p.keyboard.type(':'); await p.keyboard.type('vsplit'); await keys(p, 'Enter');
      await keys(p, 'Escape'); await p.keyboard.type(':'); await p.keyboard.type('split'); await keys(p, 'Enter');
    }
    const h = p.locator(sel).first(), r = await h.boundingBox(), x = r.x + r.width / 2, y = r.y + Math.min(r.height / 2, 200);
    await p.mouse.move(640, 790); await settle(p, 250);
    const rest = await look(sel);
    assert.equal(rest.opacity, '0', `${name}: no line at rest`);
    assert.equal(rest.thick, 1, `${name}: a 1px hairline`);
    await p.mouse.move(r.width === 1 ? x + 4 : x, r.width === 1 ? y : y + 4);   // the edge of the hit area
    await settle(p, 40);
    assert.equal((await look(sel)).opacity, '0', `${name}: passing over it does not flash the line`);
    await settle(p, 400);
    const hover = await look(sel);
    assert.equal(hover.opacity, '1', `${name}: the line shows on hover`);
    await p.mouse.down(); await p.mouse.move(x, y, { steps: 2 });
    assert.ok((await look(sel)).on, `${name}: held while dragging`);
    await p.mouse.up(); await settle(p, 60);
    assert.ok(!(await look(sel)).on, `${name}: let go`);
    seen[name] = { ...hover, cursor: hover.cursor };
  }
  const { sidebar, tree, across, down } = seen, same = o => JSON.stringify({ rest: o.rest, line: o.line, lineW: o.lineW, hit: o.hit });
  for (const [name, o] of Object.entries({ tree, across, down })) assert.equal(same(o), same(sidebar), `${name} matches the sidebar's edge`);
  assert.equal(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() !== ''), true);
  assert.deepEqual([sidebar.cursor, tree.cursor, across.cursor, down.cursor], ['col-resize', 'col-resize', 'col-resize', 'row-resize']);
});

test('resize edges: double-click puts the sidebar back to its default width', async p => {
  const side = () => p.locator('#side').boundingBox().then(b => Math.round(b.width));
  const w0 = await side(), h = await p.locator('#side > .rsz').boundingBox();
  await p.mouse.move(h.x, h.y + 200); await p.mouse.down(); await p.mouse.move(h.x + 60, h.y + 200, { steps: 3 }); await p.mouse.up();
  assert.equal(await side(), w0 + 60);
  await p.mouse.dblclick(h.x + 60, h.y + 200);
  assert.equal(await side(), w0, 'back to the default');
  assert.equal(await p.evaluate(() => localStorage.getItem('skein.sidebarWidth')), null, 'the kept width is forgotten');
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
  assert.match(await p.locator('.s-body').innerText(), /Notify me/);
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
  // an idle thread: while a turn runs, the composer's second esc arms stop instead (esc esc)
  await p.locator('#side').getByText('Tidy PowerShell profile', { exact: true }).first().click();
  await p.locator('.pane .chat').first().waitFor();
  await keys(p, 'Escape Escape');   // composer NORMAL, then app NORMAL
  const view = () => p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); return w.tree.tabs.find(t => t.id === w.tree.active).view; });
  const v0 = await view();
  await keys(p, 'g v');
  assert.notEqual(await view(), v0);
});

test('/ is always a search where you are: the chat text from app NORMAL, the threads in the sidebar; never the palette', async p => {
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await p.locator('.pane .chat').first().waitFor();
  await p.waitForTimeout(450);
  await keys(p, 'Escape Escape');   // composer NORMAL, then app NORMAL
  await p.keyboard.press('/');
  const q = p.locator('.menu .pfx', { hasText: '/' });
  await q.waitFor();
  assert.equal(await p.locator('.menu.pal').count(), 0, 'no palette');
  await keys(p, 'Escape Escape');
  await ldr(p, 'h');   // the leftmost pane's left is the sidebar
  assert.equal(await p.evaluate(() => window.__skein.S.sideFocus), true, 'sidebar has the keys');
  await p.keyboard.press('/');
  await p.locator('.menu.side-q').waitFor();
  await p.keyboard.type('queue');
  assert.match(await p.locator('.menu.side-q').innerText(), /Refactor queue worker/);
  await keys(p, 'Enter');
  assert.equal(await p.evaluate(() => window.__skein.S.threads.find(t => t.id === window.__skein.S.sideCursor)?.title), 'Refactor queue worker', 'cursor on the pick');
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

test('new thread: machine and folder menus open above their chips; the folder is the shared folder field', async p => {
  const chipM = p.locator('.pane.focus .newp .chip[title="Machine"]'), chipD = p.locator('.pane.focus .newp .chip[title="Directory"]');
  await chipM.click();
  const mm = p.locator('.menu').last(); await mm.waitFor();
  const [cb, mb] = [await chipM.boundingBox(), await mm.boundingBox()];
  assert.ok(mb.y + mb.height <= cb.y + 1, 'machine menu above its chip');
  assert.equal(Math.round(mb.width), 280);
  assert.match(await mm.innerText(), /Add SSH host/);
  // a machine that knows the folder keeps it
  await keys(p, 'Escape');
  await chipD.click(); await p.locator('.menu.dirs .mi', { hasText: 'skein' }).first().click(); await settle(p);
  await p.evaluate(() => { const S = window.__skein.S; S.projects = { ...S.projects, linux: ['~/projects/skein'] }; });
  await chipM.click();
  await p.locator('.menu .mi', { hasText: 'linux' }).click(); await settle(p);
  assert.match(await chipD.innerText(), /skein/);
  await chipD.click();
  const dm = p.locator('.menu.dirs'); await dm.waitFor();
  const [db, fb] = [await chipD.boundingBox(), await dm.boundingBox()];
  assert.ok(fb.y + fb.height <= db.y + 1, 'folder menu above its chip');
  assert.equal(Math.round(fb.width), 360);
  assert.equal(await dm.locator('input').getAttribute('placeholder'), 'Folder or path on linux');
  assert.match(await dm.innerText(), /Recent folders[\s\S]*trade-ticker[\s\S]*Browse/);
  await dm.locator('.mi', { hasText: 'etl-config' }).click(); await settle(p);
  assert.match(await chipD.innerText(), /etl-config/);
});

test('new thread: a machine without the harness switches it and names the model', async p => {
  await p.locator('.pane.focus .newp .chip[title="Machine"]').click();
  await p.locator('.menu .mi', { hasText: 'build-07' }).click(); await settle(p);
  assert.match(await p.locator('.toast').last().innerText(), /build-07 has only Codex\. Switched to GPT-6\.2 Sol/);
  assert.match(await p.locator('.pane.focus .newp .chip[title="Directory"]').innerText(), /ci/);   // its known folder
});

test('sidebar: dragging a project shows its folder and name under the pointer', async p => {
  const row = p.locator('#side .s-d[data-machine=local]').first();
  const a = await row.boundingBox();
  await p.mouse.move(a.x + 30, a.y + a.height / 2); await p.mouse.down();
  await p.mouse.move(a.x + 40, a.y + 40, { steps: 5 });
  const pv = p.locator('body > .s-d.drag-preview');
  assert.equal(await pv.count(), 1);
  assert.equal(await pv.locator('.project-folder').count(), 1);
  assert.match(await pv.innerText(), /skein|dotfiles/);
  await p.mouse.up(); await settle(p);
  assert.equal(await pv.count(), 0);
});

test('tabs: alt-click x pops a tab out and the tab before it becomes active', async p => {
  await twoTabs(p);
  await p.locator('.pane.focus .card', { hasText: 'Shell' }).click();
  await ldr(p, 'c');
  const tabs = p.locator('.pane.focus .tab');
  assert.equal(await tabs.count(), 3);
  const ids = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); return w.tree.tabs.map(t => t.id); });
  await tabs.nth(1).click(); await settle(p);
  await tabs.nth(1).locator('.tx').click({ modifiers: ['Alt'] }); await settle(p);
  assert.equal(await p.locator('.peek').count(), 1);
  const active = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); return w.tree.active; });
  assert.equal(active, ids[0]);
});

test('app NORMAL: j moves the sidebar cursor without focusing the sidebar, o opens it', async p => {
  await p.locator('#side').getByText('Add timestamps to chat rows', { exact: true }).first().click();
  await p.locator('.pane .chat').first().waitFor();
  await keys(p, 'Escape Escape');
  const S = () => p.evaluate(() => { const S = window.__skein.S; return { cur: S.sideCursor, focus: S.sideFocus }; });
  await keys(p, 'j');
  const after = await S();
  assert.equal(after.focus, false);
  assert.notEqual(after.cur, 't3');
  assert.equal(await p.locator(`#side .row.cur[data-thread="${after.cur}"]`).count(), 1);
  await keys(p, 'o'); await settle(p, 300);
  const open = await p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); return w.tree.tabs.find(t => t.id === w.tree.active).thread; });
  assert.equal(open, after.cur);
});

test('palette: archived threads and side chats are listed too', async p => {
  await p.evaluate(() => { const S = window.__skein.S; S.threads.find(t => t.id === 't4').archived = true; });
  await keys(p, `${mod}+k`);
  const row = p.locator('.menu.pal .mi', { hasText: 'Tidy PowerShell profile' });
  assert.equal(await row.count(), 1);
  assert.match(await row.locator('.mh').innerText(), /archived/);
});

test('workspaces: switching clears the sidebar cursor', async p => {
  await ldr(p, 'h'); await keys(p, 'j j Escape');
  assert.ok(await p.evaluate(() => window.__skein.S.sideCursor));
  await ldr(p, 'w'); await p.keyboard.type('review'); await keys(p, 'Enter');
  assert.equal(await p.evaluate(() => window.__skein.S.sideCursor), null);
  await ldr(p, 'h'); await keys(p, 'j Escape');
  await keys(p, 'Control+Tab');
  assert.equal(await p.evaluate(() => window.__skein.S.sideCursor), null);
});

test('sidebar: double-click renames a project and a thread in place; typed keys reach the field', async p => {
  await p.locator('#side').getByText('dotfiles', { exact: true }).dblclick();
  const inp = p.locator('#side .sidebar-name-input');
  await inp.waitFor();
  await p.keyboard.type('Xy');
  assert.equal(await inp.inputValue(), 'Xy', 'typing replaces the selected name');
  await p.keyboard.press('Enter');
  await p.locator('#side').getByText('Xy', { exact: true }).waitFor();
  assert.equal(await inp.count(), 0, 'enter closes the field');
  await p.locator('#side').getByText('Tidy PowerShell profile', { exact: true }).dblclick();
  await inp.waitFor();
  await p.keyboard.type('Nope');
  await p.keyboard.press('Escape');
  await settle(p);
  assert.equal(await p.locator('#side').getByText('Tidy PowerShell profile', { exact: true }).count(), 1, 'esc keeps the old name');
});

test('window drag: only top-edge tab bars move the window; a popup header and a lower pane never do', async p => {
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await p.locator('.pane .chat').first().waitFor();
  await p.waitForTimeout(450);
  await p.locator('.pane.focus .sc-link').first().click();
  await p.locator('.peek').waitFor();
  const region = sel => p.evaluate(s => [...document.querySelectorAll(s)].map(e => getComputedStyle(e).getPropertyValue('-webkit-app-region')), sel);
  assert.deepEqual([...new Set(await region('.peek, .peek *'))], ['no-drag'], 'nothing in a popup drags the window');
  assert.ok((await region('.pane .tb .drag')).includes('drag'), 'a top tab bar still drags it');
  await ldr(p, 's');   // split below
  await settle(p);
  const lower = await region('.split.d-col > .cell:last-child .tb, .split.d-col > .cell:last-child .tb *');
  if (lower.length) assert.deepEqual([...new Set(lower)], ['no-drag'], 'a lower pane does not drag the window');
});

test('the tab bar + opens another new-thread tab every time', async p => {
  const n = () => p.locator('.pane.focus .tab').count();
  const before = await n();
  const plus = p.locator('.pane.focus .tb [aria-label="New tab"]');
  await plus.click(); await plus.click(); await plus.click();
  await settle(p);
  assert.equal(await n(), before + 3, 'three more tabs');
  assert.equal(await mode(p), 'INSERT', 'the newest launcher has the caret');
  await ldr(p, 'c');
  await settle(p);
  assert.equal(await n(), before + 4, 'ldr c does the same');
});

test('archiving a thread closes its tabs and its side chat; Undo brings them back', async p => {
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await settle(p, 300);
  const open = () => p.evaluate(() => { const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid); const tabs = []; const walk = n => n.type === 'pane' ? tabs.push(...n.tabs) : (walk(n.a), walk(n.b)); walk(w.tree); return [...tabs, ...w.pops.map(x => x.tab)].filter(t => t.thread === 't1' || t.thread === 's1').map(t => t.thread).sort(); });
  // its side chat as a popup too
  const seg = p.locator('.pane.focus .tb .seg button[aria-label^="Chat"]');
  if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
  await p.locator('.pane.focus .sc-link', { hasText: 'Why not a mutex here?' }).first().click();
  await settle(p, 300);
  const before = await open();
  assert.deepEqual(before, ['s1', 't1'], 'the thread and its side chat are open');
  const row = p.locator('#side .row[data-thread="t1"]');
  await row.hover();
  await row.getByRole('button', { name: 'Archive thread' }).click();
  await settle(p, 300);
  assert.deepEqual(await open(), [], 'no tab or popup shows the thread or its side chat');
  const undo = p.locator('.toast button', { hasText: 'Undo' });
  await undo.click(); await settle(p, 300);
  assert.deepEqual(await open(), before, 'Undo reopens them');
  assert.ok(!(await p.evaluate(() => window.__skein.S.threads.find(t => t.id === 't1').archived)), 'and unarchives the thread');
});

test('sidebar NORMAL: k from the top heading reaches New thread, enter opens one; every row type draws the same cursor', async p => {
  await p.locator('#side').getByText('Fix session-restore race', { exact: true }).first().click();
  await settle(p, 450);
  await keys(p, 'Escape'); await ldr(p, 'h'); await settle(p);
  const cur = () => p.evaluate(() => { const c = document.querySelector('#side .cur'); if (!c) return null; const r = c.getBoundingClientRect(), cs = getComputedStyle(c); return { cls: c.className, h: Math.round(r.height), shadow: cs.boxShadow, radius: cs.borderRadius }; });
  const seen = [];
  for (let i = 0; i < 6; i++) { await keys(p, 'k'); seen.push(await cur()); }
  const top = seen[seen.length - 1];
  assert.match(top.cls, /\bnav\b/, 'the cursor reached New thread');
  // the same cursor on New thread, a heading, a folder and a thread: the same outline, radius and height
  await keys(p, 'g'); const kinds = [await cur()];
  for (let i = 0; i < 4; i++) { await keys(p, 'j'); kinds.push(await cur()); }
  const types = new Set(kinds.map(k => k.cls.split(' ')[0]));
  assert.ok(types.size >= 3, `several row types (${[...types]})`);
  assert.equal(new Set(kinds.map(k => k.shadow)).size, 1, 'one outline');
  assert.equal(new Set(kinds.map(k => k.radius)).size, 1, 'one radius');
  assert.ok(Math.max(...kinds.map(k => k.h)) - Math.min(...kinds.map(k => k.h)) <= 2, `one height (${kinds.map(k => k.h)})`);
  await keys(p, 'g');
  const before = await tabsIn(p);
  await keys(p, 'Enter'); await settle(p, 300);
  assert.equal((await tabsIn(p)).reduce((a, b) => a + b, 0), before.reduce((a, b) => a + b, 0) + 1, 'enter on New thread opens a new-thread tab');
});
