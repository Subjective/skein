// A Mac app started from the Finder does not get the login shell's PATH, so `claude` and `codex` would not
// be found. Read the login shell's environment once at startup and merge PATH (what VS Code does too).
import { execFileSync } from 'node:child_process';
import { log } from './log';

export function loadLoginEnv() {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const mark = '__SKEIN_ENV__';
    const out = execFileSync(shell, ['-ilc', `echo ${mark}; env`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const body = out.slice(out.indexOf(mark) + mark.length);
    for (const line of body.split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = line.slice(0, i);
      if (k === 'PATH' || (!(k in process.env) && /^[A-Z_][A-Z0-9_]*$/.test(k))) process.env[k] = line.slice(i + 1);
    }
  } catch (e) { log('env', 'could not read the login shell environment', (e as Error).message); }
}
