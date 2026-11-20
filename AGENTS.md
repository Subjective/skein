# Working on Skein

Skein is a desktop interface for Claude Code and Codex, locally and over SSH. The current deliverable is the interactive HTML mockup in `mockups/`. Work on that prototype until the desktop build is approved. Start in the [home scene](mockups/index.html?scene=home). The layers button opens other scenes.

## Product model

- Use **thread** for a conversation and **workspace** for a saved project layout. Chat and terminal are two views of the same live thread. Switching views belongs to the tab and preserves the conversation.
- A workspace has panes, each with its own tabs. Keep split, zoom, drag, pop out, and dock operations scoped to the pane or tab they act on. The sidebar lists threads across workspaces, grouped by machine and directory or by recent activity.
- Scope controls to the work at hand. Global search and its shortcut open the same picker. Pane search includes the current thread’s side chats. File search and folder browsing use the selected machine and project root.
- Use one composer for the main thread, side chats, and editing an earlier prompt. Keep the relevant model, permissions, and attachment controls available. Quoted selections move and delete as single inline items and link back to their source. A side chat links to the message it branched from.
- Group models by harness in one picker. Show the effort and permission choices the selected harness and model support.

## Interface design

- Use Codex desktop and Cursor as visual references, including their hover, focus, and collapsed states. Reuse Skein’s typography, spacing, neutral surfaces, hairline borders, and icon sizes in light and dark themes.
- Give each control one clear purpose. Prefer a recognizable icon with an accessible name. Put occasional actions on hover and keyboard focus. Add text when it helps someone choose, act, or recover. Use the established harness marks and give meaningful states a recognizable shape or label.
- Use motion to explain the result of an action. A disclosure arrow turns as its contents slide. During a drag, show one item under the pointer and preview its final position with stable sizing. Support interrupted gestures and reduced motion.
- Design for the width of the pane. As a split narrows, hide secondary elements such as the timeline before they crowd the composer or cause horizontal scrolling.

## Keyboard and focus

- Follow [the Vim interaction model](docs/VIM-MODEL.md). Give each new surface a role as a field, reader, list, layout, or terminal. Reuse its navigation and selection rules. Update the document when an interaction rule changes.
- One surface owns the keyboard and visible cursor. Clicking a field places the caret and enters Insert. Escape backs out one level at a time. Closing a popup restores the originating pane and cursor position.
- Mouse and keyboard actions should reach the same result. Keep visual selection within its starting message (one reply or one of your messages; a file keeps its own bounds) and let Normal mode move across blocks in both directions. Keep actions reachable with Vim disabled and editable bindings in sync with the vimrc.

## Verifying changes

Try the changed interaction in the relevant mockup scene, on both keyboards (`?os=mac` and `?os=win`). For a reference image, compare the rendered state at a similar pane width and theme. For a focus change, exercise entry, action, dismissal, and return. Report what you observed and identify anything verified only through a scripted check.

[HANDOFF.md](HANDOFF.md) maps the implementation. [PROMPTS.md](PROMPTS.md) records the design history. When prompts conflict, follow the latest explicit decision. Treat open questions as design history.
