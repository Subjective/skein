// Runs scripts/smoke-pty.cjs with the installed Electron acting as Node.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..');
const bin = join(root, 'node_modules', 'electron', 'dist', readFileSync(join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const r = spawnSync(bin, [join(root, 'scripts', 'smoke-pty.cjs')], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: root });
process.exit(r.status ?? 1);
