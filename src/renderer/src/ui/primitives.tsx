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

/** A pill that opens a picker: icon, label, chevron. The label goes in one span (`lbl` gives it a class, such as
 *  `lbl`, which narrow panes hide); `raw` puts the label in as given, for a label made of its own spans. */
export const Chip = forwardRef<HTMLButtonElement, BtnProps & { icon?: IconName | string; label: ReactNode; lbl?: string; raw?: boolean; caret?: boolean; on?: boolean; title?: string }>(
  function Chip({ icon, label, lbl, raw, caret, on, className, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={cx('chip', on && 'on', className)} {...rest}>
        {icon && <Icon name={icon} />}{raw ? label : <span className={lbl}>{label}</span>}{caret && <Icon name="down" size="sm" />}
      </button>
    );
  });

/** Two or more toggles in a well (chat | terminal). Icons, or words when `text` (Preview | Source). */
export function Seg<T extends string>({ value, options, onChange, label, mark, text }: {
  value: T; options: { v: T; icon?: IconName | string; label: string }[]; onChange: (v: T) => void; label: string; mark?: T | null; text?: boolean;
}) {
  return (
    <div className={cx('seg', text && 'txt')} role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.v} type="button" className={cx(value === o.v && 'on', mark === o.v && 'drv')} aria-pressed={value === o.v} title={o.label} aria-label={o.label}
          onMouseDown={e => e.preventDefault()} onClick={() => onChange(o.v)}>
          {text || !o.icon ? o.label : <Icon name={o.icon} />}
        </button>
      ))}
    </div>
  );
}

export const Spinner = ({ label = 'Working' }: { label?: string }) => <span className="spin" role="img" aria-label={label} title={label} />;
export const Dot = ({ color, pulse, label }: { color: 'green' | 'amber' | 'red' | 'blue' | 'off'; pulse?: boolean; label?: string }) =>
  <span className={cx('dot', color, pulse && 'pulse')} role={label ? 'img' : undefined} aria-label={label} title={label} />;
export const Kbd = ({ k }: { k: string }) => <kbd>{kb(k)}</kbd>;
/** A switch; `large` is the Settings size (34 x 20, the mockup's .swb), the default the composer's small one. */
export const Switch = ({ on, onChange, label, large }: { on: boolean; onChange: (v: boolean) => void; label: string; large?: boolean }) =>
  <button type="button" role="switch" aria-checked={on} aria-label={label} className={large ? 'swb' : 'sw-btn'} onClick={() => onChange(!on)}><span className={cx('sw', on && 'on')} /></button>;

/** A tri-state box (stage a file, select all). `on` 'mix' draws a dash. */
export const Checkbox = ({ on, onChange, label, className }: { on: boolean | 'mix'; onChange: (v: boolean) => void; label: string; className?: string }) => (
  <button type="button" role="checkbox" aria-checked={on === 'mix' ? 'mixed' : on} aria-label={label} title={label} className={cx('cb', on === 'mix' ? 'mix' : on && 'on', className)}
    onMouseDown={e => e.preventDefault()} onClick={e => { e.stopPropagation(); onChange(on !== true); }}>
    {on === true && <Icon name="check" />}
  </button>
);

/** A primary action with a caret for its other forms (Commit | Commit & push ...). */
/** `menuDisabled` defaults to `disabled`; a menu with an action that needs nothing (Create branch) stays open to it. */
/** A primary action with a menu of related ones, drawn as one button in every state: both halves primary when the
 *  action can run; both secondary, the action's label dimmed, when only the menu can (with `reason` on hover); both
 *  dimmed when neither can. The menu half stays keyboard reachable whenever it is enabled. */
export function SplitButton({ label, onClick, onMenu, menuLabel, disabled, menuDisabled = disabled, keys, reason }: { label: ReactNode; onClick: () => void; onMenu: (anchor: DOMRect) => void; menuLabel: string; disabled?: boolean; menuDisabled?: boolean; keys?: string; /** why the action cannot run now */ reason?: string }) {
  const part = disabled && !menuDisabled, kind = disabled ? 'btn sm' : 'btn primary sm';
  const tip = disabled ? reason : keys ? (typeof label === 'string' ? `${label} · ${kb(keys)}` : kb(keys)) : undefined;
  return (
    <span className={cx('split', part && 'part', disabled && menuDisabled && 'off')} title={disabled ? reason : undefined}>
      <button type="button" className={kind} disabled={disabled} aria-disabled={disabled || undefined} title={tip} onMouseDown={e => e.preventDefault()} onClick={onClick}>{label}</button>
      <button type="button" className={cx(kind, 'caret')} disabled={menuDisabled} aria-haspopup="menu" aria-label={menuLabel} title={menuLabel}
        onMouseDown={e => e.preventDefault()} onClick={e => onMenu(e.currentTarget.parentElement!.getBoundingClientRect())}><Icon name="down" size="sm" /></button>
    </span>
  );
}

/** The round send button at the end of a composer; a square stops a running turn. `armed`: the first esc of a
 *  running turn's esc esc was pressed, so it shows "Esc" until the second one stops the turn (or the window ends). */
export const SendButton = ({ stop, armed, play, label, ...rest }: BtnProps & { stop?: boolean; armed?: boolean; /** continue a stopped turn */ play?: boolean; label?: string }) => {
  const name = label || (armed ? 'Press Esc again to stop' : stop || armed ? 'Stop' : play ? 'Continue the stopped turn' : 'Send');
  return (
    <button type="button" className={cx('send', (stop || armed) && 'stop', armed && 'armed')} aria-label={name} title={name} {...rest}>
      {armed ? <span className="esc">Esc</span> : stop ? <span className="sq" /> : play ? <Icon name="play" /> : <Icon name="up" />}
    </button>
  );
};
