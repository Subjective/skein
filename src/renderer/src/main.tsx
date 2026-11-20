import { createRoot } from 'react-dom/client';
import './styles/skein.css';
import './styles/app.css';
import { spriteHtml } from './ui/icons';
import { App, boot } from './shell/App';
import { owner, startKeyboard } from './shell/keyboard';
import { S } from './state/store';

document.body.insertAdjacentHTML('afterbegin', spriteHtml());
startKeyboard();
// for UI tests and debugging from devtools
(window as unknown as { __skein: unknown }).__skein = { S, owner };
void boot();
createRoot(document.getElementById('root')!).render(<App />);
