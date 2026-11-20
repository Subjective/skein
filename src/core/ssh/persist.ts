// Keeping a remote harness alive across a dropped link (G5). A thread's TUI runs inside a tmux (or screen)
// session named after the thread, so when the ssh link drops the turn keeps running there, and the next
// `ssh -tt` reattaches to the same session. Skein's tmux uses its own server (-L skein) and config, so it never
// touches the person's own tmux: no status bar, no prefix key, and no alternate screen, so the terminal's
// own scrollback keeps working.
import { sq } from '../shell';

export type Keeper = 'tmux' | 'screen';

export const CONF_DIR = '.skein';
const TMUX_CONF = `${CONF_DIR}/tmux.conf`;
const SCREENRC = `${CONF_DIR}/screenrc`;

/** "tmux 3.3a" -> 3.3 */
export const tmuxVersion = (v: string) => { const m = /(\d+)\.(\d+)/.exec(v); return m ? +m[1] + +m[2] / 10 : 0; };

/** Skein's tmux config for a tmux version. Pure, for tests. */
export function tmuxConf(version: number): string {
  return [
    '# Written by Skein. Skein runs agent threads in this tmux server (tmux -L skein) so they survive a dropped link.',
    'set -g status off',
    version >= 3.0 ? 'set -g prefix None' : 'set -g prefix M-F12',
    'unbind-key -a',
    'set -s escape-time 0',
    'set -g mouse off',
    'set -g set-titles off',
    'set -g history-limit 0',
    'set -g default-terminal "screen-256color"',
    // full redraws stay out of the alternate screen, so Skein's scrollback gets the lines; 24-bit colour
    "set -ga terminal-overrides ',*:smcup@:rmcup@,xterm*:Tc'",
    'set -g window-size latest',
    'set -g aggressive-resize on',
    ...(version >= 3.3 ? ['set -g allow-passthrough on'] : []), // inline images
    ...(version >= 2.6 ? ['set -g focus-events on'] : []),
    '',
  ].join('\n');
}

export const SCREEN_CONF = ['# Written by Skein', 'startup_message off', 'hardstatus off', 'altscreen off', 'defscrollback 0',
  'escape ^^^^', 'termcapinfo xterm* ti@:te@', 'defutf8 on', ''].join('\n');

/** A sh snippet that writes the configs (run once per connection, cheap and idempotent). */
export function writeConfScript(tmuxV: number): string {
  return `mkdir -p ~/${CONF_DIR} && cat > ~/${TMUX_CONF} <<'SKEIN_EOF'\n${tmuxConf(tmuxV)}SKEIN_EOF\ncat > ~/${SCREENRC} <<'SKEIN_EOF'\n${SCREEN_CONF}SKEIN_EOF\n`;
}

/** Session name for a thread: letters, digits, dash. */
export const sessionName = (thread: string) => 'skein-' + thread.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60);

/** Wrap a remote command line so it runs in (or reattaches to) the thread's persistent session. */
export function wrap(line: string, thread: string, k: Keeper): string {
  const name = sessionName(thread);
  if (k === 'tmux') return `exec tmux -L skein -f ~/${TMUX_CONF} new-session -A -s ${name} ${sq(line)}`;
  return `exec screen -U -D -RR -S ${name} -c ~/${SCREENRC} sh -c ${sq(line)}`;
}

/** End the thread's session (the tab or thread was closed on purpose). */
export function killLine(thread: string, k: Keeper): string {
  const name = sessionName(thread);
  return k === 'tmux' ? `tmux -L skein kill-session -t =${name} 2>/dev/null; true` : `screen -S ${name} -X quit 2>/dev/null; true`;
}

/** Thread session names still alive on the machine. */
export const listLine = `tmux -L skein list-sessions -F '#S' 2>/dev/null; screen -ls 2>/dev/null | sed -n 's/^[[:space:]]*[0-9]*\\.\\(skein-[^[:space:]]*\\).*/\\1/p'; true`;
