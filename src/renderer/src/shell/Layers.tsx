// Overlays and toasts.
import { dismissToast, useApp } from '../state/store';
import { Button, Icon } from '../ui/primitives';

export function Layers() {
  const s = useApp();
  return <>{s.layers.map(l => <div key={l.id} className="layer">{l.render(l.close)}</div>)}</>;
}

/** One toast at a time (a new one replaces it), as the mockup's toast(): icon, text (names in bold), an inline
 *  action such as Undo, which also dismisses it. */
export function Toasts() {
  const s = useApp();
  // the toast itself is the mockup's (.toast drops in from above); the live region only announces it
  return <div aria-live="polite" style={{ display: 'contents' }}>{s.toasts.map(t => (
    <div key={t.id} className="toast" role="status">
      {t.icon && <Icon name={t.icon} />}<span>{t.text}</span>
      {t.action && <Button small onClick={() => { dismissToast(t.id); t.action!.run(); }}>{t.action.label}</Button>}
    </div>
  ))}</div>;
}
