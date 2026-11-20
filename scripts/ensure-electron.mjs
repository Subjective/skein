// postinstall: Electron 45 no longer downloads its runtime at install time (it waits for first use).
// Download it now, so `pnpm install` is the only step that touches the network. Honours ELECTRON_MIRROR.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..');
const install = join(root, 'node_modules', 'electron', 'install.js');
if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || !existsSync(install)) process.exit(0);
const r = spawnSync(process.execPath, [install], { stdio: 'inherit', cwd: join(root, 'node_modules', 'electron') });
if (r.status !== 0) {
  console.error('\nCould not download the Electron runtime. If github.com is blocked, set ELECTRON_MIRROR (see README, "Locked-down machines") and run `pnpm install` again.');
  process.exit(r.status ?? 1);
}
