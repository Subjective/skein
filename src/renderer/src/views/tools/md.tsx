// A small Markdown renderer for previews: headings, lists, quotes, fenced code, rules, paragraphs, and inline
// code, bold, italic and links. React elements only (no HTML strings), so file text can never inject markup.
import type { ReactNode } from 'react';
import { api } from '../../api';
import { tokenizeAll, langOf } from './highlight';

function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let i = 0, m: RegExpExecArray | null, k = key;
  while ((m = re.exec(s))) {
    if (m.index > i) out.push(s.slice(i, m.index));
    if (m[2] != null) out.push(<code key={k++}>{m[2]}</code>);
    else if (m[3] != null || m[4] != null) out.push(<b key={k++}>{inline(m[3] ?? m[4], k * 100)}</b>);
    else if (m[5] != null || m[6] != null) out.push(<em key={k++}>{inline(m[5] ?? m[6], k * 100)}</em>);
    else if (m[7] != null) {
      const href = m[8];
      out.push(/^https?:\/\//.test(href)
        ? <a key={k++} href={href} onClick={e => { e.preventDefault(); void api.app.openExternal(href); }}>{inline(m[7], k * 100)}</a>
        : <span key={k++} className="mlink">{inline(m[7], k * 100)}</span>);
    }
    i = re.lastIndex;
  }
  if (i < s.length) out.push(s.slice(i));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let list: { t: 'ul' | 'ol'; items: string[] } | null = null, para: string[] = [], quote: string[] = [];
  let k = 0;
  const flush = () => {
    if (para.length) { out.push(<p key={k++}>{inline(para.join(' '))}</p>); para = []; }
    if (list) { const L = list.t; out.push(<L key={k++}>{list.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</L>); list = null; }
    if (quote.length) { out.push(<blockquote key={k++}>{inline(quote.join(' '))}</blockquote>); quote = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if ((m = /^\s*(```|~~~)\s*([\w+-]*)/.exec(l))) {
      flush();
      const fence = m[1], body: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence)) body.push(lines[i]);
      const lang = langOf('x.' + (m[2] || 'txt'));
      const toks = tokenizeAll(body, lang);
      out.push(<pre key={k++} className="code"><code>{toks.map((ts, j) => <div key={j}>{ts.length ? ts.map(([c, t], n) => <span key={n} className={c || undefined}>{t}</span>) : ' '}</div>)}</code></pre>);
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(l))) {
      flush();
      const H = `h${Math.min(3, m[1].length)}` as 'h1' | 'h2' | 'h3';
      out.push(<H key={k++}>{inline(m[2])}</H>);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push(<hr key={k++} />); }
    else if ((m = /^\s*(?:[-*+]|(\d+)[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l))) {
      const t = m[1] ? 'ol' : 'ul';
      if (para.length || quote.length || (list && list.t !== t)) flush();
      if (!list) list = { t, items: [] };
      list.items.push(m[2]);
    } else if ((m = /^>\s?(.*)$/.exec(l))) { if (para.length || list) flush(); quote.push(m[1]); }
    else if (!l.trim()) flush();
    else if (list && /^\s{2,}\S/.test(l)) list.items[list.items.length - 1] += ' ' + l.trim();
    else { if (list || quote.length) flush(); para.push(l.trim()); }
  }
  flush();
  return <>{out}</>;
}
