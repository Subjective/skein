// Where a link in a reply goes. Agents write web links and links to files: a path relative to the thread's
// folder, an absolute path (often inside it), a file:// URL, with a line as `#L12`, `#L12C3` or `:12[:3]`.
// A web or mail link opens outside Skein; a file opens in Skein's file view (or, for what it cannot show as
// text, the system's default app). Other schemes go nowhere.
import { normalize } from '../tools/mdlinks';

export type ChatLink =
  | { kind: 'external'; url: string }
  /** `path` is relative to `dir` (forward slashes); `dir` is the thread's folder unless the file is outside it. */
  | { kind: 'file'; dir: string; path: string; line?: number; col?: number }
  | { kind: 'none' };

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Files Skein's file view does not show as text: on this computer they open in the system's default app. */
export const OS_OPENS = /\.(html?|pdf|png|jpe?g|gif|webp|bmp|ico|heic|mp4|mov|webm|mp3|wav|zip|docx?|xlsx?|pptx?)$/i;

export function chatLink(href: string, dir: string): ChatLink {
  let h = href.trim().replace(/^<(.*)>$/, '$1');
  if (!h) return { kind: 'none' };
  if (/^(https?:|mailto:)/i.test(h)) return { kind: 'external', url: h };
  if (/^file:/i.test(h)) {
    try { const u = new URL(h); h = decode(u.pathname).replace(/^\/([a-z]:)/i, '$1') + u.hash; } catch { return { kind: 'none' }; }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(h) || h.startsWith('//')) return { kind: 'none' };   // a scheme (not a drive letter)
  let line: number | undefined, col: number | undefined;
  const hash = h.indexOf('#');
  if (hash >= 0) {
    const m = /^L(\d+)(?:C(\d+))?(?:-L?\d+)?$/i.exec(h.slice(hash + 1));
    if (m) { line = +m[1]; col = m[2] ? +m[2] : undefined; }
    h = h.slice(0, hash);
  }
  h = decode(h.replace(/\?.*$/, '')).replace(/\\/g, '/');
  const lc = /^(.*?):(\d+)(?::(\d+))?$/.exec(h);
  if (lc && lc[1] && !/^[a-z]$/i.test(lc[1])) { h = lc[1]; line ??= +lc[2]; col ??= lc[3] ? +lc[3] : undefined; }
  if (!h) return { kind: 'none' };
  const at = { ...(line ? { line } : {}), ...(col ? { col } : {}) };
  const root = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (h.startsWith('/') || h.startsWith('~') || /^[a-z]:\//i.test(h)) {
    const win = /^[a-z]:\//i.test(h), inRoot = root && (win ? h.toLowerCase().startsWith(root.toLowerCase() + '/') : h.startsWith(root + '/'));
    const rel = inRoot ? normalize(h.slice(root.length + 1)) : '';
    if (rel) return { kind: 'file', dir, path: rel, ...at };
    const cut = h.replace(/\/+$/, '').lastIndexOf('/');
    if (cut < 0) return { kind: 'none' };
    return { kind: 'file', dir: h.slice(0, cut) || '/', path: h.slice(cut + 1).replace(/\/+$/, ''), ...at };
  }
  const path = normalize(h);
  return path ? { kind: 'file', dir, path, ...at } : { kind: 'none' };
}
