# Skein

A desktop app for Claude Code and Codex threads, on this computer and over SSH. Every thread has a
terminal view (the harness's own TUI) and a chat view; panes, tabs, the sidebar and menus all work from
the keyboard with Vim keys.

Built from source on purpose: clone, install, run. Nothing is downloaded at runtime.

## Run it

You need Node 22+, pnpm 9+ and git. Check first; `pnpm doctor` says what is missing and how to fix it.

### Windows

```powershell
winget install OpenJS.NodeJS.LTS Git.Git     # if you don't have them
corepack enable                              # gives you pnpm
git clone https://github.com/Subjective/skein
cd skein
pnpm doctor
pnpm install
pnpm start
```

No Visual Studio or Python is needed on x64 or arm64: the terminal module (node-pty) ships prebuilt
binaries for Windows. SSH uses the OpenSSH client that comes with Windows (Settings > System >
Optional features > OpenSSH Client).

### macOS

```sh
brew install node@22 git        # or use what you have
corepack enable
git clone https://github.com/Subjective/skein
cd skein
pnpm doctor && pnpm install && pnpm start
```

### Updating

```sh
git pull && pnpm install && pnpm start
```

## Locked-down machines

`pnpm install` downloads one binary: the Electron runtime, from GitHub releases. If that is blocked:

- Point it at a mirror: `set ELECTRON_MIRROR=https://your-artifactory/electron/` (PowerShell:
  `$env:ELECTRON_MIRROR="..."`), then `pnpm install`.
- Or copy the zip by hand: download `electron-v45.4.1-win32-x64.zip` (or the darwin one) elsewhere, put it in
  `%LOCALAPPDATA%\electron\Cache` (macOS: `~/Library/Caches/electron`), then `pnpm install`.
- npm registry blocked? Set `registry=` in an `.npmrc` to your internal mirror.

pnpm 10 runs install scripts only for packages listed in `package.json` under `pnpm.onlyBuiltDependencies`
(electron, esbuild, node-pty). If your company's pnpm config blocks scripts entirely, run
`pnpm rebuild electron node-pty` once after installing.

## Use it

- **New thread:** the composer in a new tab. Pick the model (it picks Claude Code or Codex), the machine and the
  folder, type, enter. The thread opens in its terminal view.
- **Existing sessions** in `~/.claude` and `~/.codex` show up in the sidebar on first launch.
- **Remote machines:** Settings > Machines > Add SSH host (reads `~/.ssh/config`). Keys need to work from a
  terminal first (`ssh yourhost` without a password prompt, or an agent).
- **Keys:** `ctrl-space` is the leader (`ldr v` split right, `ldr s` split down, `ldr t` chat ⇄ terminal,
  `ldr h/j/k/l` focus, `ldr [` read a terminal's scrollback). `?` shows them all. On a Mac app shortcuts use ⌘.
  The full model is [docs/VIM-MODEL.md](docs/VIM-MODEL.md).
- **Find things:** `ctrl-k` (⌘K) searches threads and actions, `ctrl-p` (⌘P) searches files in the focused
  tab's folder, `ldr w` switches workspaces and `ctrl-tab` jumps to the last one.
- **Terminal copy and paste on Windows:** `ctrl-c` copies a selection (with nothing selected it interrupts),
  `ctrl-v` pastes. A screenshot on the clipboard is saved to `~/.skein/inbox` and its path pasted, which
  Claude Code and Codex turn into `[Image #1]`. Over SSH the image is uploaded first.
- **Tabs:** drag a tab onto another pane's tab bar to move it, onto a pane's edge to split, or outside to pop it out.

## Develop

```sh
pnpm dev        # Electron with hot reload
pnpm dev:web    # the UI alone in a browser at http://localhost:5199, with sample data
pnpm test       # unit tests (keymap, Vim engine, layout, discovery)
pnpm typecheck
pnpm smoke      # node-pty and node:sqlite inside Electron
```

Layout of the code and decisions: [HANDOFF.md](HANDOFF.md). The original interactive mockup is in `mockups/`.
