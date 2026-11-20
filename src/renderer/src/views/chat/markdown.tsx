// A small Markdown renderer for replies: paragraphs, headings, lists, quotes, fenced code, inline code,
// bold, italics and links. Enough for what agents write; no HTML passes through.
import { Fragment, type ReactNode } from 'react';
import { api } from '../../api';

/** Inline code that names a file (a path with an extension, or a well-known file name) links to it (`.flink`). */
export const isFile = (c: string) => /^[\w.~/-]+\.[a-z][a-z0-9]{0,4}$/i.test(c) && (c.includes('/') || /\.(md|tsx?|jsx?|json|py|rs|go|css|html|toml|ya?ml|sh|txt)$/i.test(c));

function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(⁣[^⁣]*⁣)/g;
  let last = 0, m: RegExpExecArray | null, k = key;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) { const c = t.slice(1, -1); out.push(isFile(c) ? <code key={k++} className="flink" data-p={c} title={`Open ${c} · g f`}>{c}</code> : <code key={k++}>{c}</code>); }
    else if (m[2]) out.push(<b key={k++}>{inline(t.slice(2, -2), k * 100)}</b>);
    else if (m[3]) out.push(<i key={k++}>{inline(t.slice(1, -1), k * 100)}</i>);
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(<a key={k++} href={href} onClick={e => { e.preventDefault(); void api.app.openExternal(href); }}>{label}</a>);
    } else if (m[5]) out.push(<span key={k++} className="qtok">{t}</span>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** For each character `inline` shows, its index in the Markdown it came from (plus one past the end), so a
 *  cursor in a rendered message lands on the same character in the raw text (editing from the reader). */
export function shownToRaw(s: string, base = 0): number[] {
  const out: number[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(⁣[^⁣]*⁣)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    for (let i = last; i < m.index; i++) out.push(base + i);
    const t = m[0], at = base + m.index;
    if (m[1]) for (let i = 1; i < t.length - 1; i++) out.push(at + i);
    else if (m[2]) out.push(...shownToRaw(t.slice(2, -2), at + 2).slice(0, -1));
    else if (m[3]) out.push(...shownToRaw(t.slice(1, -1), at + 1).slice(0, -1));
    else if (m[4]) { const label = /^\[([^\]]+)\]/.exec(t)![1]; out.push(...shownToRaw(label, at + 1).slice(0, -1)); }
    else for (let i = 0; i < t.length; i++) out.push(at + i);
    last = m.index + t.length;
  }
  for (let i = last; i < s.length; i++) out.push(base + i);
  out.push(base + s.length);
  return out;
}

/** Inline Markdown only (your own messages). */
export const Inline = ({ text }: { text: string }) => <>{inline(text)}</>;

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0, k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = /^```(\w*)/.exec(l);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} className="out code">{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) { const H = (`h${h[1].length + 2}`) as 'h3'; blocks.push(<H key={k++}>{inline(h[2])}</H>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l), items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={k++}>{items.map((x, j) => <li key={j}>{inline(x)}</li>)}</L>);
      continue;
    }
    if (l.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k++}>{inline(q.join(' '))}</blockquote>);
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>|\s*([-*]|\d+\.)\s)/.test(lines[i])) p.push(lines[i++]);
    blocks.push(<p key={k++}>{p.map((x, j) => <Fragment key={j}>{j > 0 && <br />}{inline(x)}</Fragment>)}</p>);
  }
  return <>{blocks}</>;
}
