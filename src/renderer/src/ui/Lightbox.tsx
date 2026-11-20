// The image viewer (the mockup's lightbox): an image full size over a dark scrim. A click anywhere, esc, q or
// enter closes it; while it is open it owns the keys, and closing gives them back to where they were.
import { openLayer } from '../state/store';
import { useDialogSurface } from './Dialog';

function Lightbox({ src, close }: { src: string; close: () => void }) {
  useDialogSurface({ onEsc: close, key: k => { if (k === 'q' || k === '?' || k === 'enter' || k === 'space') { close(); return true; } return k.length === 1; } });
  return <div className="scrim lightbox" role="dialog" aria-label="Image" onClick={close}><img src={src} alt="" /></div>;
}

/** Show an image full size. */
export function openLightbox(src: string) { openLayer(close => <Lightbox src={src} close={close} />); }
