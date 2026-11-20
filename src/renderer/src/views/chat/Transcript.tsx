// A thread's events as a conversation: your messages as bubbles, each reply as one block of prose,
// tool rows, diffs, plans and requests. Rows the reader treats as one line carry the classes in reader.ts ROWS.
import { openLightbox } from '../../ui/Lightbox';
import { useEffect, useState, type ReactNode } from 'react';
import type { Harness, ThreadEvent, ThreadMeta } from '@shared/types';
import { api } from '../../api';
import { machine, S, toast } from '../../state/store';
import { Button, cx, Icon, IconButton, Spinner } from '../../ui/primitives';
import { harnessName } from '../../shell/meta';
import { Inline, Markdown } from './markdown';
import { INSTALL } from './options';
import { answer, pending, plain } from './state';

type Ev<T extends ThreadEvent['t']> = Extract<ThreadEvent, { t: T }>;

export interface TranscriptCtx {
  thread: ThreadMeta;
  /** a prefix for data-src keys: 'ev:<thread>' or 'sub:<id>' */
  src: string;
  /** main transcript of a thread (not a subagent's) */
  main: boolean;
  editing?: string;
  editBox?: ReactNode;
  onEdit?(eventId: string): void;
  onSide?(eventId: string): void;
  onFork?(eventId: string): void;
  onOpenSub?(subId: string): void;
  onOpenSide?(threadId: string): void;
  onFix?(e: Ev<'error'>): void;
}

const VERB: Record<string, [string, string]> = {
  Read: ['Read', 'file'], Edit: ['Edited', 'diff'], MultiEdit: ['Edited', 'diff'], Write: ['Wrote', 'file'], Bash: ['Ran', 'terminal'],
  Grep: ['Searched', 'search'], Glob: ['Listed', 'search'], WebFetch: ['Fetched', 'globe'], WebSearch: ['Searched the web', 'globe'],
  Task: ['Started', 'agent'], TodoWrite: ['Planned', 'check'], shell: ['Ran', 'terminal'], exec: ['Ran', 'terminal'],
};
export const dur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
export const ago = (t: number) => { const m = (Date.now() - t) / 60000; return m < 1 ? 'now' : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/** Unified diff text to numbered lines. */
function Diff({ text }: { text: string }) {
  const rows: { k: string; n: number | ''; c: string }[] = [];
  let a = 1, b = 1;   // a hunk header resets these; a bare body (a new file's lines) counts from 1
  for (const l of text.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { a = +h[1]; b = +h[2]; continue; }
    if (/^(diff |index |--- |\+\+\+ )/.test(l)) continue;
    const k = l[0] === '+' ? '+' : l[0] === '-' ? '-' : ' ';
    rows.push({ k, n: k === '-' ? a : b, c: l.slice(1) });
    if (k !== '+') a++; if (k !== '-') b++;
  }
  return <div className="diff">{rows.map((r, i) => <div key={i} className={cx('dl', r.k === '+' && 'add', r.k === '-' && 'del')}><span className="n">{r.n}</span><span className="c">{r.c}</span></div>)}</div>;
}

function Row({ icon, verb, arg, meta, body, open, src, status }: { icon: string; verb: string; arg?: ReactNode; meta?: ReactNode; body?: ReactNode; open?: boolean; src: string; status: 'running' | 'done' | 'failed' }) {
  const head = <>{status === 'running' ? <Spinner /> : <Icon name={icon} />}<span className="v">{verb}</span>{arg}{meta != null && <span className={cx('meta', status === 'failed' && 'c-del')}>{meta}</span>}</>;
  if (!body) return <div className="tool" data-src={src}><div className="sum">{head}</div></div>;
  return <details className="tool" data-src={src} open={open}><summary>{head}<Icon name="chev" className="ch" /></summary>{body}</details>;
}

function Approval({ e, thread, count }: { e: Ev<'approval'>; thread: ThreadMeta; count: number }) {
  const r = e.request, plan = r.kind === 'plan';
  const opts = [...r.options].reverse();   // the main answer last, on the right
  return (
    <div className={cx('appr', plan && 'plan')} data-src={`appr:${e.id}`} role="group" aria-label={r.title}>
      <div className="ah"><Icon name={plan ? 'file' : 'shield'} /><span>{r.title}</span>{r.from && <span className="dim">{r.from}</span>}
        {count > 1 && <><span className="sp" /><span className="count" title="Requests waiting: y and n answer the oldest first">1 of {count}</span></>}</div>
      {plan ? <div className="prose plan-body"><Markdown text={r.body} /></div> : <pre className="out">{r.body}</pre>}
      {r.detail && <div className="dim why">{r.detail}</div>}
      <div className="af">{opts.map((o, i) => (
        <Button key={o.id} small variant={o.primary ? 'primary' : i === 0 ? 'ghost' : 'default'} onClick={() => answer(thread.id, r.requestId, o.id)}>{o.label}</Button>
      ))}</div>
    </div>
  );
}

const ERR: Record<Ev<'error'>['kind'], { act?: string; icon: string }> = {
  crash: { act: 'Restart', icon: 'alert' }, rate: { act: 'Retry now', icon: 'alert' }, auth: { act: 'Sign in', icon: 'alert' },
  missing: { act: 'Copy install command', icon: 'alert' }, other: { icon: 'alert' },
};
export function errorText(e: Ev<'error'>, h: Harness, m?: string) {
  if (e.text) return e.text;
  const n = harnessName(h);
  return { crash: `${n} stopped unexpectedly`, rate: 'Rate limit reached', auth: `Signed out of ${n}${m ? ' on ' + m : ''}`, missing: `${n} isn't installed${m ? ' on ' + m : ''}`, other: 'Something went wrong' }[e.kind];
}
export function fixError(th: ThreadMeta, e: Ev<'error'>, signIn: () => void) {
  if (e.kind === 'crash' || e.kind === 'rate') void api.chat.send(th.id, { text: '', retry: true });
  else if (e.kind === 'auth') signIn();
  else if (e.kind === 'missing') { void navigator.clipboard?.writeText(INSTALL[th.harness]).then(() => toast(`Copied ${INSTALL[th.harness]}`, { icon: 'copy' })).catch(() => toast(INSTALL[th.harness])); }
}

/** The status line at the end of a running turn. */
function Live({ since, text }: { since: number; text?: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, []);
  return <div className="live" role="status"><Spinner /><span>{text || 'Working'}</span><span className="dim">{dur(Date.now() - since)}</span></div>;
}

/** One event. */
function Event({ e, c, all }: { e: ThreadEvent; c: TranscriptCtx; all: ThreadEvent[] }): ReactNode {
  const src = `${c.src}:${e.id}`;
  switch (e.t) {
    case 'user':
      if (c.editing === e.id) return <div className="m-edit" data-user key={e.id}>{c.editBox}</div>;
      return (
        <div className={cx('m-user', c.onEdit && 'can-edit')} data-user data-ev={e.id} data-src={src} title={c.onEdit ? 'Click to edit and resend' : undefined}
          onClick={ev => { if (!c.onEdit || getSelection()?.toString()) return; if ((ev.target as Element).closest('img')) return; c.onEdit(e.id); }}>
          {e.images?.map((u, i) => <img key={i} className="m-img" src={u} alt="" data-zoom onClick={ev => { ev.stopPropagation(); openLightbox(u); }} />)}
          {e.text && <div className="mt"><Inline text={e.text} /></div>}
        </div>
      );
    case 'text': {
      const sides = c.main ? S.threads.filter(t => t.side && t.parent?.id === c.thread.id && t.parent.at === e.id) : [];
      return <>
        <div className={cx('m-asst prose', e.streaming && 'streaming')} data-src={src}><Markdown text={e.text} /></div>
        {sides.length > 0 && <div className="sc-links">{sides.map(x => <button key={x.id} type="button" className="sc-link" onClick={() => c.onOpenSide?.(x.id)}><Icon name="chat" /><span>{x.title}</span></button>)}</div>}
      </>;
    }
    case 'thinking': return <Row src={src} icon="bolt" verb="Thought" status="done" body={<div className="prose think-b">{e.text}</div>} />;
    case 'tool': {
      const [verb, icon] = VERB[e.name] || [e.name, 'bolt'];
      const body = e.out ? <pre className="out">{e.out}</pre> : undefined;
      const file = e.name === 'Read' && !!e.arg;   // a Read names a file: its path opens it
      return <Row src={src} icon={icon} verb={verb} status={e.status} arg={file ? <code className="flink" data-p={e.arg} title={`Open ${e.arg} · g f`}>{e.arg}</code> : <code>{e.arg}</code>} meta={e.meta} body={body} />;
    }
    case 'edit':
      return <Row src={src} icon="diff" verb="Edited" status={e.status} open={!!e.diff}
        arg={<code className="flink" data-p={e.path} title={`Open ${e.path} · g f`}>{e.path}</code>} meta={<><span className="c-add">+{e.add}</span> <span className="c-del">−{e.del}</span></>} body={e.diff ? <Diff text={e.diff} /> : undefined} />;
    case 'todo':
      return <div className="todo" data-src={src}>{e.items.map((it, i) => {
        const now = !it.done && e.items.findIndex(x => !x.done) === i;
        return <div key={i} className={cx('ti', it.done ? 'is-done' : now ? 'is-now' : 'is-todo')}><span className="box">{it.done && <Icon name="check" />}</span>{it.text}</div>;
      })}</div>;
    case 'image': return <figure className="m-fig" data-src={src}><img src={e.src} alt="" data-zoom onClick={() => openLightbox(e.src)} />{e.cap && <figcaption>{e.cap}</figcaption>}</figure>;
    case 'approval': {
      const p = pending(c.thread.id);
      if (p[0]?.id !== e.id) return null;   // one card: the oldest; y / n answer it
      return <Approval e={e} thread={c.thread} count={p.length} />;
    }
    case 'error': {
      const x = ERR[e.kind];
      return (
        <div className={cx('err-row', x.act && 'kbrow')} data-src={src} role="alert"><Icon name={x.icon} /><span>{errorText(e, c.thread.harness, machine(c.thread.machine)?.name)}</span>
          {x.act && <><span className="sp" /><Button small onClick={() => c.onFix?.(e)}>{x.act}</Button></>}</div>
      );
    }
    case 'notice': return <div className="err-row info" data-src={src} role="status"><Icon name="layers" /><span>{e.text}</span></div>;
    case 'interrupted': return <div className="note-row" data-src={src}><Icon name="stop" /><span>Interrupted</span></div>;
    case 'worked': return <div className="worked" data-src={src}>Worked for {dur(e.ms)} <Icon name="chev" /></div>;
    case 'sub': return null;   // grouped: see Subagents
  }
}

/** Subagents a turn started: one row each, a click opens its transcript (in INSERT, to message it). */
function Subagents({ subs, c }: { subs: Ev<'sub'>[]; c: TranscriptCtx }) {
  const run = subs.filter(g => g.status === 'running').length;
  return (
    <details className="tool agents" open data-src={`${c.src}:${subs[0].id}:agents`}>
      <summary><Icon name="agent" /><span className="v">Subagents</span><span className="meta">{run ? `${run} running · ` : ''}{subs.length - run} done</span><Icon name="chev" className="ch" /></summary>
      <div className="ag-list">{subs.map(g => (
        <button key={g.id} type="button" className="ag" onClick={() => c.onOpenSub?.(g.id)}>
          {g.status === 'running' ? <Spinner /> : <Icon name={g.status === 'failed' ? 'alert' : 'check'} />}<b>{g.name}</b><span className="at">{g.task}</span>{g.dur && <span className="dim">{g.dur}</span>}
        </button>
      ))}</div>
    </details>
  );
}

/** Copy, fork and side chat, under the last reply of each finished turn. */
function Acts({ c, at, text, last, when }: { c: TranscriptCtx; at: string; text: string; last: boolean; when?: number }) {
  return (
    <div className={cx('m-acts', !last && 'old')}>
      <IconButton small icon="copy" label="Copy" onClick={() => void navigator.clipboard?.writeText(plain(text)).then(() => toast('Copied', { icon: 'copy' }), () => {})} />
      {c.onFork && <IconButton small icon="branch" label="Fork into a new thread" onClick={() => c.onFork!(at)} />}
      {c.onSide && <IconButton small icon="chat" label="Side chat about this reply" keys="mod-shift-s" onClick={() => c.onSide!(at)} />}
      {(last || when != null) && <span className="dim">{ago(last ? c.thread.updatedAt : when!)}</span>}
    </div>
  );
}

/** The whole transcript, grouped into your messages and replies. */
export function Transcript({ events, c, running, since }: { events: ThreadEvent[]; c: TranscriptCtx; running: boolean; since: number }) {
  // group: a user message, then everything until the next one is its reply
  const groups: { user?: Ev<'user'>; reply: ThreadEvent[] }[] = [];
  for (const e of events) {
    if (e.t === 'user') groups.push({ user: e, reply: [] });
    else { if (!groups.length) groups.push({ reply: [] }); groups[groups.length - 1].reply.push(e); }
  }
  const out: ReactNode[] = [];
  groups.forEach((g, gi) => {
    if (g.user) out.push(<Event key={g.user.id} e={g.user} c={c} all={events} />);
    const lastGroup = gi === groups.length - 1;
    const body: ReactNode[] = [];
    for (let i = 0; i < g.reply.length; i++) {
      const e = g.reply[i];
      if (e.t === 'sub') {
        const run: Ev<'sub'>[] = [];
        while (g.reply[i]?.t === 'sub') run.push(g.reply[i++] as Ev<'sub'>);
        i--;
        body.push(<Subagents key={run[0].id} subs={run} c={c} />);
        continue;
      }
      body.push(<Event key={e.id} e={e} c={c} all={events} />);
    }
    const streaming = g.reply.some(e => e.t === 'text' && e.streaming);
    if (lastGroup && running && !streaming) body.push(<Live key="live" since={since} />);
    const texts = g.reply.filter((e): e is Ev<'text'> => e.t === 'text');
    const done = !lastGroup || !running;
    if (done && texts.length && c.main) body.push(<Acts key="acts" c={c} at={texts[texts.length - 1].id} text={texts.map(x => x.text).join('\n\n')} last={lastGroup} when={groups[gi + 1]?.user?.at} />);
    if (body.length) out.push(<div key={'r' + gi} className="reply">{body}</div>);
  });
  return <>{out}</>;
}
