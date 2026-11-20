// CI smoke test: load node-pty inside Electron's own Node (ELECTRON_RUN_AS_NODE=1) and run a command in a pty.
// Proves the native module works with this Electron on this OS, which unit tests under plain Node cannot.
const pty = require('node-pty');
const win = process.platform === 'win32';
const p = pty.spawn(win ? 'powershell.exe' : 'sh', win ? ['-NoProfile', '-Command', 'echo skein-ok'] : ['-c', 'echo skein-ok'], { cols: 80, rows: 24 });
let out = '';
p.onData(d => { out += d; });
const t = setTimeout(() => { console.error('timeout; output so far:', JSON.stringify(out)); process.exit(1); }, 20000);
p.onExit(({ exitCode }) => {
  clearTimeout(t);
  if (!out.includes('skein-ok')) { console.error('pty ran but printed', JSON.stringify(out)); process.exit(1); }
  console.log(`node-pty OK in Electron ${process.versions.electron} (node ${process.versions.node}), exit ${exitCode}`);
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync(':memory:').exec('create table t(a)');
  console.log('node:sqlite OK');
  process.exit(0);
});
