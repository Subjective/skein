import { createRoot } from 'react-dom/client';
import './styles/skein.css';
import './styles/app.css';
import { spriteHtml } from './ui/icons';
import { App, boot } from './shell/App';
import { startKeyboard } from './shell/keyboard';

document.body.insertAdjacentHTML('afterbegin', spriteHtml());
startKeyboard();
void boot();
createRoot(document.getElementById('root')!).render(<App />);
