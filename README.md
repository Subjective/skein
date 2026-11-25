# Skein

A desktop app for Claude Code and Codex threads, on local and remote machines. Vim-first and fully
keyboard-driven, with panes and tabs inspired by tmux.

## Run it

Needs Node 22+, pnpm 9+ and git.

### Windows

```powershell
winget install OpenJS.NodeJS.LTS Git.Git
corepack enable
git clone https://github.com/Subjective/skein
cd skein
pnpm install
pnpm start
```

### macOS

```sh
brew install node@22 git
corepack enable
git clone https://github.com/Subjective/skein
cd skein
pnpm install && pnpm start
```

`pnpm doctor` reports anything missing. To update: `git pull && pnpm install && pnpm start`.

## Develop

```sh
pnpm dev        # Electron with hot reload
pnpm dev:web    # the UI alone in a browser at http://localhost:5199, with sample data
pnpm test       # unit tests
pnpm typecheck
pnpm smoke      # node-pty and node:sqlite inside Electron
```

Keys: [docs/VIM-MODEL.md](docs/VIM-MODEL.md).
