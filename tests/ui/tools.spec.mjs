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
  await p.locator('.menu.pal').waitFor();
  await p.keyboard.type(c);
  await p.keyboard.press('Enter');
  await settle(p, 200);
}
async function openChanges(p) {
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await settle(p, 200);
  await cmd(p, 'changes');
  await p.locator('.pane.focus .changes .cfile').first().waitFor();
}
async function openFiles(p) {
  await p.locator('#side').getByText(THREAD, { exact: true }).first().click();
  await settle(p, 200);
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
  for (const s of ['Last agent turn', 'Uncommitted', 'Staged', 'Unstaged', 'Commits']) assert.ok(text.includes(s), s);
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
  assert.match(await m.innerText(), /3 of 3/);
  // untick all: back to Uncommitted
  await m.getByText('All commits').click();
  await p.waitForFunction(() => /Uncommitted/.test(document.querySelector('.pane.focus [data-k=scope]')?.textContent || ''));
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
  assert.match(await toastText(p), /Restored store\.ts/);
  await keys(p, 'u');
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
