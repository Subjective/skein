// A small Markdown renderer for replies: paragraphs, headings, lists, quotes, fenced code, GFM pipe tables, inline
// code, bold, italics and links. Enough for what agents write; no HTML passes through.
import { Fragment, memo, type ReactNode } from 'react';
import { Icon } from '../../ui/primitives';

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
      // no href: Electron must not navigate. The transcript follows it (ChatView: a click, enter or g x on it)
      out.push(<a key={k++} className="clink" data-href={href} title={href}>{inline(label, k * 100)}</a>);
    } else if (m[5]) out.push(<span key={k++} className="qtok"><Icon name="chat" />{t.replace(/^⁣(\u2003\u2009)?|⁣$/g, '')}</span>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** GFM pipe tables: a header row, a separator row (---, :--, --:, :-:), then rows while lines hold a pipe. */
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (l: string) => {
  const t = l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return t.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
};
const isTable = (lines: string[], i: number) => i + 1 < lines.length && lines[i].includes('|') && SEP.test(lines[i + 1]) && lines[i + 1].includes('-');

/** Each block carries the source lines it came from (`data-ml="first-last"`, 0-based, inclusive; a list item its
 *  own line, a fenced block its fences too) so a linewise yank can copy the Markdown, not the rendering. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const ml = (a: number, b: number) => `${a}-${b}`;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0, k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = /^```(\w*)/.exec(l);
    if (fence) {
      const body: string[] = [], a = i; i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} className="out code" data-ml={ml(a, Math.min(i, lines.length) - 1)} data-fence>{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) { const H = (`h${h[1].length + 2}`) as 'h3'; blocks.push(<H key={k++} data-ml={ml(i, i)}>{inline(h[2])}</H>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l), items: string[] = [], a = i;
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={k++}>{items.map((x, j) => <li key={j} data-ml={ml(a + j, a + j)}>{inline(x)}</li>)}</L>);
      continue;
    }
    if (isTable(lines, i)) {   // while a reply streams, the header stays a paragraph until its separator row arrives
      const a = i, head = cells(lines[i]), align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
      i += 2;
      const rows: { cs: string[]; at: number }[] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push({ cs: cells(lines[i]), at: i }); i++; }
      const td = (c: string | undefined, j: number, H: 'th' | 'td') => <H key={j} style={align[j] ? { textAlign: align[j] } : undefined}>{inline(c ?? '')}</H>;
      blocks.push(
        <div key={k++} className="tbl" data-ml={ml(a, i - 1)}>
          <table>
            <thead><tr data-ml={ml(a, a + 1)}>{head.map((c, j) => td(c, j, 'th'))}</tr></thead>
            {rows.length > 0 && <tbody>{rows.map(r => <tr key={r.at} data-ml={ml(r.at, r.at)}>{head.map((_, j) => td(r.cs[j], j, 'td'))}</tr>)}</tbody>}
          </table>
        </div>,
      );
      continue;
    }
    if (l.startsWith('>')) {
      const q: string[] = [], a = i;
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k++} data-ml={ml(a, i - 1)}>{inline(q.join(' '))}</blockquote>);
      continue;
    }
    const p: string[] = [], a = i;
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>|\s*([-*]|\d+\.)\s)/.test(lines[i]) && !(p.length && isTable(lines, i))) p.push(lines[i++]);
    blocks.push(<p key={k++} data-ml={ml(a, i - 1)}>{p.map((x, j) => <Fragment key={j}>{j > 0 && <br />}{inline(x)}</Fragment>)}</p>);
  }
  return <>{blocks}</>;
});

/** The Markdown source behind the part of a rendered message (`el`, rendered by Markdown from `md`) that `range`
 *  covers, in whole source lines: bullets, numbers, emphasis, links and code fences as written. A code block
 *  the range covers only partly gives its fences and the lines covered. Null when the range covers no block. */
export function rawLines(el: Element, md: string, range: Range): string | null {
  const raw = md.replace(/\r\n/g, '\n').split('\n'), keep = new Set<number>();
  for (const b of el.querySelectorAll<HTMLElement>('[data-ml]')) {
    if (!range.intersectsNode(b)) continue;
    const [a, z] = b.dataset.ml!.split('-').map(Number);
    if (b.hasAttribute('data-fence')) {   // the fences, and the body lines the range covers
      const line = (n: Node, o: number) => { const r = document.createRange(); r.selectNodeContents(b); r.setEnd(n, o); return r.toString().split('\n').length - 1; };
      const closed = z > a && !!raw[z]?.startsWith('```'), last = Math.max(0, z - a - (closed ? 2 : 1));
      const i0 = b.contains(range.startContainer) ? line(range.startContainer, range.startOffset) : 0;
      const i1 = b.contains(range.endContainer) ? line(range.endContainer, range.endOffset) : last;
      keep.add(a); if (closed) keep.add(z);
      for (let j = i0; j <= Math.min(i1, last); j++) keep.add(a + 1 + j);
    } else for (let j = a; j <= z; j++) keep.add(j);
  }
  if (!keep.size) return null;
  const lo = Math.min(...keep), hi = Math.max(...keep), out: string[] = [];
  for (let j = lo; j <= hi; j++) if (keep.has(j) || !raw[j]?.trim()) out.push(raw[j] ?? '');
  return out.join('\n');
}

/** The offset in `md` (the source of `el`, rendered by Markdown) of the rendered point (`node`, `off`): the block
 *  the point is in gives its first source line, and the rendered text before the point is matched char by char
 *  against the source from there, passing over what the source has and the page doesn't (marks, bullets, pipes,
 *  line breaks). */
export function rawAt(el: Element, md: string, node: Node, off: number): number {
  const src = md.replace(/\r\n/g, '\n');
  const blk = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>('[data-ml]');
  const host = blk && el.contains(blk) ? blk : el;
  const [a, z] = (host as HTMLElement).dataset?.ml ? (host as HTMLElement).dataset.ml!.split('-').map(Number) : [0, Infinity];
  const starts = [0]; for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  let j = starts[Math.min(a, starts.length - 1)];
  const end = z + 1 < starts.length ? starts[z + 1] - 1 : src.length;
  const r = document.createRange(); r.selectNodeContents(host);
  if (host.contains(node)) r.setEnd(node, off);
  if (host.hasAttribute('data-fence')) j = Math.min(end, src.indexOf('\n', j) + 1 || end);   // past the opening fence
  for (const ch of r.toString()) {
    let k = j; while (k < end && src[k] !== ch) k++;
    if (k < end) j = k + 1;
  }
  // rest on the character the page shows at the point, past marks just before it
  const rest = document.createRange(); rest.selectNodeContents(host);
  if (host.contains(node)) rest.setStart(node, off);
  const next = rest.toString()[0];
  if (next) { let k = j; while (k < end && src[k] !== next) k++; if (k < end) j = k; }
  return Math.min(j, src.length);
}
