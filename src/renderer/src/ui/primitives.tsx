// The component library's small pieces. Every surface uses these instead of writing its own markup,
// so look and behaviour stay one thing. Classes come from styles/skein.css (the mockup's stylesheet).
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { kb } from '../input/platform';
import type { IconName } from './icons';

const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');
export { cx };

export function Icon({ name, size, className }: { name: IconName | string; size?: 'sm' | 'hm' | 'xl'; className?: string }) {
  return <svg className={cx('i', size, `i-${name}`, className)} aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** Icon-only button. `label` is its accessible name and tooltip; `keys` adds the shortcut to the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, BtnProps & { icon: IconName | string; label: string; keys?: string; small?: boolean; on?: boolean }>(
  function IconButton({ icon, label, keys, small, on, className, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={cx('ib', small && 'sm', on && 'on', className)} aria-label={label} title={keys ? `${label} · ${kb(keys)}` : label} {...rest}>
        <Icon name={icon} />
      </button>
    );
  });

export const Button = forwardRef<HTMLButtonElement, BtnProps & { variant?: 'primary' | 'ghost' | 'default'; small?: boolean; icon?: IconName | string }>(
  function Button({ variant = 'default', small, icon, className, children, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={cx('btn', variant !== 'default' && variant, small && 'sm', className)} {...rest}>
        {icon && <Icon name={icon} />}{children}
      </button>
    );
  });

/** A pill that opens a picker: icon, label, chevron. */
export const Chip = forwardRef<HTMLButtonElement, BtnProps & { icon?: IconName | string; label: ReactNode; caret?: boolean; on?: boolean; title?: string }>(
  function Chip({ icon, label, caret, on, className, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={cx('chip', on && 'on', className)} {...rest}>
        {icon && <Icon name={icon} />}<span>{label}</span>{caret && <Icon name="down" size="sm" />}
      </button>
    );
  });

/** Two or more icon toggles in a well (chat | terminal). */
export function Seg<T extends string>({ value, options, onChange, label, mark }: {
  value: T; options: { v: T; icon: IconName | string; label: string }[]; onChange: (v: T) => void; label: string; mark?: T | null;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.v} type="button" className={cx(value === o.v && 'on', mark === o.v && 'drv')} aria-pressed={value === o.v} title={o.label} aria-label={o.label}
          onMouseDown={e => e.preventDefault()} onClick={() => onChange(o.v)}>
          <Icon name={o.icon} />
        </button>
      ))}
    </div>
  );
}

export const Spinner = ({ label = 'Working' }: { label?: string }) => <span className="spin" role="img" aria-label={label} title={label} />;
export const Dot = ({ color, pulse, label }: { color: 'green' | 'amber' | 'red' | 'blue' | 'off'; pulse?: boolean; label?: string }) =>
  <span className={cx('dot', color, pulse && 'pulse')} role={label ? 'img' : undefined} aria-label={label} title={label} />;
export const Kbd = ({ k }: { k: string }) => <kbd>{kb(k)}</kbd>;
export const Switch = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) =>
  <button type="button" role="switch" aria-checked={on} aria-label={label} className="sw-btn" onClick={() => onChange(!on)}><span className={cx('sw', on && 'on')} /></button>;

/** The round send button at the end of a composer; a square stops a running turn. */
export const SendButton = ({ stop, label, ...rest }: BtnProps & { stop?: boolean; label?: string }) => (
  <button type="button" className={cx('send', stop && 'stop')} aria-label={label || (stop ? 'Stop' : 'Send')} title={label || (stop ? 'Stop' : 'Send')} {...rest}>
    {stop ? <span className="sq" /> : <Icon name="up" />}
  </button>
);
