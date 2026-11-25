# Skein: decisions

The code map and the decisions behind it. Keyboard rules are in [VIM-MODEL.md](VIM-MODEL.md).

## The app (`src/`)

| Path | Holds |
|---|---|
| `src/shared/api.ts` | The only contract between renderer and main: `SkeinApi` (request / response) and `SkeinEvent` (pushes). The preload builds `window.skein` from it. Replacing Electron (Tauri fallback) means reimplementing this transport only. |
| `src/shared/types.ts` | Machine, ThreadMeta, ThreadEvent (normalized chat events), Settings |
| `src/main/` | Electron shell only: window, our own menu (G3), IPC wiring. `services.ts` implements `SkeinApi` over `src/core`. |
| `src/core/` | Node-only, no Electron: `store` (node:sqlite metadata), `machines` (local + SSH probe), `exec` (local spawn / system ssh with ControlMaster), `pty` (node-pty), `discover` (sessions in ~/.claude and ~/.codex), `threads`, `files`, `git`, `images` (inbox), `forward` (ssh port forwards for Browser tabs), `chat` (the seam for the chat drivers) |
| `src/renderer/src/input/` | The input layer: `keys` (one key name form), `platform` (per-OS keys, `kb()`), `keymap` (commands, default bindings, vimrc), `dispatcher` (the single keydown handler), `vimtext` (the Vim engine for fields), `surfaces` (who owns the keyboard), `readerkeys` (counts and search matching every reader shares, pure), `register` (the one unnamed register, clipboard fallback) |
| `src/renderer/src/state/` | `store` (one mutable state + version), `layout` (pane tree, pure), `actions` (what commands do) |
| `src/renderer/src/ui/` | The component library: `primitives` (Icon, IconButton, Button, Chip, Seg, Dot, Spinner, Kbd, Switch), `Menu` (every list; its search field runs `vimtext` in NORMAL), `Dialog`, `VimField` (the small editable fields: menu search, dialogs, the queue's edit row), `editor/` (the code editor: `CodeEditor` is CodeMirror 6 + `@replit/codemirror-vim` + Lezer grammars from `@codemirror/language-data`, styled only from tokens in `theme`; `vim` ties CodeMirror's Vim to the app's register, clipboard and status-bar mode; `route` decides Skein's NORMAL keys vs Vim's, see VIM-MODEL rule 23; `markdown` is a Markdown file's live preview, the same editor with the Markdown drawn as it reads; `CodeField` is the same editor as a field, for every composer and the edit box: it grows with its text, enter sends, esc / k / j leave it, quotes are chips), `search` (the `/` `?` prompt and `n` / `N` for every reader), `motion` (animation tokens), `icons` |
| `src/renderer/src/shell/` | App frame: Sidebar, Workspace (panes, tabs, popups), StatusBar, Launcher (new tab), overlays (palette, : line, settings, keyboard sheet), commands |
| `src/renderer/src/views/` | `terminal/` (xterm.js with WebGL and image addons, scrollback reader, image paste, Claude handoff), `chat/`, `tools/` |
| `src/renderer/src/styles/` | `skein.css` is the source of the look. `app.css` adds only what the real app needs. |

Rules for new UI: use the `ui/` components (never hand-written buttons or menus), give the surface a kind
(field, reader, list, terminal) and register it with `input/surfaces`, add commands to `keymap.ts` COMMANDS
and run them through `shell/commands.ts`, so the keyboard sheet, the vimrc and the : line all see them.


### Decisions made during the build (2026-11-20)

- Metadata store is `node:sqlite` (built into Electron's Node), so there is no native database module to compile.
- node-pty 1.1 ships prebuilt binaries for Windows and macOS, so Windows needs no Visual Studio Build Tools.
- Threads open in the chat view by default (Settings > General switches to the terminal). Claude Code: chat drives
  through the Agent SDK; showing the terminal hands the session over. Codex: both views attach to one app-server.
- Claude Code threads get their session id up front (`--session-id`), and the terminal resumes it if the
  transcript exists, so a thread knows its session before the first turn.
- A new thread's first prompt is passed on the TUI's command line.
- Code and messages are edited in CodeMirror 6 with `@replit/codemirror-vim`: the open file (`CodeEditor`) and every
  composer, the edit box included (`CodeField`). The dispatcher keeps priority; the editor reads every other key from
  the DOM event (a surface may answer `'native'`), so IME, keyboard layouts and Vim's own insert-mode keys work as
  CodeMirror intends. A quote in a composer is a chip: an atomic range, and a change that touches it takes it whole.
  `vimtext` / `VimField` remain for the small fields (menu search, the queue's edit row, dialogs, the vimrc editor).
- Existing sessions are discovered from `~/.claude/projects` and `~/.codex/sessions` (local only for now).
- Terminal copy and paste on Windows follow Windows Terminal: `ctrl-c` copies when text is selected (otherwise
  it goes to the program), `ctrl-v` and `ctrl-shift-v` paste. Every paste checks the clipboard for an image first,
  so `ctrl-v` with a screenshot pastes its inbox path (G14) the same way locally and over SSH.
- A TUI's terminal title drives the thread: a spinner glyph means running, the rest becomes the title.
  The bell, OSC 9 and OSC 777 mark the thread as waiting and post a desktop notification when it isn't on screen.
- File search (`mod-p`) searches the focused tab's folder with `git ls-files` (a capped walk outside a repo).
- Dragging a tab: onto a tab bar moves it, onto a pane's edge splits, outside every pane pops it out.
- Moving a thread (`m` in the sidebar, or drag its row onto a project or a machine heading) is built in
  `src/core/move.ts` and `shell/move.tsx`. Idle threads only: a running one, or one waiting on you, is refused with
  the reason (it does not wait for the turn), and so are an offline machine and one without the harness CLI. The
  chat driver lets go and the thread's terminals close first, then reopen at the new place. Claude Code: the
  transcript (and its `<id>/` folder) is copied into `~/.claude/projects/<slug of the new folder>/`, on the same
  machine too, because the CLI only resumes transcripts of its cwd's project. Codex: nothing is copied on the same
  machine (each turn sends the thread's cwd); another machine gets the rollout at the same `sessions/YYYY/MM/DD/`
  path. Across machines, files go over SSH (text through `core/files`, folders as a tar stream). Originals are
  never deleted or archived, and code does not move (conversation only). The toast's Undo moves it back.
- **Browser tab: an Electron `<webview>`**, not a WebContentsView managed from main. A webview is a DOM element, so
  it follows splits, popups, zoom and hidden tabs with no bounds syncing, and menus and dialogs draw over it. It is
  locked down in main: `will-attach-webview` drops any preload, turns Node off, sandboxes the page, forces its own
  session (`persist:skein-browser`, which grants no permissions but clipboard write and fullscreen) and refuses
  anything but http(s); the page's navigations and redirects stay on http(s) and its new windows open in the
  system browser. The renderer's CSP is unchanged (a webview is not a frame to it); dev:web adds `frame-src`
  for its `<iframe>` stand-in. Moving the tab to another pane re-creates the page (a webview reloads when it is
  re-parented); switching tabs only hides it.
- **Browser keys** follow a terminal (VIM-MODEL rule 11): `i` / `gi` / a click give the page the keys (TERMINAL),
  `esc` takes them back. Keys pressed in a page never reach the window, so the renderer sends main the list it
  keeps (esc, the leader, the terminal's global keys, mod-l) and main's `before-input-event` hands those back
  as `browser.key` events, which go through the one dispatcher. mod-l on a Browser tab edits the address
  instead of quoting a selection.
- **Browser on an SSH machine**: localhost (and 127.0.0.1, ::1, 0.0.0.0) means that machine. Main forwards the
  port with `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:<free port>:localhost:<port>` on a connection of its
  own (a ControlMaster would keep the forward after we let go), waits until the local port accepts, and the page
  loads from it while the address bar keeps the remote's address, with `<machine> → :<local port>` beside it.
  One forward per machine and port, kept until it dies or the app quits; a failure is a row with Retry.
- **Live follow and one writer** (2026-11-20, `core/tail.ts`, `core/follow.ts`): a thread's transcript is tailed and
  re-folded with the history parsers, and new or changed events go out as `chat` pushes with history's ids. This
  computer: watchers on `~/.claude/projects/*` and `~/.codex/sessions/Y/M/D` wake followers (a 3 s stat poll backs them
  up), for every known session written while Skein runs. SSH: one `tail -c +N -F` per file, only while a chat view
  shows it (`chat.follow`, 20 s grace). Writes during Skein's own driver turn are not pushed (the driver sends them);
  Skein's terminal writes are (the G4 mirror now updates live). Writes by anyone else set `ThreadMeta.external`: the
  thread shows running / idle from the transcript (end_turn, interrupt, task_complete; 10 min without writes is
  idle), so the blue dot follows, and the chat is read-only with Take over (`i` / `a` too); `chat.send` refuses
  meanwhile. It clears on Take over, when a Skein terminal opens it, or when no TUI for it runs any more (Linux:
  session id in the command line or same folder; macOS / Windows / SSH: id match or 30 quiet minutes).
- **Closing VIM-MODEL section 6** (2026-11-20; rules 18 and 19, section 4's Menu search field and Settings rows):
  - After `esc`, a menu's search field is a Field in NORMAL: it keeps the focus (read-only) and its block cursor, and runs
    `vimtext`. The list keeps `j` `k` `gg` `G` `enter` `q` (counts move the list: `3j`); everything else goes to the
    field. The menu owner's `keys` come first, so a folder field keeps `h` / `l` for out / in and the workspace list
    keeps `d`. Every popup with a search field opens in INSERT (VIM-MODEL rule 21); the model picker has a
    search field now, like the mockup's. `l` still picks in a menu without a search field.
  - Settings is two lists. The section list has the keys when it opens (`j` / `k` sections, `l` / `enter` / `tab`
    in); the rows take `h` / `l` as values (a switch counts: `h` off, `l` on), and `esc` / `shift-tab` / `h` on a
    row with no value go back. `J` / `K` (the old section keys) are gone; `H` / `L` do nothing in the dialog.
  - Readers share `input/readerkeys.ts` (Count, literal smart-case `findAll`, `nextHit` with wrap) and
    `ui/search.tsx` (`ReaderSearch`: the prompt is the shared Menu with prefix `/` or `?`, listing matches nearest
    first; `n` / `N`; esc clears). Each reader gives it its text as strings and its cursor as a position: the
    scrollback its buffer lines (matches drawn as xterm decorations, capped at 400), the chat reader its text nodes
    (CSS highlight `rsearch`), the file its lines (`.hit`), the diff its rows (`.hit` in code lines).
  - Changes: `/` now searches the diff like every reader; the tree's search moved to `f` (it was `/`).
  - The open file's `/` used to be a "find lines" menu with its own n / N; it is now the shared prompt, which still
    lists matching lines with their numbers.
  - One unnamed register for all fields (`input/register.ts`), filled by readers' yanks too; `p` with it empty puts
    the system clipboard. No `"+` or named registers. `vimtext` gained `NG` / `Ngg`, `3p`, and counts after an
    operator (`d2w`, `2d3w`); `r` followed by a digit replaces with that digit (it used to start a count).
- **Final polish pass** (2026-11-20, in the real app, both themes): a path under the machine's home reads `~/...`
  in the status bar and the folder chip, as the sidebar already did (stored paths stay absolute). Claude Code
  writes `gitBranch: "HEAD"` outside a repo, which is now no branch. File search outside a repo skips hidden
  folders (a home folder's `.cache` filled the list); hidden files still show. A failed Browser load names the
  cause in words and hides the engine's white page. The keyboard sheet flows in columns and lists reader keys
  (since replaced by the mockup's sheet, below).
- **Mockup parity pass, shell** (2026-11-20): the keyboard sheet, workspaces menu, `:` line, palette, pane search,
  Machines popover, Settings and toasts now follow the mockup (scenes `keys`, `workspaces`, `folders`, `cmdline`,
  `palette`, `tabs`, `machines`, `settings`). Decisions:
  - The sheet rebinds by writing `nnoremap` lines to the vimrc (VIM-MODEL rule 12); it uses the mockup's command
    names `q` and `workspace`, and `tabclose` / `workspaces` stay as aliases so older vimrc lines work.
  - Commands take arguments (`run('new linux ~/repo')`). File search is `:find` (was `:files`); `:files` opens the
    Files tool as in the mockup (`:filesview` still works). An exact name wins in the `:` line, so `:w` saves.
  - Leader `o` is the mockup's popup focus (it was `:only`, which now has no default key), `d` docks, `r`
    rotates, `+` / `-` resize stacked panes; `ctrl-w` in NORMAL arms the whole leader instead of 9 sequences.
  - `:chatall` / `:termall` also change Settings' "New threads open as". Settings > General > On launch: Start
    empty boots one blank workspace (`Settings.launch`). Folders picked in a folder field are kept (`dirs`).
  - The vimrc tab applies as you type (400 ms after the last key); `:w` / ctrl-s save at once and name what
    was ignored. Its header reads `~/.config/skein/vimrc` as in the mockup (the text lives in settings).
  - Menus are modal; Tab picks like enter (a folder list's Tab goes in, else moves on); NORMAL space picks and
    stays open; only composer menus follow the pointer. A click in the sidebar gives it the keys, but opening a
    thread from it hands them to the thread (the mockup keeps them in the sidebar, which would swallow typing).
  - Toasts: one at a time, rich text, an inline action (Undo) that also dismisses it.
  - Folder rows have no "has sub-folders" chevron: it would need a listing per row, slow over SSH.
  - One folder field everywhere (`openFolderPicker`): a machine's +, a new thread's folder chip and Move's "Other
    folder…". A new thread's machine and folder menus open above their chips. Picking a machine keeps the folder
    when that machine knows it, else takes its most recent one; a machine without the harness switches the model
    and says which. A thread dropped on a machine heading with a same-named repo goes straight to the Move dialog.
  - App NORMAL `j` / `k` / `enter` / `o` drive the sidebar cursor without focusing the sidebar (`cursorKey`); a
    chat's own app-NORMAL keys come first. A held key moves the cursor only when its first press did, so holding `j`
    to the end of a chat's reader stops there instead of running on into the sidebar. The palette lists archived threads and side chats; popping a tab out
    activates the tab before it; switching or creating a workspace clears the sidebar cursor; a dragged project
    shows its folder and name under the pointer.


## Design decisions that are settled

- **Look:** Codex and Cursor are the reference. Minimal, icons over text, hairline borders, colour only for status.
- **Words:** "Thread", never "session". A "workspace" is a whole layout per project (tmux's session).
- **Layout:** no top bar and no global mode. Arbitrary nested splits; every pane is a tab group; any tab can
  float as a popup. A thread tab toggles between chat and terminal view per tab.
- **Sidebar:** global across workspaces. Two views: pinned + machine > folder, or most recent. Remote
  machines show a green or red dot and nothing else.
- **Vim first, and the app's own Vim**, not the harness's. Leader is `ctrl-space`. `H` / `L` tabs, `|` and
  `\` split. Everything rebindable goes through the vimrc. Vim can be turned off in Settings.
- **The mouse does what the keys do.** A drag shows the final state, not hints about operations.
- **Terminals belong to their program** (audit G1). Every key goes to the TUI or shell, esc included; the leader
  opens the scrollback as a reader. The pill says TERMINAL. See VIM-MODEL rule 11.
- **Keys follow the OS** (G2): app commands are cmd on a Mac and ctrl on Windows, Vim's ctrl keys and the
  leader are ctrl on both, alt / option + hjkl are read by physical key. Table in VIM-MODEL section 5.
- **Claude Code: one view drives a thread at a time** (G4). Chat drives through the Agent SDK. Showing the
  terminal waits for the turn to end (or "Interrupt and open"), then runs `claude --resume <id>`. While the
  terminal drives, chat is a read-only mirror with Show terminal and Take back; taking back waits for the
  TUI's turn to end too. The TUI stays open after Take back, so a look at chat and back costs nothing; chat's
  first send closes it (refused while it is mid-turn), and the terminal view runs `claude --resume` again when it
  next shows, so it has what chat wrote. Two processes must never write one session at once: each chains entries
  off its own last message, the file forks, and a resume shows one branch (`core/handoff.ts`). Claude Code has no
  way for the SDK to attach to a running TUI (Remote Control only relays through claude.ai). Quitting the TUI
  (`/exit`) gives the thread back to chat. A small orange dot on the
  chat | terminal toggle marks the view that drives. **Codex** needs none of this: both views attach to one
  app-server (`codex --remote`), so both are live.
- **Images** (G14): chat, side chats and subagents send a structured attachment, nothing is copied. A terminal
  gets a file path: saved to `~/.skein/inbox/` locally, or uploaded to the remote's `~/.skein/inbox/` first over
  SSH (progress shows over the terminal, in the app's font), then the path is pasted and the TUI shows
  `[Image #n]`. A failed upload offers Retry or Discard and pastes nothing. A shell gets the path as text.
- **SSH** (G5): the harness runs under a persistent process on the remote, so a dropped link reattaches and the
  turn keeps running. The machine's dot pulses amber while connecting or reconnecting, is solid amber when it
  needs you (passphrase, verification code, new host key: one small dialog), red when down.
- **Requests** (G7): several can wait at once; y / n answer the oldest, the card shows "1 of 3".
- **Edit and resend** (G8) rewinds the thread to that message. Side chats that branched from later replies are
  kept, unlinked, and the edit box says so.
- **Errors** (G9) are a row in the thread with the one action that helps: Restart (crash), Retry now (rate
  limit), Sign in (expired harness login), Copy install command (missing CLI). Context compaction is a quiet
  row. In a terminal the TUI prints its own error; a crashed process shows its exit line and Restart.
- **Missing harness** (G6): the model picker dims models a machine can't run and offers the install command;
  choosing such a machine for a new thread switches to a model it has, and says so.
- **Focused pane** (G11): its active tab is solid with a short underline; other panes' tabs are outlined.
- **Narrow windows** (G10): below 900 px the sidebar hides itself and floats over the panes when opened;
  tabs that don't fit scroll inside the bar with a fade at the edge (B8).
- **Relaunch** (G12) restores everything: workspaces, layouts, popups, drafts, reading positions, folds. A
  terminal-driven Claude thread comes back driven by chat until its terminal is shown again.
- **Notifications** (G13): an OS notification when a thread waits on you (default) or replies, only while
  Skein is in the background or the thread is out of sight. A thread is read once its tab has been on screen
  and focused.
- **Tabs are one width** (owner, 2026-11-20): every tab in a bar is 172px, they shrink together to 100px as
  the bar fills (84px in a narrow pane), then the bar scrolls. Picking a tab never changes its size.
- **Changes** (owner's reference, 2026-11-20): the scope menu shows +/- per scope; Commit is a split button
  (on main it reads "Create branch & commit"); a file tree on the right (search, select-all, stage boxes,
  A/M marks, hidden below 620px of pane); each file header has revert (with Undo) and stage; unchanged
  runs fold to "N unmodified lines".
- **Open file**: back / forward and a clickable path; the same right-hand tree as Changes, showing the whole
  project with the open file picked out, ignored folders dimmed and M/A marks; gutter bars for lines changed
  since the last commit; syntax colours, indent guides, the cursor's line highlighted; language badge in
  the tab. Inline completion is out of scope.
- **Sidebar hover actions** (owner, 2026-11-20): one right-hand column. A machine heading's + adds a project
  (a folder with no threads yet); a project's compose starts a thread in it; a thread's pin and archive replace
  its status (spinner, request, age, unread) on hover.
- **Pane menu** (the chevron at a tab bar's right): only the active tab's thread, within this workspace: its
  side chats and subagents, then its open tabs (plus Changes / Files / Browser / Shell when not open), then pane
  actions. Other threads' tabs are left to ctrl-k.
- **Timeline preview**: a tick shows the message and the reply's first prose (or its first step, or Working…).
- **The sidebar is a pane** (owner, 2026-11-20): leader h / alt-h from the leftmost pane focuses it; keys in
  VIM-MODEL section 4. A subagent popup opens in INSERT, like a side chat.
- **Moving a thread** (proposed 2026-11-20, mocked; feasibility in the tech spike doc; built without the code choice,
  see "Decisions made during the build"): drag a thread onto a project or
  machine heading, or `m` in the sidebar. Idle only (a running one is refused with the reason). Same machine: resume
  from the new folder, nothing copied. Other machine: check the CLI there, copy the session (Claude: `<id>.jsonl` and
  its `<id>/` folder; Codex: the rollout file, resumed with path and cwd), first turn carries a "moved from" note.
  Code choice: conversation only, bring changes (same repo and commit; commits as a bundle, the rest as a patch), or
  push a branch (publishes, so only when picked). Credentials never move. The original is archived after the first
  resume succeeds; a toast offers Undo. Blocked, with the reason, when the target lacks the CLI or is offline.
- **Undo / redo** (VIM-MODEL rule 17): `u` / `ctrl-r` per field, an INSERT stretch is one step.
- **/ commands anywhere** (owner, 2026-11-20): a chat composer opens the / menu wherever a word starts with
  `/`, not only at the start. Picking one replaces just that word. `/model` and `/sidechats` mid-message take
  their word out, keep the rest of the draft, and open their picker. A word like `/usr/bin` that matches no
  command opens nothing. A terminal prompt keeps / at the start only, because the TUI owns its line.


## What the owner consistently asks for

- Remove anything redundant or explanatory: no key hints inside menus, labels or helper sentences that an icon or the layout already conveys.
- One behaviour everywhere. If a key or control works differently in two places, expect it to be questioned.
- Design questions ("should X...?") want a recommendation with the trade-off stated.
- Reports that say what was checked and how. Scripted tests are not the same as trying it by hand; say which.

