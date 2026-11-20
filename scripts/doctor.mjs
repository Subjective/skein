#!/usr/bin/env node
// pnpm doctor: checks what building and running Skein needs, and says how to fix what is missing.
// Plain Node, no dependencies, so it runs before `pnpm install`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const win = process.platform === 'win32', mac = process.platform === 'darwin';
const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
let fails = 0, warns = 0;
const ok = (what, detail = '') => console.log(`${c(32, '✓')} ${what}${detail ? c(2, '  ' + detail) : ''}`);
const warn = (what, fix) => { warns++; console.log(`${c(33, '!')} ${what}\n    ${fix}`); };
const fail = (what, fix) => { fails++; console.log(`${c(31, '✗')} ${what}\n    ${fix}`); };
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: win }).trim(); } catch { return null; } };

console.log(c(1, `Skein doctor (${process.platform} ${process.arch})\n`));

// Node
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj >= 22) ok('Node.js', process.versions.node);
else fail(`Node.js ${process.versions.node} is too old`, 'Install Node 22 or newer (https://nodejs.org, or `winget install OpenJS.NodeJS.LTS` / `brew install node@22`).');
void min;

// pnpm
const pnpm = sh('pnpm', ['--version']);
if (pnpm && +pnpm.split('.')[0] >= 9) ok('pnpm', pnpm);
else fail('pnpm 9 or newer not found', 'Run `corepack enable` (ships with Node), or `npm install -g pnpm`.');

// git
const git = sh('git', ['--version']);
git ? ok('git', git.replace('git version ', '')) : fail('git not found', win ? 'Install Git for Windows: `winget install Git.Git`.' : 'Install git (Xcode command line tools: `xcode-select --install`).');

// Electron runtime
const ePath = join(root, 'node_modules', 'electron', 'path.txt');
const mirror = process.env.ELECTRON_MIRROR || process.env.npm_config_electron_mirror;
if (existsSync(ePath)) {
  const bin = join(root, 'node_modules', 'electron', 'dist', readFileSync(ePath, 'utf8').trim());
  existsSync(bin) ? ok('Electron runtime', 'downloaded') : fail('Electron is installed but its binary is missing', 'Run `pnpm rebuild electron` (set ELECTRON_MIRROR first if github.com is blocked).');
} else {
  const host = mirror ? new URL(mirror).host : 'github.com';
  const reach = await new Promise(res => {
    const r = request({ host, method: 'HEAD', path: '/', timeout: 6000 }, x => { res(x.statusCode < 500); x.resume(); });
    r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); r.end();
  });
  if (reach) ok('Electron download host reachable', host + (mirror ? ' (ELECTRON_MIRROR)' : ''));
  else fail(`Cannot reach ${host} to download Electron`, 'Set ELECTRON_MIRROR to an internal mirror (e.g. an Artifactory "electron" remote), or set ELECTRON_SKIP_BINARY_DOWNLOAD=1 and copy a matching Electron zip into the cache (see README, "Locked-down machines").');
}

// node-pty: prebuilt for Windows and macOS (x64 and arm64), compiled elsewhere
const prebuilt = (win || mac) && ['x64', 'arm64'].includes(process.arch);
if (prebuilt) ok('Terminal module (node-pty)', `prebuilt for ${process.platform}-${process.arch}, no compiler needed`);
else {
  const py = sh(win ? 'python' : 'python3', ['--version']);
  const cc = win ? null : sh('c++', ['--version']);
  py && (win || cc) ? ok('Build tools for node-pty', `${py}${cc ? ', c++' : ''}`)
    : fail('node-pty must be compiled here, and Python or a C++ compiler is missing', win ? 'Install "Visual Studio Build Tools" with "Desktop development with C++", and Python 3.' : 'Install python3, make and a C++ compiler (build-essential).');
}
if (existsSync(join(root, 'node_modules', 'node-pty'))) {
  const built = ['build/Release/pty.node', `prebuilds/${process.platform}-${process.arch}/pty.node`].some(p => existsSync(join(root, 'node_modules', 'node-pty', p)));
  built ? ok('node-pty binary present') : fail('node-pty has no binary', 'Run `pnpm rebuild node-pty`. pnpm 10 skips install scripts not listed in package.json "pnpm.onlyBuiltDependencies".');
}

// Runtime tools (warnings: the app runs without them, with less to do)
for (const [cmd, name, fix] of [
  ['claude', 'Claude Code CLI', 'Install: https://docs.claude.com/claude-code (`npm i -g @anthropic-ai/claude-code`).'],
  ['codex', 'Codex CLI', 'Install: `npm i -g @openai/codex`.'],
  ['ssh', 'OpenSSH client', win ? 'Windows: Settings > System > Optional features > OpenSSH Client.' : 'Install openssh.'],
]) {
  const v = sh(cmd, ['--version']) ?? sh(cmd, ['-V']);
  const found = v != null || sh(win ? 'where' : 'which', [cmd]);
  found ? ok(name, (v || '').split('\n')[0]) : warn(`${name} not found on PATH`, fix);
}

console.log('\n' + (fails ? c(31, `${fails} problem${fails > 1 ? 's' : ''} to fix before building.`) : c(32, 'Ready to build: pnpm install && pnpm start')) + (warns ? c(33, `  (${warns} warning${warns > 1 ? 's' : ''})`) : ''));
process.exit(fails ? 1 : 0);
