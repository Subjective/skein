// Where a link in a Markdown preview goes. A web or mail link opens outside Skein; `#heading` scrolls this
// file's preview; anything else is a path relative to the file (or, with a leading /, to its folder's root),
// which opens as a file, at a heading (`#name`) or a line (`#L12`). Other schemes go nowhere.

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; slug: string }
  | { kind: 'file'; path: string; slug?: string; line?: number }
  | { kind: 'none' };

const EXTERNAL = /^(https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** A heading's id as GitHub writes it: lower case, punctuation dropped, spaces as dashes. */
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Ids for a file's headings in order, numbered as GitHub does when one repeats (`setup`, `setup-1`). */
export function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const s = slug(text), n = seen.get(s);
    seen.set(s, (n ?? -1) + 1);
    return n == null ? s : `${s}-${n + 1}`;
  };
}

/** `a/./b/../c` as `a/c`. A path that climbs above the root keeps its leading `..`. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** Resolve `href` written in the file at `from` (a path relative to the folder the tab shows). */
export function linkTarget(href: string, from: string): LinkTarget {
  const h = href.trim();
  if (!h) return { kind: 'none' };
  if (EXTERNAL.test(h)) return { kind: 'external', url: h };
  if (SCHEME.test(h) || h.startsWith('//')) return { kind: 'none' };
  const hash = h.indexOf('#');
  const pathPart = (hash < 0 ? h : h.slice(0, hash)).replace(/\?.*$/, '');
  const frag = hash < 0 ? '' : decode(h.slice(hash + 1));
  if (!pathPart) return frag ? { kind: 'anchor', slug: frag.toLowerCase() } : { kind: 'none' };
  const base = pathPart.startsWith('/') ? '' : from.includes('/') ? from.replace(/\/[^/]*$/, '') : '';
  const path = normalize((base ? base + '/' : '') + decode(pathPart));
  if (!path) return { kind: 'none' };
  const ln = /^L(\d+)(?:-L?\d+)?$/.exec(frag);
  return ln ? { kind: 'file', path, line: +ln[1] } : frag ? { kind: 'file', path, slug: frag.toLowerCase() } : { kind: 'file', path };
}
