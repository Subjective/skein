// Vendors the file-type icons Skein uses from Catppuccin's icon set (@iconify-json/catppuccin, MIT) into
// src/renderer/src/ui/fileIcons.gen.ts, so the app ships only the ~90 icons it maps and fetches nothing at runtime.
// Re-run after changing the maps below or upgrading the package:  node scripts/gen-file-icons.mjs
//
// The package draws each icon with Catppuccin Macchiato hex colours. Each colour becomes a theme token
// (var(--ci-blue) and so on, defined in styles/skein.css), set to Mocha under the dark theme and Latte under the
// light one. Text and overlay greys map to Skein's own --fg tokens so plain files and folders stay neutral.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@iconify-json/catppuccin/package.json'));
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const info = JSON.parse(readFileSync(join(pkgDir, 'info.json'), 'utf8'));
const set = JSON.parse(readFileSync(join(pkgDir, 'icons.json'), 'utf8'));
if (pkg.license !== 'MIT' || info.license?.spdx !== 'MIT') throw new Error(`unexpected license: ${pkg.license} / ${info.license?.spdx}`);

// exact file names (lower case) first, then compound extensions (d.ts, test.ts), then the last extension
const BY_NAME = {
  'package.json': 'package-json', 'package-lock.json': 'npm-lock', 'pnpm-lock.yaml': 'pnpm-lock', 'pnpm-workspace.yaml': 'pnpm',
  'yarn.lock': 'yarn-lock', 'bun.lockb': 'bun-lock', 'bun.lock': 'bun-lock', 'cargo.toml': 'cargo', 'cargo.lock': 'cargo-lock', 'go.mod': 'go-mod', 'go.sum': 'go-mod',
  'dockerfile': 'docker', 'containerfile': 'docker', '.dockerignore': 'docker-ignore', 'docker-compose.yml': 'docker-compose', 'docker-compose.yaml': 'docker-compose', 'compose.yml': 'docker-compose', 'compose.yaml': 'docker-compose',
  'makefile': 'makefile', 'gnumakefile': 'makefile', 'justfile': 'just',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git', '.npmrc': 'npm', '.npmignore': 'npm-ignore', '.editorconfig': 'editorconfig',
  '.prettierrc': 'prettier', '.prettierignore': 'prettier-ignore', '.eslintrc': 'eslint', '.eslintignore': 'eslint-ignore', '.nvmrc': 'config',
  '.bashrc': 'bash', '.bash_profile': 'bash', '.zshrc': 'bash', '.zprofile': 'bash', '.profile': 'bash', 'vimrc': 'vim', '.vimrc': 'vim', '.envrc': 'envrc',
  'tsconfig.json': 'typescript-config', 'jsconfig.json': 'javascript-config',
  'readme': 'readme', 'readme.md': 'readme', 'license': 'license', 'license.md': 'license', 'license.txt': 'license', 'copying': 'license',
  'changelog': 'changelog', 'changelog.md': 'changelog', 'agents.md': 'markdown', 'claude.md': 'markdown', 'favicon.ico': 'favicon', 'robots.txt': 'robots',
};
const BY_PATTERN = [   // [regex on the lower-case base name, icon]: for names with variable parts
  [/^tsconfig\..*\.json$/, 'typescript-config'], [/^vite\.config\./, 'vite'], [/^vitest\.config\./, 'vitest'], [/^electron\.vite\.config\./, 'vite'],
  [/^\.env(\.|$)/, 'env'], [/^\.eslintrc\./, 'eslint'], [/^eslint\.config\./, 'eslint'], [/^\.prettierrc\./, 'prettier'], [/^dockerfile\./, 'docker'],
  [/\.d\.[mc]?ts$/, 'typescript-def'], [/\.(test|spec)\.[mc]?tsx?$/, 'typescript-test'], [/\.(test|spec)\.[mc]?jsx?$/, 'javascript-test'],
];
const BY_EXT = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript-react', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript-react',
  json: 'json', jsonc: 'json', json5: 'json', md: 'markdown', markdown: 'markdown', mdx: 'markdown-mdx',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'batch', cmd: 'batch',
  py: 'python', pyi: 'python', pyc: 'python-compiled', ipynb: 'jupyter', rs: 'rust', go: 'go', java: 'java', jar: 'java-jar', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c-header', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp-header', hh: 'cpp-header', cs: 'csharp', rb: 'ruby', php: 'php', lua: 'lua', zig: 'zig', dart: 'dart',
  html: 'html', htm: 'html', css: 'css', scss: 'sass', sass: 'sass', less: 'less', vue: 'vue', svelte: 'svelte', astro: 'astro', graphql: 'graphql', gql: 'graphql',
  xml: 'xml', plist: 'xml', xaml: 'xaml', svg: 'svg', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'config', cfg: 'config', conf: 'config', properties: 'properties', env: 'env',
  lock: 'lock', txt: 'text', log: 'log', csv: 'csv', tsv: 'csv', sql: 'database', db: 'database', sqlite: 'database', prisma: 'prisma', proto: 'proto', vim: 'vim', nix: 'nix',
  diff: 'diff', patch: 'diff', pem: 'certificate', crt: 'certificate', key: 'key', tf: 'terraform',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image', heic: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', mp4: 'video', mov: 'video', webm: 'video', mkv: 'video',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', pdf: 'pdf', zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', bz2: 'zip', xz: 'zip', '7z': 'zip', rar: 'zip',
  exe: 'exe', dll: 'binary', so: 'binary', dylib: 'binary', bin: 'binary', wasm: 'web-assembly', doc: 'ms-word', docx: 'ms-word', xls: 'ms-excel', xlsx: 'ms-excel', ppt: 'ms-powerpoint', pptx: 'ms-powerpoint',
};
// folders by name (lower case); each also needs its "-open" variant
const DIRS = {
  src: 'folder-src', source: 'folder-src', lib: 'folder-lib', docs: 'folder-docs', doc: 'folder-docs', test: 'folder-tests', tests: 'folder-tests', __tests__: 'folder-tests', spec: 'folder-tests',
  scripts: 'folder-scripts', bin: 'folder-command', '.git': 'folder-git', '.github': 'folder-github', node_modules: 'folder-node', public: 'folder-public', assets: 'folder-assets', static: 'folder-public',
  dist: 'folder-dist', out: 'folder-dist', build: 'folder-dist', config: 'folder-config', '.config': 'folder-config', components: 'folder-components', styles: 'folder-styles', css: 'folder-styles',
  types: 'folder-types', '@types': 'folder-types', images: 'folder-images', img: 'folder-images', icons: 'folder-images', utils: 'folder-utils', '.vscode': 'folder-vscode', hooks: 'folder-hooks',
  shared: 'folder-shared', server: 'folder-server', api: 'folder-api', packages: 'folder-packages', mocks: 'folder-mocks', fixtures: 'folder-mocks', '.devcontainer': 'folder-devcontainer',
};
const BASE = ['file', 'folder', 'folder-open'];

// Catppuccin Macchiato (what the package ships) -> token names
const TOKENS = {
  '#cad3f5': 'text', '#8087a2': 'overlay', '#f4dbd6': 'rosewater', '#f0c6c6': 'flamingo', '#f5bde6': 'pink', '#c6a0f6': 'mauve', '#ed8796': 'red', '#ee99a0': 'maroon',
  '#f5a97f': 'peach', '#eed49f': 'yellow', '#a6da95': 'green', '#8bd5ca': 'teal', '#91d7e3': 'sky', '#7dc4e4': 'sapphire', '#8aadf4': 'blue', '#b7bdf8': 'lavender',
};

const names = [...new Set([...BASE, ...Object.values(BY_NAME), ...BY_PATTERN.map(p => p[1]), ...Object.values(BY_EXT), ...Object.values(DIRS), ...Object.values(DIRS).map(d => d + '-open')])].sort();
const icons = {};
for (const n of names) {
  const ic = set.icons[n] || (set.aliases?.[n] && set.icons[set.aliases[n].parent]);
  if (!ic) throw new Error(`no icon "${n}" in @iconify-json/catppuccin ${pkg.version}`);
  if (ic.width || ic.height || ic.left || ic.top) throw new Error(`"${n}" is not on the 16x16 grid`);
  if (/style=/.test(ic.body)) throw new Error(`"${n}" has its own style attribute`);
  icons[n] = ic.body.replace(/\s(stroke|fill)="(#[0-9a-fA-F]{3,8})"/g, (m, attr, hex) => {
    const t = TOKENS[hex.toLowerCase()];
    if (!t) throw new Error(`"${n}" uses ${hex}, which has no theme token`);
    return ` style="${attr}:var(--ci-${t})"`;
  });
}

const lit = o => JSON.stringify(o, null, 0).replace(/","/g, '", "');
const out = `// GENERATED by scripts/gen-file-icons.mjs from @iconify-json/catppuccin ${pkg.version}. Do not edit; re-run the script.
//
// Catppuccin Icons, https://github.com/catppuccin/vscode-icons
// MIT License. Copyright (c) 2021 Catppuccin
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
// copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
// SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
//
// Each icon is the inner markup of a 16x16 svg; colours are var(--ci-*) tokens (styles/skein.css).

/** Inner svg markup by icon name, viewBox 0 0 16 16. */
export const ICONS: Record<string, string> = {
${names.map(n => `  ${JSON.stringify(n)}: ${JSON.stringify(icons[n])},`).join('\n')}
};

/** Lower-case exact file name -> icon. */
export const BY_NAME: Record<string, string> = ${lit(BY_NAME)};

/** Lower-case base name pattern -> icon, tried after BY_NAME. */
export const BY_PATTERN: [RegExp, string][] = [${BY_PATTERN.map(([r, n]) => `[${r}, ${JSON.stringify(n)}]`).join(', ')}];

/** Lower-case last extension -> icon. */
export const BY_EXT: Record<string, string> = ${lit(BY_EXT)};

/** Lower-case folder name -> closed folder icon (the open one adds "-open"). */
export const DIRS: Record<string, string> = ${lit(DIRS)};
`;
const dest = join(root, 'src/renderer/src/ui/fileIcons.gen.ts');
writeFileSync(dest, out);
console.log(`wrote ${names.length} icons to ${dest}`);
