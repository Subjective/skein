// Languages and a small syntax highlighter for diffs and open files. A line at a time, with only the state a
// block comment or a multi-line string needs carried over, so a diff line colours the same as in its file.
// Token classes are the mockup's: sx-k keyword, sx-s string, sx-n number, sx-c comment, sx-t type, sx-f call.

export interface Lang { badge: string; cls: string; name: string; kw?: RegExp; line?: string; block?: [string, string]; hash?: boolean; md?: boolean }

const JS_KW = /^(import|from|export|default|const|let|var|function|async|await|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|delete|type|interface|enum|class|extends|implements|typeof|instanceof|keyof|of|in|as|satisfies|true|false|null|undefined|void|this|super|yield|static|public|private|protected|readonly|declare|namespace|abstract)$/;
const PY_KW = /^(def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|assert|del|async|await|True|False|None|self|match|case)$/;
const GO_KW = /^(package|import|func|return|if|else|for|range|switch|case|default|break|continue|go|defer|select|chan|map|struct|interface|type|var|const|nil|true|false|make|new|len|append)$/;
const RS_KW = /^(fn|let|mut|pub|use|mod|crate|self|Self|super|struct|enum|impl|trait|for|in|if|else|match|while|loop|return|break|continue|as|where|move|ref|async|await|dyn|const|static|unsafe|type|true|false|Some|None|Ok|Err)$/;
const SH_KW = /^(if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|exit|export|local|readonly|set|unset|source|echo|cd)$/;
const PS_KW = /^(function|param|if|else|elseif|foreach|for|while|do|switch|return|try|catch|finally|throw|begin|process|end|in|true|false|null)$/i;
const SQL_KW = /^(select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|index|on|join|left|right|inner|outer|group|by|order|limit|offset|having|as|null|is|in|exists|primary|key|references|alter|drop|distinct|union|all|case|when|then|else|end|default|returning|with)$/i;
const C_KW = /^(int|char|float|double|long|short|unsigned|signed|void|bool|auto|const|static|extern|struct|union|enum|typedef|sizeof|return|if|else|for|while|do|switch|case|default|break|continue|goto|class|public|private|protected|virtual|override|namespace|using|template|typename|new|delete|nullptr|true|false|this|include|define|import|package|final|extends|implements|var|val|fun|let|func|String)$/;
const CONF_KW = /^(true|false|null|yes|no|on|off)$/;

const L = (badge: string, cls: string, name: string, o: Partial<Lang> = {}): Lang => ({ badge, cls, name, ...o });
const js = (b: string, n: string) => L(b, 'ts', n, { kw: JS_KW, line: '//', block: ['/*', '*/'] });
const BY_EXT: Record<string, Lang> = {
  ts: js('TS', 'TypeScript'), tsx: js('TSX', 'TypeScript'), mts: js('TS', 'TypeScript'), cts: js('TS', 'TypeScript'),
  js: { ...js('JS', 'JavaScript'), cls: 'js' }, jsx: { ...js('JSX', 'JavaScript'), cls: 'js' }, mjs: { ...js('JS', 'JavaScript'), cls: 'js' }, cjs: { ...js('JS', 'JavaScript'), cls: 'js' },
  json: L('{ }', 'json', 'JSON', { kw: CONF_KW }), jsonc: L('{ }', 'json', 'JSON', { kw: CONF_KW, line: '//', block: ['/*', '*/'] }),
  css: L('CSS', 'css', 'CSS', { block: ['/*', '*/'] }), scss: L('SCSS', 'css', 'SCSS', { line: '//', block: ['/*', '*/'] }), less: L('LESS', 'css', 'Less', { line: '//', block: ['/*', '*/'] }),
  html: L('HTML', 'css', 'HTML', { block: ['<!--', '-->'] }), xml: L('XML', 'css', 'XML', { block: ['<!--', '-->'] }), svg: L('SVG', 'css', 'SVG', { block: ['<!--', '-->'] }),
  md: L('MD', 'md', 'Markdown', { md: true }), mdx: L('MDX', 'md', 'Markdown', { md: true }),
  py: L('PY', 'sql', 'Python', { kw: PY_KW, hash: true }), go: L('GO', 'ts', 'Go', { kw: GO_KW, line: '//', block: ['/*', '*/'] }),
  rs: L('RS', 'css', 'Rust', { kw: RS_KW, line: '//', block: ['/*', '*/'] }),
  sh: L('SH', 'sql', 'Shell', { kw: SH_KW, hash: true }), bash: L('SH', 'sql', 'Shell', { kw: SH_KW, hash: true }), zsh: L('SH', 'sql', 'Shell', { kw: SH_KW, hash: true }),
  ps1: L('PS', 'ts', 'PowerShell', { kw: PS_KW, hash: true, block: ['<#', '#>'] }), psm1: L('PS', 'ts', 'PowerShell', { kw: PS_KW, hash: true, block: ['<#', '#>'] }),
  sql: L('SQL', 'sql', 'SQL', { kw: SQL_KW, line: '--', block: ['/*', '*/'] }),
  yaml: L('YML', 'json', 'YAML', { kw: CONF_KW, hash: true }), yml: L('YML', 'json', 'YAML', { kw: CONF_KW, hash: true }), toml: L('TOML', 'json', 'TOML', { kw: CONF_KW, hash: true }),
  ini: L('INI', 'json', 'INI', { hash: true }), env: L('ENV', 'json', 'Env', { hash: true }),
  c: L('C', 'ts', 'C', { kw: C_KW, line: '//', block: ['/*', '*/'] }), h: L('H', 'ts', 'C', { kw: C_KW, line: '//', block: ['/*', '*/'] }),
  cpp: L('C++', 'ts', 'C++', { kw: C_KW, line: '//', block: ['/*', '*/'] }), hpp: L('H++', 'ts', 'C++', { kw: C_KW, line: '//', block: ['/*', '*/'] }),
  cs: L('C#', 'ts', 'C#', { kw: C_KW, line: '//', block: ['/*', '*/'] }), java: L('JAVA', 'ts', 'Java', { kw: C_KW, line: '//', block: ['/*', '*/'] }),
  kt: L('KT', 'ts', 'Kotlin', { kw: C_KW, line: '//', block: ['/*', '*/'] }), swift: L('SW', 'ts', 'Swift', { kw: C_KW, line: '//', block: ['/*', '*/'] }),
  rb: L('RB', 'sql', 'Ruby', { kw: PY_KW, hash: true }), lua: L('LUA', 'ts', 'Lua', { kw: JS_KW, line: '--' }),
  vim: L('VIM', 'sql', 'Vim script', { line: '"' }),
};
const BY_NAME: Record<string, string> = { dockerfile: 'sh', makefile: 'sh', '.bashrc': 'sh', '.zshrc': 'sh', '.profile': 'sh', '.gitignore': 'ini', '.npmrc': 'ini', '.editorconfig': 'ini', vimrc: 'vim', '.vimrc': 'vim' };
const PLAIN: Lang = { badge: '', cls: '', name: 'Plain text' };

export const baseName = (p: string) => p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
export function langOf(path: string): Lang {
  const n = baseName(path).toLowerCase();
  if (BY_NAME[n]) return BY_EXT[BY_NAME[n]];
  if (n.startsWith('.env')) return BY_EXT.env;
  const ext = n.includes('.') ? n.split('.').pop()! : '';
  return BY_EXT[ext] || PLAIN;
}

export type Tok = [cls: string, text: string];
/** Carried from one line to the next: inside a block comment, or a template string. */
export type HlState = '' | 'block' | 'tpl';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reCache = new Map<Lang, RegExp>();
function tokenRe(l: Lang): RegExp {
  let r = reCache.get(l);
  if (r) return r;
  const parts = [
    l.line ? `(${esc(l.line)}.*$)` : l.hash ? '(#.*$)' : '(\\u0000never)',
    l.block ? `(${esc(l.block[0])})` : '(\\u0000never)',
    `("(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|\`)`,
    '(\\b\\d[\\d_.xXa-fA-FeEn]*\\b)',
    '([A-Za-z_$@][\\w$-]*)',
  ];
  r = new RegExp(parts.join('|'), 'g'); reCache.set(l, r);
  return r;
}

/** Split one line into tokens. Returns the state for the next line. */
export function tokenize(line: string, l: Lang, state: HlState = ''): { toks: Tok[]; state: HlState } {
  const toks: Tok[] = [];
  const push = (c: string, t: string) => { if (!t) return; const last = toks[toks.length - 1]; if (last && last[0] === c) last[1] += t; else toks.push([c, t]); };
  if (!l.kw && !l.line && !l.block && !l.hash) { push('', line); return { toks, state: '' }; }
  let i = 0;
  if (state === 'block' && l.block) {
    const e = line.indexOf(l.block[1]);
    if (e < 0) { push('sx-c', line); return { toks, state }; }
    push('sx-c', line.slice(0, e + l.block[1].length)); i = e + l.block[1].length; state = '';
  }
  if (state === 'tpl') {
    const e = line.indexOf('`');
    if (e < 0) { push('sx-s', line); return { toks, state }; }
    push('sx-s', line.slice(0, e + 1)); i = e + 1; state = '';
  }
  const re = tokenRe(l); re.lastIndex = i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > i) push('', line.slice(i, m.index));
    const [x, cm, bl, st, nu, id] = m;
    if (cm) push('sx-c', x);
    else if (bl && l.block) {
      const e = line.indexOf(l.block[1], m.index + bl.length);
      if (e < 0) { push('sx-c', line.slice(m.index)); return { toks, state: 'block' }; }
      push('sx-c', line.slice(m.index, e + l.block[1].length)); re.lastIndex = e + l.block[1].length;
    } else if (st === '`') {
      const e = line.indexOf('`', m.index + 1);
      if (e < 0) { push('sx-s', line.slice(m.index)); return { toks, state: 'tpl' }; }
      push('sx-s', line.slice(m.index, e + 1)); re.lastIndex = e + 1;
    } else if (st) push(l.cls === 'json' && /^\s*:/.test(line.slice(m.index + x.length)) ? 'sx-t' : 'sx-s', x);
    else if (nu) push('sx-n', x);
    else if (id) {
      const after = line[m.index + x.length];
      push(l.kw?.test(id) ? 'sx-k' : after === '(' ? 'sx-f' : /^[A-Z][a-z]/.test(id) && l.kw ? 'sx-t' : '', x);
    } else push('', x);
    i = re.lastIndex;
    if (x === '') re.lastIndex++;
  }
  if (i < line.length) push('', line.slice(i));
  return { toks, state: '' };
}

/** Tokens for every line of a text, carrying state across lines. */
export function tokenizeAll(text: string[], l: Lang): Tok[][] {
  let st: HlState = '';
  return text.map(line => { const r = tokenize(line, l, st); st = r.state; return r.toks; });
}

/** The indent unit of a text (2, 4, or a tab), for indent guides. */
export function indentUnit(lines: string[]): number {
  let tabs = 0; const n: Record<number, number> = {};
  for (const l of lines.slice(0, 2000)) {
    if (l.startsWith('\t')) { tabs++; continue; }
    const s = /^ +/.exec(l)?.[0].length; if (s) n[s] = (n[s] || 0) + 1;
  }
  if (tabs > (n[2] || 0) + (n[4] || 0)) return 1;
  const two = Object.entries(n).filter(([k]) => +k % 4 === 2).reduce((a, [, c]) => a + c, 0);
  return two > 0 ? 2 : 4;
}
