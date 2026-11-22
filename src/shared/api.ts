// The one contract between the renderer and the main process.
//
// Every method is `namespace.method` over ipcRenderer.invoke (see src/preload/index.ts and src/main/ipc.ts).
// Pushes from main to the renderer go over one channel as `SkeinEvent`s.
// The renderer reaches it as `window.skein`. Nothing else crosses the boundary, which keeps the shell
// layer thin: replacing Electron (Tauri fallback) means reimplementing this file's transport only.

import type {
  AuthPrompt, DirEntry, Harness, Machine, Platform, Settings, SshTarget, ThreadEvent, ThreadMeta, ThreadStatus, ViewKind,
} from './types';
import type { KeyLike } from './keys';
import type { HarnessCommands } from './commands';
import type { HarnessOptions } from './models';

export interface AppInfo {
  platform: Platform;
  version: string;
  home: string;
  /** false when the build could not load node-pty; terminals then show why. */
  pty: boolean;
}

export interface PtySpec {
  machine: string;
  cwd: string;
  /** What to run. 'shell' is the user's login shell; a harness spec launches its TUI. */
  run:
    | { kind: 'shell' }
    /** Resumes `session` if its transcript exists on the machine, else starts a new session with that id. */
    | { kind: 'claude'; session?: string; args?: string[] }
    | { kind: 'codex'; resume?: string; remote?: string; args?: string[] };
  cols: number;
  rows: number;
  /** Ties the pty to a thread, for handoff and detection. */
  thread?: string;
}

export interface ChatSend {
  text: string;
  /** Local file paths or data URLs of images (G14: chat sends a structured attachment). */
  images?: string[];
  model?: string;
  effort?: string;
  perm?: string;
  /** Claude Code's Ultracode switch (standing dynamic-workflow orchestration, at any effort). Session-scoped like the
   *  SDK's setting: absent keeps what the thread's driver has. */
  ultra?: boolean;
  /** Edit and resend (G8): the id of the user event this message replaces. The thread rewinds to just before it. */
  rewind?: string;
  /** Send to this subagent (the id of its `sub` event) instead of the thread. */
  sub?: string;
  /** Run the last turn again (Restart after a crash, Retry now after a rate limit). `text` is empty. */
  retry?: boolean;
}

export interface NewThread {
  harness: Harness;
  machine: string;
  dir: string;
  model?: string;
  effort?: string;
  perm?: string;
  worktree?: boolean;
  view: ViewKind;
  /** Fork from this thread at that event: a new thread, or a side chat when `side` is set. */
  parent?: { id: string; at?: string };
  /** A side chat: a fork kept with its parent (ThreadMeta.side), not listed as a thread of its own. */
  side?: boolean;
}

export interface GitFile { path: string; status: 'M' | 'A' | 'D' | 'R' | '?'; add: number; del: number; staged: boolean }
export interface GitStatus { branch?: string; files: GitFile[]; ahead?: number; behind?: number; isRepo: boolean }

// ---- Changes and Files (src/core/git.ts) ----
/** One line of a diff. `a` is its number in the old file, `b` in the new one. */
export interface DiffLine { k: ' ' | '+' | '-'; a?: number; b?: number; text: string }
export interface Hunk { a: number; b: number; an: number; bn: number; lines: DiffLine[] }
export interface FileDiff {
  path: string;
  /** the old path of a rename */
  old?: string;
  status: 'M' | 'A' | 'D' | 'R';
  add: number;
  del: number;
  binary?: boolean;
  hunks: Hunk[];
  /** For working-tree scopes: whether the file's changes are in the index. */
  staged?: 'yes' | 'no' | 'part';
}
/** What Changes compares. turn: `base` is the tree when the agent's turn began, `head` the tree when it ended
 *  (absent while it runs). commits: `base` is the oldest commit of the run, `head` the newest. */
/** 'all': everything this branch changed, committed or not (the trunk's merge base, `base`, to the working tree). */
export type DiffScope = 'uncommitted' | 'staged' | 'unstaged' | 'turn' | 'all' | 'commits';
export interface ScopeSpec { scope: DiffScope; base?: string; head?: string; path?: string }
export interface ScopeCounts { files: number; add: number; del: number }
export interface RepoState {
  root: string;
  /** The asked-for folder relative to the root ('' at the root), with /. */
  prefix: string;
  branch?: string;
  /** HEAD's hash; absent before the first commit */
  head?: string;
  ahead: number;
  behind: number;
  upstream?: string;
  /** The default branch (main / master), where Commit makes a branch first. */
  trunk?: string;
  /** Changes whenever the working tree, the index or HEAD does: cheap polling compares it. */
  key: string;
  /** Uncommitted files and what happened to them (new files are A), relative to the root. For tree marks. */
  changed: Record<string, 'M' | 'A' | 'D' | 'R'>;
}
export interface Commit { hash: string; short: string; subject: string; when: string; author: string }
export interface Branch { name: string; current: boolean; when: string }
/** What a revert threw away, kept so Undo can put it back. */
export interface RevertUndo { id: string; paths: string[] }

export interface SkeinApi {
  app: {
    info(): Promise<AppInfo>;
    /** Persisted renderer state (layout, workspaces, drafts). Opaque JSON per key. */
    load(key: string): Promise<unknown>;
    save(key: string, value: unknown): Promise<void>;
    settings(): Promise<Settings>;
    setSettings(patch: Partial<Settings>): Promise<Settings>;
    openExternal(url: string): Promise<void>;
    /** Show a file on this computer in Finder / File Explorer (~ allowed). */
    reveal(path: string): Promise<void>;
    notify(title: string, body: string, thread?: string): Promise<void>;
  };
  machines: {
    list(): Promise<Machine[]>;
    add(name: string, ssh: SshTarget): Promise<Machine>;
    remove(id: string): Promise<void>;
    /** Connect (or reconnect) and refresh what the machine has. */
    connect(id: string): Promise<Machine>;
    /** Answer an AuthPrompt. null cancels. */
    answer(promptId: string, value: string | null): Promise<void>;
    /** Hosts from ~/.ssh/config that are not added yet. */
    sshHosts(): Promise<string[]>;
  };
  fs: {
    list(machine: string, dir: string): Promise<DirEntry[]>;
    read(machine: string, path: string): Promise<string>;
    write(machine: string, path: string, text: string): Promise<void>;
    /** Expand ~ and return an absolute path on that machine. */
    resolve(machine: string, path: string): Promise<string>;
    /** Every file under dir, relative to it (git's list when it is a repo; capped). For file search. */
    find(machine: string, dir: string): Promise<string[]>;
  };
  threads: {
    list(): Promise<ThreadMeta[]>;
    /** Scan ~/.claude and ~/.codex on a machine for sessions Skein has not seen. */
    discover(machine: string): Promise<ThreadMeta[]>;
    create(spec: NewThread): Promise<ThreadMeta>;
    update(id: string, patch: Partial<ThreadMeta>): Promise<ThreadMeta>;
    /** Full history, normalized. */
    history(id: string): Promise<ThreadEvent[]>;
    /** A subagent's turns (its `sub` event: id, and `agent` when known), read from what the harness keeps of it. */
    sub(id: string, sub: { id: string; agent?: string }): Promise<ThreadEvent[]>;
    /** Move an idle thread to another folder, on this machine or another (HANDOFF "Moving a thread"). Its
     *  terminals close and its chat driver lets go first; the session file is copied where the harness will
     *  look for it (the original stays). Rejects with the reason when it can't move. */
    move(id: string, machine: string, dir: string): Promise<ThreadMeta>;
  };
  chat: {
    send(thread: string, msg: ChatSend): Promise<void>;
    interrupt(thread: string): Promise<void>;
    answer(thread: string, requestId: string, optionId: string): Promise<void>;
    /** Claude Code handoff (G4, core/handoff): hand the thread to a view. Resolves once that view drives: chat after
     *  the terminal's turn ends, the terminal after chat's. Handing it back to the terminal cancels a wait for chat. */
    drive(thread: string, view: ViewKind): Promise<void>;
    /** A chat view showing the thread opened (true) or closed (false): its transcript is followed live meanwhile
     *  (new entries arrive as 'chat' pushes, whoever writes them). */
    follow(thread: string, on: boolean): void;
  };
  pty: {
    spawn(spec: PtySpec): Promise<string>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    /** A shell tab: is a harness TUI running in it now (claude or codex, started by hand)? If so the terminal
     *  becomes a new thread's (listed in the sidebar), which is returned; its session id follows once the
     *  harness writes its transcript. `seen` is what the renderer saw (Claude Code's terminal title), used
     *  where the process tree can't be read (an SSH shell runs its programs on the other machine). */
    adopt(id: string, seen?: Harness): Promise<ThreadMeta | null>;
  };
  images: {
    /** Save a pasted image into ~/.skein/inbox on the machine (uploading over SSH). Returns its path there. */
    toInbox(machine: string, png: Uint8Array, name?: string): Promise<string>;
  };
  git: {
    status(machine: string, dir: string): Promise<GitStatus>;
    diff(machine: string, dir: string, opts: { path?: string; staged?: boolean; range?: string }): Promise<string>;
    stage(machine: string, dir: string, paths: string[], on: boolean): Promise<void>;
    /** Throw a file's changes away (back to HEAD, index too). Returns what Undo needs. */
    revert(machine: string, dir: string, paths: string[]): Promise<RevertUndo>;
    unrevert(machine: string, dir: string, undo: RevertUndo): Promise<void>;
    /** With nothing staged, `all` stages everything (new files too) first. `branch` creates and switches to it first. */
    commit(machine: string, dir: string, message: string, opts?: { branch?: string; all?: boolean }): Promise<void>;
    log(machine: string, dir: string, n: number): Promise<{ hash: string; subject: string; when: string }[]>;
    /** null when `dir` is not in a repository. */
    repo(machine: string, dir: string): Promise<RepoState | null>;
    changes(machine: string, root: string, spec: ScopeSpec): Promise<FileDiff[]>;
    counts(machine: string, root: string, specs: ScopeSpec[]): Promise<ScopeCounts[]>;
    /** A file's text: 'worktree', 'index', or any revision (a commit or tree hash). */
    show(machine: string, root: string, path: string, rev: string): Promise<string>;
    commits(machine: string, root: string, n: number): Promise<Commit[]>;
    branches(machine: string, root: string): Promise<Branch[]>;
    switch(machine: string, root: string, branch: string, create?: boolean): Promise<void>;
    /** Push the branch (setting its upstream). `pr` is the forge's page for opening a pull request, when known. */
    push(machine: string, root: string): Promise<{ pr?: string }>;
    /** The working tree as a tree object (new files included), for "Last agent turn". */
    snapshot(machine: string, root: string): Promise<string>;
    /** Tracked and untracked files, ignored ones left out. Paths relative to the root, with /. */
    files(machine: string, root: string): Promise<string[]>;
    /** The file's page on the remote's website (GitHub, GitLab, Bitbucket), at the upstream branch, else the
     *  default branch. null when there is no remote or its host is not one of those. */
    webUrl(machine: string, root: string, path: string): Promise<string | null>;
  };
  browser: {
    /** Forward a port on an SSH machine to this computer (`ssh -N -L`), so a Browser tab can load the remote's
     *  localhost. Resolves with the local port once it accepts connections; one forward per machine and port is reused. */
    forward(machine: string, port: number): Promise<number>;
    /** The keys Skein keeps while a page has the keyboard (keyOf form): main stops them reaching the page and
     *  sends them back as `browser.key`. */
    keys(keys: string[]): void;
  };
  harness: {
    /** What a harness offers on a machine: its models (with effort levels), effort names and permission modes,
     *  asked from the harness (Claude: the Agent SDK's initialize; Codex: the app-server's model/list) and cached.
     *  Never rejects: when the harness can't be asked it is shared/models.ts's lists with source 'bundled'. */
    options(machine: string, harness: Harness): Promise<HarnessOptions>;
    /** What the harness offers in the composer's / menu in that folder: its commands, and its skills (user,
     *  project, plugin), asked from the harness there and cached. Never rejects: the bundled lists, source 'bundled'. */
    commands(machine: string, harness: Harness, dir: string): Promise<HarnessCommands>;
  };
}

/** Pushes from main. */
export type SkeinEvent =
  | { type: 'pty.data'; id: string; data: string }
  /** `handoff`: closed so chat could take the thread (core/handoff); its view resumes the session when shown again. */
  | { type: 'pty.exit'; id: string; code: number | null; handoff?: boolean }
  | { type: 'machine'; machine: Machine }
  | { type: 'auth'; prompt: AuthPrompt }
  | { type: 'auth.done'; id: string }
  | { type: 'thread'; thread: ThreadMeta }
  | { type: 'thread.status'; id: string; status: ThreadStatus }
  | { type: 'chat'; thread: string; event: ThreadEvent; replace?: boolean }
  | { type: 'upload'; machine: string; name: string; pct: number; error?: string }
  | { type: 'menu'; command: string }
  /** A kept key (browser.keys) pressed while a Browser tab's page had focus. `contents` is the page's webContents id. */
  | { type: 'browser.key'; contents: number; key: KeyLike };

/** What the preload exposes on window.skein. pty.write / resize / kill are fire-and-forget (ipc send). */
export type SkeinBridge = SkeinApi & { on(fn: (e: SkeinEvent) => void): () => void; setTheme(dark: boolean): void };

export const FIRE_AND_FORGET = new Set(['pty.write', 'pty.resize', 'pty.kill', 'browser.keys', 'chat.follow']);
export const API_SHAPE: { [K in keyof SkeinApi]: (keyof SkeinApi[K])[] } = {
  app: ['info', 'load', 'save', 'settings', 'setSettings', 'openExternal', 'reveal', 'notify'],
  machines: ['list', 'add', 'remove', 'connect', 'answer', 'sshHosts'],
  fs: ['list', 'read', 'write', 'resolve', 'find'],
  threads: ['list', 'discover', 'create', 'update', 'history', 'sub', 'move'],
  chat: ['send', 'interrupt', 'answer', 'drive', 'follow'],
  pty: ['spawn', 'write', 'resize', 'kill', 'adopt'],
  images: ['toInbox'],
  git: ['status', 'diff', 'stage', 'revert', 'unrevert', 'commit', 'log', 'repo', 'changes', 'counts', 'show', 'commits', 'branches', 'switch', 'push', 'snapshot', 'files', 'webUrl'],
  browser: ['forward', 'keys'],
  harness: ['options', 'commands'],
};
