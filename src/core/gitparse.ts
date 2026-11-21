// Pure parsers for git's output. No I/O, so they are tested without a repository.
import type { FileDiff, Hunk } from '../shared/api';

/** C-quoted paths ("a\tb") as git prints them when a name has odd characters. core.quotepath=off keeps UTF-8 as is. */
function unq(s: string): string {
  if (!s.startsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { for (const b of Buffer.from(c, 'utf8')) bytes.push(b); continue; }
    const n = body[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}
const stripPrefix = (p: string) => unq(p.replace(/\t$/, '')).replace(/^[ab]\//, '');
/** "a/x y b/x y": the halves of an unquoted name with spaces are the same path. */
const halves = (s: string) => { const n = (s.length - 1) / 2; return Number.isInteger(n) && s.slice(2, n) === s.slice(n + 3) ? s.slice(n + 3) : s.replace(/^.* b\//, ''); };

/** Parse `git diff` (unified, with --no-prefix off) into files and hunks. */
export function parseDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  let f: FileDiff | null = null, h: Hunk | null = null, a = 0, b = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(l);
      f = { path: m ? stripPrefix(m[2]) : halves(l.slice(11)), status: 'M', add: 0, del: 0, hunks: [] };
      out.push(f); h = null; continue;
    }
    if (!f) continue;
    if (!h) {
      if (l.startsWith('new file mode')) f.status = 'A';
      else if (l.startsWith('deleted file mode')) f.status = 'D';
      else if (l.startsWith('rename from ')) { f.old = unq(l.slice(12)); f.status = 'R'; }
      else if (l.startsWith('copy to ')) f.path = unq(l.slice(8));
      else if (l.startsWith('rename to ')) f.path = unq(l.slice(10));
      else if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) f.binary = true;
      else if (l.startsWith('+++ ') && !l.startsWith('+++ /dev/null')) f.path = stripPrefix(l.slice(4));
      else if (l.startsWith('--- ') && !l.startsWith('--- /dev/null') && f.status === 'D') f.path = stripPrefix(l.slice(4));
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (hm) { a = +hm[1]; b = +hm[3]; h = { a: Math.max(1, a), b: Math.max(1, b), an: hm[2] == null ? 1 : +hm[2], bn: hm[4] == null ? 1 : +hm[4], lines: [] }; f.hunks.push(h); continue; }
    if (!h) continue;
    const c = l[0];
    if (c === '+') { h.lines.push({ k: '+', b: b++, text: l.slice(1) }); f.add++; }
    else if (c === '-') { h.lines.push({ k: '-', a: a++, text: l.slice(1) }); f.del++; }
    else if (c === ' ') h.lines.push({ k: ' ', a: a++, b: b++, text: l.slice(1) });
    else if (c === '\\') { /* "\ No newline at end of file" */ }
    else if (l === '' && i < lines.length - 1) h.lines.push({ k: ' ', a: a++, b: b++, text: '' });
  }
  return out;
}

/** `git diff --numstat -z`-less form: "add\tdel\tpath" lines. Binary files count as 0. */
export function parseNumstat(text: string): { path: string; add: number; del: number }[] {
  return text.split('\n').filter(Boolean).map(l => {
    const [a, d, ...rest] = l.split('\t');
    let p = rest.join('\t');
    const r = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
    if (r) p = (r[1] + r[3] + r[4]).replace(/\/\//g, '/');
    else if (p.includes(' => ')) p = p.split(' => ')[1];
    return { path: unq(p), add: +a || 0, del: +d || 0 };
  });
}

/** A git remote URL as the web page that opens a pull request for `branch`, if the host is a known forge. */
/** A file's page on the forge, at `ref` (a branch or a commit). null for a host it doesn't know. */
export function blobUrl(remote: string, ref: string, path: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return null;
  const [, host, repo] = m, r = ref.split('/').map(encodeURIComponent).join('/'), p = path.split('/').map(encodeURIComponent).join('/');
  if (/github/.test(host)) return `https://${host}/${repo}/blob/${r}/${p}`;
  if (/gitlab/.test(host)) return `https://${host}/${repo}/-/blob/${r}/${p}`;
  if (/bitbucket/.test(host)) return `https://${host}/${repo}/src/${r}/${p}`;
  return null;
}

export function prUrl(remote: string, branch: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return null;
  const [, host, repo] = m, b = encodeURIComponent(branch);
  if (/github/.test(host)) return `https://${host}/${repo}/compare/${b}?expand=1`;
  if (/gitlab/.test(host)) return `https://${host}/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${b}`;
  if (/bitbucket/.test(host)) return `https://${host}/${repo}/pull-requests/new?source=${b}`;
  return null;
}
