// The one contract between the renderer and the main process.
//
// Every method is `namespace.method` over ipcRenderer.invoke (see src/preload/index.ts and src/main/ipc.ts).
// Pushes from main to the renderer go over one channel as `SkeinEvent`s.
// The renderer reaches it as `window.skein`. Nothing else crosses the boundary, which keeps the shell
// layer thin: replacing Electron (Tauri fallback) means reimplementing this file's transport only.

import type {
  AuthPrompt, DirEntry, Harness, Machine, Platform, Settings, SshTarget, ThreadEvent, ThreadMeta, ThreadStatus, ViewKind,
} from './types';

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
  /** Fork from this thread (a side chat). */
  parent?: { id: string; at?: string };
}

export interface GitFile { path: string; status: 'M' | 'A' | 'D' | 'R' | '?'; add: number; del: number; staged: boolean }
export interface GitStatus { branch?: string; files: GitFile[]; ahead?: number; behind?: number; isRepo: boolean }

export interface SkeinApi {
  app: {
    info(): Promise<AppInfo>;
    /** Persisted renderer state (layout, workspaces, drafts). Opaque JSON per key. */
    load(key: string): Promise<unknown>;
    save(key: string, value: unknown): Promise<void>;
    settings(): Promise<Settings>;
    setSettings(patch: Partial<Settings>): Promise<Settings>;
    openExternal(url: string): Promise<void>;
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
  };
  chat: {
    send(thread: string, msg: ChatSend): Promise<void>;
    interrupt(thread: string): Promise<void>;
    answer(thread: string, requestId: string, optionId: string): Promise<void>;
    /** Claude Code handoff (G4): hand the thread to a view. Resolves once that view drives. */
    drive(thread: string, view: ViewKind): Promise<void>;
  };
  pty: {
    spawn(spec: PtySpec): Promise<string>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
  };
  images: {
    /** Save a pasted image into ~/.skein/inbox on the machine (uploading over SSH). Returns its path there. */
    toInbox(machine: string, png: Uint8Array, name?: string): Promise<string>;
  };
  git: {
    status(machine: string, dir: string): Promise<GitStatus>;
    diff(machine: string, dir: string, opts: { path?: string; staged?: boolean; range?: string }): Promise<string>;
    stage(machine: string, dir: string, paths: string[], on: boolean): Promise<void>;
    revert(machine: string, dir: string, paths: string[]): Promise<void>;
    commit(machine: string, dir: string, message: string, opts?: { branch?: string; all?: boolean }): Promise<void>;
    log(machine: string, dir: string, n: number): Promise<{ hash: string; subject: string; when: string }[]>;
  };
}

/** Pushes from main. */
export type SkeinEvent =
  | { type: 'pty.data'; id: string; data: string }
  | { type: 'pty.exit'; id: string; code: number | null }
  | { type: 'machine'; machine: Machine }
  | { type: 'auth'; prompt: AuthPrompt }
  | { type: 'auth.done'; id: string }
  | { type: 'thread'; thread: ThreadMeta }
  | { type: 'thread.status'; id: string; status: ThreadStatus }
  | { type: 'chat'; thread: string; event: ThreadEvent; replace?: boolean }
  | { type: 'upload'; machine: string; name: string; pct: number; error?: string }
  | { type: 'menu'; command: string };

/** What the preload exposes on window.skein. pty.write / resize / kill are fire-and-forget (ipc send). */
export type SkeinBridge = SkeinApi & { on(fn: (e: SkeinEvent) => void): () => void; setTheme(dark: boolean): void };

export const FIRE_AND_FORGET = new Set(['pty.write', 'pty.resize', 'pty.kill']);
export const API_SHAPE: { [K in keyof SkeinApi]: (keyof SkeinApi[K])[] } = {
  app: ['info', 'load', 'save', 'settings', 'setSettings', 'openExternal', 'notify'],
  machines: ['list', 'add', 'remove', 'connect', 'answer', 'sshHosts'],
  fs: ['list', 'read', 'write', 'resolve', 'find'],
  threads: ['list', 'discover', 'create', 'update', 'history'],
  chat: ['send', 'interrupt', 'answer', 'drive'],
  pty: ['spawn', 'write', 'resize', 'kill'],
  images: ['toInbox'],
  git: ['status', 'diff', 'stage', 'revert', 'commit', 'log'],
};
