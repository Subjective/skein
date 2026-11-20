// Changes, Files and the open file: every interactive state, against the fake repo (src/renderer/src/dev/fakeRepo.ts).
// The fake repo, on branch fix/restore-race, has 3 commits and 4 uncommitted files:
//   sessions/store.ts M (unstaged), sessions/restore.test.ts A (unstaged), ui/theme.css M (staged), docs/notes.txt D (unstaged).
import { assert, keys, mod, mode, settle, test as base } from './harness.mjs';

// wide enough that a split pane keeps its side tree (below 640px a pane hides it)
const test = (name, fn, o = {}) => base(name, fn, { viewport: { width: 1600, height: 900 }, ...o });

const THREAD = 'Fix session-restore race';

/** Run an ex command from anywhere (ctrl-space leaves the composer for the pane, : opens the command line). */
async function cmd(p, c) {
  await p.keyboard.press('Control+Space');
  await p.keyboard.press(':');
  await p.locator('.menu.cmd').waitFor();
  await p.keyboard.type(c);
  await p.keyboard.press('Enter');
  await settle(p, 200);
}
async function openChanges(p) {
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await settle(p, 450);   // a sidebar click waits 350ms for a possible double-click (rename)
  await cmd(p, 'changes');
  await p.locator('.pane.focus .changes .cfile').first().waitFor();
}
async function openFiles(p) {
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await settle(p, 450);   // a sidebar click waits 350ms for a possible double-click (rename)
  await cmd(p, 'filesview');
  await p.locator('.pane.focus .files-v .ptree [role=treeitem]').first().waitFor();
}
const C = p => p.locator('.pane.focus .changes');
const files = async p => C(p).locator('.cfile').evaluateAll(es => es.map(e => e.getAttribute('data-p')));
const scopeChip = p => C(p).locator('[data-k=scope]');
const menu = p => p.locator('.menu').last();
const toastText = p => p.locator('.toast').last().innerText();
const curRow = p => p.locator('.pane.focus .rowcur, .pane.focus .curl').first();

// ---------- Changes ----------

await test('changes: opens beside the thread on Uncommitted with counts, branch and every changed file', async p => {
  await openChanges(p);
  assert.match(await scopeChip(p).innerText(), /Uncommitted/);
  assert.match(await scopeChip(p).innerText(), /\+\d+/);
  assert.match(await C(p).locator('[data-k=branch]').innerText(), /fix\/restore-race/);
  assert.deepEqual((await files(p)).sort(), ['docs/notes.txt', 'sessions/restore.test.ts', 'sessions/store.ts', 'ui/theme.css']);
  assert.equal(await C(p).locator('.split .btn').first().innerText(), 'Commit');
  assert.equal(await C(p).locator('.split .btn').first().getAttribute('title'), 'Commit · c');
  assert.ok(await C(p).locator('.tag', { hasText: 'New' }).count());
  assert.ok(await C(p).locator('.tag', { hasText: 'Deleted' }).count());
  assert.equal(await mode(p), 'NORMAL');
});

await test('changes: reusing the command focuses the open tab instead of a second one', async p => {
  await openChanges(p);
  await cmd(p, 'changes');
  assert.equal(await p.locator('.changes').count(), 1);
});

await test('changes: scope menu lists every scope with counts; Staged and Unstaged split the files', async p => {
  await openChanges(p);
  await keys(p, 'g s');
  const m = menu(p);
  await m.waitFor();
  const text = await m.innerText();
  for (const s of ['Last agent turn', 'Uncommitted', 'Staged', 'Unstaged', 'All changes', 'Commits']) assert.ok(text.includes(s), s);
  await m.getByText('Staged', { exact: true }).click();
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .changes .cfile').length === 1);
  assert.deepEqual(await files(p), ['ui/theme.css']);
  await scopeChip(p).click();
  await menu(p).getByText('Unstaged', { exact: true }).click();
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .changes .cfile').length === 3);
  assert.ok(!(await files(p)).includes('ui/theme.css'));
});

await test('changes: commits menu ticks a commit, grows a range, unticking the last goes back', async p => {
  await openChanges(p);
  await keys(p, 'g s');
  await menu(p).getByText('Commits', { exact: true }).click();
  const m = p.locator('.commits-m');
  await m.waitFor();
  await m.getByText('Document the test command').click();
  await p.waitForFunction(() => /^[0-9a-f]{7}/.test(document.querySelector('.pane.focus [data-k=scope]')?.textContent || ''));
  await p.waitForFunction(() => [...document.querySelectorAll('.pane.focus .cfile')].map(e => e.dataset.p).join() === 'README.md');
  // tick the oldest: the run grows to cover all three
  await m.getByText('First version of session restore').click();
  await p.waitForFunction(() => /All commits/.test(document.querySelector('.pane.focus [data-k=scope]')?.textContent || ''));
  assert.match(await m.locator('.fly-r').innerText(), /3 commits/);   // the range footer
  // untick all: back to Uncommitted
  await m.getByText('All commits', { exact: true }).click();
  await p.waitForFunction(() => /Uncommitted/.test(document.querySelector('.pane.focus [data-k=scope]')?.textContent || ''));
  // the filter opened in INSERT: esc drops it to NORMAL, a second esc closes (VIM-MODEL rule 21)
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await m.waitFor({ state: 'detached' });
});

await test('changes: in a commit range there is no stage or revert', async p => {
  await openChanges(p);
  await keys(p, 'g s');
  await menu(p).getByText('Commits', { exact: true }).click();
  await p.locator('.commits-m').getByText('Track when a session last changed').click();
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => [...document.querySelectorAll('.pane.focus .cfile')].map(e => e.dataset.p).join() === 'sessions/types.ts');
  assert.equal(await C(p).locator('.cb').count(), 0);
  assert.equal(await C(p).locator('[aria-label="Revert file"]').count(), 0);
});

await test('changes: j k { } move the cursor; enter folds and unfolds a file; h l fold', async p => {
  await openChanges(p);
  const first = (await files(p))[0];
  assert.equal(await curRow(p).evaluate(e => e.closest('.cfile').dataset.p), first);
  await keys(p, '}');
  const second = (await files(p))[1];
  assert.equal(await curRow(p).evaluate(e => e.closest('.cfile').dataset.p), second);
  await keys(p, '{');
  assert.equal(await curRow(p).evaluate(e => e.closest('.cfile').dataset.p), first);
  const open = () => C(p).locator(`.cfile[data-p="${first}"]`).evaluate(e => e.open);
  assert.equal(await open(), true);
  await keys(p, 'Enter');
  assert.equal(await open(), false);
  await keys(p, 'l');
  assert.equal(await open(), true);
  await keys(p, 'j h');
  assert.equal(await open(), false);
  assert.ok(await curRow(p).evaluate(e => e.tagName === 'SUMMARY'), 'folding puts the cursor on the file');
  await keys(p, 'G');
  const last = (await files(p)).at(-1);
  assert.equal(await curRow(p).evaluate(e => e.closest('.cfile').dataset.p), last);
  await keys(p, 'g g');
  assert.equal(await curRow(p).evaluate(e => e.closest('.cfile').dataset.p), first);
});

await test('changes: clicking a file header folds it', async p => {
  await openChanges(p);
  const f = C(p).locator('.cfile[data-p="sessions/store.ts"]');
  await f.locator('summary .f').click();
  assert.equal(await f.evaluate(e => e.open), false);
  await f.locator('summary .f').click();
  assert.equal(await f.evaluate(e => e.open), true);
});

await test('changes: unmodified lines fold into a gap that expands on click and on enter', async p => {
  await openChanges(p);
  const f = C(p).locator('.cfile[data-p="sessions/store.ts"]');
  const gaps = f.locator('.dgap');
  const n = await gaps.count();
  assert.ok(n >= 1, 'store.ts has a folded gap');
  const lines = await f.locator('.dl').count();
  await gaps.first().click();
  await p.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length < n, [`.pane.focus .cfile[data-p="sessions/store.ts"] .dgap`, n]);
  assert.ok((await f.locator('.dl').count()) > lines, 'the gap became lines');
  if (n > 1) {
    // the keyboard: move onto the next gap and press enter
    await f.locator('.dgap').first().evaluate(e => e.scrollIntoView());
    for (let i = 0; i < 200 && !(await C(p).locator('.dgap.rowcur').count()); i++) await p.keyboard.press('j');
    await keys(p, 'Enter');
    await p.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length < n - 1, [`.pane.focus .cfile[data-p="sessions/store.ts"] .dgap`, n]);
  }
});

await test('changes: s stages the file under the cursor, again unstages; the box follows', async p => {
  await openChanges(p);
  const box = C(p).locator('.cfile[data-p="sessions/store.ts"] summary .cb');
  while ((await curRow(p).evaluate(e => e.closest('.cfile').dataset.p)) !== 'sessions/store.ts') await keys(p, '}');
  assert.equal(await box.getAttribute('aria-checked'), 'false');
  await keys(p, 's');
  await p.waitForFunction(() => document.querySelector('.pane.focus .cfile[data-p="sessions/store.ts"] summary .cb')?.getAttribute('aria-checked') === 'true');
  assert.match(await C(p).locator('.split .btn').first().getAttribute('title').catch(() => '') || '', /|/);
  await keys(p, 's');
  await p.waitForFunction(() => document.querySelector('.pane.focus .cfile[data-p="sessions/store.ts"] summary .cb')?.getAttribute('aria-checked') === 'false');
});

await test('changes: stage all box is mixed, then stages and unstages everything (S too)', async p => {
  await openChanges(p);
  const all = C(p).locator('.ctree .tf.all .cb');
  assert.equal(await all.getAttribute('aria-checked'), 'mixed');
  await all.click();
  await p.waitForFunction(() => document.querySelector('.pane.focus .ctree .tf.all .cb')?.getAttribute('aria-checked') === 'true');
  assert.equal(await C(p).locator('summary .cb[aria-checked=true]').count(), 4);
  await keys(p, 'S');
  await p.waitForFunction(() => document.querySelector('.pane.focus .ctree .tf.all .cb')?.getAttribute('aria-checked') === 'false');
});

await test('changes: x reverts a file with an Undo toast; u brings it back', async p => {
  await openChanges(p);
  while ((await curRow(p).evaluate(e => e.closest('.cfile').dataset.p)) !== 'sessions/store.ts') await keys(p, '}');
  await keys(p, 'x');
  await p.waitForFunction(() => !document.querySelector('.pane.focus .cfile[data-p="sessions/store.ts"]'));
  assert.match(await toastText(p), /Reverted store\.ts/);
  assert.ok(await p.locator('.toast').last().getByRole('button', { name: 'Undo' }).count());
  await keys(p, 'u');
  await p.waitForFunction(() => !!document.querySelector('.pane.focus .cfile[data-p="sessions/store.ts"]'));
  await keys(p, 'u');   // the file coming back is the answer: no second toast
  assert.match(await toastText(p), /Nothing to undo/);
});

await test('changes: the revert button and the toast Undo do the same with the mouse', async p => {
  await openChanges(p);
  const f = C(p).locator('.cfile[data-p="sessions/restore.test.ts"]');
  await f.locator('summary').hover();
  await f.getByRole('button', { name: 'Revert file' }).click();
  await p.waitForFunction(() => !document.querySelector('.pane.focus .cfile[data-p="sessions/restore.test.ts"]'));
  await p.locator('.toast').last().getByRole('button', { name: 'Undo' }).click();
  await p.waitForFunction(() => !!document.querySelector('.pane.focus .cfile[data-p="sessions/restore.test.ts"]'));
});

await test('changes: f searches the tree, enter jumps to the first match, esc leaves', async p => {
  await openChanges(p);
  await keys(p, 'f');
  assert.equal(await mode(p), 'INSERT');
  await p.keyboard.type('theme');
  assert.equal(await C(p).locator('.ctree .tf:not(.all)').count(), 1);
  await p.keyboard.press('Enter');
  await settle(p, 200);
  assert.equal(await curRow(p).evaluate(e => e.closest('.cfile').dataset.p), 'ui/theme.css');
  assert.equal(await mode(p), 'NORMAL');
  await keys(p, 'f');
  await p.keyboard.type('zzz');
  assert.ok(await C(p).locator('.ctree .tf.none').count());
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await settle(p);
  assert.equal(await mode(p), 'NORMAL');
});

await test('changes: clicking a file in the tree jumps to it; t hides and shows the tree', async p => {
  await openChanges(p);
  await C(p).locator('.ctree .tfn', { hasText: 'theme.css' }).click();
  await settle(p, 200);
  assert.equal(await curRow(p).evaluate(e => e.closest('.cfile').dataset.p), 'ui/theme.css');
  await keys(p, 't');
  assert.equal(await C(p).locator('.ctree').count(), 0);
  await C(p).getByRole('button', { name: 'Changed files' }).click();
  assert.equal(await C(p).locator('.ctree').count(), 1);
});

await test('changes: V selects lines and y copies them', async p => {
  await openChanges(p);
  await keys(p, 'j V j j');
  assert.equal(await mode(p), 'V-LINE');
  assert.equal(await C(p).locator('.vsel').count(), 3);
  await keys(p, 'y');
  assert.match(await toastText(p), /Copied 3 lines/);
  assert.equal(await mode(p), 'NORMAL');
  await keys(p, 'V Escape');
  assert.equal(await mode(p), 'NORMAL');
  assert.equal(await C(p).locator('.vsel').count(), 0);
});

await test('changes: enter on a line opens the file at that line in a new tab', async p => {
  await openChanges(p);
  while ((await curRow(p).evaluate(e => e.closest('.cfile').dataset.p)) !== 'sessions/store.ts') await keys(p, '}');
  await keys(p, 'j j');
  const line = Number(await curRow(p).locator('.n').innerText());
  await keys(p, 'Enter');
  await p.locator('.pane.focus .file-v .src').waitFor();
  assert.match(await p.locator('.pane.focus .file-v .crumbs').innerText(), /store\.ts/);
  await p.waitForFunction(l => document.querySelector('.pane.focus .file-v .curl .n')?.textContent === String(l), line);
});

await test('changes: branch menu switches and creates branches', async p => {
  await openChanges(p);
  await keys(p, 'g b');
  await menu(p).waitFor();
  assert.ok((await menu(p).innerText()).includes('main'));
  await p.keyboard.type('feature-x');
  await menu(p).getByText('Create branch').click();
  await p.waitForFunction(() => /feature-x/.test(document.querySelector('.pane.focus [data-k=branch]')?.textContent || ''));
  await C(p).locator('[data-k=branch]').click();
  await menu(p).getByText('main', { exact: true }).click();
  await p.waitForFunction(() => /main/.test(document.querySelector('.pane.focus [data-k=branch]')?.textContent || ''));
  // on the trunk, committing makes a branch first
  assert.equal(await C(p).locator('.split .btn').first().innerText(), 'Create branch & commit');
});

await test('commit: c opens the dialog with the thread title; enter commits the staged file', async p => {
  await openChanges(p);
  await keys(p, 'c');
  const d = p.locator('.dialog.commit, [role=dialog]').last();
  await d.waitFor();
  assert.match(await d.innerText(), /1 staged file/);
  assert.equal(await d.locator('textarea').last().inputValue(), THREAD);
  await p.keyboard.press(`${mod}+Enter`);
  await d.waitFor({ state: 'detached' });
  await p.waitForFunction(() => !document.querySelector('.pane.focus .cfile[data-p="ui/theme.css"]'));
  assert.equal((await files(p)).length, 3);
  await keys(p, 'g s');
  await menu(p).getByText('Commits', { exact: true }).click();
  assert.ok((await p.locator('.commits-m').innerText()).includes(THREAD));
});

await test('commit: an empty message is refused and esc cancels', async p => {
  await openChanges(p);
  await C(p).locator('.split .btn').first().click();
  const d = p.locator('[role=dialog]').last();
  await d.waitFor();
  await d.locator('textarea').last().fill('');
  await d.getByRole('button', { name: 'Commit' }).click();
  await d.locator('[role=alert]').waitFor();
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await d.waitFor({ state: 'detached' });
  assert.equal((await files(p)).length, 4);
});

await test('commit: the split menu offers push, PR and branch; Create branch asks only for a name', async p => {
  await openChanges(p);
  await C(p).getByRole('button', { name: 'More commit actions' }).click();
  const text = await menu(p).innerText();
  for (const s of ['Commit & push', 'Commit & open PR', 'Create branch']) assert.ok(text.includes(s), s);
  await menu(p).getByText('Create branch', { exact: true }).click();
  const d = p.locator('[role=dialog]').last();
  await d.waitFor();
  assert.equal(await d.locator('textarea').count(), 1);
  await d.locator('textarea').fill('try-this');
  await p.keyboard.press(`${mod}+Enter`);
  await d.waitFor({ state: 'detached' });
  await p.waitForFunction(() => /try-this/.test(document.querySelector('.pane.focus [data-k=branch]')?.textContent || ''));
});

await test('commit: commit & push reports the push', async p => {
  await openChanges(p);
  await keys(p, 'C');
  await menu(p).getByText('Commit & push').click();
  const d = p.locator('[role=dialog]').last();
  await d.waitFor();
  await p.keyboard.press(`${mod}+Enter`);
  await d.waitFor({ state: 'detached' });
  await p.waitForFunction(() => /push/i.test([...document.querySelectorAll('.toast')].map(e => e.textContent).join()));
});

await test('changes: nothing staged shows an empty state', async p => {
  await openChanges(p);
  await C(p).locator('.ctree .tf.all .cb').click();
  await p.waitForFunction(() => document.querySelector('.pane.focus .ctree .tf.all .cb')?.getAttribute('aria-checked') === 'true');
  await C(p).locator('.ctree .tf.all .cb').click();
  await p.waitForFunction(() => document.querySelector('.pane.focus .ctree .tf.all .cb')?.getAttribute('aria-checked') === 'false');
  await keys(p, 'g s');
  await menu(p).getByText('Staged', { exact: true }).click();
  await C(p).getByText('Nothing staged yet').waitFor();
});

await test('changes: a narrow pane hides the tree; t shows it there; f brings it for search', async p => {
  await openChanges(p);
  assert.equal(await C(p).locator('.ctree').count(), 0);
  assert.ok(await C(p).locator('.split').isVisible(), 'the commit button stays in view');
  const box = await C(p).locator('.split').boundingBox(), pane = await C(p).boundingBox();
  assert.ok(box.x + box.width <= pane.x + pane.width + 1, 'the commit button is not cut off');
  await keys(p, 't');
  assert.equal(await C(p).locator('.ctree').count(), 1);
  await keys(p, 't f');
  assert.equal(await C(p).locator('.ctree').count(), 1);
  assert.equal(await mode(p), 'INSERT');
}, { viewport: { width: 1100, height: 800 } });

// ---------- Files ----------

await test('files: lists the project with change marks; j k and enter open folders and files', async p => {
  await openFiles(p);
  const tree = p.locator('.pane.focus .files-v .ptree');
  const text = await tree.innerText();
  for (const n of ['sessions', 'ui', 'README.md', 'node_modules']) assert.ok(text.includes(n), n);
  assert.ok(await tree.locator('.gst').count(), 'changed files and folders are marked');
  // open the sessions folder, then a file in it
  while (!(await tree.locator('.rowcur, [aria-selected=true]').first().innerText().catch(() => '')).includes('sessions')) await keys(p, 'j');
  await keys(p, 'Enter');
  await tree.getByText('store.ts').waitFor();
  await keys(p, 'j');
  await keys(p, 'Enter');
  await p.locator('.pane.focus .file-v .src').waitFor();
});

await test('files: / filters by name across folders; enter opens the first hit', async p => {
  await openFiles(p);
  await keys(p, '/');
  await p.keyboard.type('theme');
  const tree = p.locator('.pane.focus .files-v .ptree');
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .files-v .ptree [role=treeitem]').length === 1);
  assert.match(await tree.innerText(), /theme\.css/);
  await p.keyboard.press('Enter');
  await p.locator('.pane.focus .file-v .src').waitFor();
  assert.match(await p.locator('.pane.focus .file-v .crumbs').innerText(), /theme\.css/);
});

await test('files: a click opens a file', async p => {
  await openFiles(p);
  await p.locator('.pane.focus .files-v .ptree').getByText('package.json').click();
  await p.locator('.pane.focus .file-v .src').waitFor();
});

// ---------- the open file ----------

/** Open a file from Files; Markdown opens as a preview, `source` switches it to the text. */
async function openFile(p, name, { source = true } = {}) {
  await openFiles(p);
  await p.locator('.pane.focus .files-v .ptree').getByText(name, { exact: true }).click();
  await p.locator('.pane.focus .file-v .src, .pane.focus .file-v .doc').first().waitFor();
  if (source && await p.locator('.pane.focus .file-v .doc').count()) { await keys(p, 'g p'); await p.locator('.pane.focus .file-v .src').waitFor(); }
}
const openReadme = (p, o) => openFile(p, 'README.md', o);
const F = p => p.locator('.pane.focus .file-v');

await test('file: syntax colours, a language badge, line numbers and the cursor line', async p => {
  await openFiles(p);
  await keys(p, '/');
  await p.keyboard.type('store.ts');
  await p.keyboard.press('Enter');
  await F(p).locator('.src').waitFor();
  assert.ok(await F(p).locator('.crumb.now .lang, .crumb.now [class*=badge]').count(), 'language badge');
  assert.equal(await p.locator('.pane.focus .tab.on .lang').innerText(), 'TS', 'the tab shows the language badge in place of its icon');
  assert.ok(await F(p).locator('.src .c span[class]').count(), 'syntax colours');
  assert.equal(await F(p).locator('.curl .n').innerText(), '1');
  await keys(p, 'j j');
  assert.equal(await F(p).locator('.curl .n').innerText(), '3');
  await keys(p, 'G');
  assert.equal(Number(await F(p).locator('.curl .n').innerText()), await F(p).locator('.src .n').count());
  assert.ok(await F(p).locator('.src .g-add, .src .g-chg, .src .g-del, .src [class*=g-]').count(), 'gutter change bars');
});

await test('file: i edits, esc reads, the tab is Modified, u undoes, :w saves', async p => {
  await openFile(p, 'package.json');
  await keys(p, 'i');
  assert.equal(await mode(p), 'INSERT');
  await p.keyboard.type('Hello ');
  await p.keyboard.press('Escape');
  assert.equal(await mode(p), 'NORMAL');
  await p.keyboard.press('Escape');
  await settle(p);
  assert.ok(await F(p).getByRole('button', { name: 'Save' }).isVisible());
  assert.equal(await p.locator('.pane.focus .tab.on.dirty').count(), 1, 'the tab marks unsaved edits');
  assert.match(await F(p).locator('.src .dl').first().innerText(), /Hello \{/);
  // u hands over to the editor and undoes there; ctrl-r redoes
  const ed = F(p).locator('.ed textarea');
  await keys(p, 'u');
  assert.equal(await mode(p), 'NORMAL');
  assert.ok(!(await ed.inputValue()).startsWith('Hello'));
  await keys(p, 'Control+r');
  assert.ok((await ed.inputValue()).startsWith('Hello'));
  await p.keyboard.press('Escape');
  await cmd(p, 'w');
  await p.waitForFunction(() => !document.querySelector('.pane.focus .file-v .tool-h .btn.mod'));
  assert.equal(await p.locator('.pane.focus .tab.on.dirty').count(), 0, 'saved: no dot');
  // the change shows in Changes
  await cmd(p, 'changes');
  await p.locator('.pane.focus .changes .cfile[data-p="package.json"]').waitFor({ state: 'attached' });
});

await test('file: crumbs list a folder; picking a file moves the tab; ctrl-o and ctrl-i walk history', async p => {
  await openReadme(p);
  await F(p).locator('.crumb').first().click();
  await menu(p).waitFor();
  await menu(p).getByText('package.json').click();
  await p.waitForFunction(() => /package\.json/.test(document.querySelector('.pane.focus .file-v .crumbs')?.textContent || ''));
  assert.ok(await F(p).getByRole('button', { name: 'Back' }).isEnabled());
  await keys(p, 'Control+o');
  await p.waitForFunction(() => /README\.md/.test(document.querySelector('.pane.focus .file-v .crumbs')?.textContent || ''));
  assert.ok(await F(p).getByRole('button', { name: 'Forward' }).isEnabled());
  await keys(p, 'Control+i');
  await p.waitForFunction(() => /package\.json/.test(document.querySelector('.pane.focus .file-v .crumbs')?.textContent || ''));
  await F(p).getByRole('button', { name: 'Back' }).click();
  await p.waitForFunction(() => /README\.md/.test(document.querySelector('.pane.focus .file-v .crumbs')?.textContent || ''));
  // - lists this file's folder from the keyboard
  await keys(p, '-');
  await menu(p).waitFor();
  await p.keyboard.press('Escape');
});

await test('file: / finds lines; enter jumps; n moves to the next hit', async p => {
  await openReadme(p);
  await keys(p, '/');
  await menu(p).waitFor();
  await p.keyboard.type('pnpm');
  await settle(p, 200);
  assert.ok((await menu(p).locator('.mi').count()) >= 2);
  await p.keyboard.press('Enter');
  await settle(p);
  const at = Number(await F(p).locator('.curl .n').innerText());
  assert.match(await F(p).locator('.curl').innerText(), /pnpm/);
  await keys(p, 'n');
  assert.ok(Number(await F(p).locator('.curl .n').innerText()) > at);
  assert.ok(await F(p).locator('.hit').count(), 'hits are highlighted');
});

await test('file: Markdown opens as a preview; gp and the Source / Preview switch toggle', async p => {
  await openReadme(p, { source: false });
  await F(p).locator('.doc.prose h1').waitFor();
  await keys(p, 'g p');
  await F(p).locator('.src').waitFor();
  await F(p).locator('.seg').getByText('Preview').click();
  await F(p).locator('.doc.prose h1').waitFor();
  await F(p).locator('.seg').getByText('Source').click();
  await F(p).locator('.src').waitFor();
});

await test('file: the project tree toggles beside the file and opens another file', async p => {
  await openReadme(p);
  if (!(await F(p).locator('.ctree').count())) await F(p).getByRole('button', { name: 'Project files' }).click();
  await F(p).locator('.ctree').getByText('package.json').click();
  await p.waitForFunction(() => /package\.json/.test(document.querySelector('.pane.focus .file-v .crumbs')?.textContent || ''));
  await F(p).getByRole('button', { name: 'Project files' }).click();
  assert.equal(await F(p).locator('.ctree').count(), 0);
});

// ---------- scopes, panes and terminals: mockup parity ----------

await test('changes: All changes lists the branch\'s files and offers no revert', async p => {
  await openChanges(p);
  await scopeChip(p).click();
  await menu(p).getByText('All changes', { exact: true }).click();
  await p.waitForFunction(() => /All changes/.test(document.querySelector('.pane.focus .changes [data-k=scope]')?.textContent || ''));
  await C(p).locator('.cfile').first().waitFor();
  assert.ok((await files(p)).length >= 1);
  assert.equal(await C(p).getByRole('button', { name: 'Revert file' }).count(), 0);
});

await test('popups: resize from an edge or a corner; holding alt swaps the x for its other action', async p => {
  await openChanges(p);
  await cmd(p, 'popout');
  const pk = p.locator('.peek');
  await pk.waitFor();
  assert.equal(await pk.locator('.rz').count(), 8);
  const before = await pk.boundingBox(), g = await pk.locator('.rz-sw').boundingBox();
  await p.mouse.move(g.x + 6, g.y + 6); await p.mouse.down();
  await p.mouse.move(g.x + 6 - 80, g.y + 6 + 60, { steps: 4 }); await p.mouse.up();
  const after = await pk.boundingBox();
  assert.ok(Math.abs(after.width - before.width - 80) < 3, `wider by 80 (${before.width} -> ${after.width})`);
  assert.ok(Math.abs(after.height - before.height - 60) < 3, 'taller by 60');
  assert.ok(Math.abs(after.x + after.width - (before.x + before.width)) < 3, 'the right edge stays');
  // the north edge cannot shrink it below the minimum height
  const n = await pk.locator('.rz-n').boundingBox();
  await p.mouse.move(n.x + 20, n.y + 3); await p.mouse.down(); await p.mouse.move(n.x + 20, n.y + 2000, { steps: 3 }); await p.mouse.up();
  assert.ok(Math.abs((await pk.boundingBox()).height - 220) < 3, 'stops at 220px');
  assert.equal(await pk.locator('.px').getAttribute('title'), 'Close · hold alt to put it back as a tab');
  assert.equal(await p.locator('.pane .tab .tx').first().getAttribute('title'), 'Close tab · hold alt to pop it out');
  await p.keyboard.down('Alt');
  assert.ok(await pk.locator('.px .i-dockin').isVisible());
  assert.ok(!(await pk.locator('.px .i-x').isVisible()));
  await p.keyboard.up('Alt');
  assert.ok(await pk.locator('.px .i-x').isVisible());
});

await test('tabs: a dragged tab leaves a slot that moves where it will land; dropping there reorders', async p => {
  await openChanges(p);
  await cmd(p, 'tabnew');
  const bar = p.locator('.pane.focus .tabs');
  const names = () => bar.locator('.tab .t').allInnerTexts();
  const was = await names();
  assert.equal(was.length, 2);
  const a = await bar.locator('.tab').nth(0).boundingBox(), b = await bar.locator('.tab').nth(1).boundingBox();
  await p.mouse.move(a.x + 20, a.y + 10); await p.mouse.down();
  await p.mouse.move(a.x + 30, a.y + 10, { steps: 2 });
  assert.equal(await p.locator('.tab.lift').count(), 1, 'the tab is lifted');
  assert.equal(await bar.locator('.tab.ghost').count(), 1, 'its bar keeps a slot');
  await p.mouse.move(b.x + b.width - 4, b.y + 10, { steps: 4 });
  const order = await bar.locator('.tab:not(.dragging)').evaluateAll(es => es.map(e => (e.classList.contains('ghost') ? 'slot' : 'tab')));
  assert.deepEqual(order, ['tab', 'slot'], 'the slot moved past the other tab');
  // over the pane's right edge: a half-pane panel with its own bar and the big icon
  const pb = await p.locator('.pane.focus').boundingBox();
  await p.mouse.move(pb.x + pb.width - 10, pb.y + pb.height / 2, { steps: 4 });
  await settle(p, 250);   // the panel glides into place
  assert.equal(await p.locator('.drop .tb .tab.ghost').count(), 1);
  assert.ok(Math.abs((await p.locator('.drop').boundingBox()).width - pb.width / 2) < 3);
  await p.mouse.move(b.x + b.width - 4, b.y + 10, { steps: 4 });
  await p.mouse.up();
  await settle(p);
  assert.deepEqual(await names(), [was[1], was[0]]);
  assert.equal(await p.locator('.tab.lift, .tab.ghost, .drop').count(), 0);
});

await test('shell: claude typed in a shell tab turns it into a thread in the sidebar', async p => {
  await p.locator('.pane.focus .card', { hasText: 'Shell' }).click();
  await p.locator('.pane.focus .xterm').waitFor();
  await settle(p, 300);
  await p.keyboard.type('claude');
  await p.keyboard.press('Enter');
  await p.locator('.toast', { hasText: 'Claude Code detected in this shell · added to the sidebar' }).waitFor();
  assert.ok(await p.locator('.pane.focus .tab.on .i-claude').count(), 'the tab is a Claude Code thread');
  assert.ok(await p.locator('.pane.focus .seg').count(), 'with the chat / terminal switch');
  assert.ok(await p.locator('#side').getByText('New thread', { exact: true }).count(), 'listed in the sidebar');
});

await test('handoff: chat mid-turn keeps driving; the card waits, esc goes back to chat', async p => {
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await settle(p, 450);
  await p.evaluate(() => { window.__skein.api.chat.drive = async () => {}; });   // the turn never ends here
  await p.locator('.pane.focus .seg button').nth(1).click();
  const h = p.locator('.pane.focus .handoff');
  await h.waitFor();
  assert.match(await h.innerText(), /Opens when this turn finishes/);
  assert.match(await h.innerText(), /Chat keeps driving this thread until then\./);
  assert.ok(await h.getByRole('button', { name: 'Back to chat' }).isVisible());
  assert.ok(await h.getByRole('button', { name: 'Interrupt and open' }).isVisible());
  assert.deepEqual(await p.locator('.pane.focus .seg button').evaluateAll(b => b.map(x => x.title)), ['Chat · driving', 'Terminal · read-only while the other view drives']);
  assert.equal(await p.locator('.pane.focus .seg').getAttribute('aria-label'), 'Chat or terminal · ldr t');
  // the row stands in for a field: h / l move along it (VIM-MODEL rule 16)
  const on = () => p.evaluate(() => document.activeElement?.textContent);
  await keys(p, 'l');
  assert.equal(await on(), 'Interrupt and open');
  await keys(p, 'h');
  assert.equal(await on(), 'Back to chat');
  await p.keyboard.press('Escape');
  await p.locator('.pane.focus .chat, .pane.focus .comp').first().waitFor();
  assert.equal(await h.count(), 0);
});

// ---------- any tab pops out and docks back ----------

const pfOf = p => p.evaluate(() => { const S = window.__skein.S; return S.workspaces.find(x => x.id === S.wid).pf; });
const activeId = p => p.evaluate(() => {
  const S = window.__skein.S, w = S.workspaces.find(x => x.id === S.wid);
  const find = n => n.tabs ? (n.id === w.focus ? n : null) : find(n.a) || find(n.b);
  return find(w.tree)?.active;
});
// a field or terminal holds the DOM focus; a list tool in NORMAL leaves it on body and takes the keys by being focused
const focusIn = (p, sel) => p.evaluate(s => { const a = document.activeElement; return !a || a === document.body || !!a.closest(s); }, sel);
/** ldr f pops the focused tab out, ldr d docks it: the same body, the same state, and the keys go with it. */
async function roundTrip(p, kind, body, check = async () => {}) {
  const id = await activeId(p);
  await keys(p, 'Control+Space f');
  await p.locator(`.peek.focus ${body} >> visible=true`).first().waitFor();
  await settle(p, 250);
  assert.equal(await pfOf(p), id, `${kind}: the popup has the keys`);
  assert.ok(await focusIn(p, '.peek.focus'), `${kind}: focus is in the popup`);
  await check(p.locator('.peek.focus'), `${kind} popped out`);
  await keys(p, 'Control+Space d');
  await p.locator(`.pane.focus ${body} >> visible=true`).first().waitFor();
  await settle(p, 250);
  assert.equal(await pfOf(p), null, `${kind}: docked`);
  assert.equal(await activeId(p), id, `${kind}: the same tab is active in the focused pane`);
  assert.ok(await focusIn(p, '.pane.focus'), `${kind}: focus is in the docked tab`);
  await check(p.locator('.pane.focus'), `${kind} docked`);
}
const draftKept = (sel, text) => async (c, at) => assert.equal(await c.locator(`${sel} >> visible=true`).first().inputValue(), text, `${at}: the draft is kept`);

await test('popups: every kind pops out and docks back with its state and the keys', async p => {
  // thread chat: a draft in the composer
  await p.locator('#side').getByText('Add timestamps to chat rows', { exact: true }).first().click();
  await p.locator('.pane.focus .compw textarea').waitFor();
  await settle(p, 450);
  await p.locator('.pane.focus .compw textarea').fill('kept draft');
  await roundTrip(p, 'chat', '.compw textarea', draftKept('.compw textarea', 'kept draft'));
  // thread terminal: the same session
  await p.locator('.pane.focus .seg button').nth(1).click();
  await p.locator('.pane.focus .xterm >> visible=true').first().waitFor();
  await settle(p, 300);
  const tid = await activeId(p), was = await p.evaluate(i => window.__skein.text(i), tid);
  await roundTrip(p, 'terminal', '.xterm', async (c, at) => assert.equal(await p.evaluate(i => window.__skein.text(i), tid), was, `${at}: same screen`));
  // shell: a typed line
  await cmd(p, 'tabnew');
  await p.locator('.pane.focus .card', { hasText: 'Shell' }).first().click();
  await p.locator('.pane.focus .xterm >> visible=true').first().waitFor();
  await settle(p, 300);
  await p.keyboard.type('echo kept');
  await settle(p, 200);
  const sid = await activeId(p);
  await roundTrip(p, 'shell', '.xterm', async (c, at) => assert.match(await p.evaluate(i => window.__skein.text(i), sid), /echo kept/, `${at}: the typed line`));
  // changes: the scope
  await openChanges(p);
  await keys(p, 'g s');
  await menu(p).getByText('Staged', { exact: true }).click();
  await p.waitForFunction(() => document.querySelectorAll('.pane.focus .changes .cfile').length === 1);
  await roundTrip(p, 'changes', '.changes .cfile', async (c, at) => assert.match(await c.locator('[data-k=scope] >> visible=true').first().innerText(), /Staged/, `${at}: the scope`));
  // files and a file: the cursor
  await openFiles(p);
  await roundTrip(p, 'files', '.files-v .ptree [role=treeitem]');
  await keys(p, '/');
  await p.keyboard.type('store.ts');
  await p.keyboard.press('Enter');
  await p.locator('.pane.focus .file-v .src').waitFor();
  await keys(p, 'j j');
  await roundTrip(p, 'file', '.file-v .src', async (c, at) => assert.equal(await c.locator('.file-v .curl .n >> visible=true').first().innerText(), '3', `${at}: the cursor line`));
  // browser (it reloads its page when re-parented: a webview cannot move without reloading)
  await cmd(p, 'browser');
  await p.locator('.pane.focus .browser-v').waitFor();
  await roundTrip(p, 'browser', '.browser-v');
  // vimrc
  await cmd(p, 'settings');
  await p.getByText('Vim', { exact: true }).last().click();
  await p.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await p.locator('.pane.focus .vimrc-view').waitFor();
  await settle(p, 200);
  await roundTrip(p, 'vimrc', '.vimrc-view .rc-ed');
  // subagent and side chat start as popups: dock, then pop out again
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await settle(p, 450);
  const seg = p.locator('.pane.focus .tb .seg button[aria-label^="Chat"]');
  if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
  await p.locator('.pane.focus .ag', { hasText: 'Test runner' }).click();
  await p.locator('.peek.focus textarea').waitFor();
  await p.locator('.peek.focus textarea').fill('sub draft');
  await keys(p, 'Control+Space d');
  await p.locator('.pane.focus .sub-h').waitFor();
  await roundTrip(p, 'subagent', '.sub-h', draftKept('textarea', 'sub draft'));
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await settle(p, 450);
  await p.locator('.pane.focus .sc-link', { hasText: 'Why not a mutex here?' }).first().click();
  await p.locator('.peek.focus .sc-anchor').waitFor();
  await p.locator('.peek.focus textarea').fill('side draft');
  await keys(p, 'Control+Space d');
  await p.locator('.pane.focus .sc-anchor').waitFor();
  await roundTrip(p, 'side chat', '.sc-anchor', draftKept('textarea', 'side draft'));
}, { timeout: 15000 });

await test(': opens the command line from Changes, Files and an open file in NORMAL', async p => {
  const colon = async at => {
    await p.keyboard.press(':');
    await p.locator('.menu.cmd').waitFor();
    await keys(p, 'Escape Escape');   // the : line's own NORMAL, then closed
    await settle(p, 150);
    assert.equal(await p.locator('.menu.cmd').count(), 0, `${at}: esc closes it`);
  };
  await openChanges(p);
  assert.equal(await mode(p), 'NORMAL');
  await colon('changes');
  await openFiles(p);
  await colon('files');
  await keys(p, '/');
  await p.keyboard.type('store.ts');
  await p.keyboard.press('Enter');
  await p.locator('.pane.focus .file-v .src').waitFor();
  assert.equal(await mode(p), 'NORMAL');
  await colon('file');
});

await test('popups: esc closes one and the keys go back to the pane; it reopens at the size it was left', async p => {
  await openChanges(p);
  await keys(p, 'Control+Space f');
  const pk = p.locator('.peek');
  await pk.waitFor();
  const g = await pk.locator('.rz-se').boundingBox();
  await p.mouse.move(g.x + 4, g.y + 4); await p.mouse.down(); await p.mouse.move(g.x + 64, g.y + 44, { steps: 3 }); await p.mouse.up();
  const size = await pk.boundingBox();
  await keys(p, 'Control+Space d');
  const pane = await p.evaluate(() => { const S = window.__skein.S; return S.workspaces.find(x => x.id === S.wid).focus; });
  await keys(p, 'Control+Space f');
  await pk.waitFor();
  const again = await pk.boundingBox();
  assert.ok(Math.abs(again.width - size.width) < 2 && Math.abs(again.height - size.height) < 2, 'the size it was left at');
  await keys(p, 'Escape');
  assert.equal(await pk.count(), 0, 'esc closed it');
  assert.equal(await pfOf(p), null);
  assert.equal(await p.evaluate(() => { const S = window.__skein.S; return S.workspaces.find(x => x.id === S.wid).focus; }), pane, 'the pane it came from has the keys');
});

await test('tools: a tool opens in the pane to the right instead of another split', async p => {
  await openChanges(p);
  await keys(p, 'Control+Space h');
  await cmd(p, 'filesview');
  await p.locator('.pane.focus .files-v').waitFor();
  assert.equal(await p.locator('.pane[data-pane]').count(), 2, 'still two panes');
  assert.equal(await p.locator('.pane.focus .tab').count(), 2, 'Files joined Changes');
  // tabs that don't fit: the bar scrolls and fades at the edge that has more
  await keys(p, 'Control+Space h');
  await cmd(p, 'browser');
  await p.setViewportSize({ width: 820, height: 900 });
  await settle(p, 300);
  const bar = p.locator('.pane.focus .tabs');
  assert.ok(await bar.evaluate(b => b.scrollWidth > b.clientWidth), 'the tabs overflow');
  assert.ok(await bar.evaluate(b => b.classList.contains('ovl') || b.classList.contains('ovr')), 'the bar fades');
});

await test('changes: the commit caret works on a clean tree; a file view quotes with its source', async p => {
  await openChanges(p);
  assert.ok(!(await C(p).locator('.split button').nth(1).isDisabled()), 'the caret is never disabled');
  assert.ok(await C(p).locator('.diff.flat[data-src^="diff:"]').count(), 'diffs carry their source');
  await openFile(p, 'package.json');
  assert.equal(await F(p).locator('.src').getAttribute('data-src'), 'file:package.json');
});

await test('tabs: a sidebar thread dragged into the panes lands as a tab where it is dropped', async p => {
  await openChanges(p);
  const row = await p.locator('#side').getByText('Add timestamps to chat rows', { exact: true }).first().boundingBox();
  const bar = await p.locator('.pane.focus .tabs').boundingBox();
  await p.mouse.move(row.x + 20, row.y + row.height / 2); await p.mouse.down();
  await p.mouse.move(row.x + 60, row.y + row.height / 2, { steps: 3 });
  await p.mouse.move(bar.x + bar.width - 20, bar.y + bar.height / 2, { steps: 6 });
  await settle(p, 200);
  assert.equal(await p.locator('.pane.focus .tabs .tab.ghost, .tabs .tab.ghost').count(), 1, 'the bar opens a slot');
  await p.mouse.up();
  await settle(p, 250);
  assert.ok(await p.locator('.pane.focus .tab.on', { hasText: 'Add timestamps' }).count(), 'the thread is the active tab there');
  assert.equal(await p.locator('.tab.ghost, .drop').count(), 0);
});

// ---------- the mouse on text in tools (VIM-MODEL rule 10) ----------

const selText = p => p.evaluate(() => getSelection().toString());
const bar = p => p.locator('.seltb');
/** The centre of the first occurrence of `word` in an element's text. */
async function wordAt(loc, word) {
  return loc.evaluate((el, w) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, acc = '', nodes = [];
    while ((n = walk.nextNode())) { nodes.push([n, acc.length]); acc += n.data; }
    const i = acc.indexOf(w); if (i < 0) return null;
    const at = k => { const [nn, b] = nodes.filter(([x, b0]) => b0 <= k && k < b0 + x.data.length)[0]; return [nn, k - b]; };
    const r = document.createRange(), [sn, so] = at(i), [en, eo] = at(i + w.length - 1);
    r.setStart(sn, so); r.setEnd(en, eo + 1);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, l: b.x + 2, r: b.right - 2 };
  }, word);
}

await test('file: double click selects a word in VISUAL with Add to Chat, triple the line, never editing', async p => {
  await openFile(p, 'package.json');
  const line = F(p).locator('.src .dl').nth(1).locator('.c');
  const w = await wordAt(line, 'name');
  await p.mouse.dblclick(w.x, w.y);
  await settle(p, 200);
  assert.equal(await mode(p), 'VISUAL');
  assert.equal(await selText(p), 'name');
  assert.ok(await bar(p).isVisible(), 'Add to Chat bar');
  assert.ok(!(await F(p).locator('.ed').isVisible()), 'not editing');
  // a click elsewhere lets it go
  await F(p).locator('.src .dl').nth(3).locator('.c').click();
  await settle(p, 150);
  assert.equal(await mode(p), 'NORMAL');
  assert.equal(await bar(p).count(), 0);
  // triple: the line in V-LINE
  await p.mouse.click(w.x, w.y, { clickCount: 1 }); await p.mouse.click(w.x, w.y, { clickCount: 2 }); await p.mouse.click(w.x, w.y, { clickCount: 3 });
  await settle(p, 200);
  assert.equal(await mode(p), 'V-LINE');
  assert.match(await selText(p), /"name"/);
  assert.ok(await bar(p).isVisible());
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL');
  assert.equal(await bar(p).count(), 0);
});

await test('file: a drag selects in VISUAL with Add to Chat; the line number puts the cursor at the line start', async p => {
  await openFile(p, 'package.json');
  const line = F(p).locator('.src .dl').nth(1).locator('.c');
  const a = await wordAt(line, 'name'), b = await wordAt(line, 'skein');
  await p.mouse.move(a.l, a.y); await p.mouse.down(); await p.mouse.move(b.r, b.y, { steps: 6 }); await p.mouse.up();
  await settle(p, 200);
  assert.equal(await mode(p), 'VISUAL');
  assert.match(await selText(p), /^name.*skein$/);
  assert.ok(await bar(p).isVisible());
  await F(p).locator('.src .dl').nth(2).locator('.n').click();
  await settle(p, 150);
  assert.equal(await mode(p), 'NORMAL');
  const row = F(p).locator('.src .dl').nth(2);
  assert.equal(await row.evaluate(r => { const c = r.querySelector('.c'), vc = r.querySelector('.vc'); const rg = document.createRange(); rg.setStart(c, 0); rg.setEndBefore(vc); return rg.toString().length; }), 0, 'column 0');
});

await test('changes: a click draws the character cursor; double click, drag and triple select with Add to Chat, not open the file', async p => {
  await openChanges(p);
  const tabs = await p.locator('.tab').count();
  const line = C(p).locator('.diff.flat .dl.add .c').filter({ hasText: 'import { load }' }).first();
  const w = await wordAt(line, 'load');
  await p.mouse.click(w.x, w.y);
  await settle(p, 150);
  assert.ok(['o', 'a'].includes(await C(p).locator('.dl.curl .vc').innerText()), 'the character cursor where clicked (the middle of load)');
  await p.mouse.dblclick(w.x, w.y);
  await settle(p, 200);
  assert.equal(await mode(p), 'VISUAL');
  assert.equal(await selText(p), 'load');
  assert.ok(await bar(p).isVisible());
  assert.equal(await p.locator('.tab').count(), tabs, 'no file opened');
  // a click on the toolbar lets the selection go
  await C(p).locator('.tool-h').click({ position: { x: 400, y: 10 } });
  await settle(p, 150);
  assert.equal(await mode(p), 'NORMAL');
  assert.equal(await selText(p), '');
  assert.equal(await bar(p).count(), 0);
  // a drag
  const a = await wordAt(line, 'import'), b = await wordAt(line, 'from');
  await p.mouse.move(a.l, a.y); await p.mouse.down(); await p.mouse.move(b.r, b.y, { steps: 6 }); await p.mouse.up();
  await settle(p, 200);
  assert.equal(await mode(p), 'VISUAL');
  assert.equal(await selText(p), 'import { load } from');
  assert.ok(await bar(p).isVisible());
  await keys(p, 'Escape');
  assert.equal(await mode(p), 'NORMAL');
  assert.equal(await bar(p).count(), 0);
  // triple: V-LINE on that line
  await p.mouse.click(w.x, w.y, { clickCount: 1 }); await p.mouse.click(w.x, w.y, { clickCount: 2 }); await p.mouse.click(w.x, w.y, { clickCount: 3 });
  await settle(p, 200);
  assert.equal(await mode(p), 'V-LINE');
  assert.match(await selText(p), /import \{ load \} from '\.\/store';/);
  assert.ok(await bar(p).isVisible());
  assert.equal(await p.locator('.tab').count(), tabs, 'no file opened');
  // Add to Chat quotes it into the thread's composer
  await bar(p).getByText('Add to Chat').click();
  await p.locator('.compw .bk .tok').first().waitFor();
});
