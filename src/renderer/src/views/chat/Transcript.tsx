// A thread's events as a conversation: your messages as bubbles, each reply as one block of prose,
// tool rows, diffs, plans and requests. Rows the reader treats as one line carry the classes in reader.ts ROWS.
import { openLightbox } from '../../ui/Lightbox';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Density, Harness, StepKind, ThreadEvent, ThreadMeta } from '@shared/types';
import { api } from '../../api';
import { machine, S, toast } from '../../state/store';
import type { IconName } from '../../ui/icons';
import { Button, cx, Icon, IconButton, Spinner } from '../../ui/primitives';
import { harnessName } from '../../shell/meta';
import { Markdown } from './markdown';
import { MOTION, reduced } from '../../ui/motion';
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
  /** How much of the agent's steps a turn shows (Settings, or zr / zm in this view). */
  density: Density;
}

// A step's verb and icon: by its tool's name where the name says more than its kind, else by its kind.
const VERB: Record<string, [string, IconName]> = {
  Write: ['Wrote', 'file'], Glob: ['Listed', 'search'], WebSearch: ['Searched the web', 'globe'], 'Web search': ['Searched the web', 'globe'],
  'Open page': ['Opened', 'globe'], 'View image': ['Viewed', 'image'], Task: ['Started', 'agent'], TodoWrite: ['Planned', 'check'],
};
const KIND: Record<StepKind, [string, IconName]> = {
  read: ['Read', 'file'], search: ['Searched', 'search'], list: ['Listed', 'folder'], command: ['Ran', 'terminal'], web: ['Fetched', 'globe'], mcp: ['', 'plug'], other: ['', 'wrench'],
};
/** Events from before steps had kinds (and the browser samples) name the tool only. */
const kindOf = (e: Ev<'tool'>): StepKind => e.kind ?? ({ Read: 'read', Grep: 'search', Glob: 'search', Bash: 'command', Shell: 'command', WebFetch: 'web', WebSearch: 'web' } as Record<string, StepKind>)[e.name] ?? (/^[^:]+: /.test(e.name) ? 'mcp' : 'other');
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

/** Which folds are open: each has a default (from the density, and whether its work is still going) that the
 *  person can override by opening or closing it. A changed density starts over from its defaults. */
interface Folds { open(key: string, def: boolean): boolean; toggled(key: string, def: boolean, open: boolean): void }
function useFolds(density: Density): Folds {
  const [ov, setOv] = useState<Record<string, boolean>>({});
  useEffect(() => setOv({}), [density]);
  return {
    open: (k, d) => ov[k] ?? d,
    // React's own changes to `open` fire toggle too: those match the default, and leave nothing to remember
    toggled: (k, d, o) => setOv(m => { if ((m[k] ?? d) === o) return m; const n = { ...m }; if (o === d) delete n[k]; else n[k] = o; return n; }),
  };
}

/** A fold: a row whose summary opens what is under it. */
function Fold({ f, k, def, className, src, head, children }: { f: Folds; k: string; def: boolean; className?: string; src?: string; head: ReactNode; children: ReactNode }) {
  return (
    <details className={cx('tool', className)} data-src={src} open={f.open(k, def)} onToggle={e => f.toggled(k, def, e.currentTarget.open)}>
      <summary>{head}<Icon name="chev" className="ch" /></summary>{children}
    </details>
  );
}

function Row({ icon, verb, arg, meta, body, open = false, src, status, f, k }: { icon: IconName; verb: string; arg?: ReactNode; meta?: ReactNode; body?: ReactNode; open?: boolean; src: string; status: 'running' | 'done' | 'failed'; f: Folds; k: string }) {
  const head = <>{status === 'running' ? <Spinner /> : <Icon name={icon} />}<span className="v">{verb}</span>{arg}{meta != null && <span className={cx('meta', status === 'failed' && 'c-del')}>{meta}</span>}</>;
  if (!body) return <div className="tool" data-src={src}><div className="sum">{head}</div></div>;
  return <Fold f={f} k={k} def={open} src={src} head={head}>{body}</Fold>;
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

type Step = Ev<'thinking'> | Ev<'tool'> | Ev<'edit'>;
const isStep = (e: ThreadEvent): e is Step => e.t === 'thinking' || e.t === 'tool' || e.t === 'edit';

/** One step: a thought, a tool call or an edit. An edit's diff starts open only in Detailed. */
function StepRow({ e, c, f }: { e: Step; c: TranscriptCtx; f: Folds }) {
  const src = `${c.src}:${e.id}`, k = e.id;
  if (e.t === 'thinking') return <Row src={src} f={f} k={k} icon="brain" verb="Thought" status="done" body={<div className="prose think-b">{e.text}</div>} />;
  if (e.t === 'edit') return <Row src={src} f={f} k={k} icon="diff" verb="Edited" status={e.status} open={!!e.diff && c.density === 'detailed'}
    arg={<code className="flink" data-p={e.path} title={`Open ${e.path} · g f`}>{e.path}</code>} meta={<><span className="c-add">+{e.add}</span> <span className="c-del">−{e.del}</span></>} body={e.diff ? <Diff text={e.diff} /> : undefined} />;
  const kind = kindOf(e), [verb, icon] = VERB[e.name] || [KIND[kind][0] || e.name, KIND[kind][1]];
  const file = kind === 'read' && !!e.arg;   // a read names a file: its path opens it
  return <Row src={src} f={f} k={k} icon={icon} verb={verb} status={e.status} arg={file ? <code className="flink" data-p={e.arg} title={`Open ${e.arg} · g f`}>{e.arg}</code> : e.arg ? <code>{e.arg}</code> : undefined} meta={e.meta} body={e.out ? <pre className="out">{e.out}</pre> : undefined} />;
}

/** What a run of steps did, weightiest first ("Edited 2 files, read 3 files, ran a command"), and the icon of the first. */
function summary(run: Step[]): { text: string; icon: IconName } {
  const n = { edit: new Set<string>(), read: 0, search: 0, list: 0, command: 0, web: 0, tool: 0, think: 0 };
  for (const e of run) {
    if (e.t === 'edit') n.edit.add(e.path);
    else if (e.t === 'thinking') n.think++;
    else { const k = kindOf(e); if (k === 'mcp' || k === 'other') n.tool++; else n[k]++; }
  }
  const files = (x: number) => `${x} file${x > 1 ? 's' : ''}`, times = (x: number) => (x === 1 ? 'once' : x === 2 ? 'twice' : `${x} times`);
  const parts: [number, string, IconName][] = [
    [n.edit.size, `edited ${files(n.edit.size)}`, 'diff'], [n.read, `read ${files(n.read)}`, 'file'], [n.search, `searched ${times(n.search)}`, 'search'],
    [n.list, `listed ${n.list} folder${n.list > 1 ? 's' : ''}`, 'folder'], [n.command, `ran ${n.command === 1 ? 'a command' : n.command + ' commands'}`, 'terminal'],
    [n.web, `fetched ${n.web === 1 ? 'a page' : n.web + ' pages'}`, 'globe'], [n.tool, `used ${n.tool === 1 ? 'a tool' : n.tool + ' tools'}`, 'wrench'], [n.think, 'thought', 'brain'],
  ];
  const on = parts.filter(p => p[0] > 0), t = on.map(p => p[1]).join(', ');
  return { text: t[0].toUpperCase() + t.slice(1), icon: on[0][2] };
}

/** Steps between two of the agent's notes: one row each when it is a single step, else one row that opens to them. */
function Run({ run, c, f, open }: { run: Step[]; c: TranscriptCtx; f: Folds; open: boolean }) {
  if (run.length === 1) return <StepRow e={run[0]} c={c} f={f} />;
  const sm = summary(run), live = run.some(e => 'status' in e && e.status === 'running');
  return (
    <Fold f={f} k={'run:' + run[0].id} def={open} className="run" src={`${c.src}:${run[0].id}:run`} head={<>{live ? <Spinner /> : <Icon name={sm.icon} />}<span className="v">{sm.text}</span></>}>
      <div className="fold-b">{run.map(e => <StepRow key={e.id} e={e} c={c} f={f} />)}</div>
    </Fold>
  );
}

/** The files a folded turn edited, under its answer, so a shut fold still says what changed. */
function Edited({ edits }: { edits: Ev<'edit'>[] }) {
  const by = new Map<string, { add: number; del: number }>();
  for (const e of edits) { const x = by.get(e.path) || { add: 0, del: 0 }; x.add += e.add; x.del += e.del; by.set(e.path, x); }
  return (
    <div className="tool edited"><div className="sum"><Icon name="diff" /><span className="v">Edited</span>
      {[...by].map(([p, x]) => <span key={p} className="ef"><code className="flink" data-p={p} title={`Open ${p} · g f`}>{p.split(/[\\/]/).pop()}</code><span className="meta"><span className="c-add">+{x.add}</span> <span className="c-del">−{x.del}</span></span></span>)}
    </div></div>
  );
}

/** A long message shows its first lines, fading out, with Show more (as Codex): CLIP px of it, once it is a quarter
 *  taller than that. The choice is kept per message, so it survives the edit box and a remount. */
const CLIP = 280;
const OPEN = new Set<string>();

function UserMsg({ e, c, src }: { e: Ev<'user'>; c: TranscriptCtx; src: string }) {
  const clip = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false), [open, setOpen] = useState(() => OPEN.has(src));
  const shut = long && !open;
  useLayoutEffect(() => {
    const el = clip.current; if (!el) return;
    const measure = () => setLong(el.scrollHeight > CLIP * 1.25);
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, [src, e.text, e.images?.length]);
  // the reader moving onto words below the fold opens the message (j, w, a search), so the cursor is never hidden
  useEffect(() => {
    const el = clip.current; if (!el) return;
    const on = () => { OPEN.add(src); flushSync(() => setOpen(true)); };
    el.addEventListener('skein-open', on); return () => el.removeEventListener('skein-open', on);
  }, [src]);
  const toggle = () => {
    const el = clip.current; if (!el) return;
    const from = el.getBoundingClientRect().height;
    if (!open) {
      OPEN.add(src); flushSync(() => setOpen(true));
      if (!reduced()) el.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${el.scrollHeight}px`, overflow: 'hidden' }], { duration: MOTION.slow, easing: MOTION.ease });
      return;
    }
    const done = () => {
      OPEN.delete(src); flushSync(() => setOpen(false));
      const u = el.closest('.m-user'); if (u && u.getBoundingClientRect().top < 0) u.scrollIntoView({ block: 'start' });
      else el.parentElement?.querySelector('.m-more')?.scrollIntoView({ block: 'nearest' });
    };
    if (reduced()) return done();
    const a = el.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${CLIP}px`, overflow: 'hidden' }], { duration: MOTION.base, easing: MOTION.ease, fill: 'forwards' });
    void a.finished.then(() => { done(); a.cancel(); }, () => {});
  };
  return (
    <div className={cx('m-user', c.onEdit && 'can-edit', long && 'long')} data-user data-ev={e.id} data-src={src} title={c.onEdit ? 'Click to edit and resend' : undefined}
      onClick={ev => { if (!c.onEdit || getSelection()?.toString()) return; if ((ev.target as Element).closest('img, .m-more')) return; c.onEdit(e.id); }}>
      <div ref={clip} className={cx('m-clip', shut && 'shut')}>
        {e.images?.map((u, i) => <img key={i} className="m-img" src={u} alt="" data-zoom onClick={ev => { ev.stopPropagation(); openLightbox(u); }} />)}
        {/* your words as you wrote them: line breaks kept, Markdown (lists, code, bold, links) as in a reply */}
        {e.text && <div className="mt prose" data-md={e.text}><Markdown text={e.text} /></div>}
      </div>
      {long && (
        <button type="button" className="m-more" aria-expanded={open} title={open ? 'Show less' : 'Show the whole message'}
          onClick={ev => { ev.stopPropagation(); toggle(); }}><span>{open ? 'Show less' : 'Show more'}</span><Icon name="down" /></button>
      )}
    </div>
  );
}

/** One event. */
function Event({ e, c, all, f, folded }: { e: ThreadEvent; c: TranscriptCtx; all: ThreadEvent[]; f: Folds; folded?: boolean }): ReactNode {
  const src = `${c.src}:${e.id}`;
  switch (e.t) {
    case 'user':
      if (c.editing === e.id) return <div className="m-edit" data-user key={e.id}>{c.editBox}</div>;
      return <UserMsg e={e} c={c} src={src} />;
    case 'text': {
      return <>
        <div className={cx('m-asst prose', e.streaming && 'streaming')} data-src={src} data-md={e.text}><Markdown text={e.text} /></div>
        {!folded && <SideLinks at={e.id} c={c} />}
      </>;
    }
    case 'thinking': case 'tool': case 'edit': return <StepRow e={e} c={c} f={f} />;
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
    case 'worked': return null;   // the duration heads the turn's work: see Turn
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

/** A run of events as they come, with consecutive subagents as one block. */
function inOrder(list: ThreadEvent[], c: TranscriptCtx, f: Folds, all: ThreadEvent[]): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.t === 'sub') {
      const run: Ev<'sub'>[] = [];
      while (list[i]?.t === 'sub') run.push(list[i++] as Ev<'sub'>);
      i--;
      out.push(<Subagents key={run[0].id} subs={run} c={c} />);
      continue;
    }
    out.push(<Event key={e.id} e={e} c={c} all={all} f={f} />);
  }
  return out;
}

/** One reply. Its work (the agent's notes and steps) sits under "Worked for", a fold at the top; the notes after the
 *  last step are the answer, below it. What needs you or went wrong (requests, errors, subagents, the latest to-do
 *  list, images) stays out of the fold. While the turn runs, the fold is open with its newest run of steps open too;
 *  a run folds when the agent writes its next note, and in Compact the whole turn folds when it ends. */
/** Links to the side chats started from a note. A note in the turn's work shows them below the fold, so they stay in view when it is shut. */
function SideLinks({ at, c }: { at: string; c: TranscriptCtx }) {
  const sides = c.main ? S.threads.filter(t => t.side && t.parent?.id === c.thread.id && t.parent.at === at) : [];
  if (!sides.length) return null;
  return <div className="sc-links">{sides.map(x => <button key={x.id} type="button" className="sc-link" onClick={() => c.onOpenSide?.(x.id)}><Icon name="chat" /><span>{x.title}</span></button>)}</div>;
}

function Turn({ reply, c, f, live, all }: { reply: ThreadEvent[]; c: TranscriptCtx; f: Folds; live: boolean; all: ThreadEvent[] }): ReactNode[] {
  const worked = reply.find((e): e is Ev<'worked'> => e.t === 'worked');
  const evs = reply.filter(e => e.t !== 'worked');
  let last = -1; evs.forEach((e, i) => { if (isStep(e)) last = i; });
  if (last < 0) return inOrder(evs, c, f, all);   // nothing but words: a plain answer
  const lastTodo = evs.filter(e => e.t === 'todo').pop();
  const pinned = (e: ThreadEvent) => e.t === 'sub' || e.t === 'approval' || e.t === 'error' || e.t === 'interrupted' || e.t === 'image' || e === lastTodo;
  const end = live ? evs.length : last + 1;
  const work = evs.slice(0, end).filter(e => !pinned(e) && e.t !== 'todo');
  const nodes: ReactNode[] = [];
  for (let i = 0; i < work.length; i++) {
    const e = work[i];
    if (!isStep(e)) { nodes.push(<Event key={e.id} e={e} c={c} all={all} f={f} folded />); continue; }
    const run: Step[] = [];
    while (work[i] && isStep(work[i])) run.push(work[i++] as Step);
    i--;
    nodes.push(<Run key={'run:' + run[0].id} run={run} c={c} f={f} open={c.density === 'detailed' || (live && i === work.length - 1)} />);
  }
  const k = 'turn:' + evs[0].id, def = live || c.density !== 'compact', open = f.open(k, def);
  const edits = work.filter((e): e is Ev<'edit'> => e.t === 'edit');
  return [
    <Fold key={k} f={f} k={k} def={def} className="turn" src={`${c.src}:${evs[0].id}:turn`} head={<span className="v">{live ? 'Working' : worked ? `Worked for ${dur(worked.ms)}` : 'Worked'}</span>}>
      <div className="fold-b">{nodes}</div>
    </Fold>,
    ...(work.filter(e => e.t === 'text').map(e => <SideLinks key={'sides:' + e.id} at={e.id} c={c} />)),
    ...inOrder(evs.filter(pinned), c, f, all),
    ...inOrder(evs.slice(end).filter(e => !pinned(e)), c, f, all),
    ...(!live && !open && edits.length ? [<Edited key="edited" edits={edits} />] : []),
  ];
}

/** The whole transcript, grouped into your messages and replies. */
export function Transcript({ events, c, running, since }: { events: ThreadEvent[]; c: TranscriptCtx; running: boolean; since: number }) {
  const f = useFolds(c.density);
  // group: a user message, then everything until the next one is its reply
  const groups: { user?: Ev<'user'>; reply: ThreadEvent[] }[] = [];
  for (const e of events) {
    if (e.t === 'user') groups.push({ user: e, reply: [] });
    else { if (!groups.length) groups.push({ reply: [] }); groups[groups.length - 1].reply.push(e); }
  }
  const out: ReactNode[] = [];
  groups.forEach((g, gi) => {
    if (g.user) out.push(<Event key={g.user.id} e={g.user} c={c} all={events} f={f} />);
    const lastGroup = gi === groups.length - 1, live = lastGroup && running, waiting = lastGroup && pending(c.thread.id).length > 0;
    const body = Turn({ reply: g.reply, c, f, live: live || waiting, all: events });   // a turn waiting on your answer is still open
    const streaming = g.reply.some(e => e.t === 'text' && e.streaming);
    if (live && !streaming) body.push(<Live key="live" since={since} />);
    const texts = g.reply.filter((e): e is Ev<'text'> => e.t === 'text');
    if (!live && texts.length && c.main) body.push(<Acts key="acts" c={c} at={texts[texts.length - 1].id} text={texts.map(x => x.text).join('\n\n')} last={lastGroup} when={groups[gi + 1]?.user?.at} />);
    if (body.length) out.push(<div key={'r' + gi} className="reply">{body}</div>);
  });
  return <>{out}</>;
}
