// Quoting and command lookup. Remote machines are assumed to run a POSIX shell (ssh into Linux or macOS).
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Quote one argument for a POSIX shell. */
export const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** A remote path that may start with ~/ : keep ~ unquoted so the remote shell expands it. */
export const sqPath = (p: string) => (p === '~' ? '~' : p.startsWith('~/') ? '~/' + sq(p.slice(2)) : sq(p));

/** Find an executable on this computer's PATH, honouring PATHEXT on Windows (claude.cmd, codex.cmd, claude.exe). */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.toLowerCase()) : [''];
  const extra = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', join(env.HOME || '', '.local/bin'), join(env.HOME || '', '.npm-global/bin')];
  for (const dir of [...(env.PATH || env.Path || '').split(delimiter), ...extra]) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}
