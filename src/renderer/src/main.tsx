import { createRoot } from 'react-dom/client';
import './styles/skein.css';
import './styles/app.css';
import { spriteHtml } from './ui/icons';
import { App, boot } from './shell/App';
import { owner, startKeyboard } from './shell/keyboard';
import { S } from './state/store';
import { termOf } from './views/terminal/TerminalView';

document.body.insertAdjacentHTML('afterbegin', spriteHtml());
startKeyboard();
// for UI tests and debugging from devtools
(window as unknown as { __skein: unknown }).__skein = { S, owner, text: (tabId: string) => { const t = termOf(tabId); if (!t) return ''; const b = t.term.buffer.active; let o = ''; for (let i = 0; i < b.length; i++) o += (b.getLine(i)?.translateToString(true) ?? '') + '\n'; return o.trimEnd(); },
  /** A terminal's selection (the scrollback reader's cursor or match): its text and the buffer line it starts on. */
  sel: (tabId: string) => { const t = termOf(tabId); return t ? { text: t.term.getSelection(), line: t.term.getSelectionPosition()?.start.y ?? null } : null; } };
void boot();
createRoot(document.getElementById('root')!).render(<App />);
