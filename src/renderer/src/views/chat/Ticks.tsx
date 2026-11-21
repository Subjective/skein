// Timeline ticks: one per message you sent, all the same length; the one you are reading is dark.
// Hovering (as in Cursor) lengthens and darkens the ticks around the pointer, most at the one under it and less
// with each tick away, about three on each side, following the pointer smoothly; it previews that message with the start of its reply
// (its first prose, or its first step, or Working… while it runs). A click scrolls there.
// In a long thread the rail is as tall as the pane allows and scrolls (as in Codex): the wheel scrolls it, the tick
// of the message you are reading stays in view as you move, and an end with more ticks past it fades out.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../../ui/primitives';
import { reduced } from '../../ui/motion';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const said = (u: Element) => {
  const r = u.nextElementSibling, rep = r?.matches('.reply') ? r : null;
  const first = rep && (rep.querySelector('.m-asst') || rep.querySelector('.tool, .live, .err-row'));
  if (first) return ((first.querySelector(':scope > summary') || first) as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
  return rep ? '' : 'Working…';
};

export function Ticks({ scroller, version }: { scroller: React.RefObject<HTMLDivElement | null>; version: unknown }) {
  const [us, setUs] = useState<HTMLElement[]>([]);
  const [on, setOn] = useState(0);
  const [hover, setHover] = useState(-1);
  /** Where the pointer is along the ticks, in ticks (fractional, so the falloff glides between them); -1 = away. */
  const [at, setAt] = useState(-1);
  const posOf = (y: number) => {
    const bs = box.current?.children; if (!bs?.length) return -1;
    const first = (bs[0] as HTMLElement).getBoundingClientRect(), pitch = first.height || 9;
    return Math.max(0, Math.min(bs.length - 1, (y - first.top - pitch / 2) / pitch));
  };
  const track = (e: React.MouseEvent) => { if (scrub.current) return; const f = posOf(e.clientY); setAt(f); setHover(Math.round(f)); };
  const go = (i: number, smooth: boolean) => { const u = us[i]; if (u) scroller.current?.scrollTo({ top: u.offsetTop - 24, behavior: smooth && !reduced() ? 'smooth' : 'auto' }); };
  // press and drag along the ticks to scrub: the thread follows the message under the pointer; release stays there
  const scrub = useRef(false);
  const press = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    scrub.current = true; document.body.classList.add('scrubbing');
    let last = -1;
    const mv = (ev: MouseEvent) => {
      const f = posOf(ev.clientY), i = Math.round(f);
      setAt(f); setHover(i);
      if (i !== last) { last = i; go(i, false); show(i); }
    };
    const up = (ev: MouseEvent) => {
      scrub.current = false; document.body.classList.remove('scrubbing');
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
      const r = box.current?.getBoundingClientRect();
      if (!r || ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) { setAt(-1); setHover(-1); }
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
    mv(e.nativeEvent);
  };
  const box = useRef<HTMLDivElement>(null);
  /** Which ends of the rail have ticks scrolled past them (they fade). */
  const [ends, setEnds] = useState({ up: false, down: false });
  const edges = () => { const el = box.current; if (!el) return; const up = el.scrollTop > 1, down = el.scrollTop + el.clientHeight < el.scrollHeight - 1; setEnds(e => (e.up === up && e.down === down ? e : { up, down })); };
  /** Scroll the rail just enough to show tick i, with a tick of room past it. */
  const show = (i: number) => {
    const el = box.current, t = el?.children[i] as HTMLElement | undefined; if (!el || !t) return;
    const pad = t.offsetHeight * 2;
    if (t.offsetTop - pad < el.scrollTop) el.scrollTop = t.offsetTop - pad;
    else if (t.offsetTop + t.offsetHeight + pad > el.scrollTop + el.clientHeight) el.scrollTop = t.offsetTop + t.offsetHeight + pad - el.clientHeight;
  };
  useLayoutEffect(() => { if (!scrub.current) show(on); edges(); }, [on, us]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(edges); ro.observe(el);
    return () => ro.disconnect();
  }, [us.length >= 2]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { setUs([...(scroller.current?.querySelectorAll<HTMLElement>('[data-user]') ?? [])]); }, [version, scroller]);
  useEffect(() => {
    const th = scroller.current; if (!th) return;
    const f = () => {
      const y = th.scrollTop + th.clientHeight * 0.4;
      let lo = 0; for (let i = 0; i < us.length; i++) if (us[i].offsetTop <= y) lo = i;
      setOn(lo);
    };
    f(); th.addEventListener('scroll', f, { passive: true });
    return () => th.removeEventListener('scroll', f);
  }, [us, scroller]);
  if (us.length < 2) return null;
  // the preview beside the tick under the pointer, wherever the rail is scrolled
  const popTop = (t?: HTMLElement) => { const host = box.current?.offsetParent; if (!t || !host) return 0; return t.getBoundingClientRect().top - host.getBoundingClientRect().top - 12; };
  const b = hover >= 0 ? box.current?.children[hover] as HTMLElement | undefined : undefined;
  return (
    <>
      <div className={cx('ticks', ends.up && 'fade-up', ends.down && 'fade-down')} ref={box} aria-label="Your messages" onScroll={edges} onMouseMove={track} onMouseDown={press} onMouseLeave={() => { if (!scrub.current) { setAt(-1); setHover(-1); } }}>{us.map((u, i) => {
        const d = i - at, w = at < 0 ? 0 : Math.exp(-(d * d) / 3.5);
        return <button key={i} type="button" tabIndex={-1} className={cx(i === on && 'on')} aria-label={clip(u.innerText.trim(), 60)} style={{ '--w': w.toFixed(3) } as React.CSSProperties}><i /></button>;
      })}</div>
      {hover >= 0 && us[hover] && (
        <div className="tick-pop on" role="tooltip" style={{ top: Math.max(8, popTop(b)) }}>
          <b>{clip(us[hover].innerText.replace(/\s+/g, ' ').trim(), 150)}</b>
          {said(us[hover]) && <span>{clip(said(us[hover]), 160)}</span>}
        </div>
      )}
    </>
  );
}
