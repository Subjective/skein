// Timeline ticks: one per message you sent, all the same length; the one you are reading is dark.
// Hovering lengthens the ticks around the pointer and previews that message with the start of its reply
// (its first prose, or its first step, or Working… while it runs). A click scrolls there.
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
  const box = useRef<HTMLDivElement>(null);
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
  const b = hover >= 0 ? box.current?.children[hover] as HTMLElement | undefined : undefined;
  return (
    <>
      <div className="ticks" ref={box} aria-label="Your messages">{us.map((u, i) => {
        const d = i - hover, w = hover < 0 ? 10 : 10 + 12 * Math.exp(-(d * d) / 2.2);
        return <button key={i} type="button" tabIndex={-1} className={cx(i === on && 'on')} aria-label={clip(u.innerText.trim(), 60)}
          onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}
          onClick={() => scroller.current?.scrollTo({ top: u.offsetTop - 24, behavior: reduced() ? 'auto' : 'smooth' })}><i style={{ width: w.toFixed(1) + 'px' }} /></button>;
      })}</div>
      {hover >= 0 && us[hover] && (
        <div className="tick-pop on" role="tooltip" style={{ top: Math.max(8, (box.current?.offsetTop ?? 0) + (b?.offsetTop ?? 0) - (box.current?.offsetHeight ?? 0) / 2 - 12) }}>
          <b>{clip(us[hover].innerText.replace(/\s+/g, ' ').trim(), 150)}</b>
          {said(us[hover]) && <span>{clip(said(us[hover]), 160)}</span>}
        </div>
      )}
    </>
  );
}
