# Skein: how Vim mode works

One model for every part of the app, so a key means the same thing wherever you are.
This is the reference for the mockup ([mockups/](../mockups/)) and for the Electron build.

## 1. Five kinds of surface

Every part of the interface is one of these. A new feature picks a kind and inherits its keys.

| Kind | What it is | Examples |
|---|---|---|
| **Field** | Text you can edit | Composer, edit-a-message box, a menu's search field, an SSH passphrase, vimrc |
| **Reader** | Text you can only read | A thread, a side chat, a subagent transcript, a diff, terminal scrollback; a file until you edit it |
| **Terminal** | A program that owns its own input | A thread's terminal view (the harness TUI), a shell |
| **List** | Discrete items | Sidebar, any menu, settings, keyboard popup, rows inside a thread |
| **Layout** | Where things are | Panes, tabs, popups |

## 2. Modes

| Mode | Fields | Readers | Lists | Layout |
|---|---|---|---|---|
| NORMAL | block cursor, motions, operators | block cursor, motions | item cursor | acts on the focused pane |
| INSERT | typing | none | only in a list's search field | none |
| VISUAL / V-LINE | selection, operators | selection, quote / yank | none | none |
| TERMINAL | none | none | none | none: every key goes to the program |

Exactly one surface owns the keyboard at a time. The status pill shows that surface's mode. TERMINAL is
Vim's own name for a `:terminal` window that has the keys; leaving it is the same idea as Vim's `ctrl-w N`.

## 3. Rules that hold everywhere

1. **Plain keys act only in NORMAL.** In INSERT, plain keys type. Anything that must work while typing
   uses a modifier (`ctrl-k`, `ctrl-p`, `alt-h/j/k/l`) or the leader (`ctrl-space`).
2. **`esc` steps back exactly one level.** INSERT to NORMAL. VISUAL to NORMAL. From NORMAL, out of the
   current thing: close the menu, cancel the edit, close the popup, leave the field. One press never does
   two of these. In a popup that is `esc` `esc` from typing: NORMAL, then closed, and focus returns to the
   pane the popup was opened from.
3. **`j` / `k` move between lines or items. `h` / `l` move within a line.** Where there is nothing to
   move along (a row, a slider, a list item), `h` / `l` fold and unfold it or lower and raise its value.
4. **`enter` does the main thing to what is under the cursor.** Send, open, pick, toggle.
5. **`i` / `a` start typing in the nearest place that makes sense.** In a field, INSERT. On one of your
   own messages, edit it. In a file, edit the file at the cursor (`:w` saves, `esc` from NORMAL goes back to reading). In a reader, the composer below. In a list with a search field, that field.
6. **Motions are the same wherever there is text.** `h l w b e 0 $ j k`, `v`, `V`, in fields and readers alike.
   A motion never behaves differently by direction: `j` and `k` both move one line. Coarser steps have
   their own keys, again the same both ways: `{` `}` by block, `[[` `]]` by your own messages, `gg` to the top.
7. **Edges lead somewhere.** `k` on a field's first line moves into the reader above it, and so do `[[` and `{`
   from a composer (`{` only once there is no blank line above the cursor in the composer itself); `j` past a
   reader's last line returns to the field. Lists stop at their ends; they do not wrap.
8. **A visual selection stays inside the block it started in** (one message, one tool call's output, one
   file). Back in NORMAL, `j` / `k` cross blocks again.
9. **Some things are one unit.** A row in a thread (tool call, subagent, side-chat chip) and a quoted
   selection in a composer take the cursor as a whole: no sideways movement inside, deleted whole.
10. **The mouse does what the keys do.** Click a field: INSERT at that spot. Click read-only text: the
    NORMAL cursor goes there. Double-click: the word, in VISUAL. Drag: VISUAL. Triple-click: V-LINE.
11. **A terminal belongs to the program running in it.** The harness TUI (or the shell) owns its input line,
    so in TERMINAL every key goes to the program, `esc` included: `esc` interrupts a turn, `esc` `esc` clears
    the line or opens the harness's rewind list, `ctrl-c`, `shift-tab` and the TUI's own menus all work as they
    do in any terminal. Skein keeps back only the leader, `alt-h/j/k/l` and its own modifier shortcuts (on a Mac
    every cmd key; on Windows, not ctrl-k / ctrl-p / ctrl-o / ctrl-i, which belong to the program there).
    Leader `[` (or leader `esc`) opens the scrollback as a Reader, like tmux's copy-mode; `i`, `a`, `q`, `esc`
    or `j` past the last line go back to the program. The vimrc's insert maps (`jk`) do not apply in a terminal.
12. **Layout commands are bindable.** Each is a named command (`:vsplit`, `:tabnext`, ...) with a default
    key. Rebinding writes an `nnoremap` line to the vimrc; the vimrc and the keyboard popup always agree.
    A key can mean one thing: binding a key that is already taken replaces that line rather than adding a second.
    In the keyboard popup (`?`) `j` / `k` move over its one list; `enter` or a click on a rebindable row waits for
    a key (the leader first makes it a leader map) and writes `nnoremap <key> :<command><CR>`, dropping any other
    line for that command or that key; `x` (or the row's reset button) removes it so the default is back. The `:`
    line matches names by prefix (an exact name first, so `:w` saves) and passes what follows as arguments:
    `:new [machine] [dir]`, `:workspace [name]`. `:find` is file search (`mod-p`), `:files` the Files tool.
14. **A block can have keys of its own, and they work when the cursor is on it** (`l` / `h` on a tool row,
    `enter` on a file). The one exception is a block that is waiting on you: a request to run something or
    a plan to approve. Its `y` / `n` work from NORMAL anywhere in that thread's tab, because nothing else
    in the thread can proceed until it is answered. In VISUAL `y` is still yank. When several wait at once
    (parallel subagents), `y` / `n` answer the oldest and the card shows how many are left.
17. **`u` undoes and `ctrl-r` redoes, in every field.** Each field (composer, edit box, file) keeps its own
    history for as long as its tab is open. A step is one NORMAL edit (`x`, `dw`, `dd`, `C`, a quote
    deleted whole) or one whole stretch of INSERT, from entering it to `esc`, as in Vim. In a terminal both
    keys belong to the program (rule 11).
15. **Leaving and coming back keeps your place.** Opening a popup remembers where the keyboard was in the
    pane (the reading cursor, or the composer's mode and position). Closing the popup, or `ctrl-o`, puts it
    back there; `ctrl-i` returns to where you were in the popup.
16. **A row of buttons can stand in for a field.** Where a pane has nothing to type into (the chat view of a
    Claude Code thread its terminal is driving, the terminal of one that is still waiting to open, a failed
    upload, an SSH dialog's buttons) the row takes the keys: `h` / `l` move, `enter` presses, `esc` presses its
    way out, `k` reads the thread above, and `i` presses the button that gets you typing (Take back).
13. **Vim keys off removes the NORMAL layer only.** No modes, `esc` just leaves, and everything stays
    reachable through modifiers, the leader, arrows and the mouse.
18. **One register, with the clipboard behind it.** Every field shares one unnamed register, as Vim has one per
    instance, not per buffer: `y`, `d`, `c`, `x` fill it, `p` / `P` (with a count, `3p`) put it, in any field.
    A yank in a reader (the thread, a file, a diff, the scrollback) fills it too, and every yank also goes to the
    system clipboard. While the register is empty, `p` / `P` put the system clipboard instead, so text copied in
    another app pastes with `p`; clipboard text that ends in a newline goes in as whole lines. There are no named
    registers and no `"+`: the clipboard is only the fallback. Lines put into a one-line field (a menu's search)
    go in as text.
19. **Every reader takes counts and searches the same way.** A count repeats a motion (`5j`, `3w`, `2}`) and
    `NG` / `Ngg` go to line N (in a diff, the Nth row; in the chat transcript, which has no line numbers, `G`
    goes to the start of the conversation's last line, just above the composer; `i`, `a`, `esc` or `j` from there
    go into the composer). Fields take the same counts, before or after an operator (`2d3w`).
    `/` searches forwards and `?` backwards: a prompt opens (the shared menu, prefix `/` or `?`), typing
    highlights every match in the reader and lists them nearest first, `enter` jumps to the one picked. After
    that `n` repeats the search in its direction and `N` the other way, each with a count; going past an end
    wraps with a short notice ("Search hit BOTTOM, continuing at TOP"). Matching is literal and smart case (all
    lower case ignores case). `esc` in the reader first clears the search, then does its usual step back
    (rule 2). While a search is active `n` repeats it, even in a thread with a waiting request (rule 14); with
    no search, `n` answers the request. In a reader `?` is the backward search; the keyboard popup's `?` works
    from every other surface.
20. **A focused popup is modal.** While a temporary surface has the keys (the composer's `/` and `@` lists, any
    menu, picker, palette or dialog), it gets every key and the global bindings and the leader wait: `ctrl-p` /
    `ctrl-n` move in a `/` list instead of opening file search, `ctrl-k` moves up a menu instead of opening the
    palette, and nothing opens behind Settings. Only `ctrl-tab` passes, so the workspace switcher keeps cycling.
    This holds for every overlay, the ctrl-k palette and ctrl-p file search included: inside them ctrl-k / ctrl-p
    move up and ctrl-j / ctrl-n move down, so a search never opens on top of itself. A dialog with text fields (the
    commit message) is modal too. (`input/dispatcher.ts`: a surface marked `local`; `shell/keyboard.ts` marks every
    overlay's surface local. `input/keyclash.test.ts` fails on a key bound twice, a global that a popup can't
    override, a terminal global that takes a shell key, or a surface handler a global would always pre-empt.)
21. **A popup with a search or input field opens in INSERT.** The palette, file search, the `:` line, the workspace
    menu, the model picker, thread move, the folder picker, the commit filter and go-to-file all start with the caret
    in the field, so typing filters at once. `ctrl-n` / `ctrl-p` and the arrows move the selection while typing,
    `esc` drops the field to NORMAL for `j` / `k`, and a second `esc` closes. A popup without a field (a row's ⋯
    menu, the ctrl-tab switcher while ctrl is held) has nothing to type into and is a plain list. One rule in
    `ui/Menu.tsx`, not a per-popup choice.

## 4. Per-surface summary

| Surface | Kind | Opens in | Notes |
|---|---|---|---|
| Composer, edit box | Field | INSERT | `enter` sends from INSERT or NORMAL |
| Terminal (TUI or shell) | Terminal | TERMINAL | rule 11; leader `[` for its scrollback |
| Mirror bar, handoff card, upload error, SSH dialog buttons, move dialog | List (one row) | NORMAL | rule 16 |
| SSH sign-in (passphrase, code) | Field | INSERT | `enter` connects; `esc` NORMAL on the buttons, `esc` again cancels |
| Composer controls (attach, permissions, model, send; machine, directory) | List | NORMAL | `j` from the text's last line; `h` `l` along, `enter` presses, `k` back to the text |
| Menu search field | Field | INSERT (NORMAL in menus that open on a pick, like a folder's crumbs) | Typing filters the list. In composer menus, moving the pointer over a result selects it (other menus keep the keyboard's selection under the pointer). Arrow keys continue from that result and Enter or Tab opens it; in NORMAL `space` picks and leaves the menu open; `ctrl-h` / `ctrl-l` are left / right. With nothing to pick, a menu without a search field closes and lets the key through. In NORMAL the field keeps its cursor and is a Field wherever that does not clash with the list: `j` `k` `gg` `G` (with counts) move the list, `enter` picks, `q` / `esc` close; `h` `l` `w` `b` `e` `0` `$` move the field's cursor, `x` `dw` `D` `C` `~` `p` `u` edit it, `i` `a` `I` `A` (and `/`) type again. A menu's own keys come first: a folder field's `h` / `l` go up and into folders, the workspace list's `d` closes a workspace. A menu without a search field keeps `h` / `l` for its items' values (the model picker's effort, rule 3) and `l` picks. |
| Side chat or subagent popup | Field | INSERT | opens ready to type into its composer |
| Thread, side chat, subagent, file, diff, scrollback | Reader | NORMAL | entered from the field below, by click, or leader `[`; counts, `/` `?` `n` `N` (rule 19) |
| Changes (diff + file tree) | Reader + Field | NORMAL | `/` `?` search the diff like any reader; `f` searches the tree, `enter` there goes to the first match; on a file's header `s` stages, `x` reverts (Undo in the toast), `enter` on "N unmodified lines" shows them |
| Browser tab | Terminal (the page) + Field (address) | NORMAL (a new tab: INSERT in the address) | `i` / `gi` or a click give the page the keys (TERMINAL), `esc` takes them back; while the page has them Skein keeps only rule 11's keys and mod-l. In NORMAL: `r` reload, `[` `]` and `ctrl-o` / `ctrl-i` back and forward, `o` / `ctrl-l` / mod-l the address (`enter` goes, `esc` `esc` puts it back), `j` `k` `ctrl-d` `ctrl-u` `gg` `G` scroll the page, `enter` on an error presses Retry, `H` / `L` tabs |
| Open file | Reader | NORMAL | `ctrl-o` / `ctrl-i` back and forward through files opened in that tab; the path's folders and the tree switch file in place |
| Rows inside a thread | List | NORMAL | `l` / `h` unfold / fold; `enter` opens |
| Menus, keyboard popup | List | NORMAL | `esc` closes |
| Settings | List (two: sections, then the section's rows) | NORMAL | The section list has the keys first: `j` / `k` move over sections (the page follows), `l`, `enter` or `tab` go into its rows. In the rows `j` / `k` move, `h` / `l` lower and raise a row's value (a choice, a switch), `enter` presses; `esc`, `shift-tab`, or `h` on a row with no value go back to the sections; `esc` there closes, `q` closes from either. `H` / `L` mean tabs everywhere and do nothing in this dialog. |
| Folder fields (workspace menu, a machine's +, a new thread's directory) | List + Field | INSERT | known folders and the machines to browse; type a path (`~/...`, `/...`, or in the workspace menu `machine:~/...`) to list that folder; `tab` (or `l` / right in NORMAL) goes into the folder under the cursor (on a row with nothing to go into, `tab` moves on), `h` back up, `enter` chooses it |
| Sidebar | List (a pane) | NORMAL | leader `h` / `alt-h` from the leftmost pane focuses it (opening it if hidden); `j` `k` move over sections, projects and threads; `h` / `l` fold and unfold (`h` on a thread goes to its project); `enter` / `o` opens in the last pane, `shift-enter` / `O` in a split; `c` new thread in the project, `p` pin, `x` archive, `m` move to another project or machine (a menu of projects on every machine plus Other folder…, then a confirm dialog whose buttons are a row, rule 16; the mouse drags the row onto a project or a machine heading); `l`, leader `l` or `esc` back to the panes. A click in the sidebar gives it the keys (opening a thread hands them to the thread); a click in the panes takes them back |
| Workspaces (a whole layout per project) | Layout | any | `ctrl-tab` most recent first, release to switch; leader `w` or `:workspace` to search, create, rename (`r`), close (`d`) |
| Panes, tabs, popups | Layout | any | `\|` `\` split, `H` `L` tabs, `g t` / `g T` tabs, `g v` chat or terminal, `/` the palette, leader for the rest: `o` focuses each popup in turn then the panes, `d` docks the focused popup as a tab, `r` rotates the split, `<` `>` resize side by side and `+` `-` stacked, `esc` reads a terminal's scrollback (elsewhere: NORMAL), `space` NORMAL. `ctrl-w` in NORMAL arms the leader (`ctrl-w v`, `ctrl-w q` ...); `:only` has no default key. `ctrl-o` from a popup goes back to the pane it came from, leaving it open; `ctrl-i` goes forward to that same popup |

## 5. Keyboard by OS

One table, read by the input layer before anything else (`mockups/platform.js`, `?os=mac|win` in the mockup).

| Kind of key | Windows | Mac | Why |
|---|---|---|---|
| App commands: search, file search, pane search, quote to chat / side chat | `ctrl-k` `ctrl-p` `ctrl-shift-a` `ctrl-l` `ctrl-shift-s` | `⌘K` `⌘P` `⌘⇧A` `⌘L` `⌘⇧S` | Mac apps use cmd; cmd never reaches a terminal, so on a Mac these work there too |
| Vim's own ctrl keys: jump list, window prefix, list movement | `ctrl-o` `ctrl-i` `ctrl-w` `ctrl-n/p/j/k` | `⌃O` `⌃I` `⌃W` `⌃N/P/J/K` | they are Vim keys, not app shortcuts; cmd-w keeps its Mac meaning (close tab) |
| Leader | `ctrl-space` | `⌃Space` | macOS can claim ⌃Space for input sources; Settings offers `ctrl-\` instead |
| Pane focus | `alt-h/j/k/l` | `⌥H/J/K/L` | read by physical key (`e.code`), since ⌥H types ˙ |
| Workspaces | `ctrl-tab` | `⌃Tab` | |

The Electron build must also drop the default menu accelerators that would swallow these keys (`ctrl-w`,
`ctrl-tab`, `ctrl-shift-a`, `cmd-k` in some menus) by building its own application menu (G3).

## 6. Where the build does not yet follow this

- **Search in the chat transcript matches within one run of text.** A phrase split by formatting (inline code,
  bold, a link) is not found as a whole; each part is.
- **Search is literal.** No regular expressions, no `*` / `#` (search for the word under the cursor), no `:s`.
- **One register.** No named registers, no explicit `"+` / `"*`, and `p` in VISUAL does not replace the selection.
- **Counts stop at the edges they knew before**: `5j` past a reader's last line goes to the field below (rule 7)
  like `j` does, and a count before `G` in the chat transcript is ignored.
- **App NORMAL `j` / `k` / `enter` / `o`** (moving the sidebar's cursor without focusing the sidebar, as the mockup does)
  are not built: with nothing to type into, those keys do nothing.
- **`ctrl-o` / `ctrl-i` always take the key**, even with nothing to jump to (the mockup lets them through then).
- **The mockup** still has the old behaviour (Settings' `H` / `L`, a model selector with a search field whose
  `h` / `l` change effort, no counts or search in readers); the build follows this document.
