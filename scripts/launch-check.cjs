// CI: start the built app, wait for the window to render the sidebar, fail on any renderer error.
// The app reports through stdout and a file (stdout from a GUI process is unreliable on Windows).
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const root = join(__dirname, '..');
const bin = join(root, 'node_modules', 'electron', 'dist', readFileSync(join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const dir = mkdtempSync(join(tmpdir(), 'skein-launch-'));
const file = join(dir, 'result.txt');
const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${join(dir, 'profile')}`, root];
const p = spawn(bin, args, { env: { ...process.env, SKEIN_LAUNCH_CHECK: '1', SKEIN_LAUNCH_CHECK_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
p.stdout.on('data', d => { out += d; });
p.stderr.on('data', d => { out += d; });
const all = () => out + (existsSync(file) ? readFileSync(file, 'utf8') : '');
const end = (code, msg) => { clearTimeout(t); clearInterval(check); p.kill(); (code ? console.error : console.log)(msg); process.exit(code); };
const t = setTimeout(() => end(1, 'no "skein: ready" within 60s\n' + all()), 60000);
const check = setInterval(() => {
  const s = all();
  if (/skein: renderer error/.test(s)) end(1, s);
  else if (/skein: ready/.test(s)) end(0, 'launched OK');
}, 250);
p.on('exit', c => setTimeout(() => end(1, `app exited (${c}) before it was ready\n` + all()), 500));
