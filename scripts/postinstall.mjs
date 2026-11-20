// postinstall, two fixes that make a clean clone work:
// 1. node-pty's prebuilt macOS `spawn-helper` can arrive without its execute bit (pnpm's store), and then every
//    terminal fails with "posix_spawnp failed". Restore it.
// 2. Electron 45 no longer downloads its runtime at install time (it waits for first use).
// Download it now, so `pnpm install` is the only step that touches the network. Honours ELECTRON_MIRROR.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..');

if (process.platform === 'darwin') {
  try {
    const pty = realpathSync(join(root, 'node_modules', 'node-pty'));
    for (const d of readdirSync(join(pty, 'prebuilds'))) {
      const helper = join(pty, 'prebuilds', d, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
    const built = join(pty, 'build', 'Release', 'spawn-helper');
    if (existsSync(built)) chmodSync(built, 0o755);
  } catch (e) { console.error('postinstall: could not fix node-pty spawn-helper permissions:', e.message); }
}

const install = join(root, 'node_modules', 'electron', 'install.js');
if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || !existsSync(install)) process.exit(0);
const r = spawnSync(process.execPath, [install], { stdio: 'inherit', cwd: join(root, 'node_modules', 'electron') });
if (r.status !== 0) {
  console.error('\nCould not download the Electron runtime. If github.com is blocked, set ELECTRON_MIRROR (see README, "Locked-down machines") and run `pnpm install` again.');
  process.exit(r.status ?? 1);
}
