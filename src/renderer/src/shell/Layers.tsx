// Overlays and toasts.
import { useApp } from '../state/store';
import { Button, Icon } from '../ui/primitives';

export function Layers() {
  const s = useApp();
  return <>{s.layers.map(l => <div key={l.id} className="layer">{l.render(l.close)}</div>)}</>;
}

export function Toasts() {
  const s = useApp();
  return <div className="toasts" aria-live="polite">{s.toasts.map(t => (
    <div key={t.id} className="toast" role="status">{t.icon && <Icon name={t.icon} />}<span>{t.text}</span>{t.action && <Button small variant="ghost" onClick={t.action.run}>{t.action.label}</Button>}</div>
  ))}</div>;
}
