# Mockup parity

The interactive mockup in `mockups/` (`app.js`, `keys.js`, `annot.js`, `view-*.js`, `styles.css`) is the spec for
how Skein looks and how it responds: clicks, double and right clicks, hover, drag, keys and animations. This page
records how the real app (`src/renderer/src`) compares with it, row by row.

How it was audited (2026-11-20):

1. A code-driven inventory. Four agents read the mockup line by line (every `data-act` handler, `act.*` action,
   keydown branch, mouse and pointer handler, CSS transition, keyframe, hover state, toast and timing) and
   checked each against the app's code, driving both builds with Playwright where the code left doubt.
2. Hands-on clicking. A click survey drove the mockup scenes and the app side by side (click, double click,
   triple click on every kind of target) and compared the results.
3. Fix waves. Other agents fixed the gaps and wrote down what they did and why they left something.
4. An independent review (this page). Every Gap, Partial and KNOWN row was re-checked against the current code,
   the keyboard and popup claims were driven again in the browser build, and the mockup's handlers were walked
   again for anything the inventory missed.

Status: **Fixed** (the app now does what the mockup does; the pointer is where), **In progress** (being fixed
now, lands in the next batch), **Proposed deviation** (the app would differ on purpose, with the reason; none is
final until Josh approves it).
Rows that already matched are not listed. At review time: 159 rows Fixed, 41 Deviation, 33 Open (T12 counts as both Fixed and Deviation). Paths are under `src/renderer/src/`. KNOWN-n is the first-pass gap list.

## Keys and modes

| ID | Behaviour | Status | Where / why |
|---|---|---|---|
| KNOWN-40 | A focused popup's keys beat global bindings (ctrl-p, ctrl-k move the list) | Fixed | `input/dispatcher.ts:56`: menus, the / and @ lists and dialogs are `local`; driven in the palette, file search, pane search, `:` line, model picker, / menu and over the keyboard sheet. |
| keys G3 | No global binding fires while a dialog (sheet, settings, auth, move, lightbox) is open | Fixed | `ui/Dialog.tsx:24` marks every dialog `local`; ctrl-k over the keyboard sheet did nothing when driven. |
| keys G5 | While a menu is open, keys it uses stay with it; other global chords and the leader close it, then run | Fixed (refined with Josh) | `input/dispatcher.ts` local + `dismiss`; menus step aside, dialogs holding input keep every chord, ctrl-tab passes (VIM-MODEL rule 20). |
| keys G11 | ctrl-o / ctrl-i only act when there is somewhere to jump, else the key falls through | Fixed | `shell/commands.ts:91-92` return false; the stale note in VIM-MODEL section 6 was removed. |
| keys G12 | mod-l / mod-shift-s with no selection do nothing | Proposed deviation | The app toasts "Select text in a thread first" (`shell/commands.ts:94`), which explains a silent key. |
| keys L3 | leader `o` focuses the next popup | Fixed | `input/keymap.ts:109`, `state/actions.ts:249` popNext. |
| keys L4 | leader `d` docks the focused popup | Fixed | `input/keymap.ts:110`, `state/actions.ts:257`. |
| keys L5 | leader `r` rotates the split | Fixed | `shell/commands.ts:79`. |
| keys L6 | leader `+` / `-` resize stacked panes | Fixed | `shell/commands.ts:78`, step 0.06. |
| keys L7 | leader `[` opens a reader on any tab, a chat tab included | Fixed | `shell/commands.ts:88` enters the chat reader, else the scrollback. |
| keys L8 | leader esc: scrollback in a terminal, else NORMAL; leader space: NORMAL | Fixed | `shell/commands.ts:85-86`. |
| keys L9 | Extra leader keys `f` (pop out) and `:` | Proposed deviation | Additions that clash with nothing in the mockup. |
| keys L10 | ctrl-w in NORMAL arms the whole leader | Fixed | `input/keymap.ts:146`, `shell/keyboard.ts` armLeader. |
| keys M2 | ctrl-h / ctrl-l act as left / right in menus | Fixed | `ui/Menu.tsx:144`. |
| keys M8 | Tab picks like enter in every menu (folder lists go in) | Fixed | `ui/Menu.tsx:151-156`. |
| keys M9 | enter with nothing to pick closes a menu without search and lets enter through | Fixed | `ui/Menu.tsx:153-156`; the @ menu's Loading state is handled in the composer. |
| keys M10 | NORMAL space picks without closing | Fixed | `ui/Menu.tsx:169`. |
| keys M11 | NORMAL `x` in a menu deletes the search's last character | Proposed deviation | HANDOFF "Closing VIM-MODEL section 6": the search field is a full Vim field in NORMAL. |
| keys M13 | `l` in a menu without search goes to its own keys | Proposed deviation | `l` picks (`ui/Menu.tsx:181`), documented in HANDOFF. |
| keys B1 | Rows of buttons (rule 16): h / l move, enter / space press | Fixed | `ui/kbrow.ts:20` useKbRow for terminal rows; the mirror bar in `views/chat/ChatView.tsx:137-146`. |
| keys B2 | esc in a button row presses `[data-esc]` | Fixed | `ui/kbrow.ts`, `views/chat/ChatView.tsx:144`. |
| keys B3 | `[` and `{` from the mirror bar read the thread above | Fixed | `views/chat/ChatView.tsx:147` (`[[` and `{` on the idle surface). |
| keys B4 | `i` / `a` on the mirror bar press Take back | Fixed | `views/chat/ChatView.tsx:136`. |
| keys C2 | On a new thread, `j` from the controls walks to the machine / folder / worktree chips and the cards | Fixed | `views/chat/Composer.tsx:203` rows(): j / k walk the controls, the chips and the cards; test "launcher: j walks from the controls to the chips and the cards". |
| keys C5 | `i` / `a` from the controls row go back to INSERT at the end of the text | Fixed | `views/chat/Composer.tsx:214`. |
| keys C7 | Any mousedown clears the controls cursor | Fixed | `views/chat/Composer.tsx:225`. |
| keys C8 | The controls cursor scrolls into view as it moves | Fixed | `views/chat/Composer.tsx:210` ctlMark scrolls the marked control into view (no `void animate` is left in Composer). |
| keys C9 | In VISUAL, `j` / `k` at the field's edges stay in the field | Fixed | `input/vimtext.ts:187` (one-line fix in this review; it used to jump to the controls or the reader). |
| keys I3 | `inoremap jk` checks the character before the caret within 600 ms | Proposed deviation | The app tracks the last typed key within 500 ms (`input/dispatcher.ts:76-81`); same effect for normal typing. |
| keys N3 | NORMAL never edits natively (Backspace, Delete, Tab, ctrl-a) | Fixed | `input/dispatcher.ts:100`. |
| keys N5 | `[[` from the composer goes to your last message | Fixed | `views/chat/ChatView.tsx:248-253`. |
| keys N6 | `{` stops at a blank line in the draft before going to the reader | Fixed | `views/chat/ChatView.tsx:243-247`. |
| keys N12 | esc from composer NORMAL blurs the field, so no cursor stays drawn | Fixed | `views/chat/ChatView.tsx:420` onLeave blurs the field before idle; test "esc esc leaves the composer unfocused; i types at the end". |
| keys A5 | `i` / `a` in app NORMAL refocus the composer with the caret at the end | Fixed | `views/chat/ChatView.tsx:143`: `i` / `a` / enter put the caret at the end first. |
| keys N13 | esc from NORMAL in a popup's composer closes the popup | Fixed | `views/chat/ChatView.tsx:363` and keymap `popclose` (`input/keymap.ts:142`); driven. |
| keys V1 | Undo history survives a remount (tab moved, popped out) | Fixed | `ui/VimField.tsx:46-55`. |
| keys V2 | `u` / ctrl-r at the end toast "Already at oldest / newest change" | Fixed | `ui/VimField.tsx:95`. |
| keys V5, V8, V10 | Word motions, `I`, and extras (counts, registers, `r ~ J`, text objects) | Proposed deviation | The app follows real Vim (VIM-MODEL rules 18, 19). |
| keys A1 / shell S25 | App NORMAL `j` / `k` / enter / `o` move and open the sidebar cursor without focusing it | Fixed | `shell/keyboard.ts:29-44` (the layout surface, and what a chat's own app-NORMAL surface leaves) calls `cursorKey` (`shell/Sidebar.tsx:199`). In a chat the chat's own keys come first, so `k` there still enters the reader and enter still goes back to the composer. |
| keys A2 | `/` in app NORMAL opens the palette | Deviation (approved by Josh) | `/` is always a search where you are: text in the reader, files, diffs and scrollback; a filter in the sidebar and lists; ctrl-k stays the palette (VIM-MODEL rule 22, `shell/commands.ts` search). |
| keys A3 | `g v` switches chat / terminal | Fixed | `input/keymap.ts:143`. |
| keys A9 | Normal-layer sequences have no timeout | Proposed deviation | 1200 ms timeout (`input/dispatcher.ts:92`) so a stray `g` does not linger. |
| keys R3 | H L \| \\ work while reading | Fixed | `views/chat/reader.ts:359` passes unhandled keys to the normal layer. |
| keys R4 / chat R6, R7 | Reader `g f` and enter on a file row open the file | Fixed | `views/chat/reader.ts:295-313`. |
| KNOWN-41 / keys K41b, chat E3 | Editing a past message from the reader maps the rendered cursor to the raw text | Fixed | `views/chat/markdown.tsx:31` shownToRaw, used at `views/chat/ChatView.tsx:195`. |
| keys K41c | The mapped cursor is clamped to the NORMAL range | Fixed | `views/chat/ChatView.tsx:197-198`. |
| keys K41f / chat E4 | esc from the edit box puts the reader cursor back on that message | Fixed | `views/chat/ChatView.tsx:211-217`. |
| keys K41g | `i` / `a` on your message in a subagent or mirror tab falls through to typing | Fixed | The reader matches `.can-edit` (`views/chat/reader.ts:321`); edits in subagents stay off (no rewind in the harness). |
| keys K41h | `k` on the edit box's first line reads the thread above | Fixed | `views/chat/ChatView.tsx:203-209`. |
| keys K41j / chat E5 | Vim off: esc in the edit box cancels it | Fixed | VimField calls onLeave on esc with Vim off (`ui/VimField.tsx:103`), which runs cancelEdit. |
| keys O7 | Rule 20: a focused temporary list sees every key first | Fixed | Menus and dialogs are `local` (see KNOWN-40). |

## Composer and chat

| ID | Behaviour | Status | Where / why |
|---|---|---|---|
| KNOWN-1 | A click into the composer shows the caret in INSERT | Fixed | `ui/VimField.tsx`; live Match in the chat wave. |
| KNOWN-2 | Hollow block cursor at an empty line or the end in NORMAL | Fixed | `views/chat/Composer.tsx` back layer `.hc`. |
| KNOWN-3 | A click in a reply puts the reader cursor there | Fixed | `views/chat/reader.ts` fromMouse. |
| KNOWN-4 | No stray or duplicate cursors | Fixed | See keys N12. |
| KNOWN-5 / chat E6 | A click outside the edit box cancels it | Fixed | `views/chat/ChatView.tsx:298` (clicks inside the chat view). |
| KNOWN-6 / chat P12 | VISUAL moving end drawn as `.vcur`; a quote is one block | Fixed | Composer back layer. |
| KNOWN-7 / chat P3 | Permission chip and menu | Fixed | `views/chat/Composer.tsx:174, 337`. |
| KNOWN-8 / chat P4 | Model picker with effort slider, Ultracode, search | Fixed | `views/chat/Composer.tsx:161-170, 431-444` (track click and drag too). |
| KNOWN-9 | The new-thread model picker has effort | Fixed | The launcher uses the same Composer (`shell/Launcher.tsx:89`). |
| chat P3, P4 (lists) | Model and permission pickers list what each harness really offers (deviation from the mockup's placeholder lists, decided by Josh) | Deviation (decided by Josh) | `core/harness/options.ts` asks the harness per machine (Claude: the Agent SDK's initialize models, with effort levels; Codex: app-server `model/list` and `configRequirements/read`), cached 10 min (30 s after a failure); API `harness.options` (`shared/api.ts`, `main/services.ts`); the renderer keeps them in `views/chat/options.ts` and the picker and permission menu read them (`views/chat/Composer.tsx` openModelPicker, pickPerm). Permission modes: Claude, every SDK PermissionMode (Default, Accept edits, Plan mode, Auto mode, Don't ask, Bypass permissions); Codex, its approval presets (Read Only, Default, Full Access). `shared/models.ts` is the fallback when the harness can't be asked. The look is the mockup's (rows with harness marks, effort track, Ultracode only for Claude models, a check on the current one). Efforts: Codex's `ultra` (above max) is the top stop when model/list gives it and goes to `turn/start` as `ultra`. Ultracode is sent: the switch rides each chat send (`ChatSend.ultra`) and the Claude driver passes `settings.ultracode` at start and `applyFlagSettings` with both `effortLevel` and `ultracode` after (`core/harness/claude/driver.ts`); it works at any effort. The SDK's ModelInfo has no Ultracode flag, so the switch shows on models with effort levels and adaptive thinking. The / menu does the same per machine and folder (`core/harness/commands.ts`, API `harness.commands`, `views/chat/options.ts` useHarnessCommands): Claude Code's initialize `commands` run in the thread's folder (built-ins first, the rest under Skills); Codex's built-in commands with its `skills/list` skills, inserted as `$name` and sent as skill inputs. /side, /sidechats, /subagents and /model stay Skein's. |
| KNOWN-10 / chat M2 | / menu names, icons, order, skills | Fixed | `views/chat/options.ts`. |
| KNOWN-11 / chat P5, K5 | Context ring popover | Fixed | `views/chat/Composer.tsx` ContextUsage. |
| KNOWN-12 | Attach tooltip "Attach image · or paste one" | Fixed | `views/chat/Composer.tsx:336` (native title, as the mockup). |
| KNOWN-39 / chat C5-C8, C11, C12 | A quote is one linked token: tinted source, hot on hover, x to remove, click to reveal, arrows step over | Fixed | `views/chat/state.ts:122-162`, `views/chat/Composer.tsx:261-349`. |
| chat C2 | After Add to Chat the caret sits after the token, in INSERT | Fixed | VimField keeps its first value; test "a second Add to chat goes after the first". |
| chat C3 | Quotes are kept in text order, so the right words are sent | Fixed | `views/chat/threads.ts:116` syncQuotes. |
| chat C9 | A quote whose source is closed reopens it (thread or file) and reveals | Fixed | Composer goQuote; diff and plan sources do not reopen. |
| chat C16 | The token is sent as is | Proposed deviation | The full quote text is sent because the harness needs the words; the bubble still shows chips. |
| chat C17 | Add to Chat on a terminal-view thread types `"text" ` into the TUI | Fixed | `views/chat/threads.ts:135`. |
| chat C18 | Drafts keep their quotes across a relaunch | Fixed | `views/chat/state.ts:80`. |
| chat C19 | A yanked and put token gets its own quote | Fixed | syncQuotes makes a twin. |
| chat S1 | The selection bar is clamped by its own width | Fixed | `views/chat/SelBar.tsx:13`. |
| chat S2 | The selection bar shows in every view | Proposed deviation | Files and diffs have their own selection handling; quoting from them works (CT-61, CT-70). |
| chat S4 | The bar hides when the selection collapses | Fixed | selectionchange in ChatView. |
| chat S5 | A drag is clamped live to its block | Fixed | `views/chat/ChatView.tsx:62-77`. |
| chat S7 | mod-l with no selection does nothing | Proposed deviation | See keys G12. |
| chat S8 | A new side chat from a quote is titled with an ellipsis at 28 characters | Fixed | `views/chat/threads.ts`. |
| chat S9 | The side-chat chooser opens below the selection, 290 wide | Fixed | `views/chat/threads.ts:65`. |
| chat S11 | Quoting from a file goes to the thread's chat or its terminal | Fixed | `views/chat/threads.ts:125-138`. |
| chat R11 | `G` from the reader lands at the start of the composer's last line | Proposed deviation | Coordinator decision: `G` stays in the reader. |
| chat R17 | Any mousedown outside the selection bar turns the reader off | In progress | Confirmed by the click survey (Z8); a fix is in progress in `views/chat/reader.ts` (uncommitted). |
| chat R20 | H L \| \\ from the reader | Fixed | See keys R3. |
| chat E10 | Editing in side chats and subagents | Proposed deviation | A subagent transcript cannot be rewound through the harness; side chats can be edited. |
| chat P6 | Send turns into stop whenever a turn runs | Proposed deviation | With text typed, send queues a follow-up (HANDOFF). |
| chat P7 | Send is never disabled | Proposed deviation | An empty send is disabled; minor. |
| chat P11 | Drag or double click in the composer gives VISUAL; triple click V-LINE | Fixed | `ui/VimField.tsx:131-137`. |
| chat P15 | esc from composer NORMAL in a popup closes it | Fixed | See keys N13. |
| chat P16 | j walks the new thread's chips and cards | Fixed | See keys C2. |
| chat P17 | A mousedown clears the controls cursor | Fixed | See keys C7. |
| chat P18, P19 | `[[` and `{` from the composer | Fixed | See keys N5, N6. |
| chat P22 | Undo toasts at the ends | Fixed | See keys V2. |
| chat P23 | `inoremap jk` | Proposed deviation | See keys I3. |
| chat P24 | An image pasted anywhere in the tab attaches it | Fixed | `views/chat/ChatView.tsx:49-54`. |
| chat M4 | Tab picks in the / and @ menus | Fixed | See keys M8. |
| chat M9 | /model at the start of an empty draft clears it | Proposed deviation | Only the word is removed, so a draft is never lost (HANDOFF). |
| chat M11 | /model, /side, /sidechats, /subagents typed alone run on enter | Fixed | `views/chat/Composer.tsx:150-156`. |
| chat M12 | /model in a subagent | Proposed deviation | A subagent uses its thread's model. |
| chat M13, M14 | @ lists every project file by substring; no empty state | Proposed deviation | Real filesystem browsing, folder by folder, with a Loading state. |
| chat D1 | Reply actions show the age on every turn; tooltip names /side | Fixed | Transcript Acts. /side is back (Josh, 2026-11-20): it starts a side chat at once, about the composer's quote (which moves into it) or the last reply; /sidechats lists them. |
| chat D2 | No reply actions in side chats | Fixed | Transcript `c.main`. |
| chat D5 | The side chat anchor scrolls to the message | Proposed deviation | Both builds only open the thread. |
| chat D6 | "Send to thread" replaces the draft with "> " + the answer | Proposed deviation | The app inserts a linked quote and keeps the draft. |
| chat D7 | /sidechats rows have a pencil Rename, oldest first | Fixed | `views/chat/threads.ts:59-79`. |
| KNOWN-51 | Timeline ticks as in Cursor: 2px ticks; the pointer lengthens and darkens the tick under it most and about three on each side less, gliding; press and drag scrubs the thread, release stays | Fixed (Josh's request; the mockup had 1.5px ticks that only lengthened) | `views/chat/Ticks.tsx`, `chat.css`; clip `skein-parity/timeline-ticks.mp4`; UI test "timeline ticks". |
| KNOWN-52 | A reply's action row (copy, fork, side chat, age) is a line in the reader: `j` / `k` land on it, `h` / `l` (`w` / `b`, `0` / `$`) ring a button, `enter` or `space` presses it; the row shows while the cursor is on it | Fixed (Josh's request) | `views/chat/reader.ts` ROWS / KROWS, `styles/skein.css` `.m-acts.rowcur`, `.m-acts .ib.kcur`; UI tests "reader: j lands on a reply's action row", "enter on Fork in the action row". |
| KNOWN-53 | `G` goes to the true last line, the last reply's action row when it has one; `gg` the top | Fixed (Josh's request) | `views/chat/reader.ts` `G`; UI test "reader: G goes to the last action row". |
| KNOWN-54 | VISUAL / V-LINE (and a mouse drag) is bounded by the message: a whole reply, prose, code and tool rows together, or one of your bubbles; in VISUAL `gg` / `G` go to its start and end and `j` / `k` stop at its edges | Fixed (Josh's request) | `views/chat/reader.ts` SEL_BLOCK, `edge`; `views/chat/ChatView.tsx` drag clamp; UI tests "VISUAL gg / G stay inside one reply", "a mouse drag past a reply". Supersedes chat S5's per-block clamp. |
| KNOWN-56 | `V` then `y` in a reply copies the Markdown behind the lines (bullets, numbers, emphasis, links, code fences); `v` then `y` copies the text as shown | Fixed (Josh's request) | `views/chat/markdown.tsx` `data-ml` and rawLines, `views/chat/reader.ts` markdown(); UI tests "reader yank". |
| KNOWN-58 | `esc` `esc` stops a running turn: the first `esc` in the composer's NORMAL arms the stop button ("Esc", 1.5 s, scale / opacity in from `ui/motion`, aria-label "Press Esc again to stop"), the second stops as the stop button does; when the window ends nothing stops and the next `esc` leaves; a side chat stops its own turn | Fixed (Josh's request) | `views/chat/Composer.tsx` escStop, `ui/primitives.tsx` SendButton `armed`, `views/chat/chat.css` `.send.armed`; VIM-MODEL rule 2; UI tests "esc esc stops a running turn", "esc esc: after the 1.5 s window". |
| chat D11 | No timeline ticks in side chats | Fixed | `views/chat/ChatView.tsx:346`. |
| chat T1 | User bubbles show quote chips; images zoom | Fixed | Transcript `.qtok`, lightbox. |
| chat T3 | Every Edit diff starts open | Fixed | `views/chat/Transcript.tsx:127`. |
| chat T5 | Read / Edit paths are links that open the file | Fixed | `views/chat/Transcript.tsx:124-128`, reader `g f`. |
| chat T8 | "Worked for" has a chevron | Fixed | `views/chat/Transcript.tsx:149`. |
| chat T10 | Plan card with a file, Open and Approve | Proposed deviation | The harness sends the plan as request text, not a file. |
| chat A3 | Error rows use the alert icon and are button rows | Fixed | `views/chat/Transcript.tsx:78-79, 143`; no "Resets at" (no data). |
| chat A4 | Fix buttons: Resuming / Retrying, auth opens /login, missing copies the install | Fixed | `views/chat/Transcript.tsx:89`; auth opens the real terminal. |
| chat A6 | The mirror bar is a keyboard row | Fixed | See keys B1, B4. |
| chat A7 | Take back toasts "Chat has the thread again" | Fixed | `views/chat/ChatView.tsx:82`. |

## Sidebar and shell

| ID | Behaviour | Status | Where / why |
|---|---|---|---|
| KNOWN-13 / shell B14 | Machine heading hover `+` and `⋯` | Fixed | `shell/Sidebar.tsx`. |
| KNOWN-14 / shell B9 | Double click renames a thread or project; a single click waits 350 ms | Fixed | `shell/Sidebar.tsx:246-248, 333`. |
| shell B9 (empty name) | Clearing a project name keeps the old name | Proposed deviation | Clearing resets it to the folder's name (`shell/Sidebar.tsx:112-115`), the only way to undo a rename. |
| KNOWN-15 / shell B17, CT-26 | Project drag reorder shows a preview of the row under the pointer | Fixed | `.s-d.drag-preview` (folder icon and name) follows the pointer (`shell/Sidebar.tsx:128`). |
| KNOWN-16 / CT-22 | Sidebar resize handle | Fixed | `shell/Sidebar.tsx:298-304`. |
| KNOWN-17 / shell B8 | `.row.vis` for threads on screen | Fixed | `shell/Sidebar.tsx:237`. |
| KNOWN-18 / shell B15 | The sign-in dot opens the auth dialog | Fixed | `shell/Sidebar.tsx:271-272`. |
| KNOWN-19 / shell K4 | Machines popover | Fixed | `shell/overlays.tsx:325`. |
| KNOWN-22 / shell W4 | Status bar waiting dot | Fixed | `shell/StatusBar.tsx`. |
| KNOWN-33 / shell X2 | `claude` / `codex` typed in a shell is adopted | Fixed | `views/terminal/TerminalView.tsx:174-180`. |
| shell S7 | Any modifier click on a row opens it in a split | Fixed | `shell/Sidebar.tsx:244-245`. |
| shell B1 | View toggle title ends "· click to switch" | Fixed | Sidebar top row. |
| shell B3 | A machine with nothing in it is not listed | Proposed deviation | Remote machines stay listed so `+` can add their first project. |
| shell B4 / CT-5 | Archived row always shown; its chevron animates | Fixed | `shell/Sidebar.tsx:346`. |
| shell B10 | A click in the sidebar gives it the keys | Fixed | `shell/Sidebar.tsx:308`; opening a thread hands them to the thread (HANDOFF). |
| shell B13 | Sidebar focus re-picks a cursor that is gone | Fixed | `shell/Sidebar.tsx:203`. |
| shell B19 | A thread dropped on a machine with a same-named repo goes straight to Move | Fixed | `dropOnMachine` (`shell/move.tsx:52`). |
| shell B20 / CT-8 | A new or moved thread's row flashes (`.fresh`) | Fixed | `shell/Sidebar.tsx:208-218, 237`. |
| shell F2 | Folder rows with sub-folders show a chevron | Proposed deviation | It would need a listing per row, slow over SSH (HANDOFF). |
| shell F4 | A new thread's folder chip uses the shared folder field (recent folders, typed paths) | Fixed | `openFolderPicker`, top-start, 360 wide (`shell/Launcher.tsx:96`); the old `dirMenu` is gone. |
| shell F5 | Move's "Other folder…" uses the shared folder field | Fixed | `shell/move.tsx:47`. |
| shell F6 | Folders used once are remembered | Fixed | Saved with `api.app.save('dirs')`. |
| shell L2 | The new-thread composer has the permission chip and attach | Fixed | `shell/Launcher.tsx:89` uses the full Composer. |
| shell L3 | Worktree chip "main" / "new worktree" | Fixed | `shell/Launcher.tsx:95`. |
| shell L4 | Machine menu above its chip, 280 wide, with address hints and "Add SSH host" | Fixed | `shell/Launcher.tsx:75`. |
| shell L5 | Picking a machine sets the folder to its first known folder | Fixed | It keeps the folder when that machine knows it, else that machine's most recent folder (`shell/Launcher.tsx:81-83`). |
| shell L6 | Switching harness toast names the model with its icon | Fixed | "X has only Codex. Switched to **GPT-6.2 Sol**", with the harness icon (`shell/Launcher.tsx:85-89`). |
| shell L7 | Folder chip title "Directory" | Fixed | `shell/Launcher.tsx:93`. |
| shell L9 | Offline machine toast "X is offline" | Proposed deviation | The app says "X is not connected" and starts connecting, which a real machine needs. |
| shell W3 | Switching workspace lands in NORMAL with the sidebar cursor cleared | Fixed | `state/actions.ts:295` (and a new workspace at 289). |
| shell W5 | Leader hint row matches the mockup | Fixed | `shell/StatusBar.tsx`. |
| shell K6 | "Connected to X" toast after signing in | Fixed | `shell/App.tsx:59-62`. |
| shell K8 | Move with a code choice; a running thread waits | Proposed deviation | HANDOFF: code never moves; a busy thread is refused with the reason. |
| KNOWN-44 | Sidebar resizes by dragging its edge, width remembered | Fixed | `shell/Sidebar.tsx:291` (200px to 60%, kept on this computer) |
| KNOWN-45 | Sidebar by keyboard: alt-h from the leftmost pane, ctrl-w h, back with alt-l or enter | Fixed | `state/actions.ts` focusDir / sideFocus |
| KNOWN-46 | Sidebar stays live: Recent reorders on activity, outside sessions rediscovered, ages tick | Fixed | `core/threads.ts` update, `shell/App.tsx` rediscover (local every 60s and on focus, remote on focus at most every 5 min) |
| KNOWN-47 | Blue unread dot when a turn ends out of sight, cleared when you open the thread | Fixed | `state/actions.ts` turnEnded / markRead |
| KNOWN-48 | Archive is a Skein concept for every harness | Decided (Josh) | Skein keeps its own flag for Claude Code and Codex alike; it never calls Codex's archive and doesn't read `~/.codex/archived_sessions`. |
| KNOWN-49 | A chat view follows a session another process (an outside terminal) is writing, read-only while it owns it | In progress | live transcript follower in `core/` |

## Panes, tabs and popups

| ID | Behaviour | Status | Where / why |
|---|---|---|---|
| KNOWN-50 | Dragging a popup's header (a side chat) or a lower pane's tab bar moved the whole window | Fixed | The header's `.drag` spacer outranked `.peek *` no-drag (`styles/app.css:11-13`); UI test "window drag". |
| KNOWN-42 | Popups sit where the mockup puts them: `:` and workspaces over the status bar, pane search under its ▾, composer menus above their chips; only ctrl-k and ctrl-p centred | Fixed | The new-thread machine and folder menus now open above their chips too (`shell/Launcher.tsx:75, 96`). |
| KNOWN-43 / KNOWN-26 / shell C4 | Pane search lists the focused thread first (its side chats and subagents), then its tabs, the tools not open, and pane actions | Fixed | `shell/overlays.tsx:124-155`; driven on "Fix session-restore race": side chat and three subagents at the top. |
| KNOWN-29 / CT-45 | Popup resize grips on every edge and corner | Fixed | `shell/Workspace.tsx:178-196`. |
| KNOWN-30 / shell D2, D3, CT-49 | Tab drag: lift, ghost slot, gliding neighbours with no jitter | Fixed | `shell/tabdrag.ts:71-75` uses layout positions. |
| KNOWN-31 | Status in popup headers, the zoom rail and subagent tabs | Fixed | `shell/Workspace.tsx:197, 228`. |
| KNOWN-32 / CT-74 | File tab language badge and dirty mark | Fixed | `shell/Workspace.tsx:53-59`. |
| shell S5 | `ldr c` / `+` on a launcher only focuses it | Fixed | `shell/commands.ts:41-45`. |
| shell S8 / CT-72 | Tools and files open beside, in the pane to the right or a new split | Fixed | `state/actions.ts:61-69`. |
| shell S10 | alt-hjkl in a popup does nothing | Fixed | `state/actions.ts:31`. |
| shell S12, S13, S15-S18 | Leader resize, rotate, popup focus, dock, esc / space, ctrl-w | Fixed | See keys L3-L10. |
| shell S21 | Extra keys (`ldr f`, `ldr :`, cmd-t / cmd-n on Mac, `:1`..`:9`) | Proposed deviation | Additions; `:only` lost its key to match the mockup's `ldr o`. |
| shell S22 / CT-21 | Divider drag: pointer capture, clamp .12-.88, no re-render per move | Fixed | `shell/Workspace.tsx:119-131`; double click resets to 50/50 (an addition). |
| shell S24 | `:chatall` / `:termall` also set the default view | Fixed | `shell/commands.ts:101-102`. |
| shell T3 | Popping a tab out activates the tab before it | Fixed | `state/actions.ts:215`. |
| shell T5 | Middle click closes a tab | Proposed deviation | An addition (`shell/Workspace.tsx:60`). |
| shell T8 | Window controls drawn in the tab bar | Proposed deviation | Native title bar overlay and traffic lights (Electron). |
| shell T9 / CT-42 | Overflowing tabs fade at the edge with more | Fixed | `shell/Workspace.tsx:75-84`. |
| shell T12 | A side chat tab shows the chat icon; an SSH shell is "bash" | Fixed / Deviation | Icon fixed in this review (`shell/meta.ts:24`); the SSH shell is titled with the machine's name, which says more. |
| shell D4 | Dropping a tab on its own pane's middle changes nothing | Fixed | `shell/tabdrag.ts`. |
| shell D8 / CT-50 | A sidebar row dragged onto the panes opens there | Fixed | `shell/move.tsx:132-159`. |
| shell D9 | A tab dropped outside every pane | Proposed deviation | It pops out (HANDOFF). |
| shell P2 | Side chat popups are narrower | Fixed | `shell/Workspace.tsx:195`. |
| shell P3 | Dragging a popup by its header drops to NORMAL | Fixed | `shell/Workspace.tsx:171`. |
| shell P5 | Closing a popup restores where the keys were | Fixed | `state/actions.ts:181-215`; ChatView registers place / restore. |
| shell P6 | esc from NORMAL in a popup closes it | Fixed | `input/keymap.ts:142`; driven. |
| shell P7 | ctrl-o / ctrl-i between a popup and its pane, keeping places | Fixed | `state/actions.ts:224-247`. |
| shell POPDOCK-browser | A Browser tab keeps its page when popped out or docked | Proposed deviation | A webview reloads when re-parented; the URL is kept. |

## Tools

| ID | Behaviour | Status | Where / why |
|---|---|---|---|
| KNOWN-34 / shell X3 | Handoff card wording and keys | Fixed | `views/terminal/ThreadTerminal.tsx:102` useKbRow. |
| KNOWN-35 / shell X5, X10 | Upload overlay shows progress and the failure cause; failed row is a button row | Fixed | `views/terminal/TerminalView.tsx:238`. |
| KNOWN-36 / CT-76 | vimrc tab beside, with its path, applying as you type | Fixed | `shell/overlays.tsx:349-351` (400 ms after the last key). |
| KNOWN-37 / CT-52 | Changes "All changes" scope | Fixed | `views/tools/ChangesView.tsx:34`. |
| KNOWN-38 | Wording (commit tooltip, view switch labels, alt pop-out swap, Awaiting approval) | Fixed | e.g. `shell/Sidebar.tsx:38`, `shell/Workspace.tsx:65`. |
| shell X1 | The mock TUI (banner, approvals, esc-esc rewind) | Proposed deviation | A real xterm runs the real TUI (rule 11). |
| shell X4 | Crash row "[process exited with code 1]" + Restart | Proposed deviation | Keeps "<Harness> exited with code n" + Show chat, which says more; the row takes keys. |
| shell X7 | `/exit` in the TUI returns to chat with a toast | Fixed | `views/terminal/ThreadTerminal.tsx:57`. |
| CT-51 | Changes header "More" (dots) button | Proposed deviation | The mockup's was inert; dropped. |
| CT-53 | Commits is a flyout beside the scope menu | Fixed | `views/tools/ChangesView.tsx:234-237`. |
| CT-54 | Flyout footer shows the range and "N commits" | Fixed | ChangesView CommitsMenu. |
| CT-56 | The commit caret works on a clean tree | Fixed | `views/tools/ChangesView.tsx:402` menuDisabled false. |
| CT-57 | Revert toast 6 s with Undo, no second toast | Fixed | ChangesView. |
| CT-60 | Changes tree folder rows show a down chevron | Fixed | `views/tools/ChangesView.tsx:509`. |
| CT-61 | Diff text links quotes back to its source | Fixed | `views/tools/ChangesView.tsx:427`. |
| CT-64 | Leftover `void animate; void MOTION` | In progress | `views/tools/ChangesView.tsx:516`; a fold animation that never landed. |
| CT-70 | File text links quotes back; mod-l from VISUAL quotes the painted lines | Fixed | `views/tools/FileView.tsx:337, 347`. |
| KNOWN-55 | `V` in a file shades only the text area, not the gutter or line numbers, and nothing moves or reflows (paint only) | Fixed (Josh's request) | `views/tools/tools.css` `.src .dl.vsel` (a gradient past the 48px gutter); UI test "file: V shades the text, not the gutter". |
| KNOWN-57 | File-type icons instead of text badges ("MD", "SH"): files and folders show Catppuccin's file icons (MIT, vendored, no runtime download), Mocha colours in dark and Latte in light, 14px, in the Files tree, Changes, crumbs, file tabs, ctrl-p, the tab switcher and the composer's @ picker | Fixed (Josh's request) | `ui/FileIcon.tsx`, `ui/fileIcons.gen.ts` (from `scripts/gen-file-icons.mjs`), `--ci-*` tokens in `styles/skein.css`; `LangBadge` renders it; UI tests "files: rows show file-type and folder icons", "file search shows each result's file-type icon"; shots `skein-parity/file-icons/`. |
| CT-71, CT-75 | Project tree and Files list | Proposed deviation | Real folder trees with search and keys instead of the mockup's fixed stub lists. |
| CT-77 | Browser tab as a screenshot with a pill address | Proposed deviation | A real webview (HANDOFF); the address field is not a pill. |

## Menus and overlays

| ID | Behaviour | Status | Where / why |
|---|---|---|---|
| KNOWN-20 / shell W2 | ctrl-tab switcher, release ctrl to switch | Fixed | `shell/switcher.tsx`. |
| KNOWN-21 / shell W1 | Workspaces menu anchored at the status button, mini layouts, rename, close, folders | Fixed | `shell/overlays.tsx:241`; driven: opens above the status bar. |
| KNOWN-23 / shell K1 | Keyboard sheet: groups, vimrc link, rebinding | Fixed | `shell/overlays.tsx:387`; "Search the file tree" is `f` (HANDOFF). |
| KNOWN-24 / shell C3 | `:` line docked over the status bar, prefix match, arguments | Fixed | `shell/overlays.tsx:99-120`; driven. |
| KNOWN-25 / shell C1 | Palette: threads with status, then actions, no key hints | Fixed | `shell/overlays.tsx:84-94`. |
| shell C1 (scope) | The palette lists archived threads and side chats too | Fixed | Archived ones last, side chats open as popups (`shell/overlays.tsx:86`). |
| KNOWN-27 / shell K2 | Settings rows (On launch, counts as read, Appearance, vimrc path) | Fixed | `shell/overlays.tsx` Settings; two-list keys per HANDOFF. |
| KNOWN-28 / shell K9, CT-10 | Toasts: one at a time, rich, inline Undo, drop in from above | Fixed | `shell/Layers.tsx:16`, `styles/skein.css:643`. |
| shell M3 / CT-39 | The composer menu look only for composer menus | Fixed | `ui/Menu.tsx:198`. |
| shell M4 / CT-38 | Hover moves the selection only in composer menus | Fixed | `ui/Menu.tsx:251`. |
| shell M5 / CT-40 | The opening button gets aria-expanded, so its caret turns | Fixed | `ui/Menu.tsx:64-73, 199-204`. |
| shell M6 | A `keep` menu keeps its row across refilters | Fixed | `ui/Menu.tsx:90-95`. |
| shell M8-M10, M12 | Space picks, enter falls through, empty menu hidden, menus modal | Fixed | `ui/Menu.tsx:140-185, 235`. |
| shell M13 | After a pick the composer gets the keys back | Fixed | Driven: after a model pick, typing went into the composer. |
| shell K3 | Dialogs are modal for keys | Fixed | See keys G3. |
| shell K10 | The lightbox closes on `?` too | Fixed | `ui/Lightbox.tsx:7` (one-line fix in this review). |
| shell K11 | A shared handler for rows of buttons | Fixed | `ui/kbrow.ts:20`. |

## Visual and CSS

| ID | Behaviour | Status | Where / why |
|---|---|---|---|
| CT-4 | Sidebar chevron turns 160 ms ease-out | Proposed deviation | Same duration with the app's motion curve; indistinguishable. |
| CT-11 | Narrow window: the floating sidebar is min(280px, 80vw) | Fixed | `styles/app.css:72` (one-line fix in this review; it was 300px / 86vw). |
| CT-13 | Replies, approvals and error rows fade up on mount | Fixed | Dropped the fade on `.reply > *` (`views/chat/chat.css:14`); approvals, errors, the mirror and the edit box still fade. |
| CT-15 | `.t-star`, `.t-chip` and blink belong to the mock TUI | Proposed deviation | The real TUI draws itself. |
| CT-21 | Divider turns blue while dragged | Fixed | See shell S22. |
| CT-41 | The flyout's parent row chevron turns while open | Fixed | Comes with the flyout (CT-53). |
| CT-43 | Settings switches are the large size | Fixed | `ui/primitives.tsx:66-68`. |
| CT-79 | Narrow tool headers drop their chip labels | Proposed deviation | An app addition so tool headers fit under 560 px. |

## Mouse on text (click survey)

From `clicks.md` (each gesture run in both builds). A fix wave for these was still in the working tree, uncommitted,
during this review; rows say what was seen in the browser build at the time.

| ID | Behaviour | Status | Where / why |
|---|---|---|---|
| clicks GAP-A | A mousedown on chrome (tab bar, status bar, popup header, a tool summary) while typing drops to NORMAL | Fixed | `ui/VimField.tsx` mousedown handler (uncommitted); driven: tab title, tab bar gap, status bar and a tool summary all gave NORMAL. |
| clicks Z8 / chat R17 | Any mousedown outside the quote bar takes the reader cursor down | Fixed | `views/chat/reader.ts:130`: any mousedown outside `.seltb` clears the reader; test "a click on chrome while typing drops the composer to NORMAL; reader cursor cleared". |
| clicks T3, T20, T21 | A double click on blank space (beside a line, the margin, next to a bubble) does nothing | Fixed | `views/chat/reader.ts:374` onText, `views/chat/ChatView.tsx:342`: a double click off the text clears the selection, the bar and a stray VISUAL; test "double-click on blank space beside a line does nothing". |
| clicks T5 | A triple click on your own message opens one menu, not the model menu twice | Fixed | Driven: no menu opened (uncommitted ChatView change). |
| clicks D4 | A double click on your own message selects the word in VISUAL in the edit box | Fixed | `views/chat/ChatView.tsx:221`: the second (third) click selects the word (line) in the edit box in VISUAL (V-LINE); test "double-click on your own message". |
| clicks T14, C2 | A click on a diff line number puts the cursor on that line | Fixed | Chat diffs: `views/chat/reader.ts:254` puts the cursor at the start of the line. Changes: `views/tools/ChangesView.tsx:382`. |
| clicks F2 | A click on a file's line number puts the cursor at the line start | Fixed | `views/tools/FileView.tsx:288`; a double click there no longer edits. |
| clicks T17, C3 | A double click on a tool summary or a Changes file header selects the word in VISUAL | Fixed | Tool summaries: `views/chat/ChatView.tsx:337` lets a double click through to VISUAL with the bar. Changes: `views/tools/ChangesView.tsx:389`. |
| clicks T27 | The attach + button keeps the caret in the composer | Fixed | `views/chat/Composer.tsx` prevents the mousedown (uncommitted). |
| clicks L1, L2, E5, D3 | Opening a thread from a sidebar row or a side chat's anchor lands in NORMAL | Proposed deviation | D3 Fixed (`views/chat/ChatView.tsx:173`: back from a side chat's anchor in NORMAL). L1, L2, E5: a thread opened from a sidebar row still opens in INSERT, as VIM-MODEL's table says (Composer: INSERT) and the "opens in INSERT" test pins; a click on the open thread's row drops to NORMAL (GAP-A). |
| clicks F1, F3 | A double click in the file view selects the word in VISUAL with the quote bar | Fixed | `views/tools/FileView.tsx:312` with `views/tools/mousesel.tsx` (the chat's SelBar); a triple click is V-LINE, a double click on a blank line does nothing, editing stays on i / a. |
| clicks C1 | A double or triple click in a Changes diff selects the word or line | Fixed | `views/tools/ChangesView.tsx:389`; a click draws the character cursor (:382); enter or g f opens the file (the mockup has no mouse gesture for it). |
| clicks DR2, DR3, Z18 | A drag in the file view or a Changes diff gives VISUAL and the quote bar | Fixed | `views/tools/FileView.tsx:312`, `views/tools/ChangesView.tsx:389`, `views/tools/mousesel.tsx`; a click on the toolbar clears the selection and the bar. |
| clicks E2, Z14 | A click on reply text while editing cancels the edit and puts the reader cursor there | Proposed deviation | The mockup only cancels; the app follows VIM-MODEL rule 10 (a click is a cursor). |

## Proposed deviations (waiting for Josh's approval)

- Real-app behaviour replaces mock stand-ins: the terminal runs the real TUI (X1, X4, CT-15), the Browser is a real
  webview that reloads when re-parented (CT-77, POPDOCK-browser), Files and the project tree list real folders (CT-71,
  CT-75), @ browses the filesystem (chat M13, M14), the plan arrives as request text (chat T10), and window controls
  are native (shell T8).
- The harness sets limits: quotes are sent as full text (chat C16), subagents cannot be edited or have their own
  model (chat E10, M12), and a busy thread cannot be moved (shell K8).
- Vim follows real Vim where the mockup simplified: word motions, `I`, counts, registers, the menu search field in
  NORMAL, `l` picking, the 1200 ms sequence timeout, the 500 ms insert map (keys V5, V8, V10, M11, M13, A9, I3).
- Small, deliberate choices: a toast for mod-l with nothing selected (keys G12), send queues a follow-up while a turn
  runs (chat P6), /model keeps the rest of the draft (chat M9), "Send to thread" inserts a linked quote (chat D6),
  `G` stays in the reader (chat R11), offline machines connect on start (shell L9), empty machines stay listed
  (shell B3), clearing a project name resets it (shell B9), no sub-folder chevrons (shell F2), a tab dropped
  outside the panes pops out (shell D9), extra keys and middle click (keys L9, shell S21, T5), the SSH shell is
  titled with its machine (shell T12), and narrow tool headers drop labels (CT-79).

## In progress

Ranked by how visible they are.

1. **Fixed.** **keys N12, A5, KNOWN-4**: esc esc from the composer leaves the textarea focused with its block cursor drawn, and
   `i` then types at the old cursor instead of the end (`views/chat/ChatView.tsx:363` onLeave and `idle` at 152; `i`
   at 135).
2. **KNOWN-42, shell L4, F4**: on a new thread the machine and folder menus open below their chips, at the wrong
   widths, and the folder menu is the old walker without recent folders or typed paths (`shell/Launcher.tsx:73-84`;
   use `openFolderPicker`, `shell/overlays.tsx:298`, with `top-start`). **Fixed** (see its row).
3. **shell F5**: Move's "Other folder…" uses the same old walker (`shell/move.tsx:48`). **Fixed** (see its row).
4. **Fixed.** **keys C2 / chat P16**: on a new thread the machine, folder and worktree chips and the four cards cannot be
   reached by keyboard (`views/chat/Composer.tsx:201` walks one row).
5. **KNOWN-15**: project drag reorder has no preview following the pointer (`shell/Sidebar.tsx:117-146`). **Fixed** (see its row).
6. (done: unread blue dot, KNOWN-47)
7. **keys A1 / shell S25**: app NORMAL `j` / `k` / enter / `o` do not drive the sidebar cursor (documented in
   VIM-MODEL section 6; `input/surfaces.ts` layoutSurface). **Fixed** (see its row).
8. **shell L5, L6**: picking a machine resets the folder to `~`, and the harness-switch toast wording differs
   (`shell/Launcher.tsx:78, 81`). **Fixed** (see its row).
9. **Fixed (dropped).** **CT-13**: app-only fade on every reply when a thread opens (`views/chat/chat.css:14`): keep or drop.
10. **shell C1 (scope)**: the palette hides archived threads and side chats (`shell/overlays.tsx:86`). **Fixed** (see its row).
11. **Fixed (chat side too).** **Mouse on text (clicks T17, T14, D4, T3, Z8)**: the reader cursor survives a click on chrome, and chat-side gestures are in progress (`views/chat/reader.ts`). The file view and Changes diff part (F1, F3, C1, C2, C3, DR2, DR3, Z18, F2) is **Fixed** (see their rows; `views/tools/mousesel.tsx`, `views/tools/FileView.tsx:312`, `views/tools/ChangesView.tsx:389`).
12. **shell B19**: no same-repo shortcut when dropping a thread on a machine (`shell/move.tsx`). **Fixed** (see its row).
13. **Fixed.** **keys B3**: `[` / `{` from the mirror bar do nothing (`views/chat/ChatView.tsx:148`).
14. **shell T3**: popping a tab out activates the last tab, not the one before it (`state/actions.ts:199`). **Fixed** (see its row).
15. **shell W3**: switching workspace keeps the sidebar cursor (`state/actions.ts:278`). **Fixed** (see its row).
16. **keys C8 Fixed (Composer).** **keys C8, CT-64** (CT-60 Fixed): no scroll for the controls
    cursor, a leftover `void animate` (`views/tools/ChangesView.tsx:457, 516`, `views/chat/Composer.tsx:202`).
