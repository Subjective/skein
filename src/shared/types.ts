// Types shared by the main process (src/main, src/core) and the renderer.
// Keep this file free of imports from Node or the DOM.

export type Harness = 'claude' | 'codex';
export type Platform = 'mac' | 'win' | 'linux';

/** Link state of a machine. Local machines are always 'up'. See HANDOFF.md "SSH" (G5). */
export type LinkState = 'up' | 'connecting' | 'reconnecting' | 'auth' | 'down';

export interface SshTarget {
  /** Host alias from ~/.ssh/config, or a hostname. Passed to the system `ssh` as is. */
  host: string;
  user?: string;
  port?: number;
}

export interface Machine {
  id: string;            // 'local' for this computer
  name: string;          // shown in the sidebar
  ssh?: SshTarget;       // absent for the local machine
  os?: string;           // 'macOS' | 'Windows' | 'Linux' once known
  home?: string;         // home directory once known
  link: LinkState;
  /** Harness CLIs found on the machine's PATH. */
  has: Harness[];
  /** Why the link is down or waiting, in plain words. */
  note?: string;
  /** What keeps harness processes alive on the remote across a dropped link (G5). Absent: nothing found. */
  persist?: 'tmux' | 'screen';
}

/** A pending SSH prompt (passphrase, password, verification code, new host key). One small dialog. */
export interface AuthPrompt {
  machine: string;
  id: string;
  kind: 'passphrase' | 'password' | 'code' | 'hostkey' | 'other';
  text: string;          // the prompt as ssh printed it
  secret: boolean;
  /** hostkey only: the host as ssh named it, and the key's fingerprint ("ED25519 SHA256:...") */
  host?: string;
  fingerprint?: string;
}

export type ThreadStatus = 'idle' | 'running' | 'wait' | 'unread' | 'error';
export type ViewKind = 'chat' | 'term';

/** Skein's own record of a thread. The conversation itself lives in ~/.claude or ~/.codex. */
export interface ThreadMeta {
  id: string;                 // Skein id
  harness: Harness;
  sessionId?: string;         // the harness's session / thread id, once known
  machine: string;
  dir: string;
  title: string;
  branch?: string;
  model?: string;
  effort?: string;
  perm?: string;
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  /** Claude Code only: which view drives the thread (G4). */
  drive?: ViewKind;
  /** Side chats are real forks: the thread they branched from and the event they branched at. */
  parent?: { id: string; at?: string };
  side?: boolean;
  /** true when found in the harness's history rather than started from Skein. */
  discovered?: boolean;
  /** Context window used, 0-100, when the harness reports it. */
  ctx?: number;
  /** When a process outside Skein (the harness in another terminal) last took this thread: Skein follows its
   *  transcript and doesn't send to it until you take over (one writer per session). 0 or absent: Skein may drive. */
  external?: number;
}

/** What a tool step did, whatever the harness called it: the chat view's icons, verbs and run summaries go by this.
 *  Claude names each kind of step as its own tool; Codex runs most of them as shell commands and tags what each one does. */
export type StepKind = 'read' | 'search' | 'list' | 'command' | 'web' | 'mcp' | 'other';

// ---- normalized conversation events, rendered by the chat view and derived from either harness ----
export type ThreadEvent =
  | { t: 'user'; id: string; text: string; images?: string[]; at?: number }
  | { t: 'text'; id: string; text: string; streaming?: boolean }
  | { t: 'thinking'; id: string; text: string }
  | { t: 'tool'; id: string; name: string; arg: string; out?: string; status: 'running' | 'done' | 'failed'; meta?: string; kind?: StepKind }
  | { t: 'edit'; id: string; path: string; add: number; del: number; diff?: string; status: 'running' | 'done' | 'failed' }
  | { t: 'todo'; id: string; items: { text: string; done: boolean }[] }
  /** A subagent. `events`: its turns as they stream in (the full record comes from api.threads.sub). `agent`: the
   *  harness's own id for it (Claude Code's agentId, Codex's thread id). `followUps`: the harness takes messages to it. */
  | { t: 'sub'; id: string; name: string; task: string; status: 'running' | 'done' | 'failed'; dur?: string; events?: ThreadEvent[]; agent?: string; followUps?: boolean }
  | { t: 'image'; id: string; src: string; cap?: string }
  | { t: 'approval'; id: string; request: ApprovalRequest }
  | { t: 'error'; id: string; kind: 'crash' | 'rate' | 'auth' | 'missing' | 'other'; text: string }
  | { t: 'notice'; id: string; text: string }       // compaction, model switch, moved-from
  | { t: 'interrupted'; id: string }
  | { t: 'worked'; id: string; ms: number };

export interface ApprovalRequest {
  requestId: string;
  kind: 'command' | 'edit' | 'plan' | 'other';
  title: string;            // "Run this command?"
  body: string;             // the command, the plan, the file
  detail?: string;
  options: { id: string; label: string; primary?: boolean }[];
  /** The subagent that asked, when it was not the thread itself. */
  from?: string;
}

// ---- persisted UI state (layout, settings) ----
export interface Settings {
  theme: 'dark' | 'light' | 'system';
  vim: boolean;
  leader: 'ctrl-space' | 'ctrl-\\';
  sideView: 'grouped' | 'recent';
  defaultView: ViewKind;
  notify: 'waiting' | 'replies' | 'off';
  vimrc: string;
  /** What a new start shows: the last session's workspaces and layouts, or one empty workspace. */
  launch?: 'restore' | 'empty';
  termFont?: string;
  /** How much of an agent's steps a turn shows (absent: compact). */
  density?: Density;
  termFontSize?: number;
  /** The open file's ⋯ menu: line numbers (on unless false) and word wrap. */
  fileNumbers?: boolean;
  fileWrap?: boolean;
}

export type Density = 'compact' | 'balanced' | 'detailed';

export interface DirEntry { name: string; dir: boolean; hidden?: boolean }
