// CI: start the built app, wait for the window to render the sidebar, fail on any renderer error.
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const bin = join(root, 'node_modules', 'electron', 'dist', readFileSync(join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const p = spawn(bin, ['--no-sandbox', '--remote-debugging-port=0', root], { env: { ...process.env, SKEIN_LAUNCH_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
p.stdout.on('data', d => { out += d; });
p.stderr.on('data', d => { out += d; });
const t = setTimeout(() => { p.kill(); console.error('no "skein: ready" within 40s\n' + out); process.exit(1); }, 40000);
const check = setInterval(() => {
  if (/skein: renderer error/.test(out)) { clearTimeout(t); clearInterval(check); p.kill(); console.error(out); process.exit(1); }
  if (/skein: ready/.test(out)) { clearTimeout(t); clearInterval(check); p.kill(); console.log('launched OK'); process.exit(0); }
}, 200);
